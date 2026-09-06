import { listingsRepo } from '../db/repositories/listingsRepo.js';
import { guildsRepo } from '../db/repositories/guildsRepo.js';
import * as ownership from './ownership.js';
import * as audit from './audit.js';

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

async function assertBotReadyForListing(tx, guildId) {
  const guild = await guildsRepo.findById(tx, guildId);
  if (!guild || !guild.botPresent) {
    throw new ListingError('ERR_BOT_ABSENT', `Bot is not present on guild ${guildId}`);
  }
  // Role-hierarchy check (M15) is asserted again by bot/trialRole.js right before role
  // assignment; here we only block listing creation on a hierarchy already known to be bad.
  if (guild.botRolePosition != null && guild.botRolePosition <= 0) {
    throw new ListingError('ERR_ROLE_HIERARCHY', 'Bot role is not positioned above the trial role');
  }
}

/**
 * Creates a listing after verifying live ownership, bot presence and role
 * hierarchy. Publication is direct (A12): the listing is visible the moment
 * this returns.
 */
export async function create(tx, userId, { guildId, mode, description, tags, seekingTags = [] }) {
  await ownership.assertOwnershipForListing(tx, userId, guildId);
  await assertBotReadyForListing(tx, guildId);

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
  });

  await audit.record(tx, {
    actorId: userId,
    action: 'listing.created',
    targetType: 'listing',
    targetId: listing.id,
    after: listing,
  });

  return listing;
}

async function assertMutable(tx, listing) {
  if (listing.status !== 'active' && listing.status !== 'hidden' && listing.status !== 'removed') {
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

export async function hide(tx, userId, listingId) {
  const listing = await listingsRepo.findById(tx, listingId);
  if (!listing) throw new ListingError('NOT_FOUND', 'Listing not found');
  await ownership.assertOwnershipForListing(tx, userId, listing.guildId);
  await assertMutable(tx, listing);
  return setStatus(tx, userId, listingId, 'hidden', 'listing.hidden');
}

export async function remove(tx, userId, listingId) {
  const listing = await listingsRepo.findById(tx, listingId);
  if (!listing) throw new ListingError('NOT_FOUND', 'Listing not found');
  await ownership.assertOwnershipForListing(tx, userId, listing.guildId);
  await assertMutable(tx, listing);
  return setStatus(tx, userId, listingId, 'removed', 'listing.removed');
}

/** Always possible unless a terminal transaction (`fulfilled`/`matched`) already references the listing. */
export async function restore(tx, userId, listingId) {
  const listing = await listingsRepo.findById(tx, listingId);
  if (!listing) throw new ListingError('NOT_FOUND', 'Listing not found');
  await ownership.assertOwnershipForListing(tx, userId, listing.guildId);
  if (listing.status === 'matched' || listing.status === 'fulfilled') {
    throw new ListingError('ERR_LISTING_LOCKED', 'Listing is engaged in a non-terminal transaction');
  }
  return setStatus(tx, userId, listingId, 'active', 'listing.restored');
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
