-- La capacidad queda separada del rol porque no todos los perfiles de
-- digitación deben administrar el maestro de proveedores.
alter table public.organization_memberships
  add column if not exists can_create_suppliers boolean not null default false;

update public.organization_memberships membership
set can_create_suppliers = true
from public.profiles profile
where profile.id = membership.user_id
  and lower(profile.email) = 'calvarezp@geimser.cl';

comment on column public.organization_memberships.can_create_suppliers is
  'Permite crear proveedores desde flujos operativos sin otorgar acceso financiero.';

-- La API fija kind = 'supplier', is_active = true y created_by = auth.uid();
-- RLS limita la organización y exige la capacidad individual.
drop policy if exists "business roles create counterparties"
  on public.counterparties;

create policy "business roles create counterparties"
on public.counterparties
for insert
to authenticated
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and (
        membership.role::text in ('administrator', 'finance', 'operations')
        or (
          membership.role::text = 'data_entry'
          and membership.can_create_suppliers
          and counterparties.kind = 'supplier'
          and counterparties.is_active
          and counterparties.created_by = (select auth.uid())
          and counterparties.merged_into_counterparty_id is null
        )
      )
  )
);
