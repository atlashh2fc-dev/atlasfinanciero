-- Una respuesta textual de plazo vencido nunca es una aceptación aunque el
-- endpoint legado entregue código 0. Reparamos la bitácora y retiramos la
-- factura de la bandeja de decisión: no hay una acción válida disponible.
update public.sii_dte_events
set request_status = 'failed'
where request_status = 'completed'
  and coalesce(sii_response_code, 0) = 0
  and coalesce(sii_response_message, '') ~* '(no[[:space:]]+(es[[:space:]]+)?posible|pasados?[[:space:]]+[0-9]+[[:space:]]+d[ií]as|fuera[[:space:]]+de[[:space:]]+plazo)';

update public.received_documents document
set sii_event_status = 'decision_window_closed',
    sii_last_checked_at = now()
where sii_event_status is null
  and exists (
    select 1
    from public.sii_dte_events event
    where event.received_document_id = document.id
      and event.request_status = 'failed'
      and coalesce(event.sii_response_message, '') ~* '(no[[:space:]]+(es[[:space:]]+)?posible|pasados?[[:space:]]+[0-9]+[[:space:]]+d[ií]as|fuera[[:space:]]+de[[:space:]]+plazo)'
  );

-- El primer paso de consolidación conservó deliberadamente la copia IMAP
-- para no cortar referencias. Las duplicadas sin referencias financieras ya
-- pueden eliminarse de forma segura, dejando una sola cuenta visible.
delete from public.received_documents imported
using public.received_documents canonical
where imported.organization_id = canonical.organization_id
  and imported.id <> canonical.id
  and imported.source_sheet_name = 'IMAP'
  and imported.source_file_name like 'sii-mail-%'
  and imported.supplier_tax_id = canonical.supplier_tax_id
  and imported.document_number = canonical.document_number
  and canonical.sii_document_type is not null
  and imported.sii_document_type is null
  and not exists (select 1 from public.payment_batch_items item where item.received_document_id = imported.id)
  and not exists (select 1 from public.payment_executions execution where execution.received_document_id = imported.id)
  and not exists (select 1 from public.bank_reconciliation_matches reconciliation where reconciliation.received_document_id = imported.id)
  and not exists (select 1 from public.profitability_cost_allocations allocation where allocation.received_document_id = imported.id);
