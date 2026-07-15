-- Control documental y comercial por cliente.
-- El catálogo pertenece a cada organización para que los precios no se compartan
-- entre empresas y quede listo para usar como origen de prefacturas.

create table public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  category text,
  description text,
  unit_name text not null default 'unidad',
  unit_price numeric(18, 2) not null default 0 check (unit_price >= 0),
  currency text not null default 'CLP' check (currency in ('CLP', 'USD', 'UF')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, name)
);

create table public.customer_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid not null,
  service_catalog_id uuid not null,
  quantity numeric(18, 4) not null default 1 check (quantity > 0),
  unit_price numeric(18, 2) not null check (unit_price >= 0),
  currency text not null default 'CLP' check (currency in ('CLP', 'USD', 'UF')),
  starts_on date,
  ends_on date,
  billing_frequency text not null default 'monthly' check (billing_frequency in ('monthly', 'one_time', 'annual', 'quarterly')),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (counterparty_id, organization_id) references public.counterparties (id, organization_id) on delete cascade,
  foreign key (service_catalog_id, organization_id) references public.service_catalog (id, organization_id),
  unique (counterparty_id, service_catalog_id)
);

create table public.customer_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid not null,
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  file_size bigint,
  document_type text not null default 'contract' check (document_type in ('contract', 'annex', 'other')),
  notes text,
  uploaded_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (counterparty_id, organization_id) references public.counterparties (id, organization_id) on delete cascade
);

create index service_catalog_org_active_idx on public.service_catalog (organization_id, is_active, name);
create index customer_services_customer_idx on public.customer_services (counterparty_id, organization_id, is_active);
create index customer_files_customer_idx on public.customer_files (counterparty_id, organization_id, created_at desc);
create index issued_documents_customer_idx on public.issued_documents (counterparty_id, organization_id, issue_date desc);

create trigger service_catalog_set_updated_at before update on public.service_catalog
for each row execute function public.set_updated_at();
create trigger customer_services_set_updated_at before update on public.customer_services
for each row execute function public.set_updated_at();

create or replace function public.seed_service_catalog_for_organization()
returns trigger
language plpgsql
as $$
begin
  insert into public.service_catalog (organization_id, name, category)
  values
    (new.id, 'Arriendo de posiciones', 'Infraestructura'),
    (new.id, 'Tráfico telefónico', 'Telecomunicaciones'),
    (new.id, 'Tráfico internet', 'Telecomunicaciones'),
    (new.id, 'Licencias Vocalcom', 'Licencias'),
    (new.id, 'Licencias Atlas', 'Licencias'),
    (new.id, 'Licencias ITSM', 'Licencias'),
    (new.id, 'Licencias Aprende', 'Licencias'),
    (new.id, 'Servicio de encuestas', 'Servicios'),
    (new.id, 'Servicios outbound', 'Servicios'),
    (new.id, 'Servicio inbound', 'Servicios')
  on conflict (organization_id, name) do nothing;
  return new;
end;
$$;

-- El orden alfabético deja primero el trigger existente organizations_assign_creator,
-- por lo que el administrador de la nueva organización ya está asignado al poblar el catálogo.
create trigger organizations_seed_service_catalog
after insert on public.organizations
for each row execute function public.seed_service_catalog_for_organization();

alter table public.service_catalog enable row level security;
alter table public.customer_services enable row level security;
alter table public.customer_files enable row level security;

create policy "members read service catalog" on public.service_catalog
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = service_catalog.organization_id and membership.user_id = (select auth.uid()))
);
create policy "administrators manage service catalog" on public.service_catalog
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = service_catalog.organization_id and membership.user_id = (select auth.uid()) and membership.role = 'administrator')
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = service_catalog.organization_id and membership.user_id = (select auth.uid()) and membership.role = 'administrator')
);
create policy "members read customer services" on public.customer_services
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_services.organization_id and membership.user_id = (select auth.uid()))
);
create policy "operators manage customer services" on public.customer_services
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_services.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_services.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
);
create policy "members read customer files" on public.customer_files
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_files.organization_id and membership.user_id = (select auth.uid()))
);
create policy "operators manage customer files" on public.customer_files
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_files.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_files.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customer-documents', 'customer-documents', false, 52428800, array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "members read customer document objects" on storage.objects
for select to authenticated using (
  bucket_id = 'customer-documents' and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1) and membership.user_id = (select auth.uid())
  )
);
create policy "operators upload customer document objects" on storage.objects
for insert to authenticated with check (
  bucket_id = 'customer-documents' and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1) and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')
  )
);
create policy "operators delete customer document objects" on storage.objects
for delete to authenticated using (
  bucket_id = 'customer-documents' and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1) and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')
  )
);

grant select, insert, update, delete on public.service_catalog, public.customer_services, public.customer_files to authenticated;

-- Catálogo inicial solicitado para las organizaciones existentes. Se puede editar,
-- desactivar o eliminar desde Administración.
insert into public.service_catalog (organization_id, name, category)
select organizations.id, defaults.name, defaults.category
from public.organizations organizations
cross join (values
  ('Arriendo de posiciones', 'Infraestructura'),
  ('Tráfico telefónico', 'Telecomunicaciones'),
  ('Tráfico internet', 'Telecomunicaciones'),
  ('Licencias Vocalcom', 'Licencias'),
  ('Licencias Atlas', 'Licencias'),
  ('Licencias ITSM', 'Licencias'),
  ('Licencias Aprende', 'Licencias'),
  ('Servicio de encuestas', 'Servicios'),
  ('Servicios outbound', 'Servicios'),
  ('Servicio inbound', 'Servicios')
) as defaults(name, category)
on conflict (organization_id, name) do nothing;
