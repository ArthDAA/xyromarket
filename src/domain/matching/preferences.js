export class PreferencesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PreferencesError';
    this.code = code;
  }
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Derives a strict, truncated preference order for `listing` over
 * `candidates`: every candidate scoring 0 is dropped (ranked below the
 * listing's own dotation, i.e. unacceptable), not "last resort". This is a
 * scoring function chosen by the developer from public tags — it is not a
 * report of the participant's real preference (see `ttc.js` Guarantees for
 * what that does and does not imply).
 *
 * @returns {string[]} candidate listing ids, most to least preferred.
 */
export function build(listing, candidates) {
  if (listing.mode !== 'echange') {
    throw new PreferencesError('ERR_MODE_MISMATCH', 'preferences.build called on a non-echange listing');
  }

  const scored = candidates
    .filter(
      (c) =>
        c.mode === 'echange' &&
        c.status === 'active' &&
        c.userId !== listing.userId &&
        c.guildId !== listing.guildId,
    )
    .map((c) => ({ candidate: c, score: jaccard(listing.seekingTags, c.tags) }))
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const createdDiff = new Date(a.candidate.createdAt) - new Date(b.candidate.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return a.candidate.id < b.candidate.id ? -1 : 1;
  });

  return scored.map((entry) => entry.candidate.id);
}
