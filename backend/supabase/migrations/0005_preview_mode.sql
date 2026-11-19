-- 0005: single-owner preview mode (PREVIEW_MODE=1): registration is open only while no user exists.
-- The advisory lock serialises concurrent first sign-ups until the registering transaction commits.
create or replace function app_has_users() returns boolean
language sql volatile security definer set search_path = public, pg_temp as $$
  select pg_advisory_xact_lock(hashtext('superdes_preview_register'));
  select exists (select 1 from users);
$$;

revoke all on function app_has_users() from public;
grant execute on function app_has_users() to app_user;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function app_has_users() from anon, authenticated;
  end if;
end $$;
