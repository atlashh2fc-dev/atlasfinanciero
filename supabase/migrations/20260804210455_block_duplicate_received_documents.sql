-- A received document is uniquely identified inside an organization by its
-- supplier, normalized document type and folio. Source file coordinates are
-- provenance only and must not be used as the business identity.

create temporary table duplicate_received_documents_to_remove (
  id uuid primary key
) on commit drop;

insert into duplicate_received_documents_to_remove (id)
select candidate.id
from (
  select
    document.id,
    row_number() over (
      partition by
        document.organization_id,
        coalesce(
          nullif(regexp_replace(upper(btrim(document.supplier_tax_id)), '[^0-9K]', '', 'g'), ''),
          document.supplier_counterparty_id::text,
          regexp_replace(upper(btrim(document.supplier_name)), '[[:space:]]+', ' ', 'g')
        ),
        case regexp_replace(translate(lower(btrim(document.document_type)), 'áéíóúüñ', 'aeiouun'), '[[:space:]]+', ' ', 'g')
          when 'factura' then 'factura afecta'
          when 'nota credito' then 'nota de credito'
          when 'nota de credito' then 'nota de credito'
          when 'nota debito' then 'nota de debito'
          when 'nota de debito' then 'nota de debito'
          else regexp_replace(translate(lower(btrim(document.document_type)), 'áéíóúüñ', 'aeiouun'), '[[:space:]]+', ' ', 'g')
        end,
        case
          when btrim(document.document_number) ~ '^[0-9]+$'
            then coalesce(nullif(ltrim(btrim(document.document_number), '0'), ''), '0')
          else lower(btrim(document.document_number))
        end,
        document.issue_date,
        document.net_amount,
        document.vat_amount,
        document.additional_tax_amount,
        document.total_amount,
        document.notes,
        document.due_date,
        document.payment_status,
        document.cost_center_id,
        document.attachment_name,
        document.attachment_mime_type,
        document.attachment_size,
        document.created_by
      order by document.created_at, document.id
    ) as duplicate_rank
  from public.received_documents document
  where document.source_sheet_name = 'Registro manual'
    and nullif(btrim(document.document_number), '') is not null
) candidate
where candidate.duplicate_rank > 1
  and not exists (select 1 from public.bank_reconciliation_matches reference where reference.received_document_id = candidate.id)
  and not exists (select 1 from public.mail_payment_receipts reference where reference.received_document_id = candidate.id)
  and not exists (select 1 from public.payment_batch_items reference where reference.received_document_id = candidate.id)
  and not exists (select 1 from public.payment_executions reference where reference.received_document_id = candidate.id)
  and not exists (select 1 from public.profitability_cost_allocations reference where reference.received_document_id = candidate.id)
  and not exists (select 1 from public.received_document_lines reference where reference.received_document_id = candidate.id)
  and not exists (select 1 from public.sii_dte_events reference where reference.received_document_id = candidate.id)
  and not exists (select 1 from public.sii_rcv_entries reference where reference.received_document_id = candidate.id);

-- Preserve a recoverable record of any exact, unreferenced manual copy removed
-- while introducing the constraint.
insert into public.audit_log (
  organization_id,
  entity_type,
  entity_id,
  action,
  before_state
)
select
  document.organization_id,
  'received_document',
  document.id,
  'deduplicate_before_unique_constraint',
  to_jsonb(document)
from public.received_documents document
join duplicate_received_documents_to_remove duplicate on duplicate.id = document.id;

delete from public.received_documents document
using duplicate_received_documents_to_remove duplicate
where document.id = duplicate.id;

create unique index received_documents_business_identity_key
on public.received_documents (
  organization_id,
  coalesce(
    nullif(regexp_replace(upper(btrim(supplier_tax_id)), '[^0-9K]', '', 'g'), ''),
    supplier_counterparty_id::text,
    regexp_replace(upper(btrim(supplier_name)), '[[:space:]]+', ' ', 'g')
  ),
  (
    case regexp_replace(translate(lower(btrim(document_type)), 'áéíóúüñ', 'aeiouun'), '[[:space:]]+', ' ', 'g')
      when 'factura' then 'factura afecta'
      when 'nota credito' then 'nota de credito'
      when 'nota de credito' then 'nota de credito'
      when 'nota debito' then 'nota de debito'
      when 'nota de debito' then 'nota de debito'
      else regexp_replace(translate(lower(btrim(document_type)), 'áéíóúüñ', 'aeiouun'), '[[:space:]]+', ' ', 'g')
    end
  ),
  (
    case
      when btrim(document_number) ~ '^[0-9]+$'
        then coalesce(nullif(ltrim(btrim(document_number), '0'), ''), '0')
      else lower(btrim(document_number))
    end
  )
)
where nullif(btrim(document_number), '') is not null;

comment on index public.received_documents_business_identity_key is
  'Prevents duplicate received documents by organization, supplier, normalized type and folio.';
