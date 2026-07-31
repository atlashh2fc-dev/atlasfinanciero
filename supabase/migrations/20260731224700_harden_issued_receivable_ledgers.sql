-- Segunda fase: la aplicación que escribe exclusivamente mediante RPC ya está
-- desplegada. Se cierra la ventana de compatibilidad y los tres libros quedan
-- append-only para clientes autenticados y accesos administrativos directos.

-- Captura cualquier abono que pudiera haber entrado por la API anterior entre
-- la migración compatible y el despliegue de la nueva aplicación.
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
    select 1 from public.payment_executions execution
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
create trigger payment_executions_sync_document
after insert on public.payment_executions
for each row execute function public.sync_payment_execution_to_document();

alter table public.issued_document_payments
  alter column payment_execution_id set not null;

alter table public.issued_document_payments
  drop constraint if exists issued_document_payments_whole_clp_check,
  add constraint issued_document_payments_whole_clp_check
    check (amount = round(amount, 0)) not valid;
alter table public.issued_document_payments
  validate constraint issued_document_payments_whole_clp_check;

alter table public.payment_executions
  drop constraint if exists payment_executions_issued_whole_clp_check,
  add constraint payment_executions_issued_whole_clp_check
    check (issued_document_id is null or amount = round(amount, 0)) not valid,
  drop constraint if exists payment_executions_manual_idempotency_check,
  add constraint payment_executions_manual_idempotency_check
    check (source <> 'manual_receipt' or idempotency_key is not null) not valid;
alter table public.payment_executions
  validate constraint payment_executions_issued_whole_clp_check;
alter table public.payment_executions
  validate constraint payment_executions_manual_idempotency_check;

alter table public.bank_reconciliation_matches
  drop constraint if exists bank_reconciliation_matches_idempotency_check,
  add constraint bank_reconciliation_matches_idempotency_check
    check (idempotency_key is not null) not valid;

create unique index if not exists bank_reconciliation_matches_issued_bank_key
  on public.bank_reconciliation_matches (bank_transaction_id, issued_document_id)
  where issued_document_id is not null;

create or replace function public.protect_issued_payment_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Issued document payments are an append-only projection of payment executions';
end;
$$;

drop trigger if exists issued_document_payments_protect_identity on public.issued_document_payments;
create trigger issued_document_payments_protect_identity
before update or delete on public.issued_document_payments
for each row execute function public.protect_issued_payment_identity();

-- Elimina metadata residual de documentos sin cobros. A partir de aquí fecha,
-- medio y estado ordinario son siempre una derivación del libro de pagos.
update public.issued_documents document
set payment_status = 'Pendiente', payment_date = null, payment_method = null
where document.payment_status not in (
    'Factorizada', 'Pagada al factoring', 'Recomprada al factoring',
    'Anulada', 'Nota de crédito'
  )
  and not exists (
    select 1 from public.issued_document_payments payment
    where payment.issued_document_id = document.id
  )
  and (
    document.payment_status is distinct from 'Pendiente'
    or document.payment_date is not null
    or document.payment_method is not null
  );

revoke insert, update, delete on public.issued_document_payments from authenticated;
revoke insert, update, delete on public.payment_executions from authenticated;
revoke update, delete on public.bank_reconciliation_matches from authenticated;

revoke all on function public.protect_issued_payment_identity() from public, anon, authenticated;

do $$
declare
  invariant_count integer;
begin
  select count(*) into invariant_count
  from public.issued_document_payments
  where payment_execution_id is null;
  if invariant_count <> 0 then raise exception 'Invariant failed: % payments without execution', invariant_count; end if;

  select count(*) into invariant_count
  from public.issued_document_payments payment
  join public.payment_executions execution on execution.id = payment.payment_execution_id
  where (payment.organization_id, payment.issued_document_id)
     is distinct from (execution.organization_id, execution.issued_document_id);
  if invariant_count <> 0 then raise exception 'Invariant failed: % payment identity mismatches', invariant_count; end if;

  if exists (
    select 1
    from public.issued_document_payments payment
    join public.issued_documents document on document.id = payment.issued_document_id
    group by document.id, document.total_amount
    having sum(payment.amount) > round(abs(coalesce(document.total_amount, 0)), 0)
  ) then raise exception 'Invariant failed: overpaid issued document'; end if;

  if exists (
    select 1
    from public.issued_documents document
    where document.payment_status not in (
        'Factorizada', 'Pagada al factoring', 'Recomprada al factoring',
        'Anulada', 'Nota de crédito'
      )
      and not exists (
        select 1 from public.issued_document_payments payment
        where payment.issued_document_id = document.id
      )
      and (document.payment_status <> 'Pendiente' or document.payment_date is not null or document.payment_method is not null)
  ) then raise exception 'Invariant failed: residual payment metadata without payment'; end if;
end;
$$;
