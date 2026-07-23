-- El pipeline se alinea con las fases que usa el equipo en la hoja
-- "Seguimiento Comercial" / pestaña "Preventa". Se preserva el historial
-- anterior, mapeando las fases genéricas a sus equivalentes más específicos.
alter table public.commercial_opportunities
  drop constraint if exists commercial_opportunities_stage_check;

update public.commercial_opportunities
set stage = case stage
  when 'lead' then 'exploration'
  when 'qualified' then 'meeting'
  else stage
end
where stage in ('lead', 'qualified');

alter table public.commercial_opportunities
  add constraint commercial_opportunities_stage_check
  check (stage in ('exploration', 'meeting', 'quotation', 'proposal', 'pilot', 'negotiation', 'won', 'lost'));

-- Un RUT aún no informado no debe impedir crear más de un prospecto. La
-- unicidad se mantiene sólo cuando existe identificador tributario.
alter table public.counterparties
  drop constraint if exists counterparties_organization_id_tax_id_key;

create unique index if not exists counterparties_organization_tax_id_unique_idx
  on public.counterparties (organization_id, tax_id)
  where tax_id is not null;

with source_customers(legal_name) as (
  values
    ('SONDA'), ('TIC Manager'), ('Verisure'), ('Jessica Call center'),
    ('GGElectrics'), ('Barba Abogado'), ('Inmobiliaria Roof'), ('Gym MXN'),
    ('Barba - Hernan'), ('Braincorp'), ('Toshiba'), ('Siptel'),
    ('Link Solutions'), ('Los Parques'), ('Jorge Miranda'), ('Sinate'),
    ('International School'), ('People Work'), ('Factoring'),
    ('Proyecto Isla de Pascua'), ('Anasac'), ('Bodenor')
), normalized_customers as (
  select legal_name, lower(regexp_replace(legal_name, '[^a-zA-Z0-9]+', '', 'g')) as normalized_name
  from source_customers
)
update public.counterparties counterparty
set kind = case when counterparty.kind = 'supplier' then 'both' else counterparty.kind end
from normalized_customers source
where counterparty.organization_id = 'cd4ebec4-3cf6-40f4-9631-0a5d8fd7a4f2'
  and lower(regexp_replace(counterparty.legal_name, '[^a-zA-Z0-9]+', '', 'g')) = source.normalized_name;

with source_customers(legal_name) as (
  values
    ('SONDA'), ('TIC Manager'), ('Verisure'), ('Jessica Call center'),
    ('GGElectrics'), ('Barba Abogado'), ('Inmobiliaria Roof'), ('Gym MXN'),
    ('Barba - Hernan'), ('Braincorp'), ('Toshiba'), ('Siptel'),
    ('Link Solutions'), ('Los Parques'), ('Jorge Miranda'), ('Sinate'),
    ('International School'), ('People Work'), ('Factoring'),
    ('Proyecto Isla de Pascua'), ('Anasac'), ('Bodenor')
)
insert into public.counterparties (organization_id, legal_name, kind)
select 'cd4ebec4-3cf6-40f4-9631-0a5d8fd7a4f2', source.legal_name, 'customer'
from source_customers source
where not exists (
  select 1
  from public.counterparties counterparty
  where counterparty.organization_id = 'cd4ebec4-3cf6-40f4-9631-0a5d8fd7a4f2'
    and lower(regexp_replace(counterparty.legal_name, '[^a-zA-Z0-9]+', '', 'g')) = lower(regexp_replace(source.legal_name, '[^a-zA-Z0-9]+', '', 'g'))
);

with source_rows(customer_name, title, stage, probability, expected_amount, currency_code, next_action_on, lost_reason, description) as (
  values
    ('SONDA', 'Agente IA ITSM', 'proposal', 55, 0, 'CLP', null, null, 'Responsable: HH - IA. Contacto: Lilian Leon. Valores de origen: setup 220; recurrente 210; moneda por confirmar. Propuesta enviada el 20-05-2026.'),
    ('TIC Manager', 'ITSM + RRM', 'proposal', 55, 0, 'CLP', null, null, 'Responsable: IA - HH. Contacto: Francisco Rojas. Valores de origen: setup 375; recurrente 231,5; moneda por confirmar. Propuesta enviada el 20-05-2026.'),
    ('Verisure', 'Scoring BDD', 'exploration', 10, 0, 'CLP', null, null, 'Responsable: CR. Etapa de exploración.'),
    ('Jessica Call center', 'Licencias CRM', 'lost', 0, 0, 'CLP', null, 'Baja propuesta', 'Responsable: HH. Propuesta Vocalcom enviada; costo rechazado.'),
    ('GGElectrics', 'Cotizador WEB', 'won', 100, 3000000, 'CLP', null, null, 'Responsable: HH - IA. Cerrada; pendiente envío de credenciales por parte del cliente.'),
    ('Barba Abogado', 'Rediseño web', 'won', 100, 0, 'CLP', null, null, 'Responsable: HH - LP. En proceso de desarrollo desde el 05-06-2026.'),
    ('Inmobiliaria Roof', 'Web completa', 'lost', 0, 0, 'CLP', null, 'Baja propuesta', 'Responsable: HH - LP. Baja registrada el 05-06-2026.'),
    ('Gym MXN', 'Arriendo GYM', 'exploration', 10, 0, 'CLP', null, null, 'Responsable: HH - LP. Contacto: Adriana Patiño.'),
    ('Barba - Hernan', 'Validador Legal', 'pilot', 70, 0, 'CLP', null, null, 'Responsable: HH. Desarrollo de MVP.'),
    ('Braincorp', 'Instalación UPS-Bancos de Batería', 'lost', 0, 4600000, 'CLP', null, 'Baja propuesta', 'Responsable: IA. Contacto: Marcelino Millar. Presupuesto con descuento enviado el 20-05-2026.'),
    ('Toshiba', 'Plataforma Contact Center', 'meeting', 25, 0, 'CLP', '2026-07-27', null, 'Responsable: IA. Contacto: Matias Cabrera. Valores de origen: setup 59,94; recurrente 17,4; moneda por confirmar. Propuesta enviada 04-05-2026; reunión 1: 17-07-2026; reunión 2: 27-07-2026.'),
    ('Siptel', 'Plataforma Contact Center', 'lost', 0, 2500, 'USD', null, 'Baja propuesta', 'Responsable: IA. Contacto: Bryant Natera. Recurrente USD 1.975. Propuesta enviada el 15-04-2026.'),
    ('Link Solutions', 'Servicio Service Desk', 'proposal', 55, 0, 'CLP', null, null, 'Responsable: IA. Contacto: Alberto Garacino. Recurrente 8, moneda por confirmar. Pendiente de evaluación en Q4.'),
    ('Los Parques', 'Desarrollo Memorial', 'proposal', 55, 0, 'CLP', null, null, 'Responsable: HH - LP. Contacto: Rodolfo Leal.'),
    ('Los Parques', 'Plataforma Ventas y Referido', 'negotiation', 85, 0, 'CLP', null, null, 'Responsable: LP. Contacto: Rodolfo Leal. En proceso de contrato.'),
    ('Jorge Miranda', 'Paneles Solares - Pichilemu', 'quotation', 40, 0, 'CLP', null, null, 'Responsable: LP. Contacto: Jorge Miranda. Pendiente cotización AC.'),
    ('Sinate', 'Paneles Solares - El Tabo', 'quotation', 40, 0, 'CLP', null, null, 'Responsable: LP. Contacto: Ricardo. Pendiente cotización AC.'),
    ('International School', 'Paneles Solares', 'meeting', 25, 0, 'CLP', null, null, 'Responsable: LP. Contacto: Gemita. En espera de reunión.'),
    ('Los Parques', 'CRM', 'meeting', 25, 0, 'CLP', null, null, 'Responsable: LP. Contacto: Rodolfo Leal. Pendiente envío de accesos a demo CRM.'),
    ('People Work', 'Venta - Referido', 'proposal', 55, 0, 'CLP', null, null, 'Responsable: LP. Envío de propuesta registrado el 05-06-2026.'),
    ('Factoring', 'Propuesta referido', 'proposal', 55, 0, 'CLP', null, null, 'Responsable: LP.'),
    ('Braincorp', 'Proyecto SML', 'pilot', 70, 17000000, 'CLP', null, null, 'Responsable: IA. Contacto: Rodrigo Torres. Etapa QA; pendiente fecha de inicio. Valor neto.'),
    ('Proyecto Isla de Pascua', 'Abordar propuesta', 'meeting', 25, 3000000, 'CLP', null, null, 'Responsable: LP. Contacto: Ninoska. Reunión 1.'),
    ('Braincorp', 'Proyecto Registro Civil', 'proposal', 55, 17000000, 'CLP', null, null, 'Responsable: IA. Contacto: Rodrigo Torres. En análisis por parte del cliente. Valor neto.'),
    ('Braincorp', 'Proyecto Piwen', 'proposal', 55, 800000, 'CLP', null, null, 'Responsable: IA. Contacto: Marcelino Millar. Pendiente fecha de inicio. Valor neto.'),
    ('Braincorp', 'Formateo Notebook', 'proposal', 55, 200000, 'CLP', null, null, 'Responsable: IA. Contacto: Rodrigo Torres. En análisis por parte del cliente. Valor neto.'),
    ('Anasac', 'Sistema detección Incendio', 'proposal', 55, 5537178, 'CLP', null, null, 'Responsable: IA. Contacto: Ignacio Carrasco. En análisis por parte del cliente. Valor neto.'),
    ('Bodenor', 'Habilitación Sala Monitoreo', 'proposal', 55, 15400000, 'CLP', null, null, 'Responsable: IA. Contacto: Claudio Perez. En análisis por parte del cliente. Valor neto.')
)
insert into public.commercial_opportunities (
  organization_id, counterparty_id, title, stage, expected_amount,
  currency_code, probability, next_action_on, source, lost_reason, description
)
select
  'cd4ebec4-3cf6-40f4-9631-0a5d8fd7a4f2',
  customer.id,
  source.title,
  source.stage,
  source.expected_amount,
  source.currency_code,
  source.probability,
  source.next_action_on::date,
  'Google Sheets · Seguimiento Comercial · Preventa',
  source.lost_reason,
  source.description
from source_rows source
join public.counterparties customer
  on customer.organization_id = 'cd4ebec4-3cf6-40f4-9631-0a5d8fd7a4f2'
  and lower(regexp_replace(customer.legal_name, '[^a-zA-Z0-9]+', '', 'g')) = lower(regexp_replace(source.customer_name, '[^a-zA-Z0-9]+', '', 'g'))
where not exists (
  select 1
  from public.commercial_opportunities opportunity
  where opportunity.organization_id = 'cd4ebec4-3cf6-40f4-9631-0a5d8fd7a4f2'
    and opportunity.counterparty_id = customer.id
    and lower(opportunity.title) = lower(source.title)
);
