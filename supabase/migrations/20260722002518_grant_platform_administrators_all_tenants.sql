-- Los Super Admin deben poder entrar al tenant y operar todos los módulos,
-- además de consultar la vista global. Se asignan a las empresas existentes.
insert into public.organization_memberships (organization_id, user_id, role)
select organization.id, administrator.user_id, 'administrator'::public.organization_role
from public.organizations organization
cross join public.platform_administrators administrator
on conflict (organization_id, user_id) do update
set role = excluded.role;

-- Las empresas nuevas heredan a los Super Admin como administradores, junto
-- con el usuario que las creó. Así siempre aparecen en el selector lateral.
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

  insert into public.organization_memberships (organization_id, user_id, role)
  select new.id, administrator.user_id, 'administrator'::public.organization_role
  from public.platform_administrators administrator
  on conflict (organization_id, user_id) do update set role = excluded.role;

  update public.profiles
  set active_organization_id = new.id
  where id = auth.uid()
    and active_organization_id is null;

  return new;
end;
$$;

revoke all on function public.assign_creator_to_new_organization() from public, anon, authenticated;
