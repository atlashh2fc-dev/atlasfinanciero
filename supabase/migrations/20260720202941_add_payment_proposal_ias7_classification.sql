-- La propuesta de pago clasifica su futuro flujo de caja según IAS 7. Se
-- conserva el nombre técnico payment_batches para no romper integraciones ni
-- historial; la interfaz puede llamarla propuesta/orden de pago.
create type public.ias7_cash_flow_classification as enum ('operating', 'investing', 'financing');

alter table public.payment_batches
  add column cash_flow_classification public.ias7_cash_flow_classification not null default 'operating';

alter table public.payment_executions
  add column cash_flow_classification public.ias7_cash_flow_classification;

-- Conserva una foto de la clasificación cuando la orden se ejecuta. Las
-- ejecuciones históricas o de conciliación independiente quedan sin clasificar
-- hasta que exista información suficiente; nunca se asume una clasificación.
update public.payment_executions execution
set cash_flow_classification = batch.cash_flow_classification
from public.payment_batches batch
where execution.payment_batch_id = batch.id
  and execution.organization_id = batch.organization_id
  and execution.cash_flow_classification is null;

create index payment_batches_organization_ias7_status_idx
  on public.payment_batches (organization_id, cash_flow_classification, status, scheduled_for);
create index payment_executions_organization_ias7_date_idx
  on public.payment_executions (organization_id, cash_flow_classification, executed_on desc)
  where cash_flow_classification is not null;

create or replace function public.validate_payment_execution()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_amount numeric(18,2);
  batch_status text;
  batch_amount numeric(18,2);
  batch_classification public.ias7_cash_flow_classification;
  bank_amount numeric(18,2);
begin
  if new.received_document_id is not null then
    select abs(total_amount) into document_amount
    from public.received_documents
    where id = new.received_document_id and organization_id = new.organization_id
    for key share;
  elsif new.direct_payable_id is not null then
    select abs(total_amount) into document_amount
    from public.direct_payables
    where id = new.direct_payable_id and organization_id = new.organization_id
    for key share;
  else
    select abs(total_amount) into document_amount
    from public.issued_documents
    where id = new.issued_document_id and organization_id = new.organization_id
    for key share;
  end if;
  if document_amount is null or document_amount = 0 then raise exception 'Payment execution requires a payable with a positive amount'; end if;
  if new.amount > document_amount + 0.01 then raise exception 'Payment execution exceeds the payable amount'; end if;
  if new.source = 'payment_batch' then
    select status, total_amount, cash_flow_classification
      into batch_status, batch_amount, batch_classification
    from public.payment_batches
    where id = new.payment_batch_id and organization_id = new.organization_id
    for key share;
    if batch_status <> 'paid' or new.direction <> 'outflow' then raise exception 'Only an executed payment order can create an outflow execution'; end if;
    if new.amount > coalesce(batch_amount, 0) + 0.01 then raise exception 'Payment execution exceeds its payment order total'; end if;
    if new.cash_flow_classification is distinct from batch_classification then
      raise exception 'Payment execution must retain the IAS 7 classification of its payment proposal';
    end if;
  elsif new.source = 'bank_reconciliation' then
    select amount into bank_amount from public.bank_transactions where id = new.bank_transaction_id and organization_id = new.organization_id for key share;
    if bank_amount is null or (new.direction = 'inflow' and bank_amount <= 0) or (new.direction = 'outflow' and bank_amount >= 0) then raise exception 'Bank transaction direction does not match payment execution'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.create_payment_executions_for_paid_batch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> 'paid' and new.status = 'paid' then
    insert into public.payment_executions (
      organization_id, direction, source, status, received_document_id,
      payment_batch_id, amount, executed_on, payment_method,
      payment_reference, notes, created_by, cash_flow_classification
    )
    select item.organization_id, 'outflow', 'payment_batch', 'executed',
      item.received_document_id, new.id, item.amount, new.paid_at::date,
      'Orden de pago', new.payment_reference,
      concat('Ejecutado por orden de pago ', new.batch_number), auth.uid(),
      new.cash_flow_classification
    from public.payment_batch_items item
    where item.payment_batch_id = new.id and item.organization_id = new.organization_id
      and item.received_document_id is not null;
    insert into public.payment_executions (
      organization_id, direction, source, status, direct_payable_id,
      payment_batch_id, amount, executed_on, payment_method,
      payment_reference, notes, created_by, cash_flow_classification
    )
    select item.organization_id, 'outflow', 'payment_batch', 'executed',
      item.direct_payable_id, new.id, item.amount, new.paid_at::date,
      'Orden de pago', new.payment_reference,
      concat('Ejecutado por orden de pago ', new.batch_number), auth.uid(),
      new.cash_flow_classification
    from public.payment_batch_items item
    where item.payment_batch_id = new.id and item.organization_id = new.organization_id
      and item.direct_payable_id is not null;
  end if;
  return new;
end;
$$;

revoke all on function public.validate_payment_execution() from public, anon, authenticated;
revoke all on function public.create_payment_executions_for_paid_batch() from public, anon, authenticated;
