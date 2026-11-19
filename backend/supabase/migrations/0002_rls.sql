-- 0002: app_user role, RLS helpers, policies, grants, narrow SECURITY DEFINER entry points.
-- The app connects as app_user and sets per-transaction:
--   set_config('app.user_id', <uuid>, true), set_config('app.studio_id', <uuid>, true)

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user login nosuperuser nobypassrls nocreatedb nocreaterole noinherit;
  end if;
end $$;
-- password is set by scripts/migrate.py from APP_USER_PASSWORD

grant usage on schema public to app_user;

-- ---------- helpers ----------
create or replace function app_uid() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create or replace function app_sid() returns uuid language sql stable as
$$ select nullif(current_setting('app.studio_id', true), '')::uuid $$;

create or replace function app_member_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from studio_members where studio_id = app_sid() and user_id = app_uid()
$$;
create or replace function app_is_staff() returns boolean language sql stable as
$$ select coalesce(app_member_role() in ('owner','designer'), false) $$;
create or replace function app_is_owner() returns boolean language sql stable as
$$ select coalesce(app_member_role() = 'owner', false) $$;

create or replace function app_can_project(pid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from projects p
    where p.id = pid and p.studio_id = app_sid()
      and (app_is_staff() or exists (
        select 1 from project_permissions pp where pp.project_id = pid and pp.user_id = app_uid()))
  )
$$;

create or replace function app_is_project_creator(pid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from projects where id = pid and studio_id = app_sid() and created_by = app_uid())
$$;

-- staff see every member of their studio; clients see themselves and studio staff
create or replace function app_can_see_user(uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select uid = app_uid() or exists (
    select 1 from studio_members m
    where m.studio_id = app_sid() and m.user_id = uid
      and (app_is_staff() or m.role in ('owner','designer'))
  )
$$;

-- ---------- RLS ----------
do $$
declare t text;
begin
  foreach t in array array[
    'users','studios','studio_members','studio_branding','subscriptions','credit_ledger','audit_events',
    'projects','project_permissions','invitations','floor_plans','plan_versions','briefs','finish_selections',
    'uploads','moodboards','moodboard_items','design_alternatives','estimate_items','ai_conversations',
    'ai_messages','ai_preferences','render_jobs','review_comments','review_decisions','project_tasks',
    'project_messages','design_dossiers']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;

  -- project-scoped tables: same studio AND (staff OR granted on the project)
  foreach t in array array[
    'floor_plans','briefs','finish_selections','moodboards','moodboard_items','design_alternatives',
    'estimate_items','ai_conversations','ai_messages','ai_preferences','render_jobs','review_comments',
    'review_decisions','project_tasks','project_messages','design_dossiers']
  loop
    execute format(
      'create policy project_access on %I to app_user using (studio_id = app_sid() and app_can_project(project_id)) '
      'with check (studio_id = app_sid() and app_can_project(project_id))', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;

-- plan_versions: immutable geometry; only review columns are updatable, by staff
create policy pv_select on plan_versions for select to app_user
  using (studio_id = app_sid() and app_can_project(project_id));
create policy pv_insert on plan_versions for insert to app_user
  with check (studio_id = app_sid() and app_can_project(project_id) and author_id = app_uid());
create policy pv_review on plan_versions for update to app_user
  using (studio_id = app_sid() and app_is_staff() and app_can_project(project_id))
  with check (studio_id = app_sid());
grant select, insert on plan_versions to app_user;
grant update (review_status, review_flags, reviewed_by, reviewed_at) on plan_versions to app_user;

-- users
create policy users_select on users for select to app_user using (app_can_see_user(id));
create policy users_insert on users for insert to app_user with check (id = app_uid());
create policy users_update on users for update to app_user using (id = app_uid()) with check (id = app_uid());
grant select, insert on users to app_user;
grant update (display_name, password_hash) on users to app_user;

-- studios
create policy studios_select on studios for select to app_user using (id = app_sid());
create policy studios_insert on studios for insert to app_user with check (id = app_sid() and owner_id = app_uid());
create policy studios_update on studios for update to app_user using (id = app_sid() and app_is_owner());
grant select, insert on studios to app_user;
grant update (name) on studios to app_user;

-- studio_members
create policy members_select on studio_members for select to app_user
  using ((studio_id = app_sid() and app_can_see_user(user_id)) or user_id = app_uid());
create policy members_insert on studio_members for insert to app_user
  with check (studio_id = app_sid() and (
    app_is_owner()
    or (user_id = app_uid() and role = 'client')
    or (user_id = app_uid() and role = 'owner'
        and exists (select 1 from studios s where s.id = studio_id and s.owner_id = app_uid()))));
create policy members_delete on studio_members for delete to app_user
  using (studio_id = app_sid() and app_is_owner() and role <> 'owner');
grant select, insert, delete on studio_members to app_user;

-- branding
create policy branding_select on studio_branding for select to app_user using (studio_id = app_sid());
create policy branding_write on studio_branding for insert to app_user with check (studio_id = app_sid() and app_is_owner());
create policy branding_update on studio_branding for update to app_user
  using (studio_id = app_sid() and app_is_owner()) with check (studio_id = app_sid());
grant select, insert, update on studio_branding to app_user;

-- subscriptions
create policy subs_select on subscriptions for select to app_user using (studio_id = app_sid());
create policy subs_insert on subscriptions for insert to app_user with check (studio_id = app_sid() and app_is_owner());
grant select, insert on subscriptions to app_user;

-- credit ledger (append-only)
create policy credits_select on credit_ledger for select to app_user using (studio_id = app_sid());
create policy credits_insert on credit_ledger for insert to app_user
  with check (studio_id = app_sid() and app_member_role() is not null and (
    delta < 0
    or (reason = 'trial_grant' and app_is_owner())
    or (reason = 'render_refund' and delta = 1 and render_job_id is not null)));
grant select, insert on credit_ledger to app_user;
-- DB-enforced one-time credit movements
create unique index credit_one_refund_per_job on credit_ledger (render_job_id) where reason = 'render_refund';
create unique index credit_one_trial_grant on credit_ledger (studio_id) where reason = 'trial_grant';

-- audit (append-only; owner reads)
create policy audit_select on audit_events for select to app_user using (studio_id = app_sid() and app_is_owner());
create policy audit_insert on audit_events for insert to app_user with check (studio_id is null or studio_id = app_sid());
grant select, insert on audit_events to app_user;
grant usage on sequence audit_events_id_seq to app_user;

-- projects
create policy projects_select on projects for select to app_user using (studio_id = app_sid() and app_can_project(id));
create policy projects_insert on projects for insert to app_user
  with check (studio_id = app_sid() and created_by = app_uid() and app_member_role() is not null);
create policy projects_update on projects for update to app_user
  using (studio_id = app_sid() and app_is_staff()) with check (studio_id = app_sid());
grant select, insert on projects to app_user;
grant update (name, status) on projects to app_user;

-- project_permissions
create policy perms_select on project_permissions for select to app_user
  using (studio_id = app_sid() and (app_is_staff() or user_id = app_uid()));
create policy perms_insert on project_permissions for insert to app_user
  with check (studio_id = app_sid() and (app_is_staff()
    or (user_id = app_uid() and app_is_project_creator(project_id))));
create policy perms_delete on project_permissions for delete to app_user using (studio_id = app_sid() and app_is_staff());
grant select, insert, delete on project_permissions to app_user;

-- invitations (staff only; pre-auth access only via functions below)
create policy invitations_staff on invitations to app_user
  using (studio_id = app_sid() and app_is_staff()) with check (studio_id = app_sid() and app_is_staff());
grant select, insert, update, delete on invitations to app_user;

-- uploads: studio-level (logo) rows have project_id null
create policy uploads_select on uploads for select to app_user
  using (studio_id = app_sid() and (project_id is null or app_can_project(project_id)));
create policy uploads_insert on uploads for insert to app_user
  with check (studio_id = app_sid() and uploaded_by = app_uid()
    and ((project_id is null and app_is_owner()) or (project_id is not null and app_can_project(project_id))));
create policy uploads_delete on uploads for delete to app_user using (studio_id = app_sid() and app_is_staff());
grant select, insert, delete on uploads to app_user;

-- global reference data
grant select on plans, catalog_items, finishes, styles to app_user;

-- ---------- narrow SECURITY DEFINER entry points (pre-auth / cross-tenant system work) ----------
create or replace function auth_login_lookup(p_email text)
returns table (id uuid, password_hash text, display_name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.password_hash, u.display_name from users u where lower(u.email) = lower(p_email)
$$;

create or replace function studio_public(p_slug text)
returns table (studio_id uuid, slug text, name text, display_name text, primary_color text,
               accent_color text, background_color text, font text, template text, has_logo boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.slug, s.name, coalesce(b.display_name, s.name),
         coalesce(b.primary_color, '#2f3e46'), coalesce(b.accent_color, '#c08552'),
         coalesce(b.background_color, '#faf8f5'), coalesce(b.font, 'inter'), coalesce(b.template, 'classic'),
         b.logo_upload_id is not null
  from studios s left join studio_branding b on b.studio_id = s.id
  where s.slug = p_slug
$$;

create or replace function studio_public_logo(p_slug text)
returns table (storage_key text, content_type text)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.storage_key, u.content_type
  from studios s join studio_branding b on b.studio_id = s.id join uploads u on u.id = b.logo_upload_id
  where s.slug = p_slug and u.kind = 'logo'
$$;

create or replace function invitation_preview(p_hash text)
returns table (studio_name text, studio_slug text, role text, project_name text, expires_at timestamptz, valid boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.name, s.slug, i.role, p.name, i.expires_at, (i.used_at is null and i.expires_at > now())
  from invitations i join studios s on s.id = i.studio_id left join projects p on p.id = i.project_id
  where i.token_hash = p_hash
$$;

-- Atomically consumes a single-use invitation for the current app.user_id and grants access.
create or replace function invitation_accept(p_hash text)
returns table (studio_id uuid, project_id uuid, role text)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare inv invitations; existing studio_members;
begin
  if app_uid() is null then raise exception 'no_user' using errcode = 'P0001'; end if;
  update invitations i set used_at = now(), used_by = app_uid()
   where i.token_hash = p_hash and i.used_at is null and i.expires_at > now()
   returning * into inv;
  if inv.id is null then raise exception 'invalid_invitation' using errcode = 'P0001'; end if;
  select * into existing from studio_members m where m.user_id = app_uid();
  if existing.user_id is not null and existing.studio_id <> inv.studio_id then
    raise exception 'other_studio' using errcode = 'P0001';
  end if;
  if existing.user_id is null then
    insert into studio_members (studio_id, user_id, role) values (inv.studio_id, app_uid(), inv.role);
  end if;
  if inv.project_id is not null then
    insert into project_permissions (studio_id, project_id, user_id) values (inv.studio_id, inv.project_id, app_uid())
    on conflict do nothing;
  end if;
  return query select inv.studio_id, inv.project_id, inv.role;
end $$;

-- Render worker: claim the oldest queued job across studios (FOR UPDATE SKIP LOCKED).
create or replace function render_claim_next()
returns table (id uuid, studio_id uuid, project_id uuid, requested_by uuid)
language sql volatile security definer set search_path = public, pg_temp as $$
  with c as (
    select j.id from render_jobs j where j.status = 'queued' order by j.created_at, j.id
    for update skip locked limit 1
  )
  update render_jobs r set status = 'running', started_at = now()
  from c where r.id = c.id
  returning r.id, r.studio_id, r.project_id, r.requested_by
$$;

do $$
declare f text;
begin
  foreach f in array array['app_member_role()','app_is_staff()','app_is_owner()','app_can_project(uuid)',
    'app_is_project_creator(uuid)','app_can_see_user(uuid)','auth_login_lookup(text)','studio_public(text)',
    'studio_public_logo(text)','invitation_preview(text)','invitation_accept(text)','render_claim_next()',
    'app_uid()','app_sid()']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to app_user', f);
    -- Supabase exposes public-schema functions/tables to these API roles; keep them out.
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon, authenticated', f);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
