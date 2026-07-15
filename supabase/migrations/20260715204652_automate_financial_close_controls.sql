-- El cierre no depende de marcar casillas: estas cuatro validaciones se
-- calculan desde los módulos operativos. Sólo la revisión de gestión requiere
-- juicio y evidencia explícita de Finanzas.

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
  ) documents;

  return jsonb_build_object(
    'documents_reviewed', jsonb_build_object(
      'state', case when unclassified_documents = 0 then 'passed' else 'blocked' end,
      'issues', unclassified_documents,
      'observed', document_count,
      'summary', case when unclassified_documents = 0 then document_count || ' documento(s) clasificado(s).' else unclassified_documents || ' documento(s) sin tipo o clasificación.' end
    ),
    'bank_reconciliation', jsonb_build_object(
      'state', case when unreconciled_transactions = 0 then 'passed' else 'blocked' end,
      'issues', unreconciled_transactions,
      'summary', case when unreconciled_transactions = 0 then 'Todos los movimientos del período están conciliados.' else unreconciled_transactions || ' movimiento(s) bancario(s) sin conciliar.' end
    ),
    'receivables_payables', jsonb_build_object(
      'state', case when aging_without_due_date = 0 then 'passed' else 'blocked' end,
      'issues', aging_without_due_date,
      'summary', case when aging_without_due_date = 0 then 'Aging generado desde documentos con vencimiento.' else aging_without_due_date || ' saldo(s) abierto(s) sin fecha de vencimiento.' end
    ),
    'journal_entries', jsonb_build_object(
      'state', case when draft_entries = 0 then 'passed' else 'blocked' end,
      'issues', draft_entries,
      'summary', case when draft_entries = 0 then 'No existen asientos en borrador.' else draft_entries || ' asiento(s) contable(s) en borrador.' end
    )
  );
end;
$$;

create or replace function public.enforce_financial_close_task_editability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  period_status public.financial_period_status;
begin
  select status into period_status
  from public.financial_periods
  where id = case when tg_op = 'DELETE' then old.financial_period_id else new.financial_period_id end
    and organization_id = case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;

  if period_status in ('closed', 'locked') then
    raise exception 'Close checklist cannot be changed after the financial period is closed';
  end if;

  if tg_op = 'UPDATE' then
    if new.organization_id <> old.organization_id
      or new.financial_period_id <> old.financial_period_id
      or new.task_code <> old.task_code
      or new.title <> old.title
      or new.description is distinct from old.description then
      raise exception 'Close checklist definition is immutable';
    end if;
    if new.task_code <> 'management_review'
      and (new.status is distinct from old.status or new.evidence_note is distinct from old.evidence_note) then
      raise exception 'Automatic close controls are calculated from operational data';
    end if;
    if new.status = 'completed' then
      if old.status = 'completed' then
        new.completed_at := old.completed_at;
        new.completed_by := old.completed_by;
      else
        new.completed_at := now();
        new.completed_by := auth.uid();
      end if;
    else
      new.completed_at := null;
      new.completed_by := null;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.transition_financial_period(
  p_financial_period_id uuid,
  p_target_status public.financial_period_status,
  p_reason text default null
)
returns public.financial_periods
language plpgsql
security definer
set search_path = ''
as $$
declare
  period_row public.financial_periods;
  previous_status public.financial_period_status;
  actor_role public.organization_role;
  management_review_pending integer;
  controls jsonb;
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select period.* into period_row from public.financial_periods period where period.id = p_financial_period_id for update;
  if not found then raise exception 'Financial period not found'; end if;
  previous_status := period_row.status;
  select membership.role into actor_role from public.organization_memberships membership
  where membership.organization_id = period_row.organization_id and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then raise exception 'Finance access required'; end if;
  if p_target_status = previous_status then return period_row; end if;
  if p_target_status = 'soft_closed' then
    if previous_status <> 'open' then raise exception 'Only open periods can be soft closed'; end if;
  elsif p_target_status in ('closed', 'locked') then
    if previous_status not in ('open', 'soft_closed')
      and not (p_target_status = 'locked' and previous_status = 'closed') then
      raise exception 'Only open or soft closed periods can be closed';
    end if;
    controls := public.financial_close_control_snapshot(period_row.id);
    if controls->'documents_reviewed'->>'state' = 'blocked' then raise exception '%', controls->'documents_reviewed'->>'summary'; end if;
    if controls->'bank_reconciliation'->>'state' = 'blocked' then raise exception '%', controls->'bank_reconciliation'->>'summary'; end if;
    if controls->'receivables_payables'->>'state' = 'blocked' then raise exception '%', controls->'receivables_payables'->>'summary'; end if;
    if controls->'journal_entries'->>'state' = 'blocked' then raise exception '%', controls->'journal_entries'->>'summary'; end if;
    select count(*) into management_review_pending from public.financial_period_close_tasks task
    where task.financial_period_id = period_row.id
      and task.task_code = 'management_review'
      and task.status = 'pending';
    if management_review_pending > 0 then raise exception 'Management review must be completed or marked not applicable before closing'; end if;
  elsif p_target_status = 'open' then
    if previous_status not in ('soft_closed', 'closed', 'locked') then raise exception 'Invalid period reopening'; end if;
    if actor_role <> 'administrator' then raise exception 'Only administrators can reopen a period'; end if;
    if normalized_reason is null then raise exception 'A reason is required to reopen a financial period'; end if;
  else
    raise exception 'Unsupported financial period transition';
  end if;
  perform set_config('app.financial_period_transition', 'on', true);
  update public.financial_periods set
    status = p_target_status,
    closed_at = case when p_target_status in ('closed', 'locked') then now() else null end,
    closed_by = case when p_target_status in ('closed', 'locked') then auth.uid() else null end
  where id = period_row.id returning * into period_row;
  insert into public.financial_period_close_events (organization_id, financial_period_id, from_status, to_status, reason, actor_id)
  values (period_row.organization_id, period_row.id, previous_status, p_target_status, normalized_reason, auth.uid());
  return period_row;
end;
$$;

revoke all on function public.financial_close_control_snapshot(uuid) from public, anon;
grant execute on function public.financial_close_control_snapshot(uuid) to authenticated;
revoke all on function public.enforce_financial_close_task_editability() from public, anon, authenticated;
revoke all on function public.transition_financial_period(uuid, public.financial_period_status, text) from public, anon;
