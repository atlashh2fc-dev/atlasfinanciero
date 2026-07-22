-- Regulariza los cuatro documentos existentes de Infobusiness que tienen folio
-- XXXXX (marcador de "sin factura"). No crea ni reemplaza documentos nuevos.
-- Fuente: Facturas Emitidas.xlsx / Presupuesto 2026, filas 54 a 57.
-- Los abonos existentes se conservan en issued_document_payments.

with source_rows as (
  select *
  from (
    values
      ('e256d34b-6fad-4f20-9c72-38a9a093e507'::uuid, 3906331.00::numeric, 742203.00::numeric, 1000000.00::numeric, 'G54:G57'),
      ('f04085c9-2193-41ee-bc2e-4a40a0accdc4'::uuid, 14601978.00::numeric, 2774376.00::numeric, 12378782.00::numeric, 'H54:H57'),
      ('87677c72-e676-4a4f-a204-178f29a13e1a'::uuid, 15526182.00::numeric, 2953833.00::numeric, 13721830.00::numeric, 'I54:I57'),
      ('6ca6e9aa-c338-4375-8f1b-f20c36d80821'::uuid, 16124606.00::numeric, 2953834.00::numeric, 12351136.00::numeric, 'J54:J57')
  ) as row(id, net_amount, vat_amount, paid_amount, source_cells)
)
update public.issued_documents document
set
  document_type = 'Sin documento',
  net_amount = source.net_amount,
  vat_amount = source.vat_amount,
  total_amount = source.net_amount + source.vat_amount,
  notes = format(
    'Regularización de cobranza. Presupuesto 2026 %s: neto a facturar $%s, abono $%s, diferencia neta $%s e IVA $%s.',
    source.source_cells,
    to_char(source.net_amount, 'FM999G999G999G990'),
    to_char(source.paid_amount, 'FM999G999G999G990'),
    to_char(source.net_amount - source.paid_amount, 'FM999G999G999G990'),
    to_char(source.vat_amount, 'FM999G999G999G990')
  ),
  source_file_name = 'Facturas Emitidas.xlsx',
  source_sheet_name = 'Presupuesto 2026',
  source_row = 54
from source_rows source
where document.id = source.id
  and document.organization_id = 'cd4ebec4-3cf6-40f4-9631-0a5d8fd7a4f2';
