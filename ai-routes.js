// AI features, served through the Roar gateway.
// The key never reaches the browser: the page calls these endpoints, the
// server calls Roar. That also means usage is capped by the key's budget.

import { Router } from 'express';
import { q } from './db.js';
import { requireAuth } from './auth.js';

export const ai = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = process.env.ROAR_MODEL || 'claude-haiku-5-5';

let client = null;
/** Loaded lazily so the app still boots and serves the CRM with no AI key set. */
async function getClient() {
  if (client) return client;
  if (!process.env.ROAR_API_KEY) return null;
  const { roar } = await import('./ai.js');
  client = roar;
  return client;
}

const unavailable = res =>
  res.status(503).json({ error: 'AI features are not configured — set ROAR_API_KEY on the app' });

async function loadLead(id, workspaceId) {
  if (!UUID.test(id)) return null;
  const { rows } = await q('select * from leads where id=$1 and workspace_id=$2', [id, workspaceId]);
  return rows[0] || null;
}

function leadSummary(l, settings) {
  const cur = settings?.currency || 'USD';
  return [
    `Name: ${l.name}`,
    `Company: ${l.company || '—'}`,
    `Email: ${l.email || '—'}`,
    `Phone: ${l.phone || '—'}`,
    `Deal value: ${cur} ${Number(l.value) || 0}`,
    `Current stage: ${l.stage}`,
    `Source: ${l.source || '—'}`,
    `Owner: ${l.assignee || 'Unassigned'}`,
    `Notes: ${l.notes || '—'}`
  ].join('\n');
}

/* ---------------- score a lead 0-100 ---------------- */
ai.post('/score/:id', requireAuth, async (req, res, next) => {
  try {
    const roar = await getClient();
    if (!roar) return unavailable(res);

    const lead = await loadLead(req.params.id, req.user.workspace_id);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    const ws = await q('select settings from workspaces where id=$1', [req.user.workspace_id]);

    const completion = await roar.chat.completions.create({
      model: MODEL,
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content:
            'You score sales leads for a marketing agency CRM. Reply with JSON only, ' +
            'exactly {"score": <integer 0-100>, "reason": "<one sentence>"}. ' +
            'Higher means more likely to close soon. Judge on deal size, stage, ' +
            'source quality and what the notes reveal about intent. ' +
            'Be sceptical: thin information means a middling score, not a high one.'
        },
        { role: 'user', content: leadSummary(lead, ws.rows[0]?.settings) }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '';
    let score = null, reason = '';
    try {
      const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
      score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
      reason = String(parsed.reason || '').slice(0, 400);
    } catch {
      return res.status(502).json({ error: 'the model did not return usable JSON', raw: raw.slice(0, 200) });
    }
    if (!Number.isFinite(score)) return res.status(502).json({ error: 'the model returned no score' });

    await q('update leads set ai_score=$1, ai_reason=$2 where id=$3 and workspace_id=$4',
      [score, reason, lead.id, req.user.workspace_id]);

    res.json({ id: lead.id, score, reason, model: completion.model || MODEL, usage: completion.usage });
  } catch (err) { next(err); }
});

/* ---------------- score every open lead ---------------- */
ai.post('/score-all', requireAuth, async (req, res, next) => {
  try {
    const roar = await getClient();
    if (!roar) return unavailable(res);

    const { rows } = await q(
      `select * from leads
        where workspace_id=$1 and ai_score is null
          and stage !~* 'won|lost|disqualif'
        order by value desc limit 25`,
      [req.user.workspace_id]
    );
    if (!rows.length) return res.json({ scored: 0, note: 'nothing left to score' });

    const ws = await q('select settings from workspaces where id=$1', [req.user.workspace_id]);
    const settings = ws.rows[0]?.settings;
    let scored = 0;
    const failures = [];

    // Sequential on purpose: a burst of parallel calls trips rate limits and
    // makes the spend cap harder to reason about.
    for (const lead of rows) {
      try {
        const c = await roar.chat.completions.create({
          model: MODEL,
          max_tokens: 300,
          messages: [
            { role: 'system', content: 'Score this sales lead. JSON only: {"score": <0-100 integer>, "reason": "<one sentence>"}.' },
            { role: 'user', content: leadSummary(lead, settings) }
          ]
        });
        const parsed = JSON.parse((c.choices?.[0]?.message?.content || '').replace(/^```(?:json)?|```$/g, '').trim());
        const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
        if (!Number.isFinite(score)) throw new Error('no score');
        await q('update leads set ai_score=$1, ai_reason=$2 where id=$3 and workspace_id=$4',
          [score, String(parsed.reason || '').slice(0, 400), lead.id, req.user.workspace_id]);
        scored++;
      } catch (err) {
        failures.push({ id: lead.id, name: lead.name, why: err.message });
      }
    }
    res.json({ scored, attempted: rows.length, failures });
  } catch (err) { next(err); }
});

/* ---------------- draft a follow-up email ---------------- */
ai.post('/draft/:id', requireAuth, async (req, res, next) => {
  try {
    const roar = await getClient();
    if (!roar) return unavailable(res);

    const lead = await loadLead(req.params.id, req.user.workspace_id);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    const ws = await q('select settings from workspaces where id=$1', [req.user.workspace_id]);
    const settings = ws.rows[0]?.settings || {};
    const tone = String(req.body?.tone || 'warm but professional').slice(0, 60);

    const completion = await roar.chat.completions.create({
      model: MODEL,
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content:
            `You draft follow-up emails for ${settings.crmName || 'our agency'}. ` +
            `Tone: ${tone}. Keep it under 150 words, specific to what the notes say, ` +
            'and end with one clear next step. Reply with JSON only: ' +
            '{"subject": "...", "body": "..."}. Never invent facts that are not in the lead details; ' +
            'if something is unknown, leave a [bracketed placeholder] for a person to fill in.'
        },
        { role: 'user', content: leadSummary(lead, settings) }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '';
    try {
      const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
      res.json({
        subject: String(parsed.subject || '').slice(0, 300),
        body: String(parsed.body || '').slice(0, 5000),
        model: completion.model || MODEL,
        usage: completion.usage
      });
    } catch {
      // Still useful to the person even when the JSON wrapper is malformed.
      res.json({ subject: '', body: raw.slice(0, 5000), model: completion.model || MODEL, unparsed: true });
    }
  } catch (err) { next(err); }
});

/* ---------------- is AI available? ---------------- */
ai.get('/status', requireAuth, async (_req, res) => {
  res.json({ available: !!process.env.ROAR_API_KEY, model: MODEL });
});
