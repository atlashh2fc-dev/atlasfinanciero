-- Maestro de clientes: datos legales, tributarios y operativos de facturación/cobranza.
alter table public.counterparties
  add column business_activity text,
  add column address_line1 text,
  add column commune text,
  add column city text,
  add column website text,
  add column legal_representative_name text,
  add column legal_representative_tax_id text,
  add column legal_representative_address text,
  add column legal_representative_phone text,
  add column legal_representative_email text,
  add column billing_email text,
  add column billing_phone text;

create table public.counterparty_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid not null,
  contact_area text not null check (contact_area in ('commercial', 'billing', 'payments', 'collections', 'legal', 'other')),
  job_title text,
  full_name text not null,
  phone text,
  email text,
  is_primary boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (counterparty_id, organization_id) references public.counterparties (id, organization_id) on delete cascade,
  unique nulls not distinct (counterparty_id, contact_area, full_name)
);

create index counterparty_contacts_counterparty_idx on public.counterparty_contacts (counterparty_id, organization_id, contact_area);

create trigger counterparty_contacts_set_updated_at before update on public.counterparty_contacts
for each row execute function public.set_updated_at();

alter table public.counterparty_contacts enable row level security;

create policy "members read counterparty contacts" on public.counterparty_contacts
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparty_contacts.organization_id
      and membership.user_id = (select auth.uid())
  )
);

create policy "customer operators manage contacts" on public.counterparty_contacts
for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparty_contacts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparty_contacts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);

create policy "operations create counterparties" on public.counterparties
for insert to authenticated with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'operations'
  )
);

create policy "operations update counterparties" on public.counterparties
for update to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'operations'
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'operations'
  )
);

grant select, insert, update, delete on public.counterparty_contacts to authenticated;

-- Ficha remitida por GEIMSER: GG Electrics. Sólo se cargan los datos explícitos en la ficha.
update public.counterparties
set
  business_activity = 'ASESORÍA, INGENIERÍA Y EJECUCIÓN DE SERVICIOS INFORMÁTICOS Y ELÉCTRICOS',
  address_line1 = 'CALLE BROWN NORTE 100 OF 303',
  commune = 'ÑUÑOA',
  city = 'SANTIAGO',
  website = 'WWW.GGELECTRICS.CL',
  email = 'FMORALES@GGELECTRICS.CL',
  phone = '56998261036',
  legal_representative_name = 'FRANCISCO JAVIER MORALES GONZALEZ',
  legal_representative_tax_id = '17958755-6',
  legal_representative_address = 'CALLE BROWN NORTE 100 OF 303',
  legal_representative_phone = '56998261036',
  legal_representative_email = 'FMORALES@GGELECTRICS.CL',
  billing_email = 'CMARTINEZ@GGELECTRICS.CL',
  billing_phone = '56975644930'
where organization_id = 'cd4ebec4-3cf6-40f4-9631-0a5d8fd7a4f2'
  and tax_id = '76859313-2';

insert into public.counterparty_contacts (
  organization_id, counterparty_id, contact_area, job_title, full_name, phone, email, is_primary
)
select
  counterparties.organization_id,
  counterparties.id,
  source.contact_area,
  source.job_title,
  source.full_name,
  source.phone,
  source.email,
  source.is_primary
from public.counterparties
cross join (
  values
    ('commercial', 'GERENTE GENERAL', 'FRANCISCO MORALES', '56998261036', 'FMORALES@GGELECTRICS.CL', true),
    ('billing', 'ASISTENTE EJECUTIVA', 'CAROLAYN MARTINEZ', '56975644930', 'CMARTINEZ@GGELECTRICS.CL', true),
    ('payments', 'ASISTENTE EJECUTIVA', 'CAROLAYN MARTINEZ', '56975644930', 'CMARTINEZ@GGELECTRICS.CL', true),
    ('collections', 'ASISTENTE EJECUTIVA', 'CAROLAYN MARTINEZ', '56975644930', 'CMARTINEZ@GGELECTRICS.CL', true)
) as source(contact_area, job_title, full_name, phone, email, is_primary)
where counterparties.organization_id = 'cd4ebec4-3cf6-40f4-9631-0a5d8fd7a4f2'
  and counterparties.tax_id = '76859313-2'
on conflict (counterparty_id, contact_area, full_name) do update
set job_title = excluded.job_title,
    phone = excluded.phone,
    email = excluded.email,
    is_primary = excluded.is_primary;
