-- Un solo libro de cobros para facturas emitidas.
-- Tesorería conserva la conciliación bancaria, pero cada ejecución de cobro se
-- refleja en issued_document_payments, que es la única fuente del saldo y estado.
alter table public.issued_document_payments
  add column payment_execution_id uuid
    references public.payment_executions(id) on delete cascade;

create unique index issued_document_payments_payment_execution_id_key
  on public.issued_document_payments (payment_execution_id)
  where payment_execution_id is not null;

-- CLP se liquida sin centavos. Algunos documentos importados conservan decimales
-- por el cálculo de IVA, mientras que sus cobros históricos están redondeados.
create or replace function public.sync_issued_document_payment_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_id uuid;
  document_organization_id uuid;
  document_total numeric(18, 2);
  existing_status text;
  paid_total numeric(18, 2);
  latest_paid_on date;
  latest_method text;
begin
  document_id := case when tg_op = 'DELETE' then old.issued_document_id else new.issued_document_id end;

  select organization_id, round(coalesce(total_amount, 0), 0), payment_status
    into document_organization_id, document_total, existing_status
  from public.issued_documents
  where id = document_id
  for update;

  if not found then
    raise exception 'Issued document % does not exist', document_id;
  end if;

  if tg_op <> 'DELETE' and new.organization_id <> document_organization_id then
    raise exception 'Payment organization must match the issued document organization';
  end if;

  if existing_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito') then
    raise exception 'A payment cannot be registered for a document in status %', existing_status;
  end if;

  select coalesce(sum(amount), 0), max(paid_on)
    into paid_total, latest_paid_on
  from public.issued_document_payments
  where issued_document_id = document_id
    and (tg_op <> 'DELETE' or id <> old.id);

  select payment_method
    into latest_method
  from public.issued_document_payments
  where issued_document_id = document_id
    and (tg_op <> 'DELETE' or id <> old.id)
  order by paid_on desc, created_at desc
  limit 1;

  if tg_op = 'INSERT' then
    paid_total := paid_total + new.amount;
    if latest_paid_on is null or new.paid_on >= latest_paid_on then
      latest_paid_on := new.paid_on;
      latest_method := new.payment_method;
    end if;
  elsif tg_op = 'UPDATE' then
    paid_total := paid_total - old.amount + new.amount;
    if latest_paid_on is null or new.paid_on >= latest_paid_on then
      latest_paid_on := new.paid_on;
      latest_method := new.payment_method;
    end if;
  end if;

  if document_total <= 0 then
    raise exception 'The issued document must have a positive total before registering payments';
  end if;

  if paid_total > document_total then
    raise exception 'The payment amount exceeds the outstanding balance';
  end if;

  update public.issued_documents
  set payment_status = case
        when paid_total >= document_total then 'Pagada'
        when paid_total > 0 then 'Abonada'
        else 'Pendiente'
      end,
      payment_date = case when paid_total > 0 then latest_paid_on else null end,
      payment_method = case when paid_total > 0 then latest_method else null end
  where id = document_id;

  return coalesce(new, old);
end;
$$;

-- Los cobros conciliados o ejecutados desde Tesorería se materializan como un
-- abono idempotente. El identificador de ejecución evita duplicarlos.
create or replace function public.sync_payment_execution_to_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  settled_amount numeric(18,2);
  document_amount numeric(18,2);
  issued_document_status text;
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
    select payment_status into issued_document_status
    from public.issued_documents
    where id = new.issued_document_id
      and organization_id = new.organization_id;
    -- El factoring y los documentos anulados no son cobros de cliente. Sus
    -- ejecuciones permanecen en Tesorería, sin convertirlas en un abono.
    if issued_document_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito') then
      return new;
    end if;
    insert into public.issued_document_payments (
      organization_id, issued_document_id, payment_execution_id, amount, paid_on,
      payment_method, notes, created_by
    ) values (
      new.organization_id, new.issued_document_id, new.id, new.amount, new.executed_on,
      coalesce(new.payment_method, 'Cobro conciliado'), left(coalesce(new.notes, 'Cobro registrado desde Tesorería.'), 2000), new.created_by
    )
    on conflict (payment_execution_id) where payment_execution_id is not null do update
    set amount = excluded.amount,
        paid_on = excluded.paid_on,
        payment_method = excluded.payment_method,
        notes = excluded.notes;
  end if;
  return new;
end;
$$;

-- Conciliación de los cobros ya existentes. No se borran ni se alteran las
-- ejecuciones: sólo se vinculan a su asiento de cobro equivalente.
insert into public.issued_document_payments (
  organization_id, issued_document_id, payment_execution_id, amount, paid_on,
  payment_method, notes, created_by, created_at
)
select
  execution.organization_id,
  execution.issued_document_id,
  execution.id,
  execution.amount,
  execution.executed_on,
  coalesce(execution.payment_method, 'Cobro histórico'),
  left(coalesce(execution.notes, 'Cobro histórico conciliado desde Tesorería.'), 2000),
  execution.created_by,
  coalesce(execution.created_at, now())
from public.payment_executions execution
join public.issued_documents document
  on document.id = execution.issued_document_id
 and document.organization_id = execution.organization_id
where execution.issued_document_id is not null
  and coalesce(document.payment_status, 'Pendiente') not in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito')
  and not exists (
    select 1
    from public.issued_document_payments payment
    where payment.payment_execution_id = execution.id
  );

revoke all on function public.sync_issued_document_payment_balance() from public, anon, authenticated;
revoke all on function public.sync_payment_execution_to_document() from public, anon, authenticated;
