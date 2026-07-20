-- Una cuenta directa pagada por lote debe generar el mismo hecho financiero
-- y conciliable que una factura recibida. De otro modo queda pagada sólo en
-- su módulo de origen y se rompe la trazabilidad de Tesorería.
alter table public.payment_executions
  add column direct_payable_id uuid,
  add constraint payment_executions_direct_payable_id_organization_fkey
    foreign key (direct_payable_id, organization_id)
    references public.direct_payables (id, organization_id) on delete restrict;

alter table public.payment_executions
  drop constraint payment_executions_check,
  drop constraint payment_executions_check1,
  add constraint payment_executions_one_payable_check
    check (num_nonnulls(received_document_id, issued_document_id, direct_payable_id) = 1),
  add constraint payment_executions_direction_payable_check
    check ((direction = 'outflow') = (received_document_id is not null or direct_payable_id is not null));

create unique index payment_executions_batch_direct_payable_idx
  on public.payment_executions (payment_batch_id, direct_payable_id)
  where payment_batch_id is not null and direct_payable_id is not null;
create unique index payment_executions_bank_direct_payable_idx
  on public.payment_executions (bank_transaction_id, direct_payable_id)
  where bank_transaction_id is not null and direct_payable_id is not null;
create index payment_executions_direct_payable_idx
  on public.payment_executions (organization_id, direct_payable_id, executed_on desc)
  where direct_payable_id is not null;

alter table public.bank_reconciliation_matches
  add column direct_payable_id uuid,
  add constraint bank_reconciliation_matches_direct_payable_organization_fkey
    foreign key (direct_payable_id, organization_id)
    references public.direct_payables (id, organization_id) on delete restrict,
  drop constraint bank_reconciliation_matches_one_document_check,
  add constraint bank_reconciliation_matches_one_payable_check
    check (num_nonnulls(issued_document_id, received_document_id, direct_payable_id) = 1);
create index bank_reconciliation_matches_direct_payable_idx
  on public.bank_reconciliation_matches (direct_payable_id)
  where direct_payable_id is not null;

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
    select status, total_amount into batch_status, batch_amount from public.payment_batches where id = new.payment_batch_id and organization_id = new.organization_id for key share;
    if batch_status <> 'paid' or new.direction <> 'outflow' then raise exception 'Only a paid payment batch can create an outflow execution'; end if;
    if new.amount > coalesce(batch_amount, 0) + 0.01 then raise exception 'Payment execution exceeds its batch total'; end if;
  elsif new.source = 'bank_reconciliation' then
    select amount into bank_amount from public.bank_transactions where id = new.bank_transaction_id and organization_id = new.organization_id for key share;
    if bank_amount is null or (new.direction = 'inflow' and bank_amount <= 0) or (new.direction = 'outflow' and bank_amount >= 0) then raise exception 'Bank transaction direction does not match payment execution'; end if;
  end if;
  return new;
end;
$$;

-- También materializa pagos directos históricos, para que no existan saldos
-- pagados que sólo vivan en el módulo de cuentas por pagar.
insert into public.payment_executions (
  organization_id, direction, source, status, direct_payable_id, amount,
  executed_on, payment_method, payment_reference, notes, created_by, created_at
)
select payable.organization_id, 'outflow', 'legacy_import', 'legacy', payable.id,
  abs(payable.total_amount), coalesce(payable.paid_at::date, payable.issue_date, current_date),
  'Pago histórico', payable.payment_reference, 'Pago histórico de cuenta directa migrado.',
  payable.created_by, coalesce(payable.paid_at, payable.created_at, now())
from public.direct_payables payable
where payable.status = 'paid'
  and abs(coalesce(payable.total_amount, 0)) > 0
  and not exists (
    select 1 from public.payment_executions execution
    where execution.organization_id = payable.organization_id
      and execution.direct_payable_id = payable.id
  );

create or replace function public.sync_payment_execution_to_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  settled_amount numeric(18,2);
  document_amount numeric(18,2);
begin
  if new.received_document_id is not null then
    select coalesce(sum(amount), 0) into settled_amount from public.payment_executions where organization_id = new.organization_id and received_document_id = new.received_document_id;
    select abs(total_amount) into document_amount from public.received_documents where id = new.received_document_id and organization_id = new.organization_id;
    if settled_amount >= document_amount then
      update public.received_documents set payment_status = 'Pagada', payment_date = new.executed_on, payment_method = coalesce(new.payment_method, 'Pago registrado'), payment_reference = new.payment_reference, payment_notes = coalesce(new.notes, 'Pago registrado en el libro de ejecuciones.'), payment_recorded_at = now(), payment_recorded_by = coalesce(new.created_by, auth.uid()) where id = new.received_document_id and organization_id = new.organization_id;
    end if;
  elsif new.direct_payable_id is not null then
    select coalesce(sum(amount), 0) into settled_amount from public.payment_executions where organization_id = new.organization_id and direct_payable_id = new.direct_payable_id;
    select abs(total_amount) into document_amount from public.direct_payables where id = new.direct_payable_id and organization_id = new.organization_id;
    if settled_amount >= document_amount then
      update public.direct_payables set status = 'paid', paid_at = coalesce(paid_at, new.executed_on::timestamptz), payment_reference = coalesce(new.payment_reference, payment_reference) where id = new.direct_payable_id and organization_id = new.organization_id and status = 'approved';
    end if;
  else
    select coalesce(sum(amount), 0) into settled_amount from public.payment_executions where organization_id = new.organization_id and issued_document_id = new.issued_document_id;
    select abs(total_amount) into document_amount from public.issued_documents where id = new.issued_document_id and organization_id = new.organization_id;
    if settled_amount >= document_amount then update public.issued_documents set payment_status = 'Pagada', payment_date = new.executed_on, payment_method = coalesce(new.payment_method, 'Cobro registrado') where id = new.issued_document_id and organization_id = new.organization_id; end if;
  end if;
  return new;
end;
$$;

create or replace function public.validate_bank_reconciliation_match()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare transaction_amount numeric(18,2); payable_amount numeric(18,2); already_matched numeric(18,2);
begin
  select abs(amount) into transaction_amount from public.bank_transactions where id = new.bank_transaction_id and organization_id = new.organization_id for update;
  if transaction_amount is null then raise exception 'bank transaction is not available in this organization'; end if;
  select coalesce(sum(matched_amount), 0) into already_matched from public.bank_reconciliation_matches where bank_transaction_id = new.bank_transaction_id and (tg_op <> 'UPDATE' or id <> old.id);
  if already_matched + new.matched_amount > transaction_amount then raise exception 'reconciliation amount exceeds bank transaction amount'; end if;
  if new.issued_document_id is not null then
    select abs(coalesce(total_amount, 0)) into payable_amount from public.issued_documents where id = new.issued_document_id and organization_id = new.organization_id for update;
    select coalesce(sum(matched_amount), 0) into already_matched from public.bank_reconciliation_matches where issued_document_id = new.issued_document_id and (tg_op <> 'UPDATE' or id <> old.id);
  elsif new.direct_payable_id is not null then
    select abs(coalesce(total_amount, 0)) into payable_amount from public.direct_payables where id = new.direct_payable_id and organization_id = new.organization_id for update;
    select coalesce(sum(matched_amount), 0) into already_matched from public.bank_reconciliation_matches where direct_payable_id = new.direct_payable_id and (tg_op <> 'UPDATE' or id <> old.id);
  else
    select abs(coalesce(total_amount, 0)) into payable_amount from public.received_documents where id = new.received_document_id and organization_id = new.organization_id for update;
    select coalesce(sum(matched_amount), 0) into already_matched from public.bank_reconciliation_matches where received_document_id = new.received_document_id and (tg_op <> 'UPDATE' or id <> old.id);
  end if;
  if payable_amount is null or payable_amount = 0 then raise exception 'reconciliation payable is not available or has no amount'; end if;
  if already_matched + new.matched_amount > payable_amount then raise exception 'reconciliation amount exceeds payable amount'; end if;
  return new;
end;
$$;

create or replace function public.materialize_reconciled_payment_execution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare execution_id uuid;
begin
  if new.received_document_id is not null or new.direct_payable_id is not null then
    select id into execution_id from public.payment_executions where organization_id = new.organization_id
      and ((new.received_document_id is not null and received_document_id = new.received_document_id) or (new.direct_payable_id is not null and direct_payable_id = new.direct_payable_id))
      and source = 'payment_batch' and bank_transaction_id is null order by created_at desc limit 1 for update;
    if execution_id is null then raise exception 'Supplier payment must be executed through a paid payment batch before bank reconciliation'; end if;
    update public.payment_executions set bank_transaction_id = new.bank_transaction_id, status = 'reconciled', reconciled_at = now(), reconciled_by = auth.uid() where id = execution_id;
  else
    insert into public.payment_executions (organization_id, direction, source, status, issued_document_id, bank_transaction_id, amount, executed_on, payment_method, payment_reference, notes, created_by, reconciled_at, reconciled_by)
    values (new.organization_id, 'inflow', 'bank_reconciliation', 'reconciled', new.issued_document_id, new.bank_transaction_id, new.matched_amount, new.matched_on, 'Conciliación bancaria', null, new.notes, auth.uid(), now(), auth.uid()) returning id into execution_id;
  end if;
  update public.bank_reconciliation_matches set payment_execution_id = execution_id where id = new.id and organization_id = new.organization_id;
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
    insert into public.payment_executions (organization_id, direction, source, status, received_document_id, payment_batch_id, amount, executed_on, payment_method, payment_reference, notes, created_by)
    select item.organization_id, 'outflow', 'payment_batch', 'executed', item.received_document_id, new.id, item.amount, new.paid_at::date, 'Lote de pago', new.payment_reference, concat('Ejecutado por lote ', new.batch_number), auth.uid()
    from public.payment_batch_items item where item.payment_batch_id = new.id and item.organization_id = new.organization_id and item.received_document_id is not null;
    insert into public.payment_executions (organization_id, direction, source, status, direct_payable_id, payment_batch_id, amount, executed_on, payment_method, payment_reference, notes, created_by)
    select item.organization_id, 'outflow', 'payment_batch', 'executed', item.direct_payable_id, new.id, item.amount, new.paid_at::date, 'Lote de pago', new.payment_reference, concat('Ejecutado por lote ', new.batch_number), auth.uid()
    from public.payment_batch_items item where item.payment_batch_id = new.id and item.organization_id = new.organization_id and item.direct_payable_id is not null;
  end if;
  return new;
end;
$$;

revoke all on function public.validate_payment_execution() from public, anon, authenticated;
revoke all on function public.sync_payment_execution_to_document() from public, anon, authenticated;
revoke all on function public.validate_bank_reconciliation_match() from public, anon, authenticated;
revoke all on function public.materialize_reconciled_payment_execution() from public, anon, authenticated;
revoke all on function public.create_payment_executions_for_paid_batch() from public, anon, authenticated;
