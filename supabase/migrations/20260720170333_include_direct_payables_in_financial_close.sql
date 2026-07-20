-- Las cuentas por pagar directas son obligaciones reales: deben participar en
-- los controles automáticos de cierre igual que las facturas recibidas.
create or replace function public.financial_close_control_snapshot(
  p_financial_period_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  period_row public.financial_periods;
  unclassified_documents integer;
  unreconciled_transactions integer;
  draft_entries integer;
  aging_without_due_date integer;
  document_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select period.* into period_row
  from public.financial_periods period
  where period.id = p_financial_period_id;
  if not found then raise exception 'Financial period not found'; end if;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = period_row.organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('administrator', 'finance', 'auditor')
  ) then raise exception 'Financial close access required'; end if;

  select count(*) into document_count from (
    select document.id from public.issued_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date between period_row.period_start and period_row.period_end
    union all
    select document.id from public.received_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date between period_row.period_start and period_row.period_end
    union all
    select payable.id from public.direct_payables payable
    where payable.organization_id = period_row.organization_id
      and payable.issue_date between period_row.period_start and period_row.period_end
      and payable.status <> 'cancelled'
  ) documents;

  select count(*) into unclassified_documents from (
    select document.id from public.issued_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date between period_row.period_start and period_row.period_end
      and nullif(btrim(coalesce(document.document_type, '')), '') is null
    union all
    select document.id from public.received_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date between period_row.period_start and period_row.period_end
      and nullif(btrim(coalesce(document.document_type, '')), '') is null
    union all
    select payable.id from public.direct_payables payable
    where payable.organization_id = period_row.organization_id
      and payable.issue_date between period_row.period_start and period_row.period_end
      and payable.status <> 'cancelled'
      and payable.cost_center_id is null
  ) documents;

  select count(*) into unreconciled_transactions
  from public.bank_transactions transaction
  where transaction.organization_id = period_row.organization_id
    and transaction.booked_on between period_row.period_start and period_row.period_end
    and transaction.reconciliation_status <> 'reconciled';

  select count(*) into draft_entries
  from public.accounting_entries entry
  where entry.organization_id = period_row.organization_id
    and entry.financial_period_id = period_row.id
    and entry.status = 'draft';

  select count(*) into aging_without_due_date from (
    select document.id from public.issued_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date <= period_row.period_end
      and coalesce(nullif(btrim(coalesce(document.payment_status, '')), ''), 'Pendiente') not in ('Pagada', 'pagada', 'Paid', 'paid')
      and document.due_date is null
    union all
    select document.id from public.received_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date <= period_row.period_end
      and coalesce(nullif(btrim(coalesce(document.payment_status, '')), ''), 'Pendiente') not in ('Pagada', 'pagada', 'Paid', 'paid')
      and document.due_date is null
    union all
    select payable.id from public.direct_payables payable
    where payable.organization_id = period_row.organization_id
      and payable.issue_date <= period_row.period_end
      and payable.status not in ('paid', 'cancelled')
      and payable.due_date is null
  ) documents;

  return jsonb_build_object(
    'documents_reviewed', jsonb_build_object(
      'state', case when unclassified_documents = 0 then 'passed' else 'blocked' end,
      'issues', unclassified_documents,
      'observed', document_count,
      'summary', case when unclassified_documents = 0 then document_count || ' documento(s) y cuenta(s) clasificado(s).' else unclassified_documents || ' documento(s) o cuenta(s) sin clasificación o centro de costo.' end
    ),
    'bank_reconciliation', jsonb_build_object(
      'state', case when unreconciled_transactions = 0 then 'passed' else 'blocked' end,
      'issues', unreconciled_transactions,
      'summary', case when unreconciled_transactions = 0 then 'Todos los movimientos del período están conciliados.' else unreconciled_transactions || ' movimiento(s) bancario(s) sin conciliar.' end
    ),
    'receivables_payables', jsonb_build_object(
      'state', case when aging_without_due_date = 0 then 'passed' else 'blocked' end,
      'issues', aging_without_due_date,
      'summary', case when aging_without_due_date = 0 then 'Aging generado desde documentos y cuentas por pagar con vencimiento.' else aging_without_due_date || ' saldo(s) abierto(s) sin fecha de vencimiento.' end
    ),
    'journal_entries', jsonb_build_object(
      'state', case when draft_entries = 0 then 'passed' else 'blocked' end,
      'issues', draft_entries,
      'summary', case when draft_entries = 0 then 'No existen asientos en borrador.' else draft_entries || ' asiento(s) contable(s) en borrador.' end
    )
  );
end;
$$;
