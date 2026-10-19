// Live updates over Server-Sent Events.
//
// The browser holds one SSE connection. Postgres LISTEN/NOTIFY is the fan-out,
// so a lead created by a webhook, a teammate, or another app instance reaches
// every connected browser — an in-process event bus would only reach clients
// attached to the same instance.

import pg from 'pg';
import { q } from './db.js';

const clients = new Set();   // { workspaceId, res }
let listener = null;

export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'   // stop any reverse proxy buffering the stream
  });
  res.write('retry: 3000\n\n');

  const client = { workspaceId: req.user.workspace_id, res };
  clients.add(client);

  // Comment frames keep idle connections from being reaped by proxies.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closing */ }
  }, 25_000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

function broadcast(workspaceId, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.workspaceId !== workspaceId) continue;
    try { c.res.write(frame); } catch { clients.delete(c); }
  }
}

/**
 * Dedicated connection for LISTEN — a pooled client would be handed back
 * and stop listening. Reconnects on its own if the connection drops.
 */
export async function startListener() {
  if (!process.env.DATABASE_URL) return;
  const needsSsl = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

  const connect = async () => {
    listener = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      ssl: needsSsl ? { rejectUnauthorized: false } : false
    });

    listener.on('notification', async msg => {
      if (msg.channel !== 'lead_change') return;
      try {
        const { op, workspace_id, id } = JSON.parse(msg.payload);
        if (op === 'DELETE') return broadcast(workspace_id, 'lead_delete', { id });
        const { rows } = await q('select * from leads where id = $1', [id]);
        if (!rows.length) return;
        const r = rows[0];
        broadcast(workspace_id, op === 'INSERT' ? 'lead_insert' : 'lead_update', {
          id: r.id, name: r.name, company: r.company, email: r.email, phone: r.phone,
          value: Number(r.value) || 0, stage: r.stage, source: r.source,
          assignee: r.assignee, notes: r.notes,
          aiScore: r.ai_score == null ? null : Number(r.ai_score),
          aiReason: r.ai_reason || null,
          createdAt: new Date(r.created_at).getTime()
        });
      } catch (err) {
        console.error('[events] notification handling failed:', err.message);
      }
    });

    listener.on('error', err => {
      console.error('[events] listener error, reconnecting:', err.message);
      try { listener.end(); } catch {}
      setTimeout(connect, 2000);
    });

    await listener.connect();
    await listener.query('listen lead_change');
    console.log('[events] listening for lead changes');
  };

  try {
    await connect();
  } catch (err) {
    console.error('[events] could not start listener, retrying:', err.message);
    setTimeout(() => startListener(), 3000);
  }
}

export const connectedCount = () => clients.size;
