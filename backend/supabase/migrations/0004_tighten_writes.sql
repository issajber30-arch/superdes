-- 0004: narrow write policies.
-- 1) review_comments, review_decisions, project_messages, render_jobs: anyone with project access may
--    SELECT/INSERT; only staff or the row's author may UPDATE/DELETE it.
-- 2) render_refund ledger rows require an existing failed render_job in the same studio with no prior refund.
-- 3) invitation_accept: an invitation addressed to an email can only be accepted by that email.

do $$
declare pair text[]; t text; author text;
begin
  foreach pair slice 1 in array array[
    ['review_comments', 'author_id'], ['review_decisions', 'decided_by'],
    ['project_messages', 'author_id'], ['render_jobs', 'requested_by']]
  loop
    t := pair[1]; author := pair[2];
    execute format('drop policy project_access on %I', t);
    execute format('create policy pa_select on %I for select to app_user '
                   'using (studio_id = app_sid() and app_can_project(project_id))', t);
    execute format('create policy pa_insert on %I for insert to app_user '
                   'with check (studio_id = app_sid() and app_can_project(project_id))', t);
    execute format('create policy pa_update on %I for update to app_user '
                   'using (studio_id = app_sid() and app_can_project(project_id) and (app_is_staff() or %I = app_uid())) '
                   'with check (studio_id = app_sid() and app_can_project(project_id))', t, author);
    execute format('create policy pa_delete on %I for delete to app_user '
                   'using (studio_id = app_sid() and app_can_project(project_id) and (app_is_staff() or %I = app_uid()))',
                   t, author);
  end loop;
end $$;

-- SECURITY DEFINER so the check does not depend on the caller still seeing the job via RLS.
create or replace function app_render_refundable(jid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from render_jobs j where j.id = jid and j.studio_id = app_sid() and j.status = 'failed')
     and not exists (select 1 from credit_ledger l where l.render_job_id = jid and l.reason = 'render_refund')
$$;
revoke all on function app_render_refundable(uuid) from public;
grant execute on function app_render_refundable(uuid) to app_user;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function app_render_refundable(uuid) from anon, authenticated;
  end if;
end $$;

drop policy credits_insert on credit_ledger;
create policy credits_insert on credit_ledger for insert to app_user
  with check (studio_id = app_sid() and app_member_role() is not null and (
    delta < 0
    or (reason = 'trial_grant' and app_is_owner())
    or (reason = 'render_refund' and delta = 1 and render_job_id is not null and app_render_refundable(render_job_id))));

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
  if inv.email is not null
     and lower(inv.email) is distinct from (select lower(u.email) from users u where u.id = app_uid()) then
    raise exception 'email_mismatch' using errcode = 'P0001';
  end if;
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
