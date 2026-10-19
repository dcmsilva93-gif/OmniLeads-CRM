import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. On Roar this is injected when the app has a database.');
}

// Managed Postgres providers terminate TLS with their own CA; in production
// we still want TLS, just without demanding a locally-trusted chain.
const needsSsl = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', err => console.error('[db] idle client error:', err.message));

export const q = (text, params) => pool.query(text, params);

/** Apply schema.sql. Every statement is idempotent, so this runs on each boot. */
export async function migrate() {
  const sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] schema applied');
}

/** Wait for Postgres to accept connections — it may still be waking up. */
export async function waitForDb(attempts = 12) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      const wait = Math.min(1000 * i, 5000);
      console.log(`[db] not ready (${err.code || err.message}); retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

/** Drop expired sessions. Cheap; called on an interval. */
export async function pruneSessions() {
  const { rowCount } = await q('delete from sessions where expires_at < now()');
  if (rowCount) console.log(`[db] pruned ${rowCount} expired session(s)`);
}
