-- Una prefactura siempre conserva la fecha y la paridad usada para convertir
-- servicios pactados en UF a CLP. El contrato mantiene su valor original.

alter table public.preinvoices
  add column pricing_date date;

update public.preinvoices
set pricing_date = period_month
where pricing_date is null;

alter table public.preinvoices
  alter column pricing_date set not null;

alter table public.preinvoice_lines
  add column source_currency char(3),
  add column source_unit_price numeric(18, 4),
  add column conversion_rate_to_clp numeric(18, 4),
  add column pricing_date date,
  add column rate_source text;

update public.preinvoice_lines line
set
  source_currency = preinvoice.currency_code,
  source_unit_price = line.unit_price,
  conversion_rate_to_clp = 1,
  pricing_date = preinvoice.pricing_date,
  rate_source = 'legacy_contract_price'
from public.preinvoices preinvoice
where preinvoice.id = line.preinvoice_id
  and preinvoice.organization_id = line.organization_id;

alter table public.preinvoice_lines
  alter column source_currency set not null,
  alter column source_unit_price set not null,
  alter column conversion_rate_to_clp set not null,
  alter column pricing_date set not null,
  alter column rate_source set not null,
  add constraint preinvoice_lines_source_currency_check
    check (source_currency in ('CLP', 'UF', 'USD')),
  add constraint preinvoice_lines_source_unit_price_check
    check (source_unit_price >= 0),
  add constraint preinvoice_lines_conversion_rate_check
    check (conversion_rate_to_clp > 0),
  add constraint preinvoice_lines_rate_source_check
    check (btrim(rate_source) <> '');

create index preinvoices_pricing_date_idx
  on public.preinvoices (organization_id, pricing_date desc);
