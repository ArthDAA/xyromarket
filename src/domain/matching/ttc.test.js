import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, runWithStats } from './ttc.js';

function listing(id) {
  return { id };
}

test('a mutual pair forms a 2-cycle', () => {
  const listings = [listing('A'), listing('B')];
  const prefs = new Map([
    ['A', ['B']],
    ['B', ['A']],
  ]);
  const cycles = run(listings, prefs);
  assert.deepEqual(cycles, [{ members: ['A', 'B'] }]);
});

test('a listing with no acceptable candidate keeps its own dotation (never returned as a cycle)', () => {
  const listings = [listing('A')];
  const prefs = new Map([['A', []]]);
  assert.deepEqual(run(listings, prefs), []);
});

test('a missing prefs entry is treated as an empty list, not an error', () => {
  const listings = [listing('A'), listing('B')];
  const prefs = new Map([['B', ['A']]]); // 'A' absent entirely
  assert.deepEqual(run(listings, prefs), []);
});

test('a 3-way cycle is extracted whole', () => {
  const listings = [listing('A'), listing('B'), listing('C')];
  const prefs = new Map([
    ['A', ['B']],
    ['B', ['C']],
    ['C', ['A']],
  ]);
  assert.deepEqual(run(listings, prefs), [{ members: ['A', 'B', 'C'] }]);
});

test('two independent pairs yield two disjoint cycles, no listing in more than one', () => {
  const listings = [listing('A'), listing('B'), listing('C'), listing('D')];
  const prefs = new Map([
    ['A', ['B']],
    ['B', ['A']],
    ['C', ['D']],
    ['D', ['C']],
  ]);
  const cycles = run(listings, prefs);
  assert.equal(cycles.length, 2);
  const allMembers = cycles.flatMap((c) => c.members);
  assert.deepEqual([...allMembers].sort(), ['A', 'B', 'C', 'D']);
});

test('a dangling preference (id absent from the active set) is skipped, not a crash', () => {
  const listings = [listing('A'), listing('B')];
  const prefs = new Map([
    ['A', ['ghost', 'B']],
    ['B', ['A']],
  ]);
  const { cycles, cursorAdvances } = runWithStats(listings, prefs);
  assert.deepEqual(cycles, [{ members: ['A', 'B'] }]);
  assert.equal(cursorAdvances, 1); // one skip over 'ghost'
});

test('rationality: a one-sided preference with no reciprocation trades nobody', () => {
  // C wants A, but A has no acceptable candidate at all — A keeps itself,
  // and C is never forced into a trade A never agreed to.
  const listings = [listing('A'), listing('C')];
  const prefs = new Map([
    ['A', []],
    ['C', ['A']],
  ]);
  assert.deepEqual(run(listings, prefs), []);
});

test('a broken prefix (its top choice got absorbed into another cycle) resumes without restarting', () => {
  // Walk order: X -> Y -> Z -> Y (cycle Y,Z found; X is now a broken prefix
  // since its next() pointed at Y, which just got removed). X's second
  // preference is W, forming a second cycle X<->W once re-walked.
  const listings = [listing('X'), listing('Y'), listing('Z'), listing('W')];
  const prefs = new Map([
    ['X', ['Y', 'W']],
    ['Y', ['Z']],
    ['Z', ['Y']],
    ['W', ['X']],
  ]);
  const cycles = run(listings, prefs);
  assert.equal(cycles.length, 2);
  const byMember = new Map(cycles.flatMap((c) => c.members.map((m) => [m, c.members])));
  assert.deepEqual([...byMember.get('Y')].sort(), ['Y', 'Z']);
  assert.deepEqual([...byMember.get('X')].sort(), ['W', 'X']);
});

/**
 * Contract-mandated non-regression test (`2-Architecture.md`, bloc
 * `domain/matching/ttc.js`): the O(n + Σ|prefs|) bound is a property of the
 * *coding* (monotone cursor, never-restarted walk), not of the algorithm —
 * it must be verified, not assumed. This counts every cursor advancement
 * across a full run and asserts it never exceeds Σ|prefs|.
 */
test('global cursor-advancement count never exceeds the sum of preference-list lengths', () => {
  let seed = 42;
  function rand() {
    // Deterministic LCG so a failure is reproducible.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  const N = 500;
  const listings = Array.from({ length: N }, (_, i) => listing(`L${i}`));
  const prefs = new Map();
  let totalPrefsLength = 0;

  for (let i = 0; i < N; i += 1) {
    const size = Math.floor(rand() * 8); // 0..7 preferences
    const candidates = new Set();
    while (candidates.size < size) {
      candidates.add(`L${Math.floor(rand() * N)}`);
    }
    const list = [...candidates];
    prefs.set(`L${i}`, list);
    totalPrefsLength += list.length;
  }

  const { cycles, cursorAdvances } = runWithStats(listings, prefs, { assertMonotonic: true });

  assert.ok(
    cursorAdvances <= totalPrefsLength,
    `cursorAdvances (${cursorAdvances}) must not exceed Σ|prefs| (${totalPrefsLength})`,
  );

  // Sanity: every returned cycle has length >= 2 and members are disjoint across cycles.
  const seen = new Set();
  for (const cycle of cycles) {
    assert.ok(cycle.members.length >= 2);
    for (const member of cycle.members) {
      assert.ok(!seen.has(member), `listing ${member} appears in more than one cycle`);
      seen.add(member);
    }
  }
});
