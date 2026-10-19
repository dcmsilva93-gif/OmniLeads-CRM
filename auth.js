import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './db.js';

const scrypt = promisify(_scrypt);
const KEYLEN = 64;
const SESSION_DAYS = 30;
const COOKIE = 'omni_session';

/* ---------------- passwords ---------------- */
// scrypt ships with Node, so there is no native module to compile at build time.
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hex) return false;
    const key = await scrypt(password, salt, KEYLEN);
    const expected = Buffer.from(hex, 'hex');
    // Lengths must match before timingSafeEqual, which throws otherwise.
    if (expected.length !== key.length) return false;
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/* ---------------- sessions ---------------- */
export async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await q('insert into sessions (token, user_id, expires_at) values ($1,$2,$3)', [token, userId, expires]);
  return { token, expires };
}

export async function destroySession(token) {
  if (token) await q('delete from sessions where token = $1', [token]);
}

function cookieOptions(req) {
  // Secure cookies require HTTPS. Roar terminates TLS at its proxy and
  // forwards x-forwarded-proto, so trust that; allow plain http locally.
  const https = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: https,
    path: '/',
    maxAge: SESSION_DAYS * 86400_000
  };
}

export function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, cookieOptions(req));
}
export function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE, { ...cookieOptions(req), maxAge: undefined });
}
export const sessionCookieName = COOKIE;

/* ---------------- middleware ---------------- */
/**
 * Resolves the session cookie to a user + workspace and hangs it on req.
 * Every data route depends on this; nothing reads a workspace id from
 * the client, which is what keeps one tenant out of another's rows.
 */
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return res.status(401).json({ error: 'not signed in' });

    const { rows } = await q(
      `select u.id, u.email, u.workspace_id, u.role
         from sessions s
         join users u on u.id = s.user_id
        where s.token = $1 and s.expires_at > now()`,
      [token]
    );
    if (!rows.length) {
      clearSessionCookie(req, res);
      return res.status(401).json({ error: 'session expired' });
    }
    req.user = rows[0];
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

/* ---------------- signup ---------------- */
const DEFAULT_STAGES = ['New', 'Contacted', 'Qualified', 'Proposal Sent', 'Won', 'Lost'];

/**
 * Creates a user. With no joinWorkspace it provisions a fresh workspace,
 * default settings and three starter connectors, all in one transaction so
 * a failure can't leave a user without a workspace.
 */
export async function signupUser({ email, password, company, joinWorkspace }) {
  const client = await (await import('./db.js')).pool.connect();
  try {
    await client.query('begin');

    const dupe = await client.query('select 1 from users where lower(email) = lower($1)', [email]);
    if (dupe.rowCount) {
      const e = new Error('An account with that email already exists');
      e.status = 409;
      throw e;
    }

    let workspaceId;
    let role = 'member';

    if (joinWorkspace) {
      const ws = await client.query('select id from workspaces where id = $1', [joinWorkspace]);
      if (!ws.rowCount) {
        const e = new Error('That workspace ID does not exist');
        e.status = 404;
        throw e;
      }
      workspaceId = joinWorkspace;
    } else {
      const who = email.split('@')[0];
      const name = (company || '').trim() || 'OmniLeads';
      const ws = await client.query(
        'insert into workspaces (name, settings) values ($1, $2) returning id',
        [name, {
          crmName: name,
          currency: 'USD',
          stages: DEFAULT_STAGES,
          salesReps: [who],
          pipelineView: 'kanban',
          sort: { key: 'value', dir: 'desc' },
          theme: 'light',
          form: {
            title: 'Lead Capture Form',
            fields: ['Full Name', 'Email Address', 'Company'],
            source: 'QR Code Campaign',
            assignee: who
          }
        }]
      );
      workspaceId = ws.rows[0].id;
      role = 'owner';

      await client.query(
        `insert into integrations (workspace_id, name, system, descr, method, source_tag, default_stage, active)
         values
          ($1,'Google Ads','Google Ads','Lead form extensions','Webhook','Google Ads','New',false),
          ($1,'Meta (Facebook & Instagram)','Meta Lead Ads','Instant lead ads','Webhook','Meta Ads','New',false),
          ($1,'TikTok Lead Gen','TikTok Lead Gen','Instant forms','Webhook','TikTok Ads','New',false)`,
        [workspaceId]
      );
    }

    const hash = await hashPassword(password);
    const user = await client.query(
      'insert into users (email, password_hash, workspace_id, role) values ($1,$2,$3,$4) returning id, email, workspace_id, role',
      [email, hash, workspaceId, role]
    );

    await client.query('commit');
    return user.rows[0];
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
