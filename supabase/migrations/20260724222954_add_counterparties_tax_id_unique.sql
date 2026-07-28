-- El upsert por organización + RUT (correo tributario y RCV) requiere una
-- restricción única real; el índice existente no lo era. Sin esto, la
-- vinculación de contrapartes falla silenciosamente.
create unique index if not exists counterparties_organization_tax_id_key
  on public.counterparties (organization_id, tax_id)
  where tax_id is not null and merged_into_counterparty_id is null;;
