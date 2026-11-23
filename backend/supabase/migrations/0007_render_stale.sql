-- 0007: find render jobs stuck in 'running' (worker died mid-render) so the worker can fail + refund them.
-- SECURITY DEFINER like render_claim_next(): the worker has no tenant context when it looks across studios.
create or replace function render_stale_jobs(older_than_minutes int)
returns table (id uuid, studio_id uuid, requested_by uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select j.id, j.studio_id, j.requested_by from render_jobs j
  where j.status = 'running' and j.started_at < now() - make_interval(mins => older_than_minutes)
$$;
revoke all on function render_stale_jobs(int) from public;
grant execute on function render_stale_jobs(int) to app_user;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function render_stale_jobs(int) from anon, authenticated;
  end if;
end $$;
