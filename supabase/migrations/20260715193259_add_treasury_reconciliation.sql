-- Tesorería: cuentas, movimientos importados y aplicaciones contra documentos.
-- Los importes de movimientos son firmados: abonos positivos y cargos negativos.

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  bank_name text,
  account_number_masked text,
  currency_code text not null default 'CLP',
  opening_balance numeric(18, 2) not null default 0,
  opening_balance_date date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique nulls not distinct (organization_id, bank_name, account_number_masked),
  constraint bank_accounts_currency_code_check check (currency_code ~ '^[A-Z]{3}$'),
  constraint bank_accounts_name_not_blank check (length(btrim(name)) > 0)
);

create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  bank_account_id uuid not null,
  booked_on date not null,
  value_date date,
  description text not null,
  reference text,
  amount numeric(18, 2) not null,
  balance_after numeric(18, 2),
  source_external_id text,
  source_file_name text,
  reconciliation_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (bank_account_id, organization_id)
    references public.bank_accounts (id, organization_id) on delete cascade,
  unique nulls not distinct (bank_account_id, source_external_id),
  constraint bank_transactions_amount_not_zero check (amount <> 0),
  constraint bank_transactions_status_check check (
    reconciliation_status in ('pending', 'partially_reconciled', 'reconciled')
  ),
  constraint bank_transactions_description_not_blank check (length(btrim(description)) > 0)
);

-- Referencias compuestas aseguran que movimiento y documento pertenezcan a la
-- misma organización, incluso para accesos directos a la API de datos.
alter table public.received_documents
  add constraint received_documents_id_organization_key unique (id, organization_id);

create table public.bank_reconciliation_matches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  bank_transaction_id uuid not null,
  issued_document_id uuid,
  received_document_id uuid,
  matched_amount numeric(18, 2) not null,
  matched_on date not null default current_date,
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (bank_transaction_id, organization_id)
    references public.bank_transactions (id, organization_id) on delete cascade,
  foreign key (issued_document_id, organization_id)
    references public.issued_documents (id, organization_id) on delete restrict,
  foreign key (received_document_id, organization_id)
    references public.received_documents (id, organization_id) on delete restrict,
  constraint bank_reconciliation_matches_one_document_check check (
    num_nonnulls(issued_document_id, received_document_id) = 1
  ),
  constraint bank_reconciliation_matches_amount_positive check (matched_amount > 0),
  constraint bank_reconciliation_matches_notes_length check (notes is null or length(notes) <= 2000)
);

create index bank_accounts_organization_active_idx
  on public.bank_accounts (organization_id, is_active, name);
create index bank_transactions_account_booked_idx
  on public.bank_transactions (bank_account_id, booked_on desc, created_at desc);
create index bank_transactions_org_status_booked_idx
  on public.bank_transactions (organization_id, reconciliation_status, booked_on desc);
create index bank_reconciliation_matches_transaction_idx
  on public.bank_reconciliation_matches (bank_transaction_id);
create index bank_reconciliation_matches_issued_document_idx
  on public.bank_reconciliation_matches (issued_document_id)
  where issued_document_id is not null;
create index bank_reconciliation_matches_received_document_idx
  on public.bank_reconciliation_matches (received_document_id)
  where received_document_id is not null;

create trigger bank_accounts_set_updated_at before update on public.bank_accounts
for each row execute function public.set_updated_at();
create trigger bank_transactions_set_updated_at before update on public.bank_transactions
for each row execute function public.set_updated_at();

-- Impide que un movimiento o documento quede sobreconciliado; las asignaciones
-- parciales están permitidas para abonos, pagos agrupados y diferencias futuras.
create or replace function public.validate_bank_reconciliation_match()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transaction_amount numeric(18, 2);
  document_amount numeric(18, 2);
  already_matched numeric(18, 2);
begin
  select abs(amount) into transaction_amount
  from public.bank_transactions
  where id = new.bank_transaction_id and organization_id = new.organization_id
  for update;

  if transaction_amount is null then
    raise exception 'bank transaction is not available in this organization';
  end if;

  select coalesce(sum(matched_amount), 0) into already_matched
  from public.bank_reconciliation_matches
  where bank_transaction_id = new.bank_transaction_id
    and (tg_op <> 'UPDATE' or id <> old.id);

  if already_matched + new.matched_amount > transaction_amount then
    raise exception 'reconciliation amount exceeds bank transaction amount';
  end if;

  if new.issued_document_id is not null then
    select abs(coalesce(total_amount, 0)) into document_amount
    from public.issued_documents
    where id = new.issued_document_id and organization_id = new.organization_id
    for update;

    select coalesce(sum(matched_amount), 0) into already_matched
    from public.bank_reconciliation_matches
    where issued_document_id = new.issued_document_id
      and (tg_op <> 'UPDATE' or id <> old.id);
  else
    select abs(coalesce(total_amount, 0)) into document_amount
    from public.received_documents
    where id = new.received_document_id and organization_id = new.organization_id
    for update;

    select coalesce(sum(matched_amount), 0) into already_matched
    from public.bank_reconciliation_matches
    where received_document_id = new.received_document_id
      and (tg_op <> 'UPDATE' or id <> old.id);
  end if;

  if document_amount is null or document_amount = 0 then
    raise exception 'reconciliation document is not available or has no amount';
  end if;
  if already_matched + new.matched_amount > document_amount then
    raise exception 'reconciliation amount exceeds document amount';
  end if;

  return new;
end;
$$;

create trigger validate_bank_reconciliation_match_before_write
before insert or update on public.bank_reconciliation_matches
for each row execute function public.validate_bank_reconciliation_match();

alter table public.bank_accounts enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.bank_reconciliation_matches enable row level security;

create policy "finance and audit read bank accounts"
on public.bank_accounts for select to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_accounts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);
create policy "finance roles manage bank accounts"
on public.bank_accounts for all to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_accounts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_accounts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance and audit read bank transactions"
on public.bank_transactions for select to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_transactions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);
create policy "finance roles manage bank transactions"
on public.bank_transactions for all to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_transactions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_transactions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance and audit read bank reconciliation matches"
on public.bank_reconciliation_matches for select to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_reconciliation_matches.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);
create policy "finance roles manage bank reconciliation matches"
on public.bank_reconciliation_matches for all to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_reconciliation_matches.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_reconciliation_matches.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

grant select, insert, update, delete on public.bank_accounts to authenticated;
grant select, insert, update, delete on public.bank_transactions to authenticated;
grant select, insert, update, delete on public.bank_reconciliation_matches to authenticated;
revoke all on function public.validate_bank_reconciliation_match() from public, anon, authenticated;
