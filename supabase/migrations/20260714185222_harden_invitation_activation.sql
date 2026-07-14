-- La activación agrega acceso sólo cuando aún no existe una membresía. Nunca
-- debe modificar el rol de una persona que ya pertenece a la organización.
create or replace function private.activate_pending_invitations_for_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  has_confirmed_account boolean;
begin
  select (user_record.email_confirmed_at is not null or user_record.confirmed_at is not null)
    into has_confirmed_account
  from auth.users user_record
  where user_record.id = p_user_id;

  if coalesce(has_confirmed_account, false) is false then
    return;
  end if;

  insert into public.organization_memberships (organization_id, user_id, role)
  select invitation.organization_id, invitation.auth_user_id, invitation.role
  from public.user_invitations invitation
  where invitation.auth_user_id = p_user_id
    and invitation.status = 'pending'
  on conflict (organization_id, user_id) do nothing;

  update public.user_invitations
  set status = 'active', activated_at = coalesce(activated_at, now())
  where auth_user_id = p_user_id
    and status = 'pending';
end;
$$;

revoke all on function private.activate_pending_invitations_for_user(uuid) from public, anon, authenticated;
