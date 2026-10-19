-- =====================================================================
--  OmniLeads CRM — Postgres schema (Roar AI hosting)
--  Applied automatically on every boot. Safe to re-run.
--
--  Access control is enforced in the application layer: every query is
--  scoped by the workspace_id attached to the caller's session. There is
--  no path to data without a session.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Workspaces: one per company. Settings ride along as JSON.
-- ---------------------------------------------------------------------
create table if not exists workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'OmniLeads',
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Users and their workspace membership
-- ---------------------------------------------------------------------
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  role          text not null default 'member' check (role in ('owner','member')),
  created_at    timestamptz not null default now()
);
create index if not exists users_workspace_idx on users(workspace_id);
-- Case-insensitive lookup on sign-in
create unique index if not exists users_email_lower_idx on users(lower(email));

-- ---------------------------------------------------------------------
-- Sessions live in the database, not on disk: app disks are wiped on
-- every redeploy, and more than one instance may serve traffic.
-- ---------------------------------------------------------------------
create table if not exists sessions (
  token      text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx    on sessions(user_id);
create index if not exists sessions_expires_idx on sessions(expires_at);

-- ---------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------
create table if not exists leads (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name         text not null,
  company      text not null default '',
  email        text not null default '',
  phone        text not null default '',
  value        numeric not null default 0,
  stage        text not null default 'New',
  source       text not null default '',
  assignee     text not null default 'Unassigned',
  notes        text not null default '',
  ai_score     integer,
  ai_reason    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists leads_workspace_idx on leads(workspace_id, created_at desc);
create index if not exists leads_stage_idx     on leads(workspace_id, stage);
create index if not exists leads_email_idx     on leads(workspace_id, lower(email));

-- Meta's leadgen_id, when the lead came from Meta Lead Ads. Added separately
-- so existing deployments pick it up on their next boot.
alter table leads add column if not exists leadgen_id text;

-- Meta retries a webhook until it gets a 200, and may deliver the same event
-- more than once. A partial unique index makes the second insert a no-op
-- rather than a duplicate lead; NULL is left free for every other source,
-- since Postgres does not treat NULLs as equal.
create unique index if not exists leads_leadgen_uniq
  on leads(workspace_id, leadgen_id) where leadgen_id is not null;

-- ---------------------------------------------------------------------
-- Integrations. webhook_token is the shared secret in the public URL.
-- ---------------------------------------------------------------------
create table if not exists integrations (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  name           text not null,
  system         text not null default 'Custom webhook / API',
  descr          text not null default '',
  method         text not null default 'Webhook',
  endpoint       text not null default '',
  api_key        text not null default '',
  source_tag     text not null default '',
  default_stage  text not null default '',
  default_owner  text not null default '',
  active         boolean not null default true,
  webhook_token  text not null unique default encode(gen_random_bytes(18), 'hex'),
  last_received  timestamptz,
  received_count integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists integrations_workspace_idx on integrations(workspace_id);
create index if not exists integrations_token_idx     on integrations(webhook_token);

-- The most recent failure for this connector, shown on its card so an expired
-- token or a permission problem is visible without reading server logs.
alter table integrations add column if not exists last_error    text;
alter table integrations add column if not exists last_error_at timestamptz;

-- ---------------------------------------------------------------------
-- Linked spreadsheets
-- ---------------------------------------------------------------------
create table if not exists sheet_links (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  url           text not null,
  provider      text not null default '',
  source_tag    text not null default '',
  default_stage text not null default '',
  default_owner text not null default '',
  skip_dupes    boolean not null default true,
  last_sync     timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);
create index if not exists sheet_links_workspace_idx on sheet_links(workspace_id);

-- ---------------------------------------------------------------------
-- Keep updated_at honest on leads
-- ---------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_touch on leads;
create trigger leads_touch before update on leads
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------
-- Broadcast lead changes so every connected browser updates live.
-- NOTIFY crosses app instances; an in-process event bus would not.
-- Payload is kept under the 8000-byte NOTIFY limit by sending ids only.
-- ---------------------------------------------------------------------
create or replace function notify_lead_change()
returns trigger language plpgsql as $$
declare
  ws uuid;
  rec_id uuid;
begin
  if (tg_op = 'DELETE') then
    ws := old.workspace_id; rec_id := old.id;
  else
    ws := new.workspace_id; rec_id := new.id;
  end if;
  perform pg_notify('lead_change', json_build_object(
    'op', tg_op, 'workspace_id', ws, 'id', rec_id
  )::text);
  return null;
end $$;

drop trigger if exists leads_notify on leads;
create trigger leads_notify after insert or update or delete on leads
  for each row execute function notify_lead_change();
