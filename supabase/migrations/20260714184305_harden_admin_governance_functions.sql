create schema if not exists private;
revoke all on schema private from public, anon;

create or replace function private.is_organization_administrator(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  );
$$;

create or replace function private.can_administrate_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships subject_membership
    where subject_membership.user_id = p_profile_id
      and private.is_organization_administrator(subject_membership.organization_id)
  );
$$;

drop policy "administrators read organization memberships" on public.organization_memberships;
drop policy "administrators create organization memberships" on public.organization_memberships;
drop policy "administrators update organization memberships" on public.organization_memberships;
drop policy "administrators delete organization memberships" on public.organization_memberships;
drop policy "administrators update their organizations" on public.organizations;
drop policy "administrators read organization member profiles" on public.profiles;

create policy "administrators read organization memberships" on public.organization_memberships
for select to authenticated
using (private.is_organization_administrator(organization_id));

create policy "administrators create organization memberships" on public.organization_memberships
for insert to authenticated
with check (private.is_organization_administrator(organization_id));

create policy "administrators update organization memberships" on public.organization_memberships
for update to authenticated
using (private.is_organization_administrator(organization_id))
with check (private.is_organization_administrator(organization_id));

create policy "administrators delete organization memberships" on public.organization_memberships
for delete to authenticated
using (private.is_organization_administrator(organization_id));

create policy "administrators update their organizations" on public.organizations
for update to authenticated
using (private.is_organization_administrator(id))
with check (private.is_organization_administrator(id));

create policy "administrators read organization member profiles" on public.profiles
for select to authenticated
using (private.can_administrate_profile(id));

revoke all on function public.is_organization_administrator(uuid) from public, anon, authenticated, service_role;
revoke all on function public.can_administrate_profile(uuid) from public, anon, authenticated, service_role;
drop function public.can_administrate_profile(uuid);
drop function public.is_organization_administrator(uuid);

grant usage on schema private to authenticated;
grant execute on function private.is_organization_administrator(uuid) to authenticated;
grant execute on function private.can_administrate_profile(uuid) to authenticated;
revoke all on function private.is_organization_administrator(uuid) from public, anon;
revoke all on function private.can_administrate_profile(uuid) from public, anon;
