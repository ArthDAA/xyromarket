import { listingsRepo } from '../db/repositories/listingsRepo.js';
import { guildsRepo } from '../db/repositories/guildsRepo.js';
import * as ownership from './ownership.js';
import * as rbac from './rbac.js';
import * as audit from './audit.js';
import { publish, CHANNELS } from '../bus/events.js';

export class ListingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ListingError';
    this.code = code;
  }
}

const TAG_RE = /^[a-z0-9-]{2,24}$/;
const MAX_TAGS = 10;
const MAX_SEEKING_TAGS = 10;
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 2000;

/** NFKC-normalizes, lowercases, strips a leading `#`, validates shape, and dedupes tags. */
function normalizeTags(tags, { max }) {
  const seen = new Set();
  const normalized = [];
  for (const raw of tags) {
    const tag = raw.normalize('NFKC').toLowerCase().replace(/^#/, '');
    if (!TAG_RE.test(tag)) {
      throw new ListingError('ERR_INVALID_TAG', `Invalid tag: ${raw}`);
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
    }
  }
  if (normalized.length > max) {
    throw new ListingError('ERR_TOO_MANY_TAGS', `At most ${max} tags allowed`);
  }
  return normalized;
}

/**
 * Bot absence no longer blocks creation (publishing is what triggers the
 * invite, not a precondition of it) — it only decides the initial status.
 * Role-hierarchy is a different failure: it only means anything once the
 * bot has actually joined, so a guild reusing an already-present bot with a
 * known-bad hierarchy still fails fast here rather than publishing an
 * annonce that can never assign a trial role. Re-checked once more by
 * bot/trialRole.js right before role assignment (M15) since position can
 * still change between the two.
 */
async function initialStatusForGuild(tx, guildId) {
  const guild = await guildsRepo.findById(tx, guildId);
  if (!guild || !guild.botPresent) {
    return 'pending_bot';
  }
  if (guild.botRolePosition != null && guild.botRolePosition <= 0) {
    throw new ListingError('ERR_ROLE_HIERARCHY', 'Bot role is not positioned above the trial role');
  }
  return 'active';
}

/**
 * Creates a listing after verifying live ownership and role hierarchy.
 * Publication is direct (A12): the listing exists and is visible the moment
 * this returns, in whichever status it earns — `active` if the bot is
 * already on the guild, `pending_bot` otherwise. The caller (web/routes)
 * is responsible for sending the owner to the bot invite screen when it
 * comes back `pending_bot`; bot/guildWatcher.js flips it to `active` the
 * moment the bot's `guildCreate` event confirms the join.
 */
export async function create(tx, userId, { guildId, mode, description, tags, seekingTags = [] }) {
  await ownership.assertOwnershipForListing(tx, userId, guildId);
  const initialStatus = await initialStatusForGuild(tx, guildId);

  const existingLive = await listingsRepo.findLiveByGuild(tx, guildId);
  if (existingLive) {
    throw new ListingError('ERR_GUILD_HAS_ACTIVE_LISTING', `Guild ${guildId} already has a live listing`);
  }

  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    throw new ListingError(
      'ERR_INVALID_DESCRIPTION',
      `Description must be between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} characters`,
    );
  }
  const normalizedTags = normalizeTags(tags, { max: MAX_TAGS });
  if (normalizedTags.length === 0) {
    throw new ListingError('ERR_INVALID_TAG', 'At least one tag is required');
  }

  if (mode === 'don' && seekingTags.length > 0) {
    throw new ListingError('ERR_SEEKING_TAGS_ON_DON', 'A don listing cannot carry seekingTags');
  }
  const normalizedSeekingTags = normalizeTags(seekingTags, { max: MAX_SEEKING_TAGS });

  const listing = await listingsRepo.insert(tx, {
    userId,
    guildId,
    mode,
    description,
    tags: normalizedTags,
    seekingTags: normalizedSeekingTags,
    status: initialStatus,
  });

  await audit.record(tx, {
    actorId: userId,
    action: 'listing.created',
    targetType: 'listing',
    targetId: listing.id,
    after: listing,
  });
  // Nudges jobs.matchRound to run early (debounced 30s) rather than waiting for its 5min
  // tick — pointless while `pending_bot`, since listActive()/listPublic() never see it yet.
  if (listing.status === 'active') {
    await publish(tx, CHANNELS.EVENT_LISTING_CHANGED, { listingId: listing.id });
  }

  return listing;
}

/**
 * Called by bot/guildWatcher.js the moment the bot's `guildCreate` event
 * confirms it has joined `guildId` — flips whichever annonce was published
 * there before the bot existed on the guild into `active`. No-op if none is
 * pending (the common case: most joins happen because of the invite flow
 * itself, but a manual invite or a re-join both land here safely too).
 */
export async function activatePendingForGuild(tx, guildId) {
  const pending = await listingsRepo.findPendingBotByGuild(tx, guildId);
  if (!pending) return null;

  const updated = await listingsRepo.updateFields(tx, pending.id, { status: 'active' });
  await audit.record(tx, {
    actorId: 'system',
    action: 'listing.activated_bot_joined',
    targetType: 'listing',
    targetId: pending.id,
    before: { status: 'pending_bot' },
    after: { status: 'active' },
  });
  await publish(tx, CHANNELS.EVENT_LISTING_CHANGED, { listingId: pending.id });
  return updated;
}

const MUTABLE_STATUSES = new Set(['active', 'pending_bot', 'hidden', 'removed']);

async function assertMutable(tx, listing) {
  if (!MUTABLE_STATUSES.has(listing.status)) {
    throw new ListingError('ERR_LISTING_LOCKED', 'Listing is engaged in a non-terminal transaction');
  }
}

export async function update(tx, userId, listingId, patch) {
  const listing = await listingsRepo.findById(tx, listingId);
  if (!listing) throw new ListingError('NOT_FOUND', 'Listing not found');
  await ownership.assertOwnershipForListing(tx, userId, listing.guildId);
  await assertMutable(tx, listing);

  const nextPatch = {};
  if (patch.description !== undefined) {
    if (patch.description.length < DESCRIPTION_MIN || patch.description.length > DESCRIPTION_MAX) {
      throw new ListingError('ERR_INVALID_DESCRIPTION', 'Description out of bounds');
    }
    nextPatch.description = patch.description;
  }
  if (patch.tags !== undefined) {
    nextPatch.tags = normalizeTags(patch.tags, { max: MAX_TAGS });
  }
  if (patch.seekingTags !== undefined) {
    if (listing.mode === 'don' && patch.seekingTags.length > 0) {
      throw new ListingError('ERR_SEEKING_TAGS_ON_DON', 'A don listing cannot carry seekingTags');
    }
    nextPatch.seekingTags = normalizeTags(patch.seekingTags, { max: MAX_SEEKING_TAGS });
  }

  const updated = await listingsRepo.updateFields(tx, listingId, nextPatch);
  await audit.record(tx, {
    actorId: userId,
    action: 'listing.updated',
    targetType: 'listing',
    targetId: listingId,
    before: listing,
    after: updated,
  });
  return updated;
}

async function setStatus(tx, actorId, listingId, status, action) {
  const listing = await listingsRepo.findById(tx, listingId);
  if (!listing) throw new ListingError('NOT_FOUND', 'Listing not found');
  const updated = await listingsRepo.updateFields(tx, listingId, { status });
  await audit.record(tx, {
    actorId,
    action,
    targetType: 'listing',
    targetId: listingId,
    before: { status: listing.status },
    after: { status },
  });
  return updated;
}

/**
 * Moderation-only (called exclusively from `web/routes/admin.js`, gated by
 * the `listings.hide` RBAC capability) — never a self-service action, so
 * this checks the actor's capability, not guild ownership (unlike
 * `update`/`remove` above, which are the owner's own actions).
 */
async function assertModerationCapability(tx, actorId, permission) {
  const caps = await rbac.resolve(tx, actorId);
  if (!rbac.can(caps, permission)) {
    throw new ListingError('ERR_FORBIDDEN', 'Missing capability');
  }
}

export async function hide(tx, actorId, listingId) {
  const listing = await listingsRepo.findById(tx, listingId);
  if (!listing) throw new ListingError('NOT_FOUND', 'Listing not found');
  await assertModerationCapability(tx, actorId, 'listings.hide');
  await assertMutable(tx, listing);
  return setStatus(tx, actorId, listingId, 'hidden', 'listing.hidden');
}

/**
 * Deleting an annonce is also the signal that the bot no longer has any
 * reason to sit in that guild — `assertMutable` above already guarantees no
 * transaction (past or in-progress) still needs it (only `active`/
 * `pending_bot`/`hidden`/`removed` reach this point, never `matched`/
 * `fulfilled`). `guild.leave()` is a plain bot-side action, no owner
 * consent needed (unlike joining, cf. A16) — fired as an intent since only
 * `bot/` holds a Discord client. `onGuildDelete` (fired by Discord the
 * moment the bot actually leaves) is what flips `bot_present` back to
 * false; this function never touches it directly.
 *
 * The row itself is deleted outright rather than left lying around as
 * `removed` forever (A18) — no point keeping it once nothing shows it
 * again. `match_participants`/`listing_queue` reference `listings(id)` with
 * `ON DELETE SET NULL` (migration 005, A24), not `RESTRICT`, so a past
 * match or queue entry never blocks this anymore — those rows survive with
 * their now-dangling listing reference cleared, keeping their own history
 * intact. `hardDelete`'s soft-delete fallback (`23503`) is kept purely as a
 * defensive last resort should some other, still-unknown reference ever
 * turn up — it is not expected to trigger in normal operation any longer.
 * Either way the full pre-delete content lives on in `audit_log.before`
 * (and `listing.created` already captured it in full at creation time), so
 * nothing about what was posted is lost even once the row itself is gone —
 * that's the actual admin-facing history (M10), not the row's survival.
 */
export async function remove(tx, userId, listingId) {
  const listing = await listingsRepo.findById(tx, listingId);
  if (!listing) throw new ListingError('NOT_FOUND', 'Listing not found');
  await ownership.assertOwnershipForListing(tx, userId, listing.guildId);
  await assertMutable(tx, listing);

  const guild = await guildsRepo.findById(tx, listing.guildId);
  const hardDeleted = await listingsRepo.hardDelete(tx, listingId);

  await audit.record(tx, {
    actorId: userId,
    action: hardDeleted ? 'listing.removed' : 'listing.removed_soft_fallback',
    targetType: 'listing',
    targetId: listingId,
    before: listing,
    after: hardDeleted ? null : { status: 'removed' },
  });

  if (guild?.botPresent) {
    await publish(tx, CHANNELS.INTENT_GUILD_LEAVE, { guildId: listing.guildId });
  }

  if (hardDeleted) {
    return { ...listing, status: 'removed' };
  }
  return listingsRepo.updateFields(tx, listingId, { status: 'removed' });
}

/**
 * Always possible unless a terminal transaction (`fulfilled`/`matched`)
 * already references the listing. Restoring re-runs the same bot-presence
 * check `create()` uses (A16): if `remove()` already sent the bot away —
 * or it was kicked manually in the meantime — restoring lands back on
 * `pending_bot`, never a silently bot-less `active` listing.
 */
export async function restore(tx, actorId, listingId) {
  const listing = await listingsRepo.findById(tx, listingId);
  if (!listing) throw new ListingError('NOT_FOUND', 'Listing not found');
  await assertModerationCapability(tx, actorId, 'listings.hide');
  if (listing.status === 'matched' || listing.status === 'fulfilled') {
    throw new ListingError('ERR_LISTING_LOCKED', 'Listing is engaged in a non-terminal transaction');
  }
  const nextStatus = await initialStatusForGuild(tx, listing.guildId);
  return setStatus(tx, actorId, listingId, nextStatus, 'listing.restored');
}

/** Owner lost live ownership: hides every active listing on the guild and records why. */
export async function hideAllForGuild(tx, guildId, reason) {
  const listing = await listingsRepo.findActiveByGuild(tx, guildId);
  if (!listing) return null;
  const updated = await listingsRepo.updateFields(tx, listing.id, { status: 'hidden' });
  await audit.record(tx, {
    actorId: 'system',
    action: 'listing.hidden_ownership_lost',
    targetType: 'listing',
    targetId: listing.id,
    before: { status: listing.status },
    after: { status: 'hidden', reason },
  });
  return updated;
}

export async function listPublic(tx, filters, page) {
  return listingsRepo.listPublic(tx, filters, page);
}
