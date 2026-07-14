-- La sincronización interactiva se ejecuta con la sesión del administrador.
-- Complementa las políticas de lectura para permitir las operaciones UPSERT
-- sólo dentro de su propia organización.

create policy "administrators sync payroll people" on public.payroll_people
for all to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_people.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_people.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);

create policy "administrators sync payroll contracts" on public.payroll_contracts
for all to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_contracts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_contracts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);

create policy "administrators sync payroll period metrics" on public.payroll_person_period_metrics
for all to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_person_period_metrics.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_person_period_metrics.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);

grant select, insert, update, delete on public.payroll_people, public.payroll_contracts, public.payroll_person_period_metrics to authenticated;

-- Cubre la FK compuesta usada al consolidar métricas de persona por período.
create index payroll_person_period_metrics_person_organization_idx
  on public.payroll_person_period_metrics (person_id, organization_id);
