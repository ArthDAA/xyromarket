export class TtcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TtcError';
    this.code = code;
  }
}

/**
 * Core walk shared by `run` and `runWithStats`. Maintains ONE persistent
 * stack across the whole traversal — after a cycle is spliced off the top,
 * the walk resumes from the new top (the broken prefix), never restarting
 * from the beginning of the active set. Combined with a cursor that only
 * ever advances, this is what keeps the whole run at O(n + Σ|prefs|): see
 * `ttc.dbtest.js`... actually `ttc.test.js` for the counted proof.
 */
function walk(listings, prefs, { assertMonotonic = false } = {}) {
  const activeIds = new Set(listings.map((l) => l.id));
  const cursor = new Map();
  const path = [];
  const posInPath = new Map();
  const cycles = [];
  let cursorAdvances = 0;

  function nextOf(id) {
    const list = prefs.get(id) ?? [];
    const previous = cursor.get(id) ?? 0;
    let c = previous;
    while (c < list.length && !activeIds.has(list[c])) {
      c += 1;
      cursorAdvances += 1;
    }
    if (assertMonotonic && c < previous) {
      throw new TtcError('ERR_CURSOR_REGRESSION', `Cursor regressed for listing ${id}`);
    }
    cursor.set(id, c);
    return c < list.length ? list[c] : id; // exhausted -> self-loop (keep own listing)
  }

  for (const listing of listings) {
    if (!activeIds.has(listing.id)) continue;
    if (path.length === 0) {
      path.push(listing.id);
      posInPath.set(listing.id, 0);
    }

    while (path.length > 0) {
      const current = path[path.length - 1];
      const candidate = nextOf(current);

      if (posInPath.has(candidate)) {
        const startIdx = posInPath.get(candidate);
        const members = path.splice(startIdx);
        for (const m of members) {
          posInPath.delete(m);
          activeIds.delete(m);
        }
        if (members.length >= 2) {
          cycles.push({ members });
        }
        // length === 1: a self-loop / terminal (keeps its own listing), never returned.
      } else {
        path.push(candidate);
        posInPath.set(candidate, path.length - 1);
      }
    }
  }

  return { cycles, cursorAdvances };
}

/**
 * Extracts exchange cycles from the functional preference graph via Top
 * Trading Cycles. Pure: no DB access, no side effects. See
 * `2-Architecture.md`'s Guarantees for what this algorithm does and does
 * not establish (core allocation of the *derived*-preference market;
 * explicitly NOT strategy-proof in Roth's sense, since users report tags,
 * not an order).
 *
 * @param {{id: string}[]} listings - all active `echange` listings.
 * @param {Map<string, string[]>} prefs - listing id -> acceptable candidate ids, best first.
 * @returns {{ members: string[] }[]} cycles of length >= 2, in extraction order.
 */
export function run(listings, prefs) {
  return walk(listings, prefs).cycles;
}

/** Same computation as `run`, plus the cursor-advancement counter the complexity guarantee requires. */
export function runWithStats(listings, prefs, opts) {
  return walk(listings, prefs, opts);
}
