-- Una propuesta puede combinar operación, inversión y financiamiento. La
-- clasificación es del ítem pagadero; la cabecera se mantiene únicamente como
-- resumen derivado para compatibilidad con consumidores existentes.
alter table public.payment_batches
  alter column cash_flow_classification drop not null,
  alter column cash_flow_classification drop default;

alter table public.payment_batch_items
  add column cash_flow_category public.ias7_cash_flow_classification not null default 'operating';

create index payment_batch_items_ias7_category_idx
  on public.payment_batch_items (payment_batch_id, cash_flow_category);

create or replace function public.refresh_procure_to_pay_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_batch_id uuid;
  v_batch_classification public.ias7_cash_flow_classification;
begin
  if tg_table_name = 'vendor_purchase_order_lines' then
    v_order_id := case when tg_op = 'DELETE' then old.purchase_order_id else new.purchase_order_id end;
    update public.vendor_purchase_orders set
      net_amount = coalesce((select sum(net_amount) from public.vendor_purchase_order_lines where purchase_order_id = v_order_id), 0),
      vat_amount = round(coalesce((select sum(net_amount) from public.vendor_purchase_order_lines where purchase_order_id = v_order_id), 0) * 0.19, 2),
      total_amount = round(coalesce((select sum(net_amount) from public.vendor_purchase_order_lines where purchase_order_id = v_order_id), 0) * 1.19, 2)
    where id = v_order_id;
  else
    v_batch_id := case when tg_op = 'DELETE' then old.payment_batch_id else new.payment_batch_id end;
    select case when count(distinct item.cash_flow_category) = 1 then min(item.cash_flow_category::text)::public.ias7_cash_flow_classification else null end
      into v_batch_classification
    from public.payment_batch_items item
    where item.payment_batch_id = v_batch_id;
    update public.payment_batches set
      total_amount = coalesce((select sum(amount) from public.payment_batch_items where payment_batch_id = v_batch_id), 0),
      cash_flow_classification = v_batch_classification
    where id = v_batch_id;
  end if;
  return coalesce(new, old);
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
  batch_status text;
  batch_amount numeric(18,2);
  item_classification public.ias7_cash_flow_classification;
  bank_amount numeric(18,2);
begin
  if new.received_document_id is not null then
    select abs(total_amount) into document_amount from public.received_documents where id = new.received_document_id and organization_id = new.organization_id for key share;
  elsif new.direct_payable_id is not null then
    select abs(total_amount) into document_amount from public.direct_payables where id = new.direct_payable_id and organization_id = new.organization_id for key share;
  else
    select abs(total_amount) into document_amount from public.issued_documents where id = new.issued_document_id and organization_id = new.organization_id for key share;
  end if;
  if document_amount is null or document_amount = 0 then raise exception 'Payment execution requires a payable with a positive amount'; end if;
  if new.amount > document_amount + 0.01 then raise exception 'Payment execution exceeds the payable amount'; end if;
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
      item.cash_flow_category
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
      item.cash_flow_category
    from public.payment_batch_items item
    where item.payment_batch_id = new.id and item.organization_id = new.organization_id
      and item.direct_payable_id is not null;
  end if;
  return new;
end;
$$;

revoke all on function public.refresh_procure_to_pay_totals() from public, anon, authenticated;
revoke all on function public.validate_payment_execution() from public, anon, authenticated;
revoke all on function public.create_payment_executions_for_paid_batch() from public, anon, authenticated;
