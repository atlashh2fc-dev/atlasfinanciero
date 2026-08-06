-- Permite registrar servicios fuera del catálogo sin crear entradas ficticias.
-- La glosa breve vive en notes y viaja a prefacturación junto al servicio.
alter table public.customer_services
  add column custom_service_name text,
  add column custom_service_category text;

alter table public.customer_services
  alter column service_catalog_id drop not null;

alter table public.customer_services
  drop constraint customer_services_counterparty_id_service_catalog_id_key;

alter table public.customer_services
  add constraint customer_services_source_check
  check (
    (
      service_catalog_id is not null
      and custom_service_name is null
      and custom_service_category is null
    )
    or
    (
      service_catalog_id is null
      and custom_service_name is not null
      and length(btrim(custom_service_name)) between 1 and 180
      and custom_service_category is not null
      and length(btrim(custom_service_category)) between 1 and 100
    )
  );

create unique index customer_services_catalog_unique_idx
  on public.customer_services (counterparty_id, service_catalog_id)
  where service_catalog_id is not null;

create index customer_services_custom_name_idx
  on public.customer_services (organization_id, counterparty_id, lower(custom_service_name))
  where custom_service_name is not null;
