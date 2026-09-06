import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from './env.js';

// 44-char base64 string that decodes to exactly 32 bytes, and is also
// >= 32 characters, so it independently satisfies both SESSION_SECRET's
// and TOKEN_ENC_KEY's format rules.
const KEY_MATERIAL = Buffer.alloc(32, 7).toString('base64');

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/xyro',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: 'client-secret',
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_HUB_GUILD_ID: '123456789012345678',
  SESSION_SECRET: 'a'.repeat(32),
  TOKEN_ENC_KEY: KEY_MATERIAL,
  PUBLIC_BASE_URL: 'https://xyro.market/',
  NODE_ENV: 'production',
  WEB_PORT: '3000',
  LOG_LEVEL: 'info',
};

test('parseConfig accepts a valid environment, normalizes and freezes it', () => {
  const config = parseConfig(validEnv);
  assert.equal(config.publicBaseUrl, 'https://xyro.market');
  assert.equal(config.webPort, 3000);
  assert.throws(() => {
    config.webPort = 9999;
  });
});

test('boot fails (ENV_SECRET_REUSE) when SESSION_SECRET === TOKEN_ENC_KEY', () => {
  const env = { ...validEnv, SESSION_SECRET: KEY_MATERIAL, TOKEN_ENC_KEY: KEY_MATERIAL };
  assert.throws(
    () => parseConfig(env),
    (err) => err instanceof ConfigError && err.code === 'ENV_SECRET_REUSE',
  );
});

test('ENV_MISSING lists every missing key at once, not just the first', () => {
  const err = assert.throws(() => parseConfig({}), ConfigError);
  assert.equal(err.code, 'ENV_MISSING');
  for (const key of [
    'DATABASE_URL',
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'DISCORD_BOT_TOKEN',
    'DISCORD_HUB_GUILD_ID',
    'SESSION_SECRET',
    'TOKEN_ENC_KEY',
    'PUBLIC_BASE_URL',
  ]) {
    assert.ok(err.message.includes(key), `expected ENV_MISSING message to mention ${key}`);
  }
});

test('ENV_INVALID rejects a non-https PUBLIC_BASE_URL without leaking secret values', () => {
  const env = { ...validEnv, PUBLIC_BASE_URL: 'http://xyro.market' };
  const err = assert.throws(() => parseConfig(env), ConfigError);
  assert.equal(err.code, 'ENV_INVALID');
  assert.ok(err.message.includes('PUBLIC_BASE_URL'));
  assert.ok(!err.message.includes(validEnv.SESSION_SECRET));
  assert.ok(!err.message.includes(validEnv.DISCORD_BOT_TOKEN));
});

test('ENV_INVALID rejects a TOKEN_ENC_KEY that is not exactly 32 bytes', () => {
  const env = { ...validEnv, TOKEN_ENC_KEY: Buffer.alloc(16, 1).toString('base64') };
  const err = assert.throws(() => parseConfig(env), ConfigError);
  assert.equal(err.code, 'ENV_INVALID');
});
