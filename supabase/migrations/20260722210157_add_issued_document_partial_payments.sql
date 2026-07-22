-- Cada abono conserva su propia fecha, medio y respaldo. El saldo del documento
-- se obtiene de la suma de estos movimientos, nunca de un valor digitado.
create table public.issued_document_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  issued_document_id uuid not null references public.issued_documents(id) on delete cascade,
  amount numeric(18, 2) not null check (amount > 0),
  paid_on date not null,
  payment_method text,
  notes text,
  proof_path text,
  proof_name text,
  proof_mime_type text,
  proof_size bigint,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (char_length(payment_method) <= 120),
  check (char_length(notes) <= 2000),
  check (proof_size is null or proof_size > 0)
);

create index issued_document_payments_document_paid_on_idx
  on public.issued_document_payments (issued_document_id, paid_on desc, created_at desc);

create index issued_document_payments_organization_paid_on_idx
  on public.issued_document_payments (organization_id, paid_on desc);

create unique index issued_document_payments_proof_path_key
  on public.issued_document_payments (proof_path)
  where proof_path is not null;

-- "Abonada" significa que hay al menos un pago, pero aún queda saldo.
alter table public.issued_documents
  drop constraint if exists issued_documents_payment_status_check,
  add constraint issued_documents_payment_status_check check (
    payment_status in (
      'Pendiente', 'Abonada', 'Pagada', 'Factorizada', 'Pagada al factoring',
      'Recomprada al factoring', 'Anulada', 'Nota de crédito'
    )
  );

-- Serializa los abonos por documento, impide sobrepagos y mantiene el estado
-- de la factura en sincronía con el historial de movimientos.
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

  select organization_id, coalesce(total_amount, 0), payment_status
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

  select
    coalesce(sum(amount), 0),
    max(paid_on)
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

create trigger issued_document_payments_sync_balance
before insert or update or delete on public.issued_document_payments
for each row execute function public.sync_issued_document_payment_balance();

alter table public.issued_document_payments enable row level security;

grant select, insert on public.issued_document_payments to authenticated;

create policy "members read issued document payments"
on public.issued_document_payments
for select to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = issued_document_payments.organization_id
      and membership.user_id = (select auth.uid())
  )
);

create policy "finance roles create issued document payments"
on public.issued_document_payments
for insert to authenticated
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = issued_document_payments.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

revoke all on function public.sync_issued_document_payment_balance() from public, anon, authenticated;
