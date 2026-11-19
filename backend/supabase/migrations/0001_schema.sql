-- 0001: core schema. Plain Postgres (Supabase-compatible). Every tenant table carries studio_id.
create extension if not exists pgcrypto;

-- Global identity (not tenant data; RLS limits visibility to self + same-studio members)
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  display_name text not null default '',
  created_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

-- Global reference data (no tenant rows)
create table plans (
  key text primary key,
  name text not null,
  monthly_credits int not null,
  price_note text not null
);
create table catalog_items (
  key text primary key,
  name text not null,
  category text not null,
  room_kinds text[] not null default '{}',
  styles text[] not null default '{}',
  width_mm int not null,
  depth_mm int not null,
  height_mm int not null,
  price_low numeric(10,2) not null,
  price_high numeric(10,2) not null
);
create table finishes (
  key text primary key,
  name text not null,
  surface text not null check (surface in ('floor','wall')),
  color text not null,
  styles text[] not null default '{}',
  price_low_m2 numeric(10,2) not null,
  price_high_m2 numeric(10,2) not null
);
create table styles (
  key text primary key,
  name text not null,
  description text not null,
  palette jsonb not null,
  materials text[] not null default '{}'
);

-- Tenancy
create table studios (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name text not null,
  owner_id uuid not null references users(id),
  created_at timestamptz not null default now()
);
-- shortcut: one studio per user (unique user_id); upgrade to multi-studio with a studio switcher.
create table studio_members (
  studio_id uuid not null references studios(id) on delete cascade,
  user_id uuid not null unique references users(id) on delete cascade,
  role text not null check (role in ('owner','designer','client')),
  created_at timestamptz not null default now(),
  primary key (studio_id, user_id)
);
create table studio_branding (
  studio_id uuid primary key references studios(id) on delete cascade,
  display_name text not null,
  logo_upload_id uuid,
  primary_color text not null default '#2f3e46' check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  accent_color text not null default '#c08552' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  background_color text not null default '#faf8f5' check (background_color ~ '^#[0-9a-fA-F]{6}$'),
  font text not null default 'inter',
  template text not null default 'classic',
  updated_at timestamptz not null default now()
);
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  plan_key text not null references plans(key),
  status text not null check (status in ('trial','active','canceled')),
  trial_ends_at timestamptz,
  created_at timestamptz not null default now()
);
create table credit_ledger (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  delta int not null,
  reason text not null,
  render_job_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index on credit_ledger (studio_id);
create table audit_events (
  id bigserial primary key,
  studio_id uuid references studios(id) on delete cascade,
  actor_id uuid references users(id),
  action text not null,
  target_type text,
  target_id text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on audit_events (studio_id, created_at desc);

create table projects (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active','archived')),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);
create index on projects (studio_id);
create table project_permissions (
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'client' check (role in ('client')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index on project_permissions (user_id);
create table invitations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  role text not null check (role in ('client','designer')),
  email text,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references users(id),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  check (role = 'designer' or project_id is not null)
);

-- Plans
create table floor_plans (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null unique references projects(id) on delete cascade,
  current_version_id uuid,
  created_at timestamptz not null default now()
);
create table plan_versions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  plan_id uuid not null references floor_plans(id) on delete cascade,
  version_no int not null,
  geometry jsonb not null,
  author_id uuid not null references users(id),
  author_role text not null check (author_role in ('owner','designer','client')),
  label text not null default '',
  review_status text not null default 'conceptual' check (review_status in ('conceptual','provisional')),
  review_flags jsonb not null default '[]',
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (plan_id, version_no)
);
alter table floor_plans add foreign key (current_version_id) references plan_versions(id);

create table briefs (
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid primary key references projects(id) on delete cascade,
  data jsonb not null default '{}',
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create table finish_selections (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  room_id text not null,
  surface text not null check (surface in ('floor','wall')),
  finish_key text not null references finishes(key),
  created_at timestamptz not null default now(),
  unique (project_id, room_id, surface)
);
create table uploads (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  kind text not null check (kind in ('image','logo','render')),
  storage_key text not null unique,
  content_type text not null,
  size_bytes int not null,
  width int not null,
  height int not null,
  filename text not null default '',
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);
alter table studio_branding add foreign key (logo_upload_id) references uploads(id) on delete set null;
create table moodboards (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create table moodboard_items (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  moodboard_id uuid not null references moodboards(id) on delete cascade,
  kind text not null check (kind in ('catalog','finish','upload','color','note')),
  ref text not null default '',
  note text not null default '',
  position int not null default 0,
  created_at timestamptz not null default now()
);
create table design_alternatives (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  description text not null default '',
  style_key text,
  plan_version_id uuid not null references plan_versions(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
-- Manual estimate lines (source='manual') and overrides of auto-generated lines (source='override', item_key = auto key)
create table estimate_items (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  source text not null check (source in ('manual','override')),
  item_key text not null,
  label text not null default '',
  qty numeric(12,2),
  unit text not null default 'pcs',
  unit_low numeric(12,2),
  unit_high numeric(12,2),
  excluded boolean not null default false,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  unique (project_id, item_key)
);

-- AI
create table ai_conversations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create table ai_messages (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  conversation_id uuid not null references ai_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  suggestions jsonb not null default '[]',
  provider text,
  author_id uuid references users(id),
  created_at timestamptz not null default now()
);
create index on ai_messages (conversation_id, created_at);
create table ai_preferences (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id),
  suggestion_id text not null,
  kind text not null,
  key text not null,
  decision text not null check (decision in ('accept','reject')),
  created_at timestamptz not null default now(),
  unique (project_id, user_id, suggestion_id)
);

-- Renders
create table render_jobs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  plan_version_id uuid not null references plan_versions(id),
  view jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  error text,
  result_upload_id uuid references uploads(id),
  idempotency_key text not null,
  ledger_id uuid references credit_ledger(id),
  requested_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (project_id, idempotency_key)
);
create index render_jobs_queued on render_jobs (created_at) where status = 'queued';

-- Collaboration
create table review_comments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  plan_version_id uuid references plan_versions(id),
  element_id text,
  author_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now()
);
create table review_decisions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  plan_version_id uuid not null references plan_versions(id),
  decision text not null check (decision in ('reviewed','concept_approved','changes_requested')),
  note text not null default '',
  decided_by uuid not null references users(id),
  decided_role text not null,
  created_at timestamptz not null default now()
);
create table project_tasks (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  assignee_id uuid references users(id),
  status text not null default 'todo' check (status in ('todo','doing','done')),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table project_messages (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  author_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now()
);
create table design_dossiers (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  plan_version_id uuid not null references plan_versions(id),
  html text not null,
  note text not null default '',
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);
