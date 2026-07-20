-- Asientos manuales: se crean y contabilizan como una sola transacción para
-- evitar borradores parciales. Las validaciones de período y de cuadratura se
-- mantienen tanto aquí como en los triggers contables existentes.
create or replace function public.post_manual_accounting_entry(
  p_organization_id uuid,
  p_financial_period_id uuid,
  p_entry_date date,
  p_description text,
  p_external_reference text,
  p_currency_code text,
  p_lines jsonb
)
returns public.accounting_entries
language plpgsql
security invoker
set search_path = ''
as $$
declare
  period_row public.financial_periods;
  entry_row public.accounting_entries;
  actor_role public.organization_role;
  debit_total numeric(18, 2);
  credit_total numeric(18, 2);
  line_count integer;
  valid_account_count integer;
  normalized_description text := nullif(btrim(coalesce(p_description, '')), '');
  normalized_reference text := nullif(btrim(coalesce(p_external_reference, '')), '');
  normalized_currency text := upper(btrim(coalesce(p_currency_code, '')));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then
    raise exception 'Finance access required';
  end if;
  if normalized_description is null or char_length(normalized_description) > 500 then
    raise exception 'Entry description is required and must be at most 500 characters';
  end if;
  if normalized_reference is not null and char_length(normalized_reference) > 180 then
    raise exception 'External reference must be at most 180 characters';
  end if;
  if normalized_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must use a three-letter ISO code';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 or jsonb_array_length(p_lines) > 200 then
    raise exception 'An entry must contain between 2 and 200 lines';
  end if;

  select period.* into period_row
  from public.financial_periods period
  where period.id = p_financial_period_id
    and period.organization_id = p_organization_id
  for update;
  if not found then raise exception 'Financial period not found'; end if;
  if period_row.status in ('closed', 'locked') then
    raise exception 'Accounting records cannot be changed in a closed financial period';
  end if;
  if p_entry_date is null or p_entry_date not between period_row.period_start and period_row.period_end then
    raise exception 'Entry date must belong to the selected financial period';
  end if;

  select
    count(*),
    coalesce(sum(line.debit), 0),
    coalesce(sum(line.credit), 0)
  into line_count, debit_total, credit_total
  from jsonb_to_recordset(p_lines) as line(account_id uuid, debit numeric, credit numeric, description text);
  if debit_total <> credit_total or debit_total <= 0 then
    raise exception 'Accounting entry debits and credits must balance and be greater than zero';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_lines) as line(account_id uuid, debit numeric, credit numeric, description text)
    where line.account_id is null
      or coalesce(line.debit, 0) < 0
      or coalesce(line.credit, 0) < 0
      or (coalesce(line.debit, 0) = 0) = (coalesce(line.credit, 0) = 0)
      or char_length(coalesce(line.description, '')) > 500
  ) then
    raise exception 'Every line requires an account, one non-zero debit or credit, and an optional description of at most 500 characters';
  end if;
  select count(*) into valid_account_count
  from jsonb_to_recordset(p_lines) as line(account_id uuid, debit numeric, credit numeric, description text)
  join public.chart_of_accounts account
    on account.id = line.account_id
   and account.organization_id = p_organization_id
   and account.is_active
   and account.is_postable;
  if valid_account_count <> line_count then
    raise exception 'Every entry line must use an active postable account from the organization';
  end if;

  insert into public.accounting_entries (
    organization_id,
    financial_period_id,
    entry_date,
    status,
    description,
    external_reference
  ) values (
    p_organization_id,
    p_financial_period_id,
    p_entry_date,
    'draft',
    normalized_description,
    normalized_reference
  ) returning * into entry_row;

  insert into public.accounting_entry_lines (
    organization_id,
    entry_id,
    account_id,
    line_number,
    description,
    currency_code,
    functional_debit,
    functional_credit
  )
  select
    p_organization_id,
    entry_row.id,
    line.account_id,
    line.ordinality::integer,
    nullif(btrim(line.description), ''),
    normalized_currency::char(3),
    line.debit,
    line.credit
  from jsonb_to_recordset(p_lines) with ordinality as line(account_id uuid, debit numeric, credit numeric, description text, ordinality bigint);

  update public.accounting_entries
  set status = 'posted', posted_at = now(), posted_by = auth.uid()
  where id = entry_row.id
    and organization_id = p_organization_id
  returning * into entry_row;
  return entry_row;
end;
$$;

revoke all on function public.post_manual_accounting_entry(uuid, uuid, date, text, text, text, jsonb) from public, anon;
grant execute on function public.post_manual_accounting_entry(uuid, uuid, date, text, text, text, jsonb) to authenticated;
