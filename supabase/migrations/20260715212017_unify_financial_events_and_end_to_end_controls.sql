-- Columna vertebral financiera: una ejecución de pago es el único hecho que
-- liquida un documento. Un lote autoriza egresos; el banco los confirma. La
-- conciliación deja de ser un segundo camino capaz de cambiar el saldo.
create type public.payment_execution_direction as enum ('inflow', 'outflow');
create type public.payment_execution_status as enum ('executed', 'reconciled', 'legacy');
create type public.payment_execution_source as enum ('payment_batch', 'bank_reconciliation', 'legacy_import');

create table public.payment_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  direction public.payment_execution_direction not null,
  source public.payment_execution_source not null,
  status public.payment_execution_status not null default 'executed',
  received_document_id uuid,
  issued_document_id uuid,
  payment_batch_id uuid,
  bank_transaction_id uuid,
  amount numeric(18, 2) not null check (amount > 0),
  executed_on date not null default current_date,
  payment_method text,
  payment_reference text,
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  reconciled_at timestamptz,
  reconciled_by uuid references auth.users(id) on delete set null,
  unique (id, organization_id),
  foreign key (received_document_id, organization_id)
    references public.received_documents (id, organization_id) on delete restrict,
  foreign key (issued_document_id, organization_id)
    references public.issued_documents (id, organization_id) on delete restrict,
  foreign key (payment_batch_id, organization_id)
    references public.payment_batches (id, organization_id) on delete restrict,
  foreign key (bank_transaction_id, organization_id)
    references public.bank_transactions (id, organization_id) on delete restrict,
  check (num_nonnulls(received_document_id, issued_document_id) = 1),
  check ((direction = 'outflow') = (received_document_id is not null)),
  check ((source = 'payment_batch') = (payment_batch_id is not null)),
  check (source <> 'bank_reconciliation' or bank_transaction_id is not null),
  check (status <> 'reconciled' or (bank_transaction_id is not null and reconciled_at is not null))
);

create unique index payment_executions_batch_document_idx
  on public.payment_executions (payment_batch_id, received_document_id)
  where payment_batch_id is not null;
create unique index payment_executions_bank_document_idx
  on public.payment_executions (bank_transaction_id, received_document_id, issued_document_id)
  where bank_transaction_id is not null;
create index payment_executions_document_idx
  on public.payment_executions (organization_id, received_document_id, issued_document_id, executed_on desc);

alter table public.bank_reconciliation_matches
  add column payment_execution_id uuid,
  add constraint bank_reconciliation_matches_payment_execution_organization_fkey
    foreign key (payment_execution_id, organization_id)
    references public.payment_executions (id, organization_id) on delete restrict;

-- Convierte los pagos ya registrados en hechos explícitos. No se pierde
-- historia y desde esta migración todo pago nuevo tiene la misma estructura.
insert into public.payment_executions (
  organization_id, direction, source, status, received_document_id, amount,
  executed_on, payment_method, payment_reference, notes, created_by, created_at
)
select organization_id, 'outflow', 'legacy_import', 'legacy', id,
  abs(total_amount), coalesce(payment_date, issue_date, current_date),
  payment_method, payment_reference, coalesce(payment_notes, 'Pago histórico migrado.'),
  payment_recorded_by, coalesce(payment_recorded_at, created_at, now())
from public.received_documents
where lower(coalesce(payment_status, '')) like '%pagada%'
  and abs(coalesce(total_amount, 0)) > 0;

insert into public.payment_executions (
  organization_id, direction, source, status, issued_document_id, amount,
  executed_on, payment_method, notes, created_at
)
select organization_id, 'inflow', 'legacy_import', 'legacy', id,
  abs(total_amount), coalesce(payment_date, issue_date, current_date),
  payment_method, 'Cobro histórico migrado.', created_at
from public.issued_documents
where lower(coalesce(payment_status, '')) like '%pagada%'
  and abs(coalesce(total_amount, 0)) > 0;

create or replace function public.validate_payment_execution()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_amount numeric(18,2);
  document_status text;
  batch_status text;
  batch_amount numeric(18,2);
  bank_amount numeric(18,2);
begin
  if new.received_document_id is not null then
    select abs(total_amount), payment_status into document_amount, document_status
    from public.received_documents
    where id = new.received_document_id and organization_id = new.organization_id
    for key share;
  else
    select abs(total_amount), payment_status into document_amount, document_status
    from public.issued_documents
    where id = new.issued_document_id and organization_id = new.organization_id
    for key share;
  end if;
  if document_amount is null or document_amount = 0 then
    raise exception 'Payment execution requires a document with a positive amount';
  end if;
  if new.amount > document_amount + 0.01 then
    raise exception 'Payment execution exceeds the document amount';
  end if;
  if new.source = 'payment_batch' then
    select status, total_amount into batch_status, batch_amount
    from public.payment_batches
    where id = new.payment_batch_id and organization_id = new.organization_id
    for key share;
    if batch_status <> 'paid' or new.direction <> 'outflow' then
      raise exception 'Only a paid payment batch can create an outflow execution';
    end if;
    if new.amount > coalesce(batch_amount, 0) + 0.01 then
      raise exception 'Payment execution exceeds its batch total';
    end if;
  elsif new.source = 'bank_reconciliation' then
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

create trigger payment_executions_validate
before insert or update on public.payment_executions
for each row execute function public.validate_payment_execution();

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
    select abs(total_amount) into document_amount from public.received_documents
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
  else
    select coalesce(sum(amount), 0) into settled_amount
    from public.payment_executions
    where organization_id = new.organization_id and issued_document_id = new.issued_document_id;
    select abs(total_amount) into document_amount from public.issued_documents
    where id = new.issued_document_id and organization_id = new.organization_id;
    if settled_amount >= document_amount then
      update public.issued_documents
      set payment_status = 'Pagada', payment_date = new.executed_on,
          payment_method = coalesce(new.payment_method, 'Cobro registrado')
      where id = new.issued_document_id and organization_id = new.organization_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger payment_executions_sync_document
after insert on public.payment_executions
for each row execute function public.sync_payment_execution_to_document();

-- Una conciliación materializa o confirma la ejecución existente. Para un
-- cargo no se permite inventar un pago: debe venir de un lote ya ejecutado.
-- Para un abono el banco es el origen de la ejecución. Las aplicaciones
-- parciales se acumulan sin liquidar el documento hasta completar su total.
create or replace function public.materialize_reconciled_payment_execution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  execution_id uuid;
begin
  if new.received_document_id is not null then
    select id into execution_id
    from public.payment_executions
    where organization_id = new.organization_id
      and received_document_id = new.received_document_id
      and source = 'payment_batch'
      and bank_transaction_id is null
    order by created_at desc limit 1
    for update;
    if execution_id is null then
      raise exception 'Supplier payment must be executed through an approved payment batch before bank reconciliation';
    end if;
    update public.payment_executions
    set bank_transaction_id = new.bank_transaction_id, status = 'reconciled',
        reconciled_at = now(), reconciled_by = auth.uid()
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
create trigger bank_reconciliation_matches_materialize_execution
after insert on public.bank_reconciliation_matches
for each row execute function public.materialize_reconciled_payment_execution();

-- No se permite marcar pagado directamente. El trigger anterior usa una
-- actualización anidada y por ello queda explícitamente permitido.
create or replace function public.prevent_direct_document_payment_status_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if pg_trigger_depth() = 1
     and new.payment_status is distinct from old.payment_status
     and lower(coalesce(new.payment_status, '')) like '%pagada%' then
    raise exception 'Documents can only be settled through payment_executions';
  end if;
  return new;
end;
$$;

create trigger received_documents_prevent_direct_payment
before update of payment_status on public.received_documents
for each row execute function public.prevent_direct_document_payment_status_change();
create trigger issued_documents_prevent_direct_payment
before update of payment_status on public.issued_documents
for each row execute function public.prevent_direct_document_payment_status_change();

-- Sustituye el legado que actualizaba documentos desde el lote. Al completar
-- un lote se crean sus ejecuciones; éstas actualizan el documento y luego
-- Tesorería sólo las concilia contra un movimiento bancario.
drop trigger if exists payment_batches_sync_paid_documents on public.payment_batches;
drop function if exists public.sync_paid_batch_to_received_documents();
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
      payment_reference, notes, created_by
    )
    select item.organization_id, 'outflow', 'payment_batch', 'executed',
      item.received_document_id, new.id, item.amount, new.paid_at::date,
      'Lote de pago', new.payment_reference,
      concat('Ejecutado por lote ', new.batch_number), auth.uid()
    from public.payment_batch_items item
    where item.payment_batch_id = new.id
      and item.organization_id = new.organization_id;
  end if;
  return new;
end;
$$;
create trigger payment_batches_create_executions
after update of status on public.payment_batches
for each row execute function public.create_payment_executions_for_paid_batch();

-- Seguridad de datos y trazabilidad de la nueva fuente de verdad.
alter table public.payment_executions enable row level security;
create policy "finance and audit read payment executions" on public.payment_executions
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = payment_executions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance manages payment executions" on public.payment_executions
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = payment_executions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = payment_executions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
);
grant select, insert, update, delete on public.payment_executions to authenticated;

revoke all on function public.validate_payment_execution() from public, anon, authenticated;
revoke all on function public.sync_payment_execution_to_document() from public, anon, authenticated;
revoke all on function public.materialize_reconciled_payment_execution() from public, anon, authenticated;
revoke all on function public.prevent_direct_document_payment_status_change() from public, anon, authenticated;
revoke all on function public.create_payment_executions_for_paid_batch() from public, anon, authenticated;
