-- Préstamos otorgados por la empresa: cartera, eventos de caja, conciliación
-- bancaria y contabilización automática. El contrato no mueve bancos; el
-- asiento se materializa cuando Tesorería lo respalda con una cartola real.

create table public.company_loans (
  id uuid primary key default gen_random_uuid(),
  loan_number bigint generated always as identity,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  borrower_counterparty_id uuid not null,
  disbursement_bank_account_id uuid not null,
  contract_date date not null,
  disbursement_date date not null,
  maturity_date date not null,
  principal_amount numeric(18, 2) not null,
  currency_code text not null default 'CLP',
  annual_interest_rate numeric(9, 6) not null default 0,
  receivable_account_code text not null,
  agreement_reference text,
  purpose text,
  related_party boolean not null default false,
  stamp_tax_status text not null default 'review',
  status text not null default 'ready',
  disbursed_amount numeric(18, 2) not null default 0,
  principal_repaid numeric(18, 2) not null default 0,
  interest_collected numeric(18, 2) not null default 0,
  principal_outstanding numeric(18, 2) not null default 0,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, loan_number),
  foreign key (borrower_counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  foreign key (disbursement_bank_account_id, organization_id)
    references public.bank_accounts (id, organization_id) on delete restrict,
  constraint company_loans_dates_check check (
    disbursement_date >= contract_date and maturity_date >= disbursement_date
  ),
  constraint company_loans_principal_check check (principal_amount > 0),
  constraint company_loans_currency_check check (currency_code = 'CLP'),
  constraint company_loans_interest_check check (
    annual_interest_rate >= 0 and annual_interest_rate <= 100
  ),
  constraint company_loans_receivable_account_check check (
    receivable_account_code in ('110230', '120300')
  ),
  constraint company_loans_reference_length_check check (
    agreement_reference is null or char_length(agreement_reference) <= 180
  ),
  constraint company_loans_purpose_length_check check (
    purpose is null or char_length(purpose) <= 2000
  ),
  constraint company_loans_stamp_tax_status_check check (
    stamp_tax_status in ('review', 'pending', 'paid', 'not_applicable')
  ),
  constraint company_loans_status_check check (
    status in ('ready', 'disbursed', 'partially_repaid', 'repaid', 'overdue', 'cancelled')
  ),
  constraint company_loans_aggregates_check check (
    disbursed_amount >= 0
    and principal_repaid >= 0
    and interest_collected >= 0
    and principal_outstanding >= 0
  )
);

create table public.company_loan_cash_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  loan_id uuid not null,
  bank_account_id uuid not null,
  event_type text not null,
  scheduled_on date not null,
  principal_amount numeric(18, 2) not null default 0,
  interest_amount numeric(18, 2) not null default 0,
  total_amount numeric(18, 2) generated always as (principal_amount + interest_amount) stored,
  status text not null default 'pending',
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (loan_id, organization_id)
    references public.company_loans (id, organization_id) on delete cascade,
  foreign key (bank_account_id, organization_id)
    references public.bank_accounts (id, organization_id) on delete restrict,
  constraint company_loan_cash_events_type_check check (
    event_type in ('disbursement', 'repayment')
  ),
  constraint company_loan_cash_events_amounts_check check (
    principal_amount >= 0
    and interest_amount >= 0
    and principal_amount + interest_amount > 0
    and (event_type <> 'disbursement' or interest_amount = 0)
  ),
  constraint company_loan_cash_events_status_check check (
    status in ('pending', 'partially_reconciled', 'reconciled', 'cancelled')
  ),
  constraint company_loan_cash_events_notes_length_check check (
    notes is null or char_length(notes) <= 2000
  )
);

create index company_loans_organization_status_maturity_idx
  on public.company_loans (organization_id, status, maturity_date);
create index company_loans_borrower_idx
  on public.company_loans (borrower_counterparty_id, maturity_date desc);
create index company_loan_cash_events_loan_date_idx
  on public.company_loan_cash_events (loan_id, scheduled_on, created_at);
create index company_loan_cash_events_pending_idx
  on public.company_loan_cash_events (organization_id, event_type, scheduled_on)
  where status in ('pending', 'partially_reconciled');

create trigger company_loans_set_updated_at
before update on public.company_loans
for each row execute function public.set_updated_at();

create trigger company_loan_cash_events_set_updated_at
before update on public.company_loan_cash_events
for each row execute function public.set_updated_at();

alter table public.company_loans enable row level security;
alter table public.company_loan_cash_events enable row level security;

create policy "finance and audit read company loans"
on public.company_loans for select to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = company_loans.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

create policy "finance manages company loans"
on public.company_loans for all to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = company_loans.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
)
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = company_loans.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance and audit read company loan cash events"
on public.company_loan_cash_events for select to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = company_loan_cash_events.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

create policy "finance manages company loan cash events"
on public.company_loan_cash_events for all to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = company_loan_cash_events.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
)
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = company_loan_cash_events.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

grant select, insert, update, delete on public.company_loans to authenticated;
grant select, insert, update, delete on public.company_loan_cash_events to authenticated;
grant usage, select on sequence public.company_loans_loan_number_seq to authenticated;

-- Amplía el plan estándar sin alterar cuentas creadas por cada empresa.
create or replace function public.seed_chilean_ifrs_chart_of_accounts(p_organization_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  inserted_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then raise exception 'Finance access required'; end if;

  insert into public.chart_of_accounts (
    organization_id, account_code, account_name, nature, normal_balance,
    statement_area, presentation_group, is_postable, is_active
  ) values
    (p_organization_id, '110100', 'Bancos', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110110', 'Caja', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110200', 'Deudores comerciales y otras cuentas por cobrar', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110210', 'IVA crédito fiscal', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110220', 'Pagos provisionales mensuales (PPM)', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110230', 'Préstamos por cobrar a empresas - corriente', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110240', 'Intereses por cobrar', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110300', 'Anticipos a proveedores', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '120100', 'Propiedades, planta y equipo', 'asset', 'debit', 'statement_of_financial_position', 'Activo no corriente', true, true),
    (p_organization_id, '120110', 'Depreciación acumulada', 'asset', 'credit', 'statement_of_financial_position', 'Activo no corriente', true, true),
    (p_organization_id, '120200', 'Activos por derecho de uso', 'asset', 'debit', 'statement_of_financial_position', 'Activo no corriente', true, true),
    (p_organization_id, '120300', 'Préstamos por cobrar a empresas - no corriente', 'asset', 'debit', 'statement_of_financial_position', 'Activo no corriente', true, true),
    (p_organization_id, '120390', 'Deterioro acumulado de préstamos por cobrar', 'asset', 'credit', 'statement_of_financial_position', 'Activo no corriente', true, true),
    (p_organization_id, '210100', 'Proveedores y cuentas por pagar', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo corriente', true, true),
    (p_organization_id, '210200', 'IVA débito fiscal', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo corriente', true, true),
    (p_organization_id, '210210', 'Retenciones y obligaciones tributarias', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo corriente', true, true),
    (p_organization_id, '220100', 'Préstamos y obligaciones financieras', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo no corriente', true, true),
    (p_organization_id, '220200', 'Pasivos por arrendamiento', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo no corriente', true, true),
    (p_organization_id, '230100', 'Provisiones', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo no corriente', true, true),
    (p_organization_id, '310100', 'Capital emitido', 'equity', 'credit', 'statement_of_financial_position', 'Patrimonio', true, true),
    (p_organization_id, '310200', 'Resultados acumulados', 'equity', 'credit', 'statement_of_financial_position', 'Patrimonio', true, true),
    (p_organization_id, '310300', 'Resultado del ejercicio', 'equity', 'credit', 'statement_of_financial_position', 'Patrimonio', true, true),
    (p_organization_id, '410100', 'Ingresos ordinarios', 'revenue', 'credit', 'profit_or_loss', 'Ingresos de actividades ordinarias', true, true),
    (p_organization_id, '410200', 'Otros ingresos', 'revenue', 'credit', 'profit_or_loss', 'Otros ingresos', true, true),
    (p_organization_id, '410300', 'Ingresos financieros por intereses', 'revenue', 'credit', 'profit_or_loss', 'Ingresos financieros', true, true),
    (p_organization_id, '510100', 'Costo de ventas', 'expense', 'debit', 'profit_or_loss', 'Costo de ventas', true, true),
    (p_organization_id, '610100', 'Gastos operacionales por clasificar', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610200', 'Remuneraciones y cargas sociales', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610300', 'Arriendos y gastos de ocupación', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610400', 'Servicios básicos y comunicaciones', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610500', 'Servicios profesionales', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610900', 'Depreciación y amortización', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610950', 'Pérdidas crediticias esperadas', 'expense', 'debit', 'profit_or_loss', 'Deterioro de activos financieros', true, true)
  on conflict (organization_id, account_code) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.create_company_loan(
  p_organization_id uuid,
  p_borrower_counterparty_id uuid,
  p_bank_account_id uuid,
  p_contract_date date,
  p_disbursement_date date,
  p_maturity_date date,
  p_principal_amount numeric,
  p_annual_interest_rate numeric,
  p_agreement_reference text,
  p_purpose text,
  p_related_party boolean,
  p_stamp_tax_status text
)
returns public.company_loans
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  loan_row public.company_loans;
  account_currency text;
  normalized_reference text := nullif(btrim(coalesce(p_agreement_reference, '')), '');
  normalized_purpose text := nullif(btrim(coalesce(p_purpose, '')), '');
  target_account_code text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then raise exception 'Finance access required'; end if;
  if p_contract_date is null or p_disbursement_date is null or p_maturity_date is null
     or p_disbursement_date < p_contract_date or p_maturity_date < p_disbursement_date then
    raise exception 'Loan dates are invalid';
  end if;
  if coalesce(p_principal_amount, 0) <= 0 then raise exception 'Principal must be positive'; end if;
  if coalesce(p_annual_interest_rate, 0) < 0 or coalesce(p_annual_interest_rate, 0) > 100 then
    raise exception 'Annual interest rate is invalid';
  end if;
  if normalized_reference is not null and char_length(normalized_reference) > 180 then
    raise exception 'Agreement reference is too long';
  end if;
  if normalized_purpose is not null and char_length(normalized_purpose) > 2000 then
    raise exception 'Purpose is too long';
  end if;
  if p_stamp_tax_status not in ('review', 'pending', 'paid', 'not_applicable') then
    raise exception 'Stamp tax status is invalid';
  end if;
  if not exists (
    select 1 from public.counterparties counterparty
    where counterparty.id = p_borrower_counterparty_id
      and counterparty.organization_id = p_organization_id
      and counterparty.is_active
  ) then raise exception 'Borrower is not available'; end if;
  select account.currency_code into account_currency
  from public.bank_accounts account
  where account.id = p_bank_account_id
    and account.organization_id = p_organization_id
    and account.is_active;
  if account_currency is null then raise exception 'Bank account is not available'; end if;
  if account_currency <> 'CLP' then raise exception 'Company loans currently require a CLP bank account'; end if;

  target_account_code := case
    when p_maturity_date <= (p_disbursement_date + interval '1 year')::date then '110230'
    else '120300'
  end;

  insert into public.company_loans (
    organization_id, borrower_counterparty_id, disbursement_bank_account_id,
    contract_date, disbursement_date, maturity_date, principal_amount,
    currency_code, annual_interest_rate, receivable_account_code,
    agreement_reference, purpose, related_party, stamp_tax_status,
    principal_outstanding
  ) values (
    p_organization_id, p_borrower_counterparty_id, p_bank_account_id,
    p_contract_date, p_disbursement_date, p_maturity_date,
    round(p_principal_amount, 2), 'CLP', coalesce(p_annual_interest_rate, 0),
    target_account_code, normalized_reference, normalized_purpose,
    coalesce(p_related_party, false), p_stamp_tax_status,
    0
  ) returning * into loan_row;

  insert into public.company_loan_cash_events (
    organization_id, loan_id, bank_account_id, event_type, scheduled_on,
    principal_amount, interest_amount, notes
  ) values (
    p_organization_id, loan_row.id, p_bank_account_id, 'disbursement',
    p_disbursement_date, loan_row.principal_amount, 0,
    coalesce('Desembolso de préstamo ' || normalized_reference, 'Desembolso de préstamo')
  );

  return loan_row;
end;
$$;

create or replace function public.create_company_loan_repayment_event(
  p_organization_id uuid,
  p_loan_id uuid,
  p_bank_account_id uuid,
  p_scheduled_on date,
  p_principal_amount numeric,
  p_interest_amount numeric,
  p_notes text
)
returns public.company_loan_cash_events
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  loan_row public.company_loans;
  event_row public.company_loan_cash_events;
  scheduled_principal numeric;
  account_currency text;
  normalized_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then raise exception 'Finance access required'; end if;

  select * into loan_row
  from public.company_loans loan
  where loan.id = p_loan_id and loan.organization_id = p_organization_id
  for update;
  if not found or loan_row.status in ('repaid', 'cancelled') then raise exception 'Loan is not available'; end if;
  if p_scheduled_on is null or p_scheduled_on < loan_row.disbursement_date then
    raise exception 'Repayment date is invalid';
  end if;
  if coalesce(p_principal_amount, 0) < 0 or coalesce(p_interest_amount, 0) < 0
     or coalesce(p_principal_amount, 0) + coalesce(p_interest_amount, 0) <= 0 then
    raise exception 'Repayment must contain principal or interest';
  end if;
  if normalized_notes is not null and char_length(normalized_notes) > 2000 then
    raise exception 'Notes are too long';
  end if;
  select account.currency_code into account_currency
  from public.bank_accounts account
  where account.id = p_bank_account_id
    and account.organization_id = p_organization_id
    and account.is_active;
  if account_currency <> 'CLP' then raise exception 'Repayment requires an active CLP bank account'; end if;
  select coalesce(sum(event.principal_amount), 0) into scheduled_principal
  from public.company_loan_cash_events event
  where event.loan_id = p_loan_id
    and event.organization_id = p_organization_id
    and event.event_type = 'repayment'
    and event.status <> 'cancelled';
  if scheduled_principal + coalesce(p_principal_amount, 0) > loan_row.principal_amount then
    raise exception 'Scheduled principal exceeds the original loan principal';
  end if;

  insert into public.company_loan_cash_events (
    organization_id, loan_id, bank_account_id, event_type, scheduled_on,
    principal_amount, interest_amount, notes
  ) values (
    p_organization_id, p_loan_id, p_bank_account_id, 'repayment',
    p_scheduled_on, round(coalesce(p_principal_amount, 0), 2),
    round(coalesce(p_interest_amount, 0), 2), normalized_notes
  ) returning * into event_row;
  return event_row;
end;
$$;

revoke all on function public.create_company_loan(uuid, uuid, uuid, date, date, date, numeric, numeric, text, text, boolean, text) from public, anon;
grant execute on function public.create_company_loan(uuid, uuid, uuid, date, date, date, numeric, numeric, text, text, boolean, text) to authenticated;
revoke all on function public.create_company_loan_repayment_event(uuid, uuid, uuid, date, numeric, numeric, text) from public, anon;
grant execute on function public.create_company_loan_repayment_event(uuid, uuid, uuid, date, numeric, numeric, text) to authenticated;

-- Un movimiento bancario ahora puede respaldar también un evento de préstamo.
alter table public.bank_reconciliation_matches
  add column loan_cash_event_id uuid,
  add column loan_principal_amount numeric(18, 2) not null default 0,
  add column loan_interest_amount numeric(18, 2) not null default 0,
  add column accounting_entry_id uuid,
  add constraint bank_reconciliation_matches_loan_event_organization_fkey
    foreign key (loan_cash_event_id, organization_id)
    references public.company_loan_cash_events (id, organization_id) on delete restrict,
  add constraint bank_reconciliation_matches_accounting_entry_organization_fkey
    foreign key (accounting_entry_id, organization_id)
    references public.accounting_entries (id, organization_id) on delete restrict,
  drop constraint bank_reconciliation_matches_one_payable_check,
  add constraint bank_reconciliation_matches_one_target_check
    check (num_nonnulls(issued_document_id, received_document_id, direct_payable_id, loan_cash_event_id) = 1),
  add constraint bank_reconciliation_matches_loan_allocation_check
    check (
      (loan_cash_event_id is null
        and loan_principal_amount = 0
        and loan_interest_amount = 0
        and accounting_entry_id is null)
      or
      (loan_cash_event_id is not null
        and loan_principal_amount >= 0
        and loan_interest_amount >= 0
        and loan_principal_amount + loan_interest_amount = matched_amount
        and accounting_entry_id is not null)
    );

create index bank_reconciliation_matches_loan_event_idx
  on public.bank_reconciliation_matches (loan_cash_event_id, matched_on)
  where loan_cash_event_id is not null;
create index bank_reconciliation_matches_accounting_entry_idx
  on public.bank_reconciliation_matches (accounting_entry_id)
  where accounting_entry_id is not null;

-- Conserva las validaciones canónicas de documentos y agrega el nuevo destino.
-- Para préstamos, el mismo BEFORE INSERT crea el asiento y evita una
-- conciliación sin contabilidad o una contabilidad sin conciliación.
create or replace function public.validate_and_materialize_bank_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction_amount numeric;
  transaction_signed_amount numeric;
  transaction_bank_account_id uuid;
  already_matched numeric;
  payable_amount numeric;
  paid_before numeric;
  required_execution numeric;
  execution_id uuid;
  document_status text;
  loan_event public.company_loan_cash_events;
  loan_row public.company_loans;
  matched_principal numeric;
  matched_interest numeric;
  period_row public.financial_periods;
  entry_row public.accounting_entries;
  bank_account_id uuid;
  receivable_account_id uuid;
  interest_account_id uuid;
  next_line integer;
begin
  select abs(transaction.amount), transaction.amount, transaction.bank_account_id
    into transaction_amount, transaction_signed_amount, transaction_bank_account_id
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

  if new.loan_cash_event_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':loan-event:' || new.loan_cash_event_id::text, 0));
    select event.* into loan_event
    from public.company_loan_cash_events event
    where event.id = new.loan_cash_event_id
      and event.organization_id = new.organization_id
      and event.status <> 'cancelled'
    for update;
    if not found then raise exception 'Loan cash event is unavailable'; end if;
    select loan.* into loan_row
    from public.company_loans loan
    where loan.id = loan_event.loan_id
      and loan.organization_id = new.organization_id
      and loan.status <> 'cancelled'
    for update;
    if not found then raise exception 'Loan is unavailable'; end if;
    if (loan_event.event_type = 'disbursement' and transaction_signed_amount >= 0)
       or (loan_event.event_type = 'repayment' and transaction_signed_amount <= 0) then
      raise exception 'Bank transaction direction does not match the loan cash event';
    end if;
    if loan_event.bank_account_id <> transaction_bank_account_id then
      raise exception 'Bank transaction account does not match the loan cash event account';
    end if;
    if loan_event.event_type = 'repayment'
       and (loan_row.disbursed_amount <= 0
         or new.loan_principal_amount > greatest(loan_row.disbursed_amount - loan_row.principal_repaid, 0)) then
      raise exception 'Repayment principal exceeds the disbursed outstanding principal';
    end if;
    if new.matched_amount <> round(new.matched_amount, 0)
       or new.loan_principal_amount <> round(new.loan_principal_amount, 0)
       or new.loan_interest_amount <> round(new.loan_interest_amount, 0) then
      raise exception 'Company loan reconciliation requires whole CLP amounts';
    end if;
    if new.loan_principal_amount < 0 or new.loan_interest_amount < 0
       or new.loan_principal_amount + new.loan_interest_amount <> new.matched_amount then
      raise exception 'Loan reconciliation allocation does not equal the matched amount';
    end if;
    if loan_event.event_type = 'disbursement'
       and (new.loan_interest_amount <> 0 or new.loan_principal_amount <> new.matched_amount) then
      raise exception 'A loan disbursement must be allocated entirely to principal';
    end if;
    select
      coalesce(sum(match.loan_principal_amount), 0),
      coalesce(sum(match.loan_interest_amount), 0)
      into matched_principal, matched_interest
    from public.bank_reconciliation_matches match
    where match.loan_cash_event_id = new.loan_cash_event_id;
    if matched_principal + new.loan_principal_amount > loan_event.principal_amount
       or matched_interest + new.loan_interest_amount > loan_event.interest_amount then
      raise exception 'Loan reconciliation exceeds the cash event allocation';
    end if;

    insert into public.chart_of_accounts (
      organization_id, account_code, account_name, nature, normal_balance,
      statement_area, presentation_group, is_postable, is_active
    ) values
      (new.organization_id, '110100', 'Bancos', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
      (new.organization_id, '110230', 'Préstamos por cobrar a empresas - corriente', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
      (new.organization_id, '120300', 'Préstamos por cobrar a empresas - no corriente', 'asset', 'debit', 'statement_of_financial_position', 'Activo no corriente', true, true),
      (new.organization_id, '410300', 'Ingresos financieros por intereses', 'revenue', 'credit', 'profit_or_loss', 'Ingresos financieros', true, true)
    on conflict (organization_id, account_code) do nothing;

    select account.id into bank_account_id
    from public.chart_of_accounts account
    where account.organization_id = new.organization_id and account.account_code = '110100';
    select account.id into receivable_account_id
    from public.chart_of_accounts account
    where account.organization_id = new.organization_id
      and account.account_code = loan_row.receivable_account_code;
    select account.id into interest_account_id
    from public.chart_of_accounts account
    where account.organization_id = new.organization_id and account.account_code = '410300';
    if bank_account_id is null or receivable_account_id is null or interest_account_id is null then
      raise exception 'Loan accounting accounts are unavailable';
    end if;

    select period.* into period_row
    from public.financial_periods period
    where period.organization_id = new.organization_id
      and period.period_start = date_trunc('month', new.matched_on)::date
    for update;
    if not found then
      insert into public.financial_periods (
        organization_id, period_start, period_end, notes
      ) values (
        new.organization_id,
        date_trunc('month', new.matched_on)::date,
        (date_trunc('month', new.matched_on) + interval '1 month - 1 day')::date,
        'Creado al conciliar un préstamo otorgado.'
      ) returning * into period_row;
    end if;
    if period_row.status in ('closed', 'locked') then
      raise exception 'Loan cannot be reconciled into a closed financial period';
    end if;

    insert into public.accounting_entries (
      organization_id, financial_period_id, entry_date, status, description,
      external_reference, source_event_key
    ) values (
      new.organization_id, period_row.id, new.matched_on, 'draft',
      case loan_event.event_type
        when 'disbursement' then 'Desembolso préstamo otorgado PRE-' || lpad(loan_row.loan_number::text, 6, '0')
        else 'Devolución préstamo otorgado PRE-' || lpad(loan_row.loan_number::text, 6, '0')
      end,
      coalesce(loan_row.agreement_reference, 'PRE-' || lpad(loan_row.loan_number::text, 6, '0')),
      'loan:bank-match:' || new.id::text
    ) returning * into entry_row;

    if loan_event.event_type = 'disbursement' then
      insert into public.accounting_entry_lines (
        organization_id, entry_id, account_id, line_number, description,
        currency_code, functional_debit, functional_credit
      ) values
        (new.organization_id, entry_row.id, receivable_account_id, 1,
         'Capital entregado a la empresa deudora', 'CLP', new.matched_amount, 0),
        (new.organization_id, entry_row.id, bank_account_id, 2,
         'Salida desde cuenta bancaria de Genesis', 'CLP', 0, new.matched_amount);
    else
      insert into public.accounting_entry_lines (
        organization_id, entry_id, account_id, line_number, description,
        currency_code, functional_debit, functional_credit
      ) values (
        new.organization_id, entry_row.id, bank_account_id, 1,
        'Ingreso bancario por devolución del préstamo', 'CLP',
        new.matched_amount, 0
      );
      next_line := 2;
      if new.loan_principal_amount > 0 then
        insert into public.accounting_entry_lines (
          organization_id, entry_id, account_id, line_number, description,
          currency_code, functional_debit, functional_credit
        ) values (
          new.organization_id, entry_row.id, receivable_account_id, next_line,
          'Recuperación de capital', 'CLP', 0, new.loan_principal_amount
        );
        next_line := next_line + 1;
      end if;
      if new.loan_interest_amount > 0 then
        insert into public.accounting_entry_lines (
          organization_id, entry_id, account_id, line_number, description,
          currency_code, functional_debit, functional_credit
        ) values (
          new.organization_id, entry_row.id, interest_account_id, next_line,
          'Intereses cobrados', 'CLP', 0, new.loan_interest_amount
        );
      end if;
    end if;

    update public.accounting_entries
    set status = 'posted', posted_at = now(), posted_by = auth.uid()
    where id = entry_row.id and organization_id = new.organization_id;
    new.accounting_entry_id := entry_row.id;
    new.payment_execution_id := null;
  elsif new.issued_document_id is not null then
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
    raise exception 'Reconciliation requires exactly one target';
  end if;
  return new;
end;
$$;

create or replace function public.refresh_company_loan_after_bank_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_event public.company_loan_cash_events;
  event_matched numeric;
  disbursed numeric;
  repaid numeric;
  interest_paid numeric;
  outstanding numeric;
  loan_maturity date;
begin
  if new.loan_cash_event_id is null then return new; end if;
  select * into target_event
  from public.company_loan_cash_events event
  where event.id = new.loan_cash_event_id and event.organization_id = new.organization_id
  for update;
  select coalesce(sum(match.matched_amount), 0) into event_matched
  from public.bank_reconciliation_matches match
  where match.loan_cash_event_id = new.loan_cash_event_id;
  update public.company_loan_cash_events
  set status = case
    when event_matched >= total_amount then 'reconciled'
    when event_matched > 0 then 'partially_reconciled'
    else 'pending'
  end
  where id = new.loan_cash_event_id and organization_id = new.organization_id;

  select
    coalesce(sum(match.loan_principal_amount) filter (where event.event_type = 'disbursement'), 0),
    coalesce(sum(match.loan_principal_amount) filter (where event.event_type = 'repayment'), 0),
    coalesce(sum(match.loan_interest_amount) filter (where event.event_type = 'repayment'), 0)
    into disbursed, repaid, interest_paid
  from public.company_loan_cash_events event
  left join public.bank_reconciliation_matches match
    on match.loan_cash_event_id = event.id
   and match.organization_id = event.organization_id
  where event.loan_id = target_event.loan_id
    and event.organization_id = new.organization_id;
  outstanding := greatest(disbursed - repaid, 0);
  select maturity_date into loan_maturity
  from public.company_loans
  where id = target_event.loan_id and organization_id = new.organization_id;
  update public.company_loans
  set disbursed_amount = disbursed,
      principal_repaid = repaid,
      interest_collected = interest_paid,
      principal_outstanding = outstanding,
      status = case
        when disbursed <= 0 then 'ready'
        when outstanding <= 0 then 'repaid'
        when loan_maturity < current_date then 'overdue'
        when repaid > 0 then 'partially_repaid'
        else 'disbursed'
      end
  where id = target_event.loan_id and organization_id = new.organization_id;
  return new;
end;
$$;

create trigger bank_reconciliation_matches_refresh_company_loan
after insert on public.bank_reconciliation_matches
for each row execute function public.refresh_company_loan_after_bank_match();

revoke all on function public.validate_and_materialize_bank_match() from public, anon, authenticated;
revoke all on function public.refresh_company_loan_after_bank_match() from public, anon, authenticated;
