/**
 * The one fixed domain-error -> HTTP mapping (`web/routes/user.js` §Errors).
 * No route invents its own status code for a domain error.
 */
const CODE_TO_STATUS = {
  // 403 — forbidden / not a party
  ERR_FORBIDDEN: 403,
  ERR_NOT_PARTY: 403,
  ERR_NOT_OWNER: 403,
  ERR_BANNED: 403,
  ERR_SANCTIONED: 403,
  ERR_ESCALATION: 403,
  ERR_CSRF: 403,
  ERR_NOT_PARTICIPANT: 403,

  // 400 — self-action guards
  ERR_SELF_REVIEW: 400,
  ERR_SELF_SANCTION: 400,
  ERR_SELF_QUEUE: 400,
  ERR_SELF_SWAP: 400,
  ERR_MODE_MISMATCH: 400,
  ERR_TAG_MISMATCH: 400,

  // 409 — conflict / bad transition / already-something
  ERR_CONFLICT: 409,
  ERR_BAD_TRANSITION: 409,
  ERR_ALREADY_QUEUED: 409,
  ERR_ALREADY_REVIEWED: 409,
  ERR_ALREADY_SANCTIONED: 409,
  ERR_DUPLICATE_DISPUTE: 409,
  ERR_LAST_OWNER: 409,
  ERR_ACTIVE_TRANSACTION: 409,
  ERR_WINDOW_CLOSED: 409,
  ERR_NOT_TRANSFERRED: 409,
  ERR_LISTING_LOCKED: 409,
  ERR_ROLE_HIERARCHY: 409,
  ERR_TOO_MANY_TAGS: 409,
  ERR_INVALID_TAG: 409,
  ERR_INVALID_DESCRIPTION: 409,
  ERR_SEEKING_TAGS_ON_DON: 409,
  ERR_GUILD_HAS_ACTIVE_LISTING: 409,
  ERR_COOLDOWN: 409,
  ERR_PROPOSAL_EXPIRED: 409,
  ERR_NO_TRANSACTION: 409,

  // 404 — not found / missing
  NOT_FOUND: 404,
  ERR_TARGET_MISSING: 404,

  // 429 — rate limited
  ERR_RATE_LIMITED: 429,

  // 200 — idempotent no-ops that are not really errors
  ERR_ALREADY_VALIDATED: 200,
};

export function mapDomainError(err, correlationId) {
  if (err?.code && err.code in CODE_TO_STATUS) {
    return { status: CODE_TO_STATUS[err.code], body: { error: err.code, message: err.message } };
  }
  return { status: 500, body: { error: 'ERR_UNEXPECTED', correlationId } };
}
