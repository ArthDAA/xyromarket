import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { Config } from '../config/env.js';
import { createPool, closePool } from '../db/pool.js';
import { hasPendingMigrations } from '../db/migrations/run.js';
import publicRoutes from './routes/public.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';
import { refreshHubInviteUrl } from './hubInvite.js';

async function main() {
  const pool = await createPool('web');

  if (await hasPendingMigrations(pool)) {
    console.error('[FATAL] pending migrations found — run `npm run migrate` before starting web');
    await closePool(pool);
    process.exit(1);
  }

  const app = Fastify({
    trustProxy: true,
    logger: {
      level: Config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', '*.accessTokenEnc', '*.refreshTokenEnc'],
    },
    genReqId: () => randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"], // no unsafe-inline — this app never emits an inline <script>
        styleSrc: ["'self'"],
        // 'data:' is scoped to img-src only (never script-src) — needed for the flat-color
        // banner fallback (A36, `render.js:solidColorImgHtml`), a same-origin-computed SVG,
        // not third-party content; still no inline <script>/<style> anywhere in this app.
        imgSrc: ["'self'", 'https://cdn.discordapp.com', 'data:'],
        objectSrc: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(cookie, { secret: Config.sessionSecret, parseOptions: {} });
  await app.register(formbody); // plain <form> submissions (no inline JS needed, CSP stays unsafe-inline-free)
  await app.register(fastifyStatic, {
    root: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'),
    prefix: '/static/',
    cacheControl: true,
    maxAge: '30d',
    immutable: true,
  });

  await app.register(publicRoutes, { pool });
  // Admin routes are mounted after session/RBAC middleware exists (session.js is already
  // imported by the time these plugins register their own per-route preHandlers).
  await app.register(userRoutes, { pool });
  await app.register(adminRoutes, { pool });

  // Primes the header's "Rejoindre le Discord" button (render.js:layout) before the first
  // request, then keeps it fresh on a slow interval — see hubInvite.js for why this can't
  // just be an ordinary per-request DB read.
  await refreshHubInviteUrl(pool);
  const hubInviteRefreshTimer = setInterval(() => {
    refreshHubInviteUrl(pool).catch((err) => app.log.warn({ err }, 'hub invite URL refresh failed'));
  }, 10 * 60 * 1000);
  hubInviteRefreshTimer.unref();

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'NOT_FOUND' });
  });

  app.setErrorHandler((err, req, reply) => {
    const correlationId = req.id;
    req.log.error({ err, correlationId }, 'unhandled route error');
    if (reply.statusCode < 400) reply.code(500);
    reply.send({ error: 'ERR_UNEXPECTED', correlationId });
  });

  try {
    await app.listen({ port: Config.webPort, host: '0.0.0.0' });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      app.log.fatal({ err }, 'ERR_PORT_IN_USE');
    } else {
      app.log.fatal({ err }, 'ERR_UNCAUGHT');
    }
    await closePool(pool);
    process.exit(1);
  }

  const shutdown = async () => {
    app.log.info('shutting down');
    await app.close();
    await closePool(pool);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[FATAL] web process failed to start', err);
  process.exit(1);
});
