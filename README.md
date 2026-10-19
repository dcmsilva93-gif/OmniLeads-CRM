# OmniLeads CRM — on Roar AI

A marketing CRM with a shared team pipeline, live-updating across devices, real ad-platform lead webhooks, and AI lead scoring. Runs as one Node app with a Postgres database on Roar AI. No Supabase, no third-party backend.

*Developed by Digithaal Digital Solutions*

---

## What's in here

| File | What it does |
|---|---|
| `server.js` | Express app: serves the CRM, mounts the API, handles shutdown |
| `schema.sql` | All tables. Re-applied on every boot; every statement is idempotent |
| `db.js` | Connection pool, migrations, waits for the database to wake up |
| `auth.js` | Signup, password hashing (scrypt), database-backed sessions |
| `api.js` | Workspace-scoped REST API for leads, connectors, sheets, settings |
| `webhook.js` | The public lead receiver — one URL per connector |
| `events.js` | Live updates via SSE, fanned out by Postgres LISTEN/NOTIFY |
| `ai.js` / `ai-routes.js` | Roar gateway client, lead scoring and follow-up drafting |
| `public/index.html` | The whole front end, one file |
| `e2e-test.mjs` | 92 API tests against a running server |
| `browser-test.mjs` | 33 UI tests driving real Chromium |

---

## Deploy it

### 1. Put the code on GitHub

Roar deploys from a repository. From this folder:

```bash
git init
git add -A
git commit -m "OmniLeads CRM on Roar"
git branch -M main
git remote add origin https://github.com/<you>/omnileads-crm.git
git push -u origin main
```

Create that empty repo on GitHub first. `.env` is gitignored, so your API key does not travel with the code.

### 2. Deploy

Roar's GitHub connection must be authorized for the repo, then the app is deployed with a database attached, in whichever region you want (`lk` for Colombo, `sg`, `in`).

It needs one environment variable set at deploy time:

| Variable | Value |
|---|---|
| `ROAR_API_KEY` | Your `roar_live_…` inference key |
| `ROAR_MODEL` | Optional. Defaults to `claude-haiku-5-5`. `qwen3.8-27b-lk` is cheaper and served in Sri Lanka |
| `META_VERIFY_TOKEN` | For Meta Lead Ads — see below |
| `META_APP_SECRET` | For Meta Lead Ads — see below |
| `META_PAGE_ACCESS_TOKEN` | For Meta Lead Ads — see below |
| `META_GRAPH_VERSION` | Optional. Defaults to `v26.0` |

`DATABASE_URL` and `PORT` are injected by Roar — do not set them yourself.

The app creates its own tables on first boot. There is no migration step to run.

### 3. Sign up

Open the app's URL. Create a workspace with your email, a password of at least 8 characters, and your company name. That first account is the owner.

---

## Adding your team

**Settings → Team access** shows a **Workspace ID**. Send it to a colleague; they sign up with **Create a workspace** and paste that ID into the *Workspace ID* field. They join yours instead of starting their own.

Everyone in a workspace shares one pipeline and sees each other's changes within a second, without refreshing.

---

## Connecting lead sources

Each connector on the **Integrations** tab has its own webhook URL:

```
https://your-app.roar.../hook/<connector token>
```

Copy it from the connector's card and paste it into the platform:

| Platform | Where it goes |
|---|---|
| **Google Ads** | Lead form asset → Webhook integration → Webhook URL |
| **Meta** | Business Settings → Webhooks → Page → `leadgen`, plus your `META_VERIFY_TOKEN` |
| **TikTok** | Assets → Lead generation → Integrations → Webhook |
| **Zapier / Make** | A "Webhooks → POST" action aimed at the URL |
| **Your website form** | POST the form fields to the URL |

Test one without touching an ad account:

```bash
curl -X POST "https://your-app.roar.../hook/<token>" \
  -H "Content-Type: application/json" \
  -d '{"full_name":"Test Lead","email":"test@example.com","budget":"Rs. 50,000"}'
```

The lead appears in your pipeline immediately, on every open browser.

### Meta Lead Ads

Meta is handled properly rather than generically: deliveries are cryptographically verified, and each lead's answers are fetched from the Graph API. It needs three secrets, all **server-side only** — the connector's card in the app shows no token field, and nothing sensitive is kept in the browser or the database.

| Variable | Where to get it |
|---|---|
| `META_VERIFY_TOKEN` | A long random string you invent. Paste the identical value into Meta as the *Verify Token* |
| `META_APP_SECRET` | Meta app → **Settings → Basic → App secret** |
| `META_PAGE_ACCESS_TOKEN` | A **Page** access token carrying the `leads_retrieval` permission |

Then in Meta: **App → Webhooks → Page → subscribe to `leadgen`**, with the Callback URL set to the Meta connector's webhook URL from its card, and the Verify Token matching `META_VERIFY_TOKEN`. Finally subscribe your Page to the app.

**How a delivery is handled.**

1. `GET` with `hub.mode=subscribe` and a matching verify token returns the `hub.challenge` as bare plain text; anything else gets a 403.
2. `POST` is checked against `X-Hub-Signature-256` — HMAC-SHA256 of the **raw** request bytes keyed with `META_APP_SECRET`, compared in constant time. A bad or missing signature is rejected with 401 and recorded on the connector.
3. A verified delivery is acknowledged with **200 immediately**, before any work. Meta redelivers anything slow or non-200, so the lead fetch happens after the response.
4. For each `entry[].changes[]` where `field === "leadgen"`, the lead is fetched from `GET /{version}/{leadgen_id}?fields=field_data,created_time,ad_id,ad_name,campaign_name,form_id`.
5. `field_data` becomes the lead: `full_name` (or `first_name` + `last_name`), `email`, `phone_number`, `company_name`. Every custom question is preserved verbatim in the notes, along with the ad name, campaign and form id.
6. It is saved with source **Meta Ads**, stage **New**, and Meta's own `created_time`, keyed on `leadgen_id` with a unique index — so a redelivery is a no-op, not a second lead. Only genuinely new leads increment the attributed count, and a successful delivery marks the connector Active.

**When something breaks**, the reason is written to the server logs *and* shown on the connector's card: an expired token names `META_PAGE_ACCESS_TOKEN` as the thing to replace, a permissions failure mentions `leads_retrieval`. The card clears itself after the next successful delivery. Access tokens never appear in any log line or error message.

**What the generic receiver handles** for every other connector: Google's `user_column_data`, Meta-shaped `field_data`, TikTok, Typeform answers, plain JSON, and ordinary form posts. It maps name, email, phone, company, budget and message however they're labelled; assembles `first_name` + `last_name` into a full name; reads money the way people write it (`Rs. 45,000`, `$1,234.56`, `1.234,56`); and ignores a repeat delivery of the same email within an hour so platform retries don't duplicate. A `GET` on the URL reports whether the connector is live without creating anything.

---

## AI features

Visible only when `ROAR_API_KEY` is set; the app runs fine without it.

- **Score leads** in the header scores up to 25 unscored open leads, highest value first.
- The **wand** on a lead row scores that one. Scores show on list rows and board cards, colour-coded, with the model's reasoning in the tooltip. The **AI** column sorts by score.
- The **envelope** drafts a follow-up email in a chosen tone. Anything the model doesn't know is left as a `[bracketed placeholder]` rather than invented.

The key stays on the server — the browser never sees it, and spending is bounded by the key's own budget cap in Roar.

---

## Spreadsheets

**Import a spreadsheet** reads `.xlsx`, `.xls`, `.xlsm`, `.xlsb`, `.ods`, `.csv` and `.tsv` in the browser. You map columns before anything is added, with a live preview and a duplicate check on email, or name + company.

**Linked sheets** pull from a Google Sheets or Excel Online URL. Unlike the browser-only version, **the server fetches these**, so cross-origin restrictions no longer apply — but the sheet must still be readable without a login (Share → *Anyone with the link*). When a fetch fails, the card records exactly why.

---

## Running it locally

```bash
npm install
# a local Postgres, any database
DATABASE_URL=postgres://postgres@127.0.0.1:5432/omnileads npm run dev
```

Tests, against a running server on port 3456:

```bash
npm run test:api     # 92 API and isolation tests
npm run test:meta    # 63 Meta webhook tests, against a stub Graph API
npm run test:ui      # 33 browser tests (needs: npm i -D playwright)
npm run test:ai      # one chat request through the Roar gateway
```

The Meta suite starts its own stub Graph API, so it needs no Meta credentials —
run the server with `META_VERIFY_TOKEN=test-verify-token`,
`META_APP_SECRET=test-app-secret`, `META_PAGE_ACCESS_TOKEN=test-page-token` and
`META_GRAPH_BASE=http://127.0.0.1:3470`.

---

## How it's built

**Tenant isolation.** Every query is scoped by the `workspace_id` on the caller's session. No endpoint accepts a workspace id from the client, so there is no request shape that reaches another tenant's rows. 11 of the API tests exist purely to prove this — a second workspace attempting to read, update and delete the first's leads, connectors and sheet links.

**Sessions** are rows in Postgres, not files on disk, because app disks are wiped on redeploy and more than one instance may serve traffic. The cookie is `httpOnly`, `sameSite=lax`, and `secure` whenever the request arrived over HTTPS. Passwords use `scrypt` from Node's standard library — no native module to compile at build time.

**Live updates** are SSE, fanned out by Postgres `LISTEN/NOTIFY`. A database trigger fires on every lead change, so an insert from a webhook — which never touches an app instance holding your browser's connection — still reaches you. An in-process event bus would not survive Roar running two instances.

**Writes.** Leads are written individually, so two people editing different leads never overwrite each other. Settings are one JSON document, debounced, so typing a CRM name is one write rather than twelve. The sidebar shows the real state: *Saving…* → *All changes saved*, or a red warning when a write fails.

**Boot order.** The HTTP listener starts before the database work, so the platform's health check always has something to answer it. If the database setup fails the app stays up serving `/healthz` instead of crash-looping, which is far easier to diagnose.

**Degrading.** A missing AI key hides the AI controls. A blocked CDN leaves the QR preview with an explanatory message instead of breaking the page, and the live connection is established *before* any rendering, so a render failure can never cost you live updates.

---

## What this still doesn't do

1. **Conversion postbacks are still simulated.** Lead *ingest* from Meta is real, but the reverse direction is not: moving a lead to Won shows the notifications a real integration would produce and sends nothing to Meta or Google. That needs the Conversions API with your ad account credentials.

2. **Private sheets need OAuth.** Server-side fetching removed the CORS problem, not the login one. A sheet behind a Google or Microsoft sign-in still needs an OAuth flow.

3. **Roles aren't enforced.** Everyone in a workspace can edit everything. The `role` column distinguishes owner from member but no endpoint checks it yet.

4. **Invites are by workspace ID.** Anyone holding the ID can join at signup. Rotate to emailed, expiring invitations before that ID circulates.

5. **Connector API keys are stored in plain text.** The field documents which key a connector uses; it is not a secrets vault.

6. **No audit trail.** `updated_at` records when a lead last changed, not who changed it or what it was before.

7. **Tailwind and the QR library load from CDNs.** The app degrades gracefully if they're unreachable, but vendoring them locally would make it fully self-contained.
