import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Config, loadDotEnvInto } from './config/env.js';
import { closePool, createPool, withTransaction } from './db/pool.js';
import { runMigrations } from './db/migrations/run.js';
import { usersRepo } from './db/repositories/usersRepo.js';
import { guildsRepo } from './db/repositories/guildsRepo.js';
import { transactionsRepo } from './db/repositories/transactionsRepo.js';
import { listingsRepo } from './db/repositories/listingsRepo.js';
import { matchRepo } from './db/repositories/matchRepo.js';
import { CHANNELS } from './bus/events.js';
import * as listings from './domain/listings.js';
import * as ownership from './domain/ownership.js';
import * as queue from './domain/matching/queue.js';
import * as engine from './domain/matching/engine.js';
import * as trial from './domain/trial.js';
import * as transfer from './domain/transfer.js';

/**
 * End-to-end, contract-mandated integration test (`2-Architecture.md`
 * §Ordre d'implémentation, point 10): one full matching round for both
 * don and échange, through to the ownership-transfer witness. Requires a
 * disposable Postgres via TEST_DATABASE_URL — run via `npm run test:db`.
 *
 * The bus (`LISTEN`/`NOTIFY`) is deliberately not exercised here: intents
 * that would normally reach `bot/*` (role assignment, hub thread, handover
 * announcement) are simulated by calling the domain confirmation entry
 * points directly, since no discord.js client runs in this test. What's
 * under test is the domain/repository behavior — the bus plumbing itself
 * has no business logic of its own to verify here.
 */

let pool;
let seq = 0;
function uniqueId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function makeUser(discordIdPrefix) {
  return withTransaction(pool, (tx) =>
    usersRepo.upsertFromOAuth(tx, {
      discordId: uniqueId(discordIdPrefix),
      username: discordIdPrefix,
      avatarHash: null,
    }),
  );
}

async function makeOwnedGuild(user, namePrefix) {
  const guildId = uniqueId(namePrefix);
  await withTransaction(pool, async (tx) => {
    await guildsRepo.ensureExists(tx, { id: guildId, name: namePrefix, ownerDiscordId: user.discordId, botPresent: true });
    await guildsRepo.updatePresence(tx, guildId, { botPresent: true, botRolePosition: 5 });
    await ownership.observe(tx, { guildId, ownerDiscordId: user.discordId, source: 'oauth', observedAt: new Date() });
  });
  return guildId;
}

before(async () => {
  // `.env` is only merged into process.env lazily, on first `Config` property access (env.js's
  // Proxy) — reading process.env.TEST_DATABASE_URL any earlier than that always saw it as unset
  // (real OS env only), silently defeating the whole TEST_DATABASE_URL override and running every
  // dbtest against Config.databaseUrl (the persistent dev DB) instead of a disposable one.
  loadDotEnvInto(process.env);
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? Config.databaseUrl;
  pool = await createPool('migrate');
  await runMigrations(pool);
});

after(async () => {
  await closePool(pool);
});

test('don: queue match runs end-to-end to TRANSFERRED', async () => {
  const giver = await makeUser('giver');
  const recipient = await makeUser('recipient');
  const guildId = await makeOwnedGuild(giver, 'don-guild');

  const listing = await withTransaction(pool, (tx) =>
    listings.create(tx, giver.id, {
      guildId,
      mode: 'don',
      description: 'Communauté de test à donner, vingt caractères minimum garantis.',
      tags: ['jeux-video'],
    }),
  );

  await withTransaction(pool, (tx) => queue.enqueue(tx, listing.id, recipient.id));

  const roundResult = await engine.runRound(pool);
  assert.equal(roundResult.proposalsCreated, 1);

  const matched = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listing.id));
  assert.equal(matched.status, 'matched');

  const openProposal = await withTransaction(pool, (tx) => matchRepo.findOpenProposalsForUser(tx, giver.id));
  assert.equal(openProposal.length, 1);
  const proposalId = openProposal[0].id;

  await withTransaction(pool, (tx) => engine.accept(tx, giver.id, proposalId));
  const finalAccept = await withTransaction(pool, (tx) => engine.accept(tx, recipient.id, proposalId));
  assert.equal(finalAccept.allAccepted, true);

  const transaction = await withTransaction(pool, (tx) => transactionsRepo.findOpenByGuild(tx, guildId));
  assert.equal(transaction.status, 'ACCEPTED');
  assert.equal(transaction.fromUserId, giver.id);
  assert.equal(transaction.toUserId, recipient.id);

  await withTransaction(pool, (tx) => trial.confirmTrialStarted(tx, transaction.id, 'fake-role-id'));
  const inTrial = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, transaction.id));
  assert.equal(inTrial.status, 'TRIAL');
  assert.ok(inTrial.trialEndsAt);

  await withTransaction(pool, (tx) => trial.validate(tx, giver.id, transaction.id));
  const afterOneValidation = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, transaction.id));
  assert.equal(afterOneValidation.status, 'TRIAL');

  await withTransaction(pool, (tx) => trial.validate(tx, recipient.id, transaction.id));
  const bothValidated = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, transaction.id));
  assert.equal(bothValidated.status, 'TRIAL_VALIDATED');

  const observedAt = new Date();
  await withTransaction(pool, (tx) =>
    transfer.onOwnershipChanged(tx, {
      guildId,
      previousOwnerId: giver.discordId,
      newOwnerId: recipient.discordId,
      observedAt,
      source: 'sweep',
    }),
  );

  const transferred = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, transaction.id));
  assert.equal(transferred.status, 'TRANSFERRED');
  assert.ok(transferred.transferredAt);
});

test('echange: a manually proposed direct swap (A19) runs end-to-end to TRANSFERRED on both edges', async () => {
  const userA = await makeUser('echange-a');
  const userB = await makeUser('echange-b');
  const guildA = await makeOwnedGuild(userA, 'echange-guild-a');
  const guildB = await makeOwnedGuild(userB, 'echange-guild-b');

  const listingA = await withTransaction(pool, (tx) =>
    listings.create(tx, userA.id, {
      guildId: guildA,
      mode: 'echange',
      description: 'Communauté A cherchant une communauté de cuisine, vingt caractères.',
      tags: ['cuisine'],
      seekingTags: ['jardinage'],
    }),
  );
  const listingB = await withTransaction(pool, (tx) =>
    listings.create(tx, userB.id, {
      guildId: guildB,
      mode: 'echange',
      description: 'Communauté B cherchant une communauté de cuisine, vingt caractères.',
      tags: ['jardinage'],
      seekingTags: ['cuisine'],
    }),
  );

  // B found A's listing themselves (e.g. via /annonces?mode=echange&tags=cuisine)
  // and proposes a direct swap — no automatic discovery involved (A19).
  const { proposal, allAccepted: acceptedOnPropose } = await withTransaction(pool, (tx) =>
    engine.proposeDirectSwap(tx, userB.id, listingB.id, listingA.id),
  );
  assert.equal(acceptedOnPropose, false, 'proposing counts as the proposer\'s own acceptance, not both sides\'');

  const matchedA = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listingA.id));
  const matchedB = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listingB.id));
  assert.equal(matchedA.status, 'matched');
  assert.equal(matchedB.status, 'matched');

  const finalAccept = await withTransaction(pool, (tx) => engine.accept(tx, userA.id, proposal.id));
  assert.equal(finalAccept.allAccepted, true);

  const txA = await withTransaction(pool, (tx) => transactionsRepo.findOpenByGuild(tx, guildA));
  const txB = await withTransaction(pool, (tx) => transactionsRepo.findOpenByGuild(tx, guildB));
  assert.equal(txA.fromUserId, userA.id);
  assert.equal(txA.toUserId, userB.id);
  assert.equal(txB.fromUserId, userB.id);
  assert.equal(txB.toUserId, userA.id);

  for (const t of [txA, txB]) {
    await withTransaction(pool, (tx) => trial.confirmTrialStarted(tx, t.id, `fake-role-${t.id}`));
    await withTransaction(pool, (tx) => trial.validate(tx, t.fromUserId, t.id));
    await withTransaction(pool, (tx) => trial.validate(tx, t.toUserId, t.id));
  }

  await withTransaction(pool, (tx) =>
    transfer.onOwnershipChanged(tx, {
      guildId: guildA,
      previousOwnerId: userA.discordId,
      newOwnerId: userB.discordId,
      observedAt: new Date(),
      source: 'sweep',
    }),
  );
  await withTransaction(pool, (tx) =>
    transfer.onOwnershipChanged(tx, {
      guildId: guildB,
      previousOwnerId: userB.discordId,
      newOwnerId: userA.discordId,
      observedAt: new Date(),
      source: 'sweep',
    }),
  );

  const finalA = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, txA.id));
  const finalB = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, txB.id));
  assert.equal(finalA.status, 'TRANSFERRED');
  assert.equal(finalB.status, 'TRANSFERRED');
});

test('cancelling one edge of a direct swap cascades to the sibling edge', async () => {
  const userA = await makeUser('swap-cancel-a');
  const userB = await makeUser('swap-cancel-b');
  const guildA = await makeOwnedGuild(userA, 'swap-cancel-guild-a');
  const guildB = await makeOwnedGuild(userB, 'swap-cancel-guild-b');

  const listingA = await withTransaction(pool, (tx) =>
    listings.create(tx, userA.id, {
      guildId: guildA,
      mode: 'echange',
      description: 'Communaute A pour test d annulation en cascade, vingt.',
      tags: ['alpha'],
      seekingTags: ['beta'],
    }),
  );
  const listingB = await withTransaction(pool, (tx) =>
    listings.create(tx, userB.id, {
      guildId: guildB,
      mode: 'echange',
      description: 'Communaute B pour test d annulation en cascade, vingt.',
      tags: ['beta'],
      seekingTags: ['alpha'],
    }),
  );

  const { proposal } = await withTransaction(pool, (tx) =>
    engine.proposeDirectSwap(tx, userA.id, listingA.id, listingB.id),
  );
  await withTransaction(pool, (tx) => engine.accept(tx, userB.id, proposal.id));

  const txA = await withTransaction(pool, (tx) => transactionsRepo.findOpenByGuild(tx, guildA));
  const txB = await withTransaction(pool, (tx) => transactionsRepo.findOpenByGuild(tx, guildB));
  for (const t of [txA, txB]) {
    await withTransaction(pool, (tx) => trial.confirmTrialStarted(tx, t.id, `fake-role-${t.id}`));
  }

  // A backs out of just their own edge — the cascade fix (cf. commit c5c4a0e) must
  // still cancel B's sibling edge too, not just A's — same code path as the old
  // n-party cycle, now reachable only with exactly 2 parties (A19).
  await withTransaction(pool, (tx) => trial.cancel(tx, userA.id, txA.id, 'user_requested'));

  const cancelledA = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, txA.id));
  const cancelledB = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, txB.id));
  assert.equal(cancelledA.status, 'CANCELLED');
  assert.equal(cancelledB.status, 'CANCELLED');

  const restoredA = await withTransaction(pool, (tx) => listingsRepo.findActiveByGuild(tx, guildA));
  const restoredB = await withTransaction(pool, (tx) => listingsRepo.findActiveByGuild(tx, guildB));
  assert.ok(restoredA, 'guild A listing should be active again');
  assert.ok(restoredB, 'guild B listing should be active again');
});

test('A20: the hub thread opens at proposal time, before the other side accepts', async () => {
  const userA = await makeUser('chat-early-a');
  const userB = await makeUser('chat-early-b');
  const guildA = await makeOwnedGuild(userA, 'chat-early-guild-a');
  const guildB = await makeOwnedGuild(userB, 'chat-early-guild-b');

  const listingA = await withTransaction(pool, (tx) =>
    listings.create(tx, userA.id, {
      guildId: guildA,
      mode: 'echange',
      description: 'Communaute A pour test ouverture anticipee du chat, vingt.',
      tags: ['un'],
      seekingTags: ['deux'],
    }),
  );
  const listingB = await withTransaction(pool, (tx) =>
    listings.create(tx, userB.id, {
      guildId: guildB,
      mode: 'echange',
      description: 'Communaute B pour test ouverture anticipee du chat, vingt.',
      tags: ['deux'],
      seekingTags: ['un'],
    }),
  );

  const { proposal, allAccepted } = await withTransaction(pool, (tx) =>
    engine.proposeDirectSwap(tx, userA.id, listingA.id, listingB.id),
  );
  assert.equal(allAccepted, false, 'B has not accepted yet');

  // The whole point: the thread intent already exists, and both transactions already
  // exist in PROPOSED, well before B has said anything.
  const { rows: threadIntents } = await pool.query(
    "SELECT id FROM outbox WHERE channel = 'intent.hub.thread_create' AND payload->>'transactionId' IN (SELECT id::text FROM transactions WHERE proposal_id = $1)",
    [proposal.id],
  );
  assert.equal(threadIntents.length, 2, 'one hub thread per edge, published before acceptance');

  const transactionsForProposal = await withTransaction(pool, (tx) => transactionsRepo.findByProposalId(tx, proposal.id));
  assert.equal(transactionsForProposal.length, 2);
  for (const t of transactionsForProposal) {
    assert.equal(t.status, 'PROPOSED', 'not ACCEPTED yet — B has not responded');
  }

  await withTransaction(pool, (tx) => engine.accept(tx, userB.id, proposal.id));
  const afterAccept = await withTransaction(pool, (tx) => transactionsRepo.findByProposalId(tx, proposal.id));
  for (const t of afterAccept) {
    assert.equal(t.status, 'ACCEPTED', 'confirmAccepted promotes the pre-existing transactions, never creates new ones');
  }
  assert.equal(afterAccept.length, 2, 'still exactly the two transactions created at proposal time');
});

test('A21: a guild with a matched (unaccepted) listing cannot be given a second listing', async () => {
  const userA = await makeUser('matched-block-a');
  const userB = await makeUser('matched-block-b');
  const guildA = await makeOwnedGuild(userA, 'matched-block-guild-a');
  const guildB = await makeOwnedGuild(userB, 'matched-block-guild-b');

  const listingA = await withTransaction(pool, (tx) =>
    listings.create(tx, userA.id, {
      guildId: guildA,
      mode: 'echange',
      description: 'Communaute A pour test du blocage matched, vingt.',
      tags: ['un'],
      seekingTags: ['deux'],
    }),
  );
  const listingB = await withTransaction(pool, (tx) =>
    listings.create(tx, userB.id, {
      guildId: guildB,
      mode: 'echange',
      description: 'Communaute B pour test du blocage matched, vingt.',
      tags: ['deux'],
      seekingTags: ['un'],
    }),
  );

  // A proposes to B but B never responds — listingA sits `matched`, unaccepted, indefinitely.
  await withTransaction(pool, (tx) => engine.proposeDirectSwap(tx, userA.id, listingA.id, listingB.id));
  const matchedA = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listingA.id));
  assert.equal(matchedA.status, 'matched');

  // A tries to publish a second, unrelated listing on the same guild while the first is still matched.
  await assert.rejects(
    () =>
      withTransaction(pool, (tx) =>
        listings.create(tx, userA.id, {
          guildId: guildA,
          mode: 'don',
          description: 'Deuxieme annonce sur la meme guilde, vingt caracteres.',
          tags: ['trois'],
        }),
      ),
    (err) => err.code === 'ERR_GUILD_HAS_ACTIVE_LISTING',
  );
});

test('A25: proposeDirectSwap rejects a swap where neither listing offers what the other seeks', async () => {
  const userA = await makeUser('tag-mismatch-a');
  const userB = await makeUser('tag-mismatch-b');
  const guildA = await makeOwnedGuild(userA, 'tag-mismatch-guild-a');
  const guildB = await makeOwnedGuild(userB, 'tag-mismatch-guild-b');

  const listingA = await withTransaction(pool, (tx) =>
    listings.create(tx, userA.id, {
      guildId: guildA,
      mode: 'echange',
      description: 'Communaute A qui cherche du jardinage, vingt caracteres.',
      tags: ['cuisine'],
      seekingTags: ['jardinage'],
    }),
  );
  // B offers "musique", not "jardinage" — A has nothing to gain from this swap, and B's own
  // seekingTags ("bricolage") isn't satisfied by A's tags ("cuisine") either: no correspondence
  // in either direction, so the browse-and-propose freedom (A19) must be caught here instead.
  const listingB = await withTransaction(pool, (tx) =>
    listings.create(tx, userB.id, {
      guildId: guildB,
      mode: 'echange',
      description: 'Communaute B qui cherche du bricolage, vingt caracteres.',
      tags: ['musique'],
      seekingTags: ['bricolage'],
    }),
  );

  await assert.rejects(
    () => withTransaction(pool, (tx) => engine.proposeDirectSwap(tx, userA.id, listingA.id, listingB.id)),
    (err) => err.code === 'ERR_TAG_MISMATCH',
  );

  // Rejected before either listing is claimed — both stay `active`, free to be proposed elsewhere.
  const stillActiveA = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listingA.id));
  const stillActiveB = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listingB.id));
  assert.equal(stillActiveA.status, 'active');
  assert.equal(stillActiveB.status, 'active');
});

test('a listing published before the bot joins starts pending_bot, blocks a second attempt, then activates on guildCreate', async () => {
  const owner = await makeUser('pending-owner');
  const guildId = uniqueId('pending-guild');
  await withTransaction(pool, async (tx) => {
    await guildsRepo.ensureExists(tx, { id: guildId, name: 'pending-guild', ownerDiscordId: owner.discordId, botPresent: false });
    await ownership.observe(tx, { guildId, ownerDiscordId: owner.discordId, source: 'oauth', observedAt: new Date() });
  });

  const listing = await withTransaction(pool, (tx) =>
    listings.create(tx, owner.id, {
      guildId,
      mode: 'don',
      description: 'Communauté de test publiée avant l\'invitation du bot, vingt caractères.',
      tags: ['jeux-video'],
    }),
  );
  assert.equal(listing.status, 'pending_bot');

  await assert.rejects(
    () =>
      withTransaction(pool, (tx) =>
        listings.create(tx, owner.id, {
          guildId,
          mode: 'don',
          description: 'Deuxième tentative sur la même guilde, vingt caractères.',
          tags: ['jeux-video'],
        }),
      ),
    (err) => err.code === 'ERR_GUILD_HAS_ACTIVE_LISTING',
  );

  // Simulates bot/guildWatcher.js:onGuildCreate's activation step.
  await withTransaction(pool, async (tx) => {
    await guildsRepo.updatePresence(tx, guildId, { botPresent: true, botRolePosition: 5 });
    await listings.activatePendingForGuild(tx, guildId);
  });

  const activated = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listing.id));
  assert.equal(activated.status, 'active');
});

test('removing a listing asks the bot to leave only if it was actually there', async () => {
  const owner = await makeUser('remove-owner');

  const guildWithBot = await makeOwnedGuild(owner, 'remove-guild-bot');
  const activeListing = await withTransaction(pool, (tx) =>
    listings.create(tx, owner.id, {
      guildId: guildWithBot,
      mode: 'don',
      description: 'Communauté de test à retirer, vingt caractères minimum garantis.',
      tags: ['jeux-video'],
    }),
  );
  assert.equal(activeListing.status, 'active');
  await withTransaction(pool, (tx) => listings.remove(tx, owner.id, activeListing.id));
  const { rows: leaveIntents } = await pool.query(
    "SELECT id FROM outbox WHERE channel = $1 AND payload->>'guildId' = $2",
    [CHANNELS.INTENT_GUILD_LEAVE, guildWithBot],
  );
  assert.equal(leaveIntents.length, 1, 'removing an annonce whose guild has the bot should ask it to leave');

  const guildWithoutBot = uniqueId('remove-guild-nobot');
  await withTransaction(pool, async (tx) => {
    await guildsRepo.ensureExists(tx, {
      id: guildWithoutBot,
      name: 'remove-guild-nobot',
      ownerDiscordId: owner.discordId,
      botPresent: false,
    });
    await ownership.observe(tx, { guildId: guildWithoutBot, ownerDiscordId: owner.discordId, source: 'oauth', observedAt: new Date() });
  });
  const pendingListing = await withTransaction(pool, (tx) =>
    listings.create(tx, owner.id, {
      guildId: guildWithoutBot,
      mode: 'don',
      description: 'Deuxième communauté de test, jamais rejointe par le bot.',
      tags: ['jeux-video'],
    }),
  );
  assert.equal(pendingListing.status, 'pending_bot');
  await withTransaction(pool, (tx) => listings.remove(tx, owner.id, pendingListing.id));
  const { rows: noLeaveIntents } = await pool.query(
    "SELECT id FROM outbox WHERE channel = $1 AND payload->>'guildId' = $2",
    [CHANNELS.INTENT_GUILD_LEAVE, guildWithoutBot],
  );
  assert.equal(noLeaveIntents.length, 0, 'a listing removed while pending_bot never had the bot to begin with');
});

test('removing a listing with no history deletes the row outright', async () => {
  const owner = await makeUser('harddelete-owner');
  const guildId = await makeOwnedGuild(owner, 'harddelete-guild');

  const listing = await withTransaction(pool, (tx) =>
    listings.create(tx, owner.id, {
      guildId,
      mode: 'don',
      description: 'Communaute de test jamais rejointe par un candidat, aucun historique.',
      tags: ['jeux-video'],
    }),
  );

  const result = await withTransaction(pool, (tx) => listings.remove(tx, owner.id, listing.id));
  assert.equal(result.status, 'removed');

  const stillThere = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listing.id));
  assert.equal(stillThere, null, 'the row should be physically gone, not just soft-deleted');
});

test('removing a listing that a candidate ever queued on still deletes the row, orphaning the queue history', async () => {
  const owner = await makeUser('harddelete-queue-owner');
  const candidate = await makeUser('harddelete-queue-candidate');
  const guildId = await makeOwnedGuild(owner, 'harddelete-queue-guild');

  const listing = await withTransaction(pool, (tx) =>
    listings.create(tx, owner.id, {
      guildId,
      mode: 'don',
      description: 'Communaute de test rejointe puis quittee par un candidat.',
      tags: ['jeux-video'],
    }),
  );
  await withTransaction(pool, (tx) => queue.enqueue(tx, listing.id, candidate.id));
  await withTransaction(pool, (tx) => queue.withdraw(tx, listing.id, candidate.id));
  const { rows: beforeRows } = await pool.query(
    'SELECT id FROM listing_queue WHERE listing_id = $1 AND candidate_user_id = $2',
    [listing.id, candidate.id],
  );
  assert.equal(beforeRows.length, 1, 'the queue history row should exist before removal');

  const result = await withTransaction(pool, (tx) => listings.remove(tx, owner.id, listing.id));
  assert.equal(result.status, 'removed');

  const stillThere = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listing.id));
  assert.equal(stillThere, null, 'listing_queue no longer blocks physical deletion (005: ON DELETE SET NULL)');

  const { rows: afterRows } = await pool.query('SELECT listing_id FROM listing_queue WHERE id = $1', [beforeRows[0].id]);
  assert.equal(afterRows.length, 1, 'the queue history row itself is kept, not cascaded away');
  assert.equal(afterRows[0].listing_id, null, 'only the now-dangling reference to the deleted listing is cleared');

  const { rows: removedAudit } = await pool.query(
    "SELECT id FROM audit_log WHERE target_id = $1 AND action = 'listing.removed'",
    [listing.id],
  );
  assert.equal(removedAudit.length, 1);
});

/** Minimal FK-satisfying `match_proposals` row — no listings/participants needed for A34's repo-level tests below. */
async function makeBareProposal() {
  const { rows } = await pool.query(
    "INSERT INTO match_proposals (kind, expires_at, status) VALUES ('queue', now() + interval '1 day', 'accepted') RETURNING id",
  );
  return rows[0].id;
}

test('A34: findAcceptedAwaitingTrial only returns ACCEPTED transactions whose trial has not started', async () => {
  const giver = await makeUser('a34-accepted-giver');
  const receiver = await makeUser('a34-accepted-receiver');
  const proposalId = await makeBareProposal();

  // Two separate guilds — `uniq_transactions_open_guild` allows only one non-terminal
  // transaction per guild, and both of these are still open (ACCEPTED/TRIAL).
  const guildA = await makeOwnedGuild(giver, 'a34-accepted-guild-a');
  const guildB = await makeOwnedGuild(giver, 'a34-accepted-guild-b');

  const waitingOnInvite = await withTransaction(pool, (tx) =>
    transactionsRepo.insert(tx, { proposalId, fromUserId: giver.id, toUserId: receiver.id, guildId: guildA, status: 'ACCEPTED' }),
  );
  // A sibling that already started its trial clock must not show up as "awaiting".
  const alreadyTrialing = await withTransaction(pool, (tx) =>
    transactionsRepo.insert(tx, { proposalId, fromUserId: giver.id, toUserId: receiver.id, guildId: guildB, status: 'ACCEPTED' }),
  );
  await withTransaction(pool, (tx) =>
    transactionsRepo.setTrialWindow(tx, alreadyTrialing.id, {
      trialStartedAt: new Date(),
      trialEndsAt: new Date(Date.now() + 3 * 86_400_000),
      trialRoleId: 'fake-role-id',
    }),
  );

  const awaiting = await withTransaction(pool, (tx) => transactionsRepo.findAcceptedAwaitingTrial(tx));
  const awaitingIds = awaiting.map((t) => t.id);
  assert.ok(awaitingIds.includes(waitingOnInvite.id), 'still-ACCEPTED, trial not started -> awaiting');
  assert.ok(!awaitingIds.includes(alreadyTrialing.id), 'trial already started -> no longer awaiting');
});

test('A34: findTrialsEndingSoon respects the cutoff and the reminder-already-sent guard', async () => {
  const giver = await makeUser('a34-reminder-giver');
  const receiver = await makeUser('a34-reminder-receiver');
  const proposalId = await makeBareProposal();

  // One guild per trial — same `uniq_transactions_open_guild` reason as the test above.
  async function makeTrial(hoursUntilEnd) {
    const guildId = await makeOwnedGuild(giver, 'a34-reminder-guild');
    const t = await withTransaction(pool, (tx) =>
      transactionsRepo.insert(tx, { proposalId, fromUserId: giver.id, toUserId: receiver.id, guildId, status: 'ACCEPTED' }),
    );
    await withTransaction(pool, (tx) =>
      transactionsRepo.setTrialWindow(tx, t.id, {
        trialStartedAt: new Date(),
        trialEndsAt: new Date(Date.now() + hoursUntilEnd * 3_600_000),
        trialRoleId: 'fake-role-id',
      }),
    );
    await pool.query("UPDATE transactions SET status = 'TRIAL' WHERE id = $1", [t.id]);
    return t.id;
  }

  const endingSoon = await makeTrial(12); // within the 24h window
  const endingLater = await makeTrial(48); // outside it
  const alreadyReminded = await makeTrial(6);
  await withTransaction(pool, (tx) => transactionsRepo.setTrialReminderSent(tx, alreadyReminded, new Date()));

  const cutoff = new Date(Date.now() + 24 * 3_600_000);
  const dueSoon = await withTransaction(pool, (tx) => transactionsRepo.findTrialsEndingSoon(tx, cutoff));
  const dueSoonIds = dueSoon.map((t) => t.id);

  assert.ok(dueSoonIds.includes(endingSoon), 'ends within the window, never reminded -> due');
  assert.ok(!dueSoonIds.includes(endingLater), 'ends outside the window -> not due yet');
  assert.ok(!dueSoonIds.includes(alreadyReminded), 'already reminded -> not returned again');
});
