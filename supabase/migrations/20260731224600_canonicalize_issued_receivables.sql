-- Fuente canónica de Cuentas por Cobrar (CLP).
-- Los documentos expresan la obligación; payment_executions registra cada
-- hecho de cobro; issued_document_payments es su proyección operacional; y
-- bank_reconciliation_matches sólo aplica esos cobros contra el banco.

alter table public.issued_documents
  add column if not exists currency_code text not null default 'CLP';

alter table public.issued_documents
  drop constraint if exists issued_documents_currency_code_check,
  add constraint issued_documents_currency_code_check check (currency_code = 'CLP');

alter table public.payment_executions
  add column if not exists idempotency_key uuid,
  add column if not exists proof_path text,
  add column if not exists proof_name text,
  add column if not exists proof_mime_type text,
  add column if not exists proof_size bigint;

alter table public.payment_executions
  drop constraint if exists payment_executions_proof_size_check,
  add constraint payment_executions_proof_size_check check (proof_size is null or proof_size > 0);

create unique index if not exists payment_executions_organization_idempotency_key
  on public.payment_executions (organization_id, idempotency_key)
  where idempotency_key is not null;

alter table public.bank_reconciliation_matches
  add column if not exists idempotency_key uuid;

create unique index if not exists bank_reconciliation_matches_organization_idempotency_key
  on public.bank_reconciliation_matches (organization_id, idempotency_key)
  where idempotency_key is not null;

-- El backfill no puede ejecutar la proyección, porque la fila de pago que se
-- está convirtiendo ya existe. El validador histórico tampoco conoce la regla
-- de redondeo CLP (por ejemplo 101963,96 se liquida en 101964). Ambos triggers
-- se restauran/redefinen inmediatamente después del backfill transaccional.
drop trigger if exists payment_executions_sync_document on public.payment_executions;
alter table public.payment_executions disable trigger payment_executions_validate;

insert into public.payment_executions (
  organization_id, direction, source, status, issued_document_id, amount,
  executed_on, payment_method, notes, created_by, created_at, idempotency_key,
  proof_path, proof_name, proof_mime_type, proof_size
)
select
  payment.organization_id, 'inflow', 'manual_receipt', 'executed',
  payment.issued_document_id, payment.amount, payment.paid_on,
  payment.payment_method, payment.notes, payment.created_by, payment.created_at,
  payment.id, payment.proof_path, payment.proof_name,
  payment.proof_mime_type, payment.proof_size
from public.issued_document_payments payment
where payment.payment_execution_id is null
  and not exists (
    select 1
    from public.payment_executions execution
    where execution.organization_id = payment.organization_id
      and execution.idempotency_key = payment.id
  );

update public.issued_document_payments payment
set payment_execution_id = execution.id
from public.payment_executions execution
where payment.payment_execution_id is null
  and execution.organization_id = payment.organization_id
  and execution.issued_document_id = payment.issued_document_id
  and execution.idempotency_key = payment.id;

alter table public.payment_executions enable trigger payment_executions_validate;

alter table public.payment_executions
  drop constraint if exists payment_executions_issued_identity_key,
  add constraint payment_executions_issued_identity_key
    unique (id, organization_id, issued_document_id);

alter table public.issued_document_payments
  drop constraint if exists issued_document_payments_payment_execution_id_fkey,
  drop constraint if exists issued_document_payments_execution_identity_fkey,
  add constraint issued_document_payments_execution_identity_fkey
    foreign key (payment_execution_id, organization_id, issued_document_id)
    references public.payment_executions (id, organization_id, issued_document_id)
    on delete restrict
    not valid;

alter table public.issued_document_payments
  validate constraint issued_document_payments_execution_identity_fkey;

-- Valida ejecuciones con la misma regla CLP que usa el saldo canónico. Para
-- documentos emitidos también serializa por documento y evita sobrepagos aun
-- con solicitudes concurrentes.
create or replace function public.validate_payment_execution()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_amount numeric(18,2);
  settled_amount numeric(18,2) := 0;
  document_status text;
  batch_status text;
  batch_amount numeric(18,2);
  item_classification public.ias7_cash_flow_classification;
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

    select coalesce(sum(amount), 0) into settled_amount
    from public.payment_executions
    where organization_id = new.organization_id
      and direct_payable_id = new.direct_payable_id
      and (tg_op <> 'UPDATE' or id <> old.id);
  else
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':issued:' || new.issued_document_id::text, 0));

    select round(abs(coalesce(total_amount, 0)), 0), payment_status
      into document_amount, document_status
    from public.issued_documents
    where id = new.issued_document_id and organization_id = new.organization_id
    for update;

    if new.amount <> round(new.amount, 0) then
      raise exception 'Issued document payments must use whole CLP amounts';
    end if;
    if document_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito') then
      raise exception 'Issued document is not collectible in status %', document_status;
    end if;

    select coalesce(sum(payment.amount), 0) into settled_amount
    from public.issued_document_payments payment
    where payment.organization_id = new.organization_id
      and payment.issued_document_id = new.issued_document_id
      and (tg_op <> 'UPDATE' or payment.payment_execution_id <> old.id);
  end if;

  if document_amount is null or document_amount <= 0 then
    raise exception 'Payment execution requires a payable with a positive amount';
  end if;
  if new.issued_document_id is not null and settled_amount + new.amount > document_amount then
    raise exception 'Payment execution exceeds the issued document outstanding balance';
  elsif new.direct_payable_id is not null and settled_amount + new.amount > document_amount + 0.01 then
    raise exception 'Payment execution exceeds the direct payable outstanding balance';
  elsif new.received_document_id is not null and new.amount > document_amount + 0.01 then
    raise exception 'Payment execution exceeds the payable amount';
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
    if batch_status <> 'paid' or new.direction <> 'outflow' then
      raise exception 'Only an executed payment order can create an outflow execution';
    end if;
    if new.amount > coalesce(batch_amount, 0) + 0.01 then
      raise exception 'Payment execution exceeds its payment order total';
    end if;
    if new.cash_flow_classification is distinct from item_classification then
      raise exception 'Payment execution must retain the IAS 7 classification of its payment proposal item';
    end if;
  end if;

  if new.bank_transaction_id is not null then
    select amount into bank_amount
    from public.bank_transactions
    where id = new.bank_transaction_id and organization_id = new.organization_id
    for key share;
    if bank_amount is null
       or (new.direction = 'inflow' and bank_amount <= 0)
       or (new.direction = 'outflow' and bank_amount >= 0) then
      raise exception 'Bank transaction direction does not match payment execution';
    end if;
  end if;
  return new;
end;
$$;

-- Una vez creada, la identidad financiera de una ejecución no cambia. Sólo
-- se permite completar sus datos de conciliación bancaria una vez.
create or replace function public.protect_payment_execution_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payment executions are append-only';
  end if;
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.direction is distinct from old.direction
     or new.source is distinct from old.source
     or new.received_document_id is distinct from old.received_document_id
     or new.issued_document_id is distinct from old.issued_document_id
     or new.direct_payable_id is distinct from old.direct_payable_id
     or new.payment_batch_id is distinct from old.payment_batch_id
     or new.amount is distinct from old.amount
     or new.executed_on is distinct from old.executed_on
     or new.payment_method is distinct from old.payment_method
     or new.payment_reference is distinct from old.payment_reference
     or new.notes is distinct from old.notes
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.idempotency_key is distinct from old.idempotency_key
     or new.proof_path is distinct from old.proof_path
     or new.proof_name is distinct from old.proof_name
     or new.proof_mime_type is distinct from old.proof_mime_type
     or new.proof_size is distinct from old.proof_size then
    raise exception 'Payment execution financial identity is immutable';
  end if;
  if old.bank_transaction_id is not null
     and new.bank_transaction_id is distinct from old.bank_transaction_id then
    raise exception 'A reconciled payment execution cannot change bank transaction';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_executions_protect_identity on public.payment_executions;
create trigger payment_executions_protect_identity
before update or delete on public.payment_executions
for each row execute function public.protect_payment_execution_identity();

-- La proyección de pagos recibe toda la metadata del hecho financiero.
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
    select coalesce(sum(amount), 0) into settled_amount
    from public.payment_executions
    where organization_id = new.organization_id and received_document_id = new.received_document_id;
    select abs(total_amount) into document_amount
    from public.received_documents
    where id = new.received_document_id and organization_id = new.organization_id;
    if settled_amount >= document_amount then
      update public.received_documents
      set payment_status = 'Pagada', payment_date = new.executed_on,
          payment_method = coalesce(new.payment_method, 'Pago registrado'),
          payment_reference = new.payment_reference,
          payment_notes = coalesce(new.notes, 'Pago registrado en el libro de ejecuciones.'),
          payment_recorded_at = now(), payment_recorded_by = coalesce(new.created_by, auth.uid())
      where id = new.received_document_id and organization_id = new.organization_id;
    end if;
  elsif new.direct_payable_id is not null then
    select coalesce(sum(amount), 0) into settled_amount
    from public.payment_executions
    where organization_id = new.organization_id and direct_payable_id = new.direct_payable_id;
    select abs(total_amount) into document_amount
    from public.direct_payables
    where id = new.direct_payable_id and organization_id = new.organization_id;
    if settled_amount >= document_amount then
      update public.direct_payables
      set status = 'paid', paid_at = coalesce(paid_at, new.executed_on::timestamptz),
          payment_reference = coalesce(new.payment_reference, payment_reference)
      where id = new.direct_payable_id and organization_id = new.organization_id and status = 'approved';
    end if;
  else
    insert into public.issued_document_payments (
      organization_id, issued_document_id, payment_execution_id, amount, paid_on,
      payment_method, notes, proof_path, proof_name, proof_mime_type, proof_size,
      created_by, created_at
    ) values (
      new.organization_id, new.issued_document_id, new.id, new.amount, new.executed_on,
      new.payment_method, new.notes, new.proof_path, new.proof_name,
      new.proof_mime_type, new.proof_size, new.created_by, new.created_at
    )
    on conflict (payment_execution_id) where payment_execution_id is not null do nothing;
  end if;
  return new;
end;
$$;

create trigger payment_executions_sync_document
after insert on public.payment_executions
for each row execute function public.sync_payment_execution_to_document();

-- El estado ordinario del documento se deriva siempre de la proyección.
create or replace function public.sync_issued_document_payment_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_id uuid := case when tg_op = 'DELETE' then old.issued_document_id else new.issued_document_id end;
  document_organization_id uuid;
  document_total numeric(18,2);
  existing_status text;
  paid_total numeric(18,2);
  latest_paid_on date;
  latest_method text;
begin
  select organization_id, round(abs(coalesce(total_amount, 0)), 0), payment_status
    into document_organization_id, document_total, existing_status
  from public.issued_documents
  where id = document_id
  for update;

  if not found then raise exception 'Issued document % does not exist', document_id; end if;
  if tg_op <> 'DELETE' and new.organization_id <> document_organization_id then
    raise exception 'Payment organization must match issued document organization';
  end if;
  if tg_op <> 'DELETE' and new.amount <> round(new.amount, 0) then
    raise exception 'Issued document payments must use whole CLP amounts';
  end if;
  if existing_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito') then
    raise exception 'A payment cannot be registered for a document in status %', existing_status;
  end if;

  select coalesce(sum(payment.amount), 0) into paid_total
  from public.issued_document_payments payment
  where payment.issued_document_id = document_id;

  select payment.paid_on, payment.payment_method
    into latest_paid_on, latest_method
  from public.issued_document_payments payment
  where payment.issued_document_id = document_id
  order by payment.paid_on desc, payment.created_at desc
  limit 1;

  if paid_total > document_total then
    raise exception 'Payment amount exceeds issued document outstanding balance';
  end if;

  update public.issued_documents
  set payment_status = case
        when paid_total >= document_total and document_total > 0 then 'Pagada'
        when paid_total > 0 then 'Abonada'
        else 'Pendiente'
      end,
      payment_date = case when paid_total > 0 then latest_paid_on else null end,
      payment_method = case when paid_total > 0 then latest_method else null end
  where id = document_id;
  return coalesce(new, old);
end;
$$;

drop trigger if exists issued_document_payments_sync_balance on public.issued_document_payments;
create trigger issued_document_payments_sync_balance
after insert or update or delete on public.issued_document_payments
for each row execute function public.sync_issued_document_payment_balance();

-- Protege moneda/montos y metadatos derivados sin impedir correcciones no
-- monetarias de documentos históricos que aún conservan centavos importados.
create or replace function public.protect_issued_document_financial_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  canonical_status text;
  paid_total numeric(18,2);
begin
  if tg_op = 'INSERT' then
    if new.currency_code <> 'CLP'
       or coalesce(new.net_amount, 0) <> round(coalesce(new.net_amount, 0), 0)
       or coalesce(new.vat_amount, 0) <> round(coalesce(new.vat_amount, 0), 0)
       or coalesce(new.total_amount, 0) <> round(coalesce(new.total_amount, 0), 0) then
      raise exception 'New issued documents must use whole CLP amounts';
    end if;
    return new;
  end if;

  if (new.net_amount, new.vat_amount, new.total_amount, new.currency_code)
       is distinct from
     (old.net_amount, old.vat_amount, old.total_amount, old.currency_code) then
    if exists (select 1 from public.issued_document_payments payment where payment.issued_document_id = old.id)
       or exists (select 1 from public.payment_executions execution where execution.issued_document_id = old.id)
       or exists (select 1 from public.bank_reconciliation_matches match where match.issued_document_id = old.id)
       or exists (
         select 1 from public.accounting_entries entry
         where entry.organization_id = old.organization_id
           and entry.source_event_key = 'ifrs:issued:' || old.id::text
       ) then
      raise exception 'Issued document monetary fields are locked after payment, reconciliation, or accounting entry';
    end if;
    if new.currency_code <> 'CLP'
       or coalesce(new.net_amount, 0) <> round(coalesce(new.net_amount, 0), 0)
       or coalesce(new.vat_amount, 0) <> round(coalesce(new.vat_amount, 0), 0)
       or coalesce(new.total_amount, 0) <> round(coalesce(new.total_amount, 0), 0) then
      raise exception 'Issued document monetary changes must use whole CLP amounts';
    end if;
  end if;

  if pg_trigger_depth() = 1
     and (new.payment_status, new.payment_date, new.payment_method)
          is distinct from
         (old.payment_status, old.payment_date, old.payment_method) then
    select coalesce(sum(payment.amount), 0) into paid_total
    from public.issued_document_payments payment
    where payment.issued_document_id = old.id;
    canonical_status := case
      when paid_total >= round(abs(coalesce(old.total_amount, 0)), 0)
           and round(abs(coalesce(old.total_amount, 0)), 0) > 0 then 'Pagada'
      when paid_total > 0 then 'Abonada'
      else 'Pendiente'
    end;
    if new.payment_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito') then
      if paid_total > 0 then raise exception 'A collected document cannot enter a non-collectible status'; end if;
    elsif new.payment_status is distinct from canonical_status then
      raise exception 'Issued document collection status is derived from payment executions';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists issued_documents_protect_financial_fields on public.issued_documents;
create trigger issued_documents_protect_financial_fields
before insert or update on public.issued_documents
for each row execute function public.protect_issued_document_financial_fields();

-- RPC única para registrar un cobro manual. La llave de idempotencia forma
-- parte del payload financiero y una repetición distinta se rechaza.
create or replace function public.record_issued_receipt(
  p_organization_id uuid,
  p_issued_document_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_method text,
  p_proof_path text,
  p_idempotency_key uuid,
  p_notes text,
  p_proof_name text,
  p_proof_mime_type text,
  p_proof_size bigint
)
returns table (
  payment_id uuid,
  payment_execution_id uuid,
  issued_document_id uuid,
  settlement_amount numeric,
  paid_amount numeric,
  outstanding_amount numeric,
  collection_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  execution_row public.payment_executions%rowtype;
  payment_row public.issued_document_payments%rowtype;
  document_total numeric;
  document_status text;
  total_paid numeric;
begin
  if actor_id is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = actor_id
      and membership.role in ('administrator', 'finance')
  ) then raise exception 'Finance access required'; end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0
     or p_amount <> round(p_amount, 0) or p_payment_date is null then
    raise exception 'Receipt requires a positive whole CLP amount, date, and idempotency key';
  end if;
  if char_length(coalesce(p_payment_method, '')) > 120
     or char_length(coalesce(p_notes, '')) > 2000
     or char_length(coalesce(p_proof_name, '')) > 300
     or (p_proof_size is not null and p_proof_size <= 0) then
    raise exception 'Receipt metadata is invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':issued:' || p_issued_document_id::text, 0));
  select * into execution_row
  from public.payment_executions execution
  where execution.organization_id = p_organization_id
    and execution.idempotency_key = p_idempotency_key
  for update;

  if found then
    if execution_row.source <> 'manual_receipt'
       or execution_row.issued_document_id is distinct from p_issued_document_id
       or execution_row.amount is distinct from p_amount
       or execution_row.executed_on is distinct from p_payment_date
       or execution_row.payment_method is distinct from p_payment_method
       or execution_row.notes is distinct from p_notes
       or execution_row.proof_path is distinct from p_proof_path
       or execution_row.proof_name is distinct from p_proof_name
       or execution_row.proof_mime_type is distinct from p_proof_mime_type
       or execution_row.proof_size is distinct from p_proof_size then
      raise exception 'Idempotency key already belongs to a different receipt';
    end if;
  else
    select round(abs(coalesce(document.total_amount, 0)), 0), document.payment_status
      into document_total, document_status
    from public.issued_documents document
    where document.id = p_issued_document_id
      and document.organization_id = p_organization_id
    for update;
    if not found then raise exception 'Issued document not found'; end if;
    if document_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito') then
      raise exception 'Issued document is not collectible in status %', document_status;
    end if;
    select coalesce(sum(payment.amount), 0) into total_paid
    from public.issued_document_payments payment
    where payment.organization_id = p_organization_id
      and payment.issued_document_id = p_issued_document_id;
    if total_paid + p_amount > document_total then
      raise exception 'Receipt exceeds issued document outstanding balance';
    end if;

    insert into public.payment_executions (
      organization_id, direction, source, status, issued_document_id, amount,
      executed_on, payment_method, notes, created_by, idempotency_key,
      proof_path, proof_name, proof_mime_type, proof_size
    ) values (
      p_organization_id, 'inflow', 'manual_receipt', 'executed',
      p_issued_document_id, p_amount, p_payment_date, p_payment_method, p_notes,
      actor_id, p_idempotency_key, p_proof_path, p_proof_name,
      p_proof_mime_type, p_proof_size
    ) returning * into execution_row;
  end if;

  select * into payment_row
  from public.issued_document_payments payment
  where payment.payment_execution_id = execution_row.id;
  if not found then raise exception 'Receipt payment projection was not created'; end if;

  return query
  select payment_row.id, execution_row.id, balance.issued_document_id,
         balance.settlement_amount, balance.paid_amount,
         balance.outstanding_amount, balance.collection_status
  from public.issued_document_receivable_balances balance
  where balance.organization_id = p_organization_id
    and balance.issued_document_id = p_issued_document_id;
end;
$$;

-- BEFORE INSERT mantiene toda la conciliación en una sola transacción. Si
-- el cobro ya estaba registrado manualmente no crea un segundo pago; sólo
-- materializa el tramo que aún no existe en el libro de cobros.
create or replace function public.validate_and_materialize_bank_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction_amount numeric;
  transaction_signed_amount numeric;
  already_matched numeric;
  payable_amount numeric;
  paid_before numeric;
  required_execution numeric;
  execution_id uuid;
  document_status text;
begin
  select abs(transaction.amount), transaction.amount
    into transaction_amount, transaction_signed_amount
  from public.bank_transactions transaction
  where transaction.id = new.bank_transaction_id
    and transaction.organization_id = new.organization_id
  for update;
  if transaction_amount is null then raise exception 'Bank transaction is not available in this organization'; end if;

  select coalesce(sum(match.matched_amount), 0) into already_matched
  from public.bank_reconciliation_matches match
  where match.bank_transaction_id = new.bank_transaction_id;
  if already_matched + new.matched_amount > transaction_amount then
    raise exception 'Reconciliation amount exceeds bank transaction amount';
  end if;

  if new.issued_document_id is not null then
    if transaction_signed_amount <= 0 or new.matched_amount <> round(new.matched_amount, 0) then
      raise exception 'Issued receivables require a positive bank inflow in whole CLP';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':issued:' || new.issued_document_id::text, 0));
    select round(abs(coalesce(document.total_amount, 0)), 0), document.payment_status
      into payable_amount, document_status
    from public.issued_documents document
    where document.id = new.issued_document_id
      and document.organization_id = new.organization_id
    for update;
    if payable_amount is null or payable_amount <= 0 then raise exception 'Issued document is unavailable'; end if;
    if document_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito') then
      raise exception 'Issued document is not collectible in status %', document_status;
    end if;
    select coalesce(sum(match.matched_amount), 0) into already_matched
    from public.bank_reconciliation_matches match
    where match.issued_document_id = new.issued_document_id;
    if already_matched + new.matched_amount > payable_amount then
      raise exception 'Reconciliation amount exceeds issued document settlement amount';
    end if;
    select coalesce(sum(payment.amount), 0) into paid_before
    from public.issued_document_payments payment
    where payment.organization_id = new.organization_id
      and payment.issued_document_id = new.issued_document_id;
    required_execution := greatest(0, already_matched + new.matched_amount - paid_before);
    if required_execution > 0 then
      insert into public.payment_executions (
        organization_id, direction, source, status, issued_document_id,
        bank_transaction_id, amount, executed_on, payment_method, notes,
        created_by, reconciled_at, reconciled_by
      ) values (
        new.organization_id, 'inflow', 'bank_reconciliation', 'reconciled',
        new.issued_document_id, new.bank_transaction_id, required_execution,
        new.matched_on, 'Conciliación bancaria', new.notes, auth.uid(), now(), auth.uid()
      ) returning id into execution_id;
      new.payment_execution_id := execution_id;
    else
      new.payment_execution_id := null;
    end if;
  elsif new.received_document_id is not null or new.direct_payable_id is not null then
    if transaction_signed_amount >= 0 then raise exception 'Payables require a bank outflow'; end if;
    if new.received_document_id is not null then
      select abs(coalesce(document.total_amount, 0)) into payable_amount
      from public.received_documents document
      where document.id = new.received_document_id and document.organization_id = new.organization_id
      for update;
      select coalesce(sum(match.matched_amount), 0) into already_matched
      from public.bank_reconciliation_matches match
      where match.received_document_id = new.received_document_id;
    else
      select abs(coalesce(payable.total_amount, 0)) into payable_amount
      from public.direct_payables payable
      where payable.id = new.direct_payable_id and payable.organization_id = new.organization_id
      for update;
      select coalesce(sum(match.matched_amount), 0) into already_matched
      from public.bank_reconciliation_matches match
      where match.direct_payable_id = new.direct_payable_id;
    end if;
    if payable_amount is null or already_matched + new.matched_amount > payable_amount then
      raise exception 'Reconciliation amount exceeds payable amount';
    end if;
    select execution.id into execution_id
    from public.payment_executions execution
    where execution.organization_id = new.organization_id
      and ((new.received_document_id is not null and execution.received_document_id = new.received_document_id)
        or (new.direct_payable_id is not null and execution.direct_payable_id = new.direct_payable_id))
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
    set bank_transaction_id = new.bank_transaction_id, status = 'reconciled',
        reconciled_at = now(), reconciled_by = auth.uid()
    where id = execution_id;
    new.payment_execution_id := execution_id;
  else
    raise exception 'Reconciliation requires exactly one document';
  end if;
  return new;
end;
$$;

create or replace function public.refresh_bank_transaction_reconciliation_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched numeric;
  transaction_amount numeric;
begin
  select abs(amount) into transaction_amount
  from public.bank_transactions
  where id = new.bank_transaction_id and organization_id = new.organization_id
  for update;
  select coalesce(sum(matched_amount), 0) into matched
  from public.bank_reconciliation_matches
  where bank_transaction_id = new.bank_transaction_id;
  update public.bank_transactions
  set reconciliation_status = case
    when matched <= 0 then 'pending'
    when matched >= transaction_amount then 'reconciled'
    else 'partially_reconciled'
  end
  where id = new.bank_transaction_id and organization_id = new.organization_id;
  return new;
end;
$$;

create or replace function public.protect_bank_match_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Bank reconciliation matches are append-only';
end;
$$;

drop trigger if exists validate_bank_reconciliation_match_before_write on public.bank_reconciliation_matches;
drop trigger if exists bank_reconciliation_matches_materialize_execution on public.bank_reconciliation_matches;
drop trigger if exists bank_reconciliation_matches_validate_and_materialize on public.bank_reconciliation_matches;
drop trigger if exists bank_reconciliation_matches_refresh_transaction on public.bank_reconciliation_matches;
drop trigger if exists bank_reconciliation_matches_protect_identity on public.bank_reconciliation_matches;

create trigger bank_reconciliation_matches_validate_and_materialize
before insert on public.bank_reconciliation_matches
for each row execute function public.validate_and_materialize_bank_match();
create trigger bank_reconciliation_matches_refresh_transaction
after insert on public.bank_reconciliation_matches
for each row execute function public.refresh_bank_transaction_reconciliation_status();
create trigger bank_reconciliation_matches_protect_identity
before update or delete on public.bank_reconciliation_matches
for each row execute function public.protect_bank_match_identity();

-- Los agregados se calculan por separado para evitar productos cartesianos al
-- existir múltiples pagos y múltiples conciliaciones del mismo documento.
drop view if exists public.issued_document_receivable_balances;
create view public.issued_document_receivable_balances
with (security_barrier = true)
as
with payment_totals as (
  select payment.organization_id, payment.issued_document_id,
         sum(payment.amount) as paid_amount
  from public.issued_document_payments payment
  group by payment.organization_id, payment.issued_document_id
), reconciliation_totals as (
  select match.organization_id, match.issued_document_id,
         sum(match.matched_amount) as reconciled_amount
  from public.bank_reconciliation_matches match
  where match.issued_document_id is not null
  group by match.organization_id, match.issued_document_id
), balances as (
  select document.id as issued_document_id,
         document.*,
         round(abs(coalesce(document.total_amount, 0)), 0) as settlement_amount,
         coalesce(payment.paid_amount, 0) as paid_amount,
         least(coalesce(reconciliation.reconciled_amount, 0), round(abs(coalesce(document.total_amount, 0)), 0)) as reconciled_amount
  from public.issued_documents document
  left join payment_totals payment
    on payment.organization_id = document.organization_id
   and payment.issued_document_id = document.id
  left join reconciliation_totals reconciliation
    on reconciliation.organization_id = document.organization_id
   and reconciliation.issued_document_id = document.id
)
select balance.*,
       greatest(balance.settlement_amount - balance.paid_amount, 0) as outstanding_amount,
       greatest(balance.paid_amount - balance.reconciled_amount, 0) as unreconciled_paid_amount,
       greatest(balance.settlement_amount - balance.reconciled_amount, 0) as available_to_reconcile,
       case
         when balance.payment_status in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito')
           then balance.payment_status
         when balance.paid_amount >= balance.settlement_amount and balance.settlement_amount > 0 then 'Pagada'
         when balance.paid_amount > 0 then 'Abonada'
         else 'Pendiente'
       end as collection_status,
       balance.payment_status not in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito')
         and balance.settlement_amount > 0 as is_collectible
from balances balance
where exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = balance.organization_id
    and membership.user_id = auth.uid()
);

grant select on public.issued_document_receivable_balances to authenticated;

revoke all on function public.record_issued_receipt(uuid, uuid, numeric, date, text, text, uuid, text, text, text, bigint) from public, anon;
grant execute on function public.record_issued_receipt(uuid, uuid, numeric, date, text, text, uuid, text, text, text, bigint) to authenticated;
revoke all on function public.validate_payment_execution() from public, anon, authenticated;
revoke all on function public.protect_payment_execution_identity() from public, anon, authenticated;
revoke all on function public.sync_payment_execution_to_document() from public, anon, authenticated;
revoke all on function public.sync_issued_document_payment_balance() from public, anon, authenticated;
revoke all on function public.protect_issued_document_financial_fields() from public, anon, authenticated;
revoke all on function public.validate_and_materialize_bank_match() from public, anon, authenticated;
revoke all on function public.refresh_bank_transaction_reconciliation_status() from public, anon, authenticated;
revoke all on function public.protect_bank_match_identity() from public, anon, authenticated;

-- Assertions: abortan la migración completa si el backfill o las invariantes
-- no son ciertos en cualquier ambiente.
do $$
begin
  if exists (select 1 from public.issued_document_payments where payment_execution_id is null) then
    raise exception 'Invariant failed: issued payment without execution';
  end if;
  if exists (
    select 1
    from public.issued_document_payments payment
    join public.payment_executions execution on execution.id = payment.payment_execution_id
    where (payment.organization_id, payment.issued_document_id)
       is distinct from (execution.organization_id, execution.issued_document_id)
  ) then raise exception 'Invariant failed: payment execution identity mismatch'; end if;
  if exists (select 1 from public.issued_document_payments where amount <> round(amount, 0)) then
    raise exception 'Invariant failed: fractional issued payment';
  end if;
  if exists (
    select 1 from public.payment_executions
    where issued_document_id is not null and amount <> round(amount, 0)
  ) then raise exception 'Invariant failed: fractional issued execution'; end if;
  if exists (
    select 1
    from public.issued_document_receivable_balances balance
    where balance.paid_amount > balance.settlement_amount
       or (balance.payment_status not in ('Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito')
           and balance.payment_status is distinct from balance.collection_status)
  ) then raise exception 'Invariant failed: receivable balance or status mismatch'; end if;
end;
$$;
