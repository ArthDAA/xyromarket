import { disputesRepo } from '../db/repositories/disputesRepo.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { settingsRepo } from '../db/repositories/settingsRepo.js';
import * as trial from './trial.js';
import * as rbac from './rbac.js';
import * as audit from './audit.js';

export class DisputeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DisputeError';
    this.code = code;
  }
}

function forbidden() {
  return new DisputeError('ERR_FORBIDDEN', 'Missing capability');
}

/** Opens a post-transfer dispute, within `dispute_window_days` of `transferred_at`. */
export async function open(tx, actorId, transactionId, { reason, body = '' }) {
  const transaction = await transactionsRepo.findById(tx, transactionId);
  if (!transaction) throw new DisputeError('NOT_FOUND', 'Transaction not found');
  if (transaction.fromUserId !== actorId && transaction.toUserId !== actorId) {
    throw new DisputeError('ERR_NOT_PARTY', 'Actor is not a party to this transaction');
  }
  if (transaction.status !== 'TRANSFERRED') {
    throw new DisputeError(
      'ERR_NOT_TRANSFERRED',
      'Transaction has not been transferred yet — use trial.cancel instead',
    );
  }

  const windowDays = await settingsRepo.get(tx, 'dispute_window_days');
  const windowEnd = new Date(new Date(transaction.transferredAt).getTime() + windowDays * 86_400_000);
  if (new Date() > windowEnd) {
    throw new DisputeError('ERR_WINDOW_CLOSED', 'Dispute window has closed');
  }

  const existing = await disputesRepo.findOpenByTransaction(tx, transactionId);
  if (existing) {
    throw new DisputeError('ERR_DUPLICATE_DISPUTE', existing.id);
  }

  const dispute = await disputesRepo.insert(tx, { transactionId, openedBy: actorId, reason, body });
  // -> DISPUTED, publishes event.transaction.updated: hub.js reacts by posting into (and
  // thereby un-archiving) the existing thread — no dedicated "reopen" bus channel needed.
  await trial.openDispute(tx, transactionId);
  await audit.record(tx, {
    actorId,
    action: 'dispute.opened',
    targetType: 'dispute',
    targetId: dispute.id,
    after: dispute,
  });
  return dispute;
}

export async function assign(tx, actorId, disputeId, assigneeId) {
  const caps = await rbac.resolve(tx, actorId);
  if (!rbac.can(caps, 'transactions.resolve')) throw forbidden();
  const dispute = await disputesRepo.findById(tx, disputeId);
  if (!dispute) throw new DisputeError('NOT_FOUND', 'Dispute not found');
  const updated = await disputesRepo.appendTimelineEntry(tx, disputeId, { actorId, event: 'assigned', assigneeId });
  await audit.record(tx, {
    actorId,
    action: 'dispute.assigned',
    targetType: 'dispute',
    targetId: disputeId,
    after: { assigneeId },
  });
  return updated;
}

export async function addNote(tx, actorId, disputeId, body, visibility = 'internal') {
  const caps = await rbac.resolve(tx, actorId);
  if (!rbac.can(caps, 'transactions.resolve')) throw forbidden();
  const updated = await disputesRepo.appendTimelineEntry(tx, disputeId, {
    actorId,
    event: 'note',
    body,
    visibility,
  });
  await audit.record(tx, {
    actorId,
    action: 'dispute.note',
    targetType: 'dispute',
    targetId: disputeId,
    after: { visibility },
  });
  return updated;
}

/**
 * Records the team's decision. `return_expected` does NOT close the
 * dossier: an effective return is only ever confirmed by an `ownership.js`
 * observation (`confirmReturn`), never by this declaration alone.
 * `rejected`/`settled` close the transaction immediately.
 */
export async function resolve(tx, actorId, disputeId, { outcome, body = '' }) {
  const caps = await rbac.resolve(tx, actorId);
  if (!rbac.can(caps, 'transactions.resolve')) throw forbidden();
  const dispute = await disputesRepo.findById(tx, disputeId);
  if (!dispute) throw new DisputeError('NOT_FOUND', 'Dispute not found');

  await disputesRepo.appendTimelineEntry(tx, disputeId, {
    actorId,
    event: 'resolution_decided',
    outcome,
    body,
  });

  if (outcome === 'return_expected') {
    await disputesRepo.setPendingOutcome(tx, disputeId, { outcome, resolution: body, resolvedBy: actorId });
    const updated = await disputesRepo.setStatus(tx, disputeId, 'awaiting_return');
    await audit.record(tx, {
      actorId,
      action: 'dispute.resolution_decided',
      targetType: 'dispute',
      targetId: disputeId,
      after: { outcome },
    });
    return updated;
  }

  const updated = await disputesRepo.resolve(tx, disputeId, { outcome, resolution: body, resolvedBy: actorId });
  await trial.close(tx, dispute.transactionId);
  await audit.record(tx, {
    actorId,
    action: 'dispute.resolved',
    targetType: 'dispute',
    targetId: disputeId,
    after: { outcome },
  });
  return updated;
}

/**
 * Called by `transfer.js` when it observes `owner_id` reverting to the
 * original owner while this dispute is `awaiting_return` — never on a
 * party's say-so (`ERR_RETURN_NOT_OBSERVED` otherwise).
 */
export async function confirmReturn(tx, disputeId) {
  const dispute = await disputesRepo.findById(tx, disputeId);
  if (!dispute) throw new DisputeError('NOT_FOUND', 'Dispute not found');
  if (dispute.status !== 'awaiting_return' || dispute.outcome !== 'return_expected') {
    throw new DisputeError('ERR_RETURN_NOT_OBSERVED', 'No pending return expected for this dispute');
  }

  await disputesRepo.appendTimelineEntry(tx, disputeId, { actorId: 'bot', event: 'return_confirmed' });
  const updated = await disputesRepo.resolve(tx, disputeId, {
    outcome: dispute.outcome,
    resolution: dispute.resolution,
    resolvedBy: dispute.resolvedBy,
  });
  await trial.close(tx, dispute.transactionId);
  await audit.record(tx, {
    actorId: 'bot',
    action: 'dispute.return_confirmed',
    targetType: 'dispute',
    targetId: disputeId,
  });
  return updated;
}

export async function findOpenAwaitingReturnForTransaction(tx, transactionId) {
  const dispute = await disputesRepo.findOpenByTransaction(tx, transactionId);
  if (!dispute || dispute.status !== 'awaiting_return') return null;
  return dispute;
}
