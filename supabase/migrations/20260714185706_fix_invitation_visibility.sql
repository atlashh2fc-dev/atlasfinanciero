-- La política consulta la membresía del propio usuario, visible por la política
-- base de membresías. Evita depender de una función SECURITY DEFINER dentro de
-- la política de invitaciones.
drop policy "administrators read organization invitations" on public.user_invitations;
drop policy "administrators create organization invitations" on public.user_invitations;
drop policy "administrators update organization invitations" on public.user_invitations;
drop policy "administrators delete organization invitations" on public.user_invitations;

create policy "administrators read organization invitations" on public.user_invitations
for select to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = user_invitations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);

create policy "administrators create organization invitations" on public.user_invitations
for insert to authenticated
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = user_invitations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);

create policy "administrators update organization invitations" on public.user_invitations
for update to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = user_invitations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
)
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = user_invitations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);

create policy "administrators delete organization invitations" on public.user_invitations
for delete to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = user_invitations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);
