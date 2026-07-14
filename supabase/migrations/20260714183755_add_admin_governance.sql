-- Administración multiempresa: toda mutación requiere una membresía administrativa.

alter table public.profiles
  add column active_organization_id uuid references public.organizations(id) on delete set null;

alter table public.organizations
  add constraint organizations_legal_name_not_blank check (btrim(legal_name) <> '');

create index profiles_active_organization_idx on public.profiles (active_organization_id) where active_organization_id is not null;

create or replace function public.is_organization_administrator(p_organization_id uuid)
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

create or replace function public.can_administrate_profile(p_profile_id uuid)
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
      and public.is_organization_administrator(subject_membership.organization_id)
  );
$$;

create or replace function public.validate_profile_active_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active_organization_id is not null and not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = new.active_organization_id
      and membership.user_id = new.id
  ) then
    raise exception 'active_organization_requires_membership';
  end if;
  return new;
end;
$$;

create or replace function public.assign_creator_to_new_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'organization_creation_requires_authenticated_user';
  end if;

  insert into public.organization_memberships (organization_id, user_id, role)
  values (new.id, auth.uid(), 'administrator')
  on conflict (organization_id, user_id) do update set role = excluded.role;

  update public.profiles
  set active_organization_id = new.id
  where id = auth.uid()
    and active_organization_id is null;

  return new;
end;
$$;

create or replace function public.prevent_last_administrator_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'administrator'
    and (tg_op = 'DELETE' or new.role <> 'administrator')
    and not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = old.organization_id
        and membership.role = 'administrator'
        and membership.user_id <> old.user_id
    ) then
    raise exception 'organization_requires_at_least_one_administrator';
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function public.refresh_active_organization_after_membership_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set active_organization_id = (
    select membership.organization_id
    from public.organization_memberships membership
    where membership.user_id = old.user_id
    order by membership.created_at, membership.organization_id
    limit 1
  )
  where id = old.user_id
    and active_organization_id = old.organization_id;
  return old;
end;
$$;

create trigger profiles_validate_active_organization
before insert or update of active_organization_id on public.profiles
for each row execute function public.validate_profile_active_organization();

create trigger organizations_assign_creator
after insert on public.organizations
for each row execute function public.assign_creator_to_new_organization();

create trigger memberships_prevent_last_administrator_update
before update of role on public.organization_memberships
for each row execute function public.prevent_last_administrator_removal();

create trigger memberships_prevent_last_administrator_delete
before delete on public.organization_memberships
for each row execute function public.prevent_last_administrator_removal();

create trigger memberships_refresh_active_organization
after delete on public.organization_memberships
for each row execute function public.refresh_active_organization_after_membership_delete();

-- La selección activa se inicializa desde la primera membresía existente.
update public.profiles profile
set active_organization_id = (
  select organization_id
  from public.organization_memberships
  where user_id = profile.id
  order by created_at, organization_id
  limit 1
)
where profile.active_organization_id is null;

grant select, update on public.profiles to authenticated;
grant insert, update on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_memberships to authenticated;

create policy "administrators read organization memberships" on public.organization_memberships
for select to authenticated
using (public.is_organization_administrator(organization_id));

create policy "administrators create organization memberships" on public.organization_memberships
for insert to authenticated
with check (public.is_organization_administrator(organization_id));

create policy "administrators update organization memberships" on public.organization_memberships
for update to authenticated
using (public.is_organization_administrator(organization_id))
with check (public.is_organization_administrator(organization_id));

create policy "administrators delete organization memberships" on public.organization_memberships
for delete to authenticated
using (public.is_organization_administrator(organization_id));

create policy "administrators create organizations" on public.organizations
for insert to authenticated
with check (exists (
  select 1
  from public.organization_memberships membership
  where membership.user_id = (select auth.uid())
    and membership.role = 'administrator'
));

create policy "administrators update their organizations" on public.organizations
for update to authenticated
using (public.is_organization_administrator(id))
with check (public.is_organization_administrator(id));

create policy "administrators read organization member profiles" on public.profiles
for select to authenticated
using (public.can_administrate_profile(id));

grant execute on function public.is_organization_administrator(uuid) to authenticated;
grant execute on function public.can_administrate_profile(uuid) to authenticated;
revoke all on function public.validate_profile_active_organization() from public, anon, authenticated;
revoke all on function public.assign_creator_to_new_organization() from public, anon, authenticated;
revoke all on function public.prevent_last_administrator_removal() from public, anon, authenticated;
revoke all on function public.refresh_active_organization_after_membership_delete() from public, anon, authenticated;
