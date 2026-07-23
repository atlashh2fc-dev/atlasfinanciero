-- Las cuentas directas pueden pagarse en más de una orden. El monto del ítem
-- conserva cada abono y el saldo se obtiene desde las ejecuciones registradas.
-- Estas validaciones se hacen en base de datos para que no existan sobrepagos
-- aunque dos personas preparen pagos al mismo tiempo.

create or replace function public.validate_payment_batch_document_assignment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_row public.received_documents%rowtype;
  payable_row public.direct_payables%rowtype;
  settled_amount numeric(18,2);
begin
  if new.direct_payable_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':' || new.direct_payable_id::text, 0));

    select * into payable_row
    from public.direct_payables
    where id = new.direct_payable_id
      and organization_id = new.organization_id
    for key share;

    if not found or coalesce(payable_row.total_amount, 0) <= 0 then
      raise exception 'Direct payable is not available for payment';
    end if;
    if payable_row.status <> 'approved' or payable_row.is_reference then
      raise exception 'Only approved direct payables can be added to a payment batch';
    end if;
    select coalesce(sum(execution.amount), 0) into settled_amount
    from public.payment_executions execution
    where execution.organization_id = new.organization_id
      and execution.direct_payable_id = new.direct_payable_id;
    if new.amount > payable_row.total_amount - settled_amount + 0.01 then
      raise exception 'Payment batch amount exceeds direct payable outstanding balance';
    end if;
    if new.supplier_name_snapshot is distinct from payable_row.supplier_name
       or new.document_number_snapshot is distinct from coalesce(payable_row.invoice_number, payable_row.payable_number)
       or new.due_date_snapshot is distinct from payable_row.due_date then
      raise exception 'Payment batch snapshots must match the direct payable at assignment time';
    end if;
    if exists (
      select 1
      from public.payment_batch_items item
      join public.payment_batches batch on batch.id = item.payment_batch_id
        and batch.organization_id = item.organization_id
      where item.organization_id = new.organization_id
        and item.direct_payable_id = new.direct_payable_id
        and batch.status in ('draft', 'review', 'approved', 'processing')
        and (tg_op <> 'UPDATE' or item.id <> old.id)
    ) then
      raise exception 'Direct payable already belongs to an active payment batch';
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':' || new.received_document_id::text, 0));
  select * into document_row
  from public.received_documents
  where id = new.received_document_id
    and organization_id = new.organization_id
  for key share;

  if not found or coalesce(document_row.total_amount, 0) <= 0 then
    raise exception 'Received document is not available for payment';
  end if;
  if lower(coalesce(document_row.payment_status, '')) like '%pagada%' then
    raise exception 'Paid received document cannot be added to a payment batch';
  end if;
  if document_row.purchase_match_status not in ('matched', 'exception', 'not_required') then
    raise exception 'Received document requires purchase match or approved exception before payment';
  end if;
  if document_row.purchase_match_status = 'exception'
     and (document_row.purchase_match_approved_at is null or document_row.purchase_match_approved_by is null) then
    raise exception 'Purchase match exception is not approved';
  end if;
  if new.amount > document_row.total_amount then
    raise exception 'Payment batch amount exceeds received document total';
  end if;
  if new.supplier_name_snapshot is distinct from document_row.supplier_name
     or new.document_number_snapshot is distinct from document_row.document_number
     or new.due_date_snapshot is distinct from document_row.due_date then
    raise exception 'Payment batch snapshots must match the received document at assignment time';
  end if;
  if exists (
    select 1
    from public.payment_batch_items item
    join public.payment_batches batch on batch.id = item.payment_batch_id
      and batch.organization_id = item.organization_id
    where item.organization_id = new.organization_id
      and item.received_document_id = new.received_document_id
      and batch.status in ('draft', 'review', 'approved', 'processing')
      and (tg_op <> 'UPDATE' or item.id <> old.id)
  ) then
    raise exception 'Received document already belongs to an active payment batch';
  end if;
  return new;
end;
$$;

create or replace function public.validate_payment_execution()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_amount numeric(18,2);
  settled_amount numeric(18,2);
  batch_status text;
  batch_amount numeric(18,2);
  item_classification public.ias7_cash_flow_classification;
  bank_amount numeric(18,2);
begin
  if new.received_document_id is not null then
    select abs(total_amount) into document_amount from public.received_documents where id = new.received_document_id and organization_id = new.organization_id for key share;
  elsif new.direct_payable_id is not null then
    select abs(total_amount) into document_amount from public.direct_payables where id = new.direct_payable_id and organization_id = new.organization_id for key share;
    select coalesce(sum(amount), 0) into settled_amount
    from public.payment_executions
    where organization_id = new.organization_id
      and direct_payable_id = new.direct_payable_id
      and (tg_op <> 'UPDATE' or id <> old.id);
  else
    select abs(total_amount) into document_amount from public.issued_documents where id = new.issued_document_id and organization_id = new.organization_id for key share;
  end if;
  if document_amount is null or document_amount = 0 then raise exception 'Payment execution requires a payable with a positive amount'; end if;
  if new.amount > document_amount + 0.01 then raise exception 'Payment execution exceeds the payable amount'; end if;
  if new.direct_payable_id is not null and settled_amount + new.amount > document_amount + 0.01 then
    raise exception 'Payment execution exceeds the direct payable outstanding balance';
  end if;
  if new.source = 'payment_batch' then
    select batch.status, batch.total_amount, item.cash_flow_category
      into batch_status, batch_amount, item_classification
    from public.payment_batches batch
    join public.payment_batch_items item
      on item.payment_batch_id = batch.id and item.organization_id = batch.organization_id
    where batch.id = new.payment_batch_id and batch.organization_id = new.organization_id
      and ((new.received_document_id is not null and item.received_document_id = new.received_document_id)
        or (new.direct_payable_id is not null and item.direct_payable_id = new.direct_payable_id))
    for key share;
    if batch_status <> 'paid' or new.direction <> 'outflow' then raise exception 'Only an executed payment order can create an outflow execution'; end if;
    if new.amount > coalesce(batch_amount, 0) + 0.01 then raise exception 'Payment execution exceeds its payment order total'; end if;
    if new.cash_flow_classification is distinct from item_classification then
      raise exception 'Payment execution must retain the IAS 7 classification of its payment proposal item';
    end if;
  elsif new.source = 'bank_reconciliation' then
    select amount into bank_amount from public.bank_transactions where id = new.bank_transaction_id and organization_id = new.organization_id for key share;
    if bank_amount is null or (new.direction = 'inflow' and bank_amount <= 0) or (new.direction = 'outflow' and bank_amount >= 0) then raise exception 'Bank transaction direction does not match payment execution'; end if;
  end if;
  return new;
end;
$$;

revoke all on function public.validate_payment_batch_document_assignment() from public, anon, authenticated;
revoke all on function public.validate_payment_execution() from public, anon, authenticated;

-- Una ejecución representa el abono concreto de un ítem de orden de pago.
-- La conciliación debe asociar exactamente ese importe: no puede conciliar una
-- fracción de una ejecución ni tomar por error otro abono de la misma cuenta.
create or replace function public.materialize_reconciled_payment_execution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  execution_id uuid;
begin
  if new.received_document_id is not null or new.direct_payable_id is not null then
    select execution.id into execution_id
    from public.payment_executions execution
    where execution.organization_id = new.organization_id
      and (
        (new.received_document_id is not null and execution.received_document_id = new.received_document_id)
        or (new.direct_payable_id is not null and execution.direct_payable_id = new.direct_payable_id)
      )
      and execution.source = 'payment_batch'
      and execution.bank_transaction_id is null
      and abs(execution.amount - new.matched_amount) <= 0.01
    order by execution.created_at desc
    limit 1
    for update;
    if execution_id is null then
      raise exception 'Bank match must equal an unreconciled payment execution for this payable';
    end if;
    update public.payment_executions
    set bank_transaction_id = new.bank_transaction_id,
        status = 'reconciled',
        reconciled_at = now(),
        reconciled_by = auth.uid()
    where id = execution_id;
  else
    insert into public.payment_executions (
      organization_id, direction, source, status, issued_document_id,
      bank_transaction_id, amount, executed_on, payment_method,
      payment_reference, notes, created_by, reconciled_at, reconciled_by
    ) values (
      new.organization_id, 'inflow', 'bank_reconciliation', 'reconciled',
      new.issued_document_id, new.bank_transaction_id, new.matched_amount,
      new.matched_on, 'Conciliación bancaria', null, new.notes, auth.uid(), now(), auth.uid()
    ) returning id into execution_id;
  end if;
  update public.bank_reconciliation_matches
  set payment_execution_id = execution_id
  where id = new.id and organization_id = new.organization_id;
  return new;
end;
$$;

revoke all on function public.materialize_reconciled_payment_execution() from public, anon, authenticated;
