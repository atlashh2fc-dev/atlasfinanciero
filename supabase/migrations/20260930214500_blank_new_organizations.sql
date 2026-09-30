-- Una empresa nueva debe partir en blanco. Al crearla, el trigger
-- organizations_seed_service_catalog le copiaba los conceptos de facturación
-- de Geimser (Vocalcom, tráfico telefónico, inbound/outbound…), y el catálogo
-- de cotización sembrado en 20260805175859/20260805181343 también llegó a
-- empresas que no son Geimser. Cada empresa crea sus propios conceptos.
drop trigger if exists organizations_seed_service_catalog on public.organizations;
drop function if exists public.seed_service_catalog_for_organization();

-- Personal LP (RUT 13109521-K) quedó con esos conceptos de Geimser. Se borran
-- sólo los que nunca se usaron (sin servicios de cliente, prefacturas ni
-- presupuesto, y sin cotizaciones en la empresa).
delete from public.service_catalog service
using public.organizations organization
where organization.id = service.organization_id
  and lower(organization.tax_id) = '13109521-k'
  and service.name in (
    'Arriendo de posiciones', 'Tráfico telefónico', 'Tráfico internet',
    'Licencias Vocalcom', 'Licencias Atlas', 'Licencias ITSM',
    'Licencias Aprende', 'Servicio de encuestas', 'Servicios outbound',
    'Servicio inbound'
  )
  and not exists (select 1 from public.customer_services used where used.service_catalog_id = service.id)
  and not exists (select 1 from public.preinvoice_lines used where used.service_catalog_id = service.id)
  and not exists (select 1 from public.financial_budget_lines used where used.service_catalog_id = service.id);

delete from public.quotation_catalog_cost_components component
using public.organizations organization
where organization.id = component.organization_id
  and lower(organization.tax_id) = '13109521-k'
  and not exists (select 1 from public.sales_quotes quote where quote.organization_id = organization.id);

delete from public.quotation_catalog_items item
using public.organizations organization
where organization.id = item.organization_id
  and lower(organization.tax_id) = '13109521-k'
  and item.created_by is null
  and not exists (select 1 from public.sales_quotes quote where quote.organization_id = organization.id);

-- Sus centros se crearon usando el código como grupo ("CASA" → EEPA,
-- "HIJOS" → Bay, "GASTOS - ADICIONALES" → Cementerio) y quedaban como líneas
-- sueltas. Se crea el grupo y el centro existente pasa a ser su subcentro,
-- conservando su id (y por lo tanto sus cuentas por pagar imputadas).
with organization as (
  select id from public.organizations where lower(tax_id) = '13109521-k'
), groups (old_code, root_code, root_name, child_code) as (
  values
    ('CASA', '1.0.0', 'Casa', '1.1.0'),
    ('HIJOS', '2.0.0', 'Hijos', '2.1.0'),
    ('GASTOS - ADICIONALES', '3.0.0', 'Gastos adicionales', '3.1.0')
), moved as (
  update public.cost_centers center
  set code = groups.child_code
  from organization, groups
  where center.organization_id = organization.id
    and center.code = groups.old_code
  returning center.organization_id, groups.root_code, groups.root_name
)
insert into public.cost_centers (organization_id, code, name)
select organization_id, root_code, root_name from moved
on conflict (organization_id, code) do nothing;
