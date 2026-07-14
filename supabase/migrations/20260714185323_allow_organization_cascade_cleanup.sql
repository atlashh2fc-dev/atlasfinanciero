-- Mantiene la protección de administradores para retiros individuales, pero no
-- bloquea la eliminación en cascada de una organización completa.
create or replace function public.prevent_last_administrator_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.organizations organization
    where organization.id = old.organization_id
  ) then
    return coalesce(new, old);
  end if;

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

revoke all on function public.prevent_last_administrator_removal() from public, anon, authenticated;
