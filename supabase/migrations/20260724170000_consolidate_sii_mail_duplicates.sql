-- Los documentos históricos pueden existir antes de que llegue el XML al correo.
-- Conservamos ese registro (pagos, respaldo y trazabilidad interna) y le
-- trasladamos la identidad/metadata SII de la copia creada por el importador.
do $$
declare
  match_row record;
begin
  for match_row in
    select
      historical.id as historical_id,
      imported.id as imported_id,
      imported.organization_id,
      imported.sii_document_type,
      imported.sii_folio,
      imported.sii_xml_path,
      imported.sii_xml_sha256,
      imported.sii_mail_message_id,
      imported.sii_purchase_order_reference,
      imported.sii_received_at,
      imported.sii_response_deadline,
      imported.sii_event_status,
      imported.sii_last_checked_at
    from public.received_documents imported
    join public.received_documents historical
      on historical.organization_id = imported.organization_id
      and historical.supplier_tax_id = imported.supplier_tax_id
      and historical.document_number = imported.sii_folio::text
      and historical.id <> imported.id
    where imported.sii_xml_sha256 is not null
      and imported.sii_document_type is not null
      and historical.sii_document_type is null
  loop
    update public.received_documents
    set
      sii_xml_sha256 = null,
      sii_document_type = null,
      sii_folio = null,
      sii_received_at = null,
      sii_response_deadline = null,
      sii_event_status = null,
      sii_last_checked_at = null
    where id = match_row.imported_id;

    update public.received_documents
    set
      sii_document_type = match_row.sii_document_type,
      sii_folio = match_row.sii_folio,
      sii_xml_path = match_row.sii_xml_path,
      sii_xml_sha256 = match_row.sii_xml_sha256,
      sii_mail_message_id = match_row.sii_mail_message_id,
      sii_purchase_order_reference = match_row.sii_purchase_order_reference,
      sii_received_at = match_row.sii_received_at,
      sii_response_deadline = match_row.sii_response_deadline,
      sii_event_status = match_row.sii_event_status,
      sii_last_checked_at = match_row.sii_last_checked_at
    where id = match_row.historical_id;

    delete from public.received_document_lines
    where received_document_id = match_row.historical_id;

    update public.received_document_lines
    set received_document_id = match_row.historical_id
    where received_document_id = match_row.imported_id;

    update public.sii_dte_events
    set received_document_id = match_row.historical_id
    where received_document_id = match_row.imported_id;
  end loop;
end $$;
