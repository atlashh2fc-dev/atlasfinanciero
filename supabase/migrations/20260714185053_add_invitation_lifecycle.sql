-- Las invitaciones no son membresías: el acceso nace sólo al aceptar el correo.
create table public.user_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  email_normalized text generated always as (lower(btrim(email))) stored,
  role public.organization_role not null default 'auditor',
  status text not null default 'pending' check (status in ('pending', 'active', 'cancelled', 'expired')),
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email_normalized)
);

create index user_invitations_organization_status_idx
  on public.user_invitations (organization_id, status, invited_at desc);
create index user_invitations_auth_user_idx
  on public.user_invitations (auth_user_id);

create trigger user_invitations_set_updated_at before update on public.user_invitations
for each row execute function public.set_updated_at();

-- Esta función sólo se ejecuta desde triggers internos. No se expone a roles de aplicación.
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
  on conflict (organization_id, user_id) do update
    set role = excluded.role;

  update public.user_invitations
  set status = 'active', activated_at = coalesce(activated_at, now())
  where auth_user_id = p_user_id
    and status = 'pending';
end;
$$;

create or replace function private.activate_invitation_after_auth_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.activate_pending_invitations_for_user(new.id);
  return new;
end;
$$;

create or replace function private.activate_invitation_after_creation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.activate_pending_invitations_for_user(new.auth_user_id);
  return new;
end;
$$;

create trigger on_auth_user_invitation_confirmed
after update of email_confirmed_at, confirmed_at on auth.users
for each row execute function private.activate_invitation_after_auth_confirmation();

create trigger user_invitations_activate_confirmed_account
after insert on public.user_invitations
for each row execute function private.activate_invitation_after_creation();

alter table public.user_invitations enable row level security;

grant select, insert, update, delete on public.user_invitations to authenticated;

create policy "administrators read organization invitations" on public.user_invitations
for select to authenticated
using (private.is_organization_administrator(organization_id));

create policy "administrators create organization invitations" on public.user_invitations
for insert to authenticated
with check (private.is_organization_administrator(organization_id));

create policy "administrators update organization invitations" on public.user_invitations
for update to authenticated
using (private.is_organization_administrator(organization_id))
with check (private.is_organization_administrator(organization_id));

create policy "administrators delete organization invitations" on public.user_invitations
for delete to authenticated
using (private.is_organization_administrator(organization_id));

revoke all on function private.activate_pending_invitations_for_user(uuid) from public, anon, authenticated;
revoke all on function private.activate_invitation_after_auth_confirmation() from public, anon, authenticated;
revoke all on function private.activate_invitation_after_creation() from public, anon, authenticated;

-- Repara las invitaciones emitidas con la versión inicial: estaban creadas como
-- membresías antes de ser aceptadas. Se mantienen visibles como pendientes y se
-- elimina ese acceso anticipado.
insert into public.user_invitations (
  organization_id,
  auth_user_id,
  email,
  role,
  status,
  invited_at
)
select
  membership.organization_id,
  membership.user_id,
  user_record.email,
  membership.role,
  'pending',
  coalesce(user_record.invited_at, membership.created_at)
from public.organization_memberships membership
join auth.users user_record on user_record.id = membership.user_id
where user_record.invited_at is not null
  and user_record.email_confirmed_at is null
  and user_record.confirmed_at is null
on conflict (organization_id, email_normalized) do nothing;

delete from public.organization_memberships membership
using auth.users user_record
where membership.user_id = user_record.id
  and user_record.invited_at is not null
  and user_record.email_confirmed_at is null
  and user_record.confirmed_at is null;
