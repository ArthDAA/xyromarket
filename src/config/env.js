import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Typed, frozen error raised when the environment contract is violated.
 * Never carries a raw secret value, only key names and validation reasons.
 */
export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

const REQUIRED_KEYS = [
  'DATABASE_URL',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_HUB_GUILD_ID',
  'SESSION_SECRET',
  'TOKEN_ENC_KEY',
  'PUBLIC_BASE_URL',
];

const SNOWFLAKE_RE = /^\d{17,20}$/;

function isBase64Of32Bytes(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

const schema = z.object({
  DATABASE_URL: z
    .string()
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'must be a postgres:// or postgresql:// connection URI',
    }),
  DISCORD_CLIENT_ID: z.string().regex(SNOWFLAKE_RE, 'must be a Discord snowflake'),
  DISCORD_CLIENT_SECRET: z.string().min(1, 'must not be empty'),
  DISCORD_BOT_TOKEN: z.string().min(1, 'must not be empty'),
  DISCORD_HUB_GUILD_ID: z.string().regex(SNOWFLAKE_RE, 'must be a Discord snowflake'),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  TOKEN_ENC_KEY: z
    .string()
    .refine(isBase64Of32Bytes, { message: 'must be base64-encoded and decode to exactly 32 bytes' }),
  PUBLIC_BASE_URL: z
    .string()
    .url('must be a valid URL')
    .refine((v) => v.startsWith('https://'), { message: 'must use https' }),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  WEB_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

/**
 * Merges `.env` into `process.env` without overriding variables already set
 * (real environment wins over the file). No-op if the file does not exist.
 */
export function loadDotEnvInto(target, path = '.env') {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in target)) target[key] = value;
  }
}

/**
 * Validates a raw environment object against the Xyro Market contract and
 * returns a frozen, camelCase Config. Pure function: no process.exit, no
 * filesystem access — callers decide how to react to a thrown ConfigError.
 */
export function parseConfig(env) {
  const missing = REQUIRED_KEYS.filter((key) => env[key] === undefined || env[key] === '');
  if (missing.length > 0) {
    throw new ConfigError(
      'ENV_MISSING',
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError('ENV_INVALID', `Invalid environment variables:\n${issues.join('\n')}`);
  }

  const data = result.data;

  // Two independent cryptographic roots by design: session signing must
  // never share key material with OAuth token encryption at rest.
  if (data.SESSION_SECRET === data.TOKEN_ENC_KEY) {
    throw new ConfigError(
      'ENV_SECRET_REUSE',
      'SESSION_SECRET and TOKEN_ENC_KEY must be independent values, never equal',
    );
  }

  return Object.freeze({
    databaseUrl: data.DATABASE_URL,
    discordClientId: data.DISCORD_CLIENT_ID,
    discordClientSecret: data.DISCORD_CLIENT_SECRET,
    discordBotToken: data.DISCORD_BOT_TOKEN,
    discordHubGuildId: data.DISCORD_HUB_GUILD_ID,
    sessionSecret: data.SESSION_SECRET,
    tokenEncKey: data.TOKEN_ENC_KEY,
    publicBaseUrl: data.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    nodeEnv: data.NODE_ENV,
    webPort: data.WEB_PORT,
    logLevel: data.LOG_LEVEL,
  });
}

/**
 * Loads and validates the process environment, exiting the process on
 * failure. This is the only place in the codebase allowed to read
 * `process.env` or call `process.exit` for configuration reasons.
 */
function boot() {
  if (process.env.NODE_ENV !== 'production') {
    loadDotEnvInto(process.env);
  }
  try {
    return parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[FATAL] ${err.code}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

let cachedConfig = null;

/**
 * `Config` is a lazy singleton: `boot()` only runs the first time a
 * property is actually read, not at import time. This keeps importing
 * `parseConfig`/`ConfigError` for testing side-effect-free, while every
 * real code path (which always reads at least one field before doing
 * anything) still gets the fail-fast boot behavior on its first touch.
 */
export const Config = new Proxy(
  {},
  {
    get(_target, prop) {
      if (!cachedConfig) cachedConfig = boot();
      return cachedConfig[prop];
    },
  },
);
