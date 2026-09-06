import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from './config/env.js';
import { closePool, createPool, withTransaction } from './db/pool.js';
import { runMigrations } from './db/migrations/run.js';
import { usersRepo } from './db/repositories/usersRepo.js';
import { guildsRepo } from './db/repositories/guildsRepo.js';
import { transactionsRepo } from './db/repositories/transactionsRepo.js';
import { listingsRepo } from './db/repositories/listingsRepo.js';
import { matchRepo } from './db/repositories/matchRepo.js';
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

test('echange: a mutual 2-cycle runs end-to-end to TRANSFERRED on both edges', async () => {
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

  const roundResult = await engine.runRound(pool);
  assert.equal(roundResult.cyclesFound, 1);
  assert.equal(roundResult.proposalsCreated, 1);

  const matchedA = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listingA.id));
  const matchedB = await withTransaction(pool, (tx) => listingsRepo.findById(tx, listingB.id));
  assert.equal(matchedA.status, 'matched');
  assert.equal(matchedB.status, 'matched');

  const [proposal] = await withTransaction(pool, (tx) => matchRepo.findOpenProposalsForUser(tx, userA.id));
  assert.ok(proposal);

  await withTransaction(pool, (tx) => engine.accept(tx, userA.id, proposal.id));
  const finalAccept = await withTransaction(pool, (tx) => engine.accept(tx, userB.id, proposal.id));
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
