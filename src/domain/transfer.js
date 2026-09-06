import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { usersRepo } from '../db/repositories/usersRepo.js';
import { publish, CHANNELS } from '../bus/events.js';
import * as trial from './trial.js';
import * as moderation from './moderation.js';
import * as dispute from './dispute.js';
import * as audit from './audit.js';
import { SYSTEM_USER_ID } from '../config/systemUser.js';

const HUB_ARCHIVE_DELAY_DAYS = 7;

async function afterTransfer(tx, transaction) {
  const [fromUser, toUser] = await Promise.all([
    usersRepo.findById(tx, transaction.fromUserId),
    usersRepo.findById(tx, transaction.toUserId),
  ]);
  await publish(tx, CHANNELS.INTENT_TRIAL_REVOKE, {
    guildId: transaction.guildId,
    memberDiscordId: toUser.discordId,
    transactionId: transaction.id,
    reason: 'TRANSFER_COMPLETE',
  });
  await publish(tx, CHANNELS.INTENT_ANNOUNCE_HANDOVER, {
    guildId: transaction.guildId,
    transactionId: transaction.id,
    previousOwnerId: fromUser.discordId,
    newOwnerId: toUser.discordId,
    transferredAt: transaction.transferredAt,
  });
  await publish(tx, CHANNELS.INTENT_HUB_THREAD_ARCHIVE, {
    transactionId: transaction.id,
    delayDays: HUB_ARCHIVE_DELAY_DAYS,
  });
}

/**
 * Handler for `event.ownership.changed`. The real Discord state always
 * wins: an early transfer (before double validation) is accepted, never
 * retroactively cancelled. Both sides of a handover (old owner losing it,
 * new owner gaining it) are one atomic observation from `ownership.js` —
 * this handler reacts to that single observation, never to a party's claim.
 */
export async function onOwnershipChanged(tx, { guildId, newOwnerId, observedAt, source }) {
  const transaction = await transactionsRepo.findOpenByGuild(tx, guildId);
  if (!transaction) {
    // ERR_NO_TRANSACTION: off-platform handover, not hostile — ownership.js
    // already recorded the raw event in ownership_events. Nothing else to do.
    return null;
  }

  const [fromUser, toUser] = await Promise.all([
    usersRepo.findById(tx, transaction.fromUserId),
    usersRepo.findById(tx, transaction.toUserId),
  ]);

  const isExpectedRecipient = newOwnerId === toUser.discordId;
  const inTransferableState = transaction.status === 'TRIAL_VALIDATED' || transaction.status === 'TRIAL';

  if (isExpectedRecipient && inTransferableState) {
    const alreadyTransferred = Boolean(transaction.transferredAt);
    const updated = await trial.markTransferred(tx, transaction.id, observedAt);
    if (!alreadyTransferred) {
      if (transaction.status === 'TRIAL') {
        await audit.record(tx, {
          actorId: 'bot',
          action: 'transfer.early_transfer',
          targetType: 'transaction',
          targetId: transaction.id,
          after: { note: 'EARLY_TRANSFER: owner_id switched before both parties validated' },
        });
      }
      await afterTransfer(tx, updated);
    }
    return updated;
  }

  if (newOwnerId !== fromUser.discordId) {
    // Neither the expected recipient nor the original owner: diverted to a third party.
    const cancelled = await trial.cancel(tx, 'bot', transaction.id, 'OWNER_DIVERTED');
    await moderation.report(tx, SYSTEM_USER_ID, {
      targetType: 'user',
      targetId: transaction.toUserId,
      reason: 'OWNER_DIVERTED',
      body: `Guild ${guildId} ownership diverted to ${newOwnerId} instead of the trial recipient (source: ${source}).`,
    });
    return cancelled;
  }

  // newOwnerId === fromUser.discordId: reverted to the original owner. If a dispute is
  // awaiting exactly this return (M14), this is the observation that confirms it — the
  // effective return is never taken on a party's word alone.
  const pendingDispute = await dispute.findOpenAwaitingReturnForTransaction(tx, transaction.id);
  if (pendingDispute) {
    return dispute.confirmReturn(tx, pendingDispute.id);
  }

  await audit.record(tx, {
    actorId: 'bot',
    action: 'transfer.reverted_to_original_owner',
    targetType: 'transaction',
    targetId: transaction.id,
    after: { guildId, observedAt },
  });
  return transaction;
}
