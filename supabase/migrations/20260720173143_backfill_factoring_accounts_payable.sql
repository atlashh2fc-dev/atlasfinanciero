-- Vincula los factorings históricos por su nombre y crea la obligación de caja
-- pendiente, de modo que los documentos ya registrados también aparezcan en CxP.
with matched as (
  select document.id as document_id, counterparty.id as counterparty_id,
    coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name) as canonical_name
  from public.issued_documents document
  join lateral (
    select supplier.* from public.counterparties supplier
    where supplier.organization_id = document.organization_id
      and supplier.is_active and supplier.kind in ('supplier', 'both')
      and document.factoring_entity is not null
      and regexp_replace(lower(supplier.legal_name), '[^[:alnum:]]+', '', 'g') like '%' || regexp_replace(lower(document.factoring_entity), '[^[:alnum:]]+', '', 'g') || '%'
    order by length(supplier.legal_name)
    limit 1
  ) counterparty on true
  where document.payment_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring')
    and document.factoring_counterparty_id is null
)
update public.issued_documents document
set factoring_counterparty_id = matched.counterparty_id,
    factoring_entity = matched.canonical_name
from matched where document.id = matched.document_id;

insert into public.direct_payables (
  organization_id, payable_number, supplier_counterparty_id, supplier_name,
  category, category_detail, description, issue_date, due_date, currency_code,
  total_amount, status, approved_at, notes, factoring_issued_document_id
)
select document.organization_id, 'FAC-' || upper(left(document.id::text, 8)),
  document.factoring_counterparty_id, document.factoring_entity,
  'other', 'Factoring', 'Obligación de factoring · documento ' || coalesce(document.document_number, 'sin folio'),
  document.issue_date, coalesce(document.factoring_settled_at, document.factoring_recourse_at, document.due_date, document.issue_date),
  'CLP', document.total_amount, 'approved', now(),
  'Generada desde documento factorizado histórico ' || coalesce(document.document_number, document.id::text), document.id
from public.issued_documents document
where document.payment_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring')
  and document.factoring_counterparty_id is not null
  and document.total_amount > 0
  and not exists (select 1 from public.direct_payables payable where payable.factoring_issued_document_id = document.id);
