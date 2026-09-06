import { reportsRepo } from '../db/repositories/reportsRepo.js';
import { sanctionsRepo } from '../db/repositories/sanctionsRepo.js';
import { usersRepo } from '../db/repositories/usersRepo.js';
import { listingsRepo } from '../db/repositories/listingsRepo.js';
import { listingQueueRepo } from '../db/repositories/listingQueueRepo.js';
import { matchRepo } from '../db/repositories/matchRepo.js';
import * as rbac from './rbac.js';
import * as audit from './audit.js';
import * as engine from './matching/engine.js';
import { publish, CHANNELS } from '../bus/events.js';

export class ModerationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModerationError';
    this.code = code;
  }
}

function forbidden() {
  return new ModerationError('ERR_FORBIDDEN', 'Missing capability');
}

/** Files a report. Human and automated reports (`OWNER_DIVERTED`, `ERR_RATE_LIMITED`) share this one entry point. */
export async function report(tx, reporterId, { targetType, targetId, reason, body = '' }) {
  const created = await reportsRepo.insert(tx, { reporterId, targetType, targetId, reason, body });
  await audit.record(tx, {
    actorId: reporterId,
    action: 'report.created',
    targetType: 'report',
    targetId: created.id,
    after: created,
  });
  return created;
}

export async function assign(tx, actorId, reportId, assigneeId) {
  const caps = await rbac.resolve(tx, actorId);
  if (!rbac.can(caps, 'reports.assign')) throw forbidden();
  const before = await reportsRepo.findById(tx, reportId);
  if (!before) throw new ModerationError('NOT_FOUND', 'Report not found');
  const updated = await reportsRepo.assign(tx, reportId, assigneeId);
  await audit.record(tx, {
    actorId,
    action: 'report.assigned',
    targetType: 'report',
    targetId: reportId,
    before,
    after: updated,
  });
  return updated;
}

export async function resolve(tx, actorId, reportId) {
  const caps = await rbac.resolve(tx, actorId);
  if (!rbac.can(caps, 'reports.assign')) throw forbidden();
  const before = await reportsRepo.findById(tx, reportId);
  if (!before) throw new ModerationError('NOT_FOUND', 'Report not found');
  const updated = await reportsRepo.resolve(tx, reportId);
  await audit.record(tx, {
    actorId,
    action: 'report.resolved',
    targetType: 'report',
    targetId: reportId,
    before,
    after: updated,
  });
  return updated;
}

/**
 * Internal note on a report. No dedicated `report_notes` table exists in
 * the contract's schema (unlike `disputes.timeline`) — the audit log is
 * the note trail here, which already gives a queryable, attributed history.
 */
export async function addNote(tx, actorId, reportId, body) {
  const caps = await rbac.resolve(tx, actorId);
  if (!rbac.can(caps, 'reports.assign')) throw forbidden();
  await audit.record(tx, {
    actorId,
    action: 'report.note',
    targetType: 'report',
    targetId: reportId,
    after: { body },
  });
}

/**
 * Platform-only sanction (A13): never calls the Discord API, never touches
 * a real guild. Hides active listings, withdraws queue entries and
 * dissolves open proposals — but never a transaction already in `TRIAL` or
 * beyond, which keeps following its own FSM (dispute if needed).
 */
export async function sanction(tx, actorId, userId, { kind, reason, endsAt = null }) {
  if (actorId === userId) {
    throw new ModerationError('ERR_SELF_SANCTION', 'Cannot sanction yourself');
  }
  const caps = await rbac.resolve(tx, actorId);
  if (!rbac.can(caps, 'moderation.sanction')) throw forbidden();

  const user = await usersRepo.findById(tx, userId);
  if (!user) throw new ModerationError('ERR_TARGET_MISSING', 'Target user not found');

  const existing = await sanctionsRepo.findActiveOfKind(tx, userId, kind);
  if (existing) {
    throw new ModerationError('ERR_ALREADY_SANCTIONED', 'An active sanction of this kind already exists');
  }

  const created = await sanctionsRepo.insert(tx, { userId, kind, reason, actorId, endsAt });

  if (kind === 'ban_temp' || kind === 'ban_perm') {
    await usersRepo.setBanState(tx, userId, { bannedUntil: endsAt, bannedPermanently: kind === 'ban_perm' });
  }

  if (kind === 'ban_temp' || kind === 'ban_perm' || kind === 'suspend') {
    const { items: listings } = await listingsRepo.listByUser(tx, userId, { limit: 1000 });
    for (const listing of listings) {
      if (listing.status === 'active') {
        await listingsRepo.updateFields(tx, listing.id, { status: 'hidden' });
      }
    }
    await listingQueueRepo.withdrawAllForUser(tx, userId);

    const openProposals = await matchRepo.findOpenProposalsForUser(tx, userId);
    for (const proposal of openProposals) {
      const found = await matchRepo.getProposal(tx, proposal.id);
      await engine.dissolveProposal(tx, proposal, found.participants, 'refused');
    }
  }

  await audit.record(tx, {
    actorId,
    action: 'moderation.sanction',
    targetType: 'user',
    targetId: userId,
    after: created,
  });
  await publish(tx, CHANNELS.EVENT_MODERATION_ACTION, { userId, kind, sanctionId: created.id });
  rbac.invalidateCache(userId);
  return created;
}

export async function lift(tx, actorId, sanctionId, reason) {
  const caps = await rbac.resolve(tx, actorId);
  if (!rbac.can(caps, 'moderation.sanction')) throw forbidden();

  const existing = await sanctionsRepo.findById(tx, sanctionId);
  if (!existing) throw new ModerationError('NOT_FOUND', 'Sanction not found');

  const updated = await sanctionsRepo.revoke(tx, sanctionId, actorId);
  const stillActive = await sanctionsRepo.findActiveByUser(tx, existing.userId);
  const stillPerm = stillActive.some((s) => s.kind === 'ban_perm');
  const stillTemp = stillActive.find((s) => s.kind === 'ban_temp');
  await usersRepo.setBanState(tx, existing.userId, {
    bannedUntil: stillTemp?.endsAt ?? null,
    bannedPermanently: stillPerm,
  });

  await audit.record(tx, {
    actorId,
    action: 'moderation.sanction_lifted',
    targetType: 'user',
    targetId: existing.userId,
    before: existing,
    after: { revokedAt: updated.revokedAt, reason },
  });
  await publish(tx, CHANNELS.EVENT_MODERATION_ACTION, { userId: existing.userId, kind: 'lift', sanctionId });
  rbac.invalidateCache(existing.userId);
  return updated;
}
