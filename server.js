import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { migrate, waitForDb, pruneSessions } from './db.js';
import { api } from './api.js';
import { hook } from './webhook.js';
import { ai } from './ai-routes.js';
import { sseHandler, startListener } from './events.js';
import { requireAuth } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Roar terminates TLS upstream; trust its forwarding headers so that
// secure cookies and req.ip behave correctly.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '20mb' }));                          // CSV imports can be chunky
app.use(express.urlencoded({ extended: true, limit: '2mb' }));     // form-encoded webhooks
app.use(cookieParser());

// Liveness: Roar needs an HTTP answer within 90s of start. This is
// registered before anything that touches the database on purpose.
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

app.use('/api/ai', ai);
app.use('/api', api);
app.get('/api/events', requireAuth, sseHandler);   // after /api so auth is in place
app.use('/hook', hook);                            // public: authenticated by its own token

app.use(express.static(join(__dirname, 'public'), {
  setHeaders(res, path) {
    // The app is one HTML file; never let a stale copy stick around.
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Anything else is the single-page app.
const INDEX = join(__dirname, 'public', 'index.html');

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/hook')) return next();
  // Without this the deploy looks healthy while every request throws ENOENT,
  // which says nothing about the actual cause.
  if (!existsSync(INDEX)) {
    return res.status(500).type('text/plain').send(
      'public/index.html is missing from this deployment, so there is no page to serve.\n' +
      'The server and database are fine. Check that the public/ folder was committed.\n'
    );
  }
  res.sendFile(INDEX);
});

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Last line of defence: log the detail, tell the client nothing useful to an attacker.
app.use((err, _req, res, _next) => {
  console.error('[error]', err.stack || err.message);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: 'something went wrong on the server' });
});

async function main() {
  // Listen first so the platform's health check always has something to talk to,
  // even if the database is slow to come up.
  const server = app.listen(PORT, '0.0.0.0', () =>
    console.log(`[http] listening on 0.0.0.0:${PORT}`)
  );

  // Say this once, at boot, rather than once per request forever.
  if (!existsSync(INDEX)) {
    console.error('[boot] NOT SERVABLE: public/index.html is missing — the front end was not deployed.');
    console.error('[boot] The API and webhooks still work; every page request will return 500 until it is committed.');
  }

  try {
    await waitForDb();
    await migrate();
    await startListener();
    setInterval(() => pruneSessions().catch(() => {}), 6 * 3600_000).unref();
    console.log('[boot] ready');
  } catch (err) {
    console.error('[boot] database setup failed:', err.message);
    // Stay up and keep serving /healthz; a crash loop would be harder to debug.
  }

  const shutdown = sig => () => {
    console.log(`[http] ${sig} received, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

main();
