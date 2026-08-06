-- Provisiones mensuales de remuneraciones con versiones semanales.
-- PeopleWork es una base contractual de solo origen; Finanzas agrega componentes
-- estimados y contabiliza directamente cada variación contra la versión anterior.

create table public.payroll_provisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_month date not null,
  status text not null default 'open' check (status in ('open', 'reconciled')),
  currency_code char(3) not null default 'CLP' check (currency_code ~ '^[A-Z]{3}$'),
  posted_amount numeric(18, 2) not null default 0 check (posted_amount >= 0),
  actual_amount numeric(18, 2) check (actual_amount is null or actual_amount >= 0),
  actual_refreshed_at timestamptz,
  reconciliation_entry_id uuid,
  reconciled_at timestamptz,
  reconciled_by uuid references auth.users(id) on delete set null,
  notes text check (notes is null or char_length(notes) <= 2000),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (reconciliation_entry_id, organization_id)
    references public.accounting_entries(id, organization_id) on delete restrict,
  unique (organization_id, period_month),
  unique (id, organization_id),
  check (period_month = date_trunc('month', period_month)::date),
  check (
    (status = 'open' and actual_amount is null and reconciled_at is null and reconciled_by is null and reconciliation_entry_id is null)
    or
    (status = 'reconciled' and actual_amount is not null and reconciled_at is not null and reconciled_by is not null)
  )
);

create table public.payroll_provision_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provision_id uuid not null,
  as_of_date date not null,
  status text not null default 'draft' check (status in ('draft', 'posted')),
  total_amount numeric(18, 2) check (total_amount is null or total_amount > 0),
  accounting_delta numeric(18, 2),
  accounting_entry_id uuid,
  source_refreshed_at timestamptz,
  posted_at timestamptz,
  posted_by uuid references auth.users(id) on delete set null,
  notes text check (notes is null or char_length(notes) <= 1000),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (provision_id, organization_id)
    references public.payroll_provisions(id, organization_id) on delete cascade,
  foreign key (accounting_entry_id, organization_id)
    references public.accounting_entries(id, organization_id) on delete restrict,
  unique (provision_id, as_of_date),
  unique (id, organization_id),
  check (
    (status = 'draft' and total_amount is null and accounting_delta is null and accounting_entry_id is null and posted_at is null and posted_by is null)
    or
    (
      status = 'posted'
      and total_amount is not null
      and accounting_delta is not null
      and posted_at is not null
      and posted_by is not null
      and ((accounting_delta = 0 and accounting_entry_id is null) or (accounting_delta <> 0 and accounting_entry_id is not null))
    )
  )
);

create unique index payroll_provision_one_draft_idx
  on public.payroll_provision_revisions(provision_id)
  where status = 'draft';

create table public.payroll_provision_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  revision_id uuid not null,
  source_type text not null check (source_type in ('peoplework', 'manual')),
  category text not null check (category in (
    'contractual_salary',
    'employer_contributions',
    'bonus',
    'commission',
    'overtime',
    'vacation',
    'severance',
    'allowance',
    'adjustment',
    'other'
  )),
  label text not null check (btrim(label) <> '' and char_length(label) <= 180),
  calculation_method text not null check (calculation_method in ('source', 'fixed', 'percentage')),
  direction text not null default 'add' check (direction in ('add', 'deduct')),
  calculation_rate numeric(9, 4)
    check (calculation_rate is null or (calculation_rate > 0 and calculation_rate <= 1000)),
  calculation_base numeric(18, 2)
    check (calculation_base is null or calculation_base >= 0),
  amount numeric(18, 2) not null check (amount >= 0),
  cost_center_id uuid,
  source_cost_center_code text,
  source_cost_center_name text,
  source_reference text,
  notes text check (notes is null or char_length(notes) <= 1000),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (revision_id, organization_id)
    references public.payroll_provision_revisions(id, organization_id) on delete cascade,
  foreign key (cost_center_id, organization_id)
    references public.cost_centers(id, organization_id) on delete restrict,
  check (
    (calculation_method = 'percentage' and calculation_rate is not null and calculation_base is not null)
    or
    (calculation_method <> 'percentage' and calculation_rate is null)
  ),
  check (
    (source_type = 'peoplework' and calculation_method = 'source' and direction = 'add')
    or source_type = 'manual'
  )
);

create index payroll_provisions_org_period_idx
  on public.payroll_provisions(organization_id, period_month desc);
create index payroll_provision_revisions_provision_date_idx
  on public.payroll_provision_revisions(provision_id, as_of_date desc);
create index payroll_provision_lines_revision_idx
  on public.payroll_provision_lines(revision_id, source_type, category);
create index payroll_provision_lines_cost_center_idx
  on public.payroll_provision_lines(organization_id, cost_center_id)
  where cost_center_id is not null;

create trigger payroll_provisions_set_updated_at
before update on public.payroll_provisions
for each row execute function public.set_updated_at();
create trigger payroll_provision_revisions_set_updated_at
before update on public.payroll_provision_revisions
for each row execute function public.set_updated_at();

create or replace function public.enforce_payroll_provision_line_editability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  revision_status text;
begin
  select status into revision_status
  from public.payroll_provision_revisions
  where id = coalesce(new.revision_id, old.revision_id)
    and organization_id = coalesce(new.organization_id, old.organization_id);

  if revision_status is distinct from 'draft' then
    raise exception 'Only draft payroll provision revisions can be edited';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger payroll_provision_lines_require_draft
before insert or update or delete on public.payroll_provision_lines
for each row execute function public.enforce_payroll_provision_line_editability();

create or replace function public.audit_payroll_provision_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entity_kind text := case when tg_table_name = 'payroll_provisions' then 'payroll_provision' else 'payroll_provision_revision' end;
begin
  insert into public.audit_log (
    organization_id, actor_id, entity_type, entity_id, action, before_state, after_state
  ) values (
    coalesce(new.organization_id, old.organization_id),
    auth.uid(),
    entity_kind,
    coalesce(new.id, old.id),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger payroll_provisions_audit_changes
after insert or update or delete on public.payroll_provisions
for each row execute function public.audit_payroll_provision_changes();
create trigger payroll_provision_revisions_audit_changes
after insert or update or delete on public.payroll_provision_revisions
for each row execute function public.audit_payroll_provision_changes();

alter table public.payroll_provisions enable row level security;
alter table public.payroll_provision_revisions enable row level security;
alter table public.payroll_provision_lines enable row level security;

create policy "finance and auditors read payroll provisions"
on public.payroll_provisions for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_provisions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);
create policy "finance manages payroll provisions"
on public.payroll_provisions for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_provisions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_provisions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance and auditors read payroll provision revisions"
on public.payroll_provision_revisions for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_provision_revisions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);
create policy "finance manages payroll provision revisions"
on public.payroll_provision_revisions for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_provision_revisions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_provision_revisions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance and auditors read payroll provision lines"
on public.payroll_provision_lines for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_provision_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);
create policy "finance manages payroll provision lines"
on public.payroll_provision_lines for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_provision_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_provision_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

grant select, insert, update, delete on
  public.payroll_provisions,
  public.payroll_provision_revisions,
  public.payroll_provision_lines
to authenticated;
revoke all on function public.enforce_payroll_provision_line_editability() from public, anon, authenticated;
revoke all on function public.audit_payroll_provision_changes() from public, anon, authenticated;

-- Abre una versión semanal. Si es una semana nueva, arrastra los componentes
-- manuales de la versión anterior y vuelve a calcular los porcentajes.
create or replace function public.refresh_payroll_provision_revision(
  p_organization_id uuid,
  p_period_month date,
  p_as_of_date date
)
returns public.payroll_provision_revisions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  provision_row public.payroll_provisions;
  revision_row public.payroll_provision_revisions;
  previous_revision_id uuid;
  created_revision boolean := false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_period_month is null or p_period_month <> date_trunc('month', p_period_month)::date then
    raise exception 'Payroll provision period must be the first day of a month';
  end if;
  if p_as_of_date is null or date_trunc('month', p_as_of_date)::date <> p_period_month then
    raise exception 'Weekly revision date must belong to the payroll provision month';
  end if;

  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then
    raise exception 'Finance access required';
  end if;

  insert into public.payroll_provisions (organization_id, period_month)
  values (p_organization_id, p_period_month)
  on conflict (organization_id, period_month) do nothing;

  select * into provision_row
  from public.payroll_provisions
  where organization_id = p_organization_id and period_month = p_period_month
  for update;
  if provision_row.status <> 'open' then
    raise exception 'A reconciled payroll provision cannot receive new weekly revisions';
  end if;

  select * into revision_row
  from public.payroll_provision_revisions
  where provision_id = provision_row.id and as_of_date = p_as_of_date
  for update;

  if found then
    if revision_row.status <> 'draft' then
      raise exception 'A posted weekly revision cannot be refreshed';
    end if;
  else
    if exists (
      select 1 from public.payroll_provision_revisions
      where provision_id = provision_row.id and status = 'draft'
    ) then
      raise exception 'Post or keep working on the current draft before opening another week';
    end if;
    if exists (
      select 1 from public.payroll_provision_revisions
      where provision_id = provision_row.id and as_of_date > p_as_of_date
    ) then
      raise exception 'Weekly revisions must be created in chronological order';
    end if;

    select id into previous_revision_id
    from public.payroll_provision_revisions
    where provision_id = provision_row.id and as_of_date < p_as_of_date
    order by as_of_date desc
    limit 1;

    insert into public.payroll_provision_revisions (
      organization_id, provision_id, as_of_date, source_refreshed_at
    ) values (
      p_organization_id, provision_row.id, p_as_of_date, now()
    )
    returning * into revision_row;
    created_revision := true;

    if previous_revision_id is not null then
      insert into public.payroll_provision_lines (
        organization_id, revision_id, source_type, category, label,
        calculation_method, direction, calculation_rate, calculation_base,
        amount, cost_center_id, source_cost_center_code,
        source_cost_center_name, source_reference, notes
      )
      select
        p_organization_id, revision_row.id, 'manual', category, label,
        calculation_method, direction, calculation_rate, calculation_base,
        amount, cost_center_id, source_cost_center_code,
        source_cost_center_name, null, notes
      from public.payroll_provision_lines
      where revision_id = previous_revision_id and source_type = 'manual';
    end if;
  end if;

  delete from public.payroll_provision_lines
  where revision_id = revision_row.id
    and organization_id = p_organization_id
    and source_type = 'peoplework';

  insert into public.payroll_provision_lines (
    organization_id, revision_id, source_type, category, label,
    calculation_method, direction, calculation_rate, calculation_base,
    amount, cost_center_id, source_cost_center_code,
    source_cost_center_name, source_reference
  )
  select
    p_organization_id,
    revision_row.id,
    'peoplework',
    'contractual_salary',
    'Remuneración bruta contractual',
    'source',
    'add',
    null,
    null,
    round(sum(line.amount), 2),
    center.id,
    line.cost_center_code,
    line.cost_center_name,
    'peoplework:contractual:' || p_period_month::text || ':' || coalesce(line.cost_center_code, line.cost_center_name, 'sin-centro')
  from public.payroll_cost_lines line
  left join public.cost_centers center
    on center.organization_id = line.organization_id
   and center.code = line.cost_center_code
  where line.organization_id = p_organization_id
    and line.period_month = p_period_month
    and line.data_basis = 'contractual_estimate'
  group by center.id, line.cost_center_code, line.cost_center_name
  having round(sum(line.amount), 2) > 0;

  with percentage_bases as (
    select
      manual.id,
      coalesce(sum(source.amount), 0)::numeric(18, 2) as base_amount
    from public.payroll_provision_lines manual
    left join public.payroll_provision_lines source
      on source.revision_id = manual.revision_id
     and source.source_type = 'peoplework'
     and (manual.cost_center_id is null or source.cost_center_id = manual.cost_center_id)
    where manual.revision_id = revision_row.id
      and manual.source_type = 'manual'
      and manual.calculation_method = 'percentage'
    group by manual.id
  )
  update public.payroll_provision_lines manual
  set calculation_base = percentage_bases.base_amount,
      amount = round(percentage_bases.base_amount * manual.calculation_rate / 100, 2)
  from percentage_bases
  where manual.id = percentage_bases.id;

  update public.payroll_provision_revisions
  set source_refreshed_at = now()
  where id = revision_row.id and organization_id = p_organization_id
  returning * into revision_row;

  return revision_row;
end;
$$;

-- Contabiliza sólo el movimiento contra la última provisión ya registrada.
create or replace function public.post_payroll_provision_revision(
  p_organization_id uuid,
  p_revision_id uuid
)
returns public.payroll_provision_revisions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  provision_row public.payroll_provisions;
  revision_row public.payroll_provision_revisions;
  period_row public.financial_periods;
  expense_account_id uuid;
  payable_account_id uuid;
  entry_row public.accounting_entries;
  revision_total numeric(18, 2);
  revision_delta numeric(18, 2);
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then
    raise exception 'Finance access required';
  end if;

  select * into revision_row
  from public.payroll_provision_revisions
  where id = p_revision_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Payroll provision revision not found'; end if;
  if revision_row.status <> 'draft' then raise exception 'Only draft revisions can be posted'; end if;

  select * into provision_row
  from public.payroll_provisions
  where id = revision_row.provision_id and organization_id = p_organization_id
  for update;
  if provision_row.status <> 'open' then raise exception 'Payroll provision is already reconciled'; end if;
  if exists (
    select 1 from public.payroll_provision_revisions
    where provision_id = provision_row.id
      and status = 'posted'
      and as_of_date >= revision_row.as_of_date
  ) then
    raise exception 'Weekly revisions must be posted in chronological order';
  end if;

  select coalesce(sum(case when direction = 'add' then amount else -amount end), 0)
  into revision_total
  from public.payroll_provision_lines
  where revision_id = revision_row.id and organization_id = p_organization_id;
  if revision_total <= 0 then raise exception 'Payroll provision total must be greater than zero'; end if;
  revision_total := round(revision_total, 2);
  revision_delta := round(revision_total - provision_row.posted_amount, 2);

  select * into period_row
  from public.financial_periods
  where organization_id = p_organization_id
    and period_start = provision_row.period_month
  for update;
  if not found then
    insert into public.financial_periods (
      organization_id, period_start, period_end, notes
    ) values (
      p_organization_id,
      provision_row.period_month,
      (provision_row.period_month + interval '1 month - 1 day')::date,
      'Creado al contabilizar provisiones semanales de remuneraciones.'
    )
    returning * into period_row;
  end if;
  if period_row.status in ('closed', 'locked') then
    raise exception 'Payroll provision cannot be posted into a closed period';
  end if;

  if revision_delta <> 0 then
    insert into public.chart_of_accounts (
      organization_id, account_code, account_name, nature, normal_balance,
      statement_area, presentation_group, is_postable, is_active
    ) values
      (p_organization_id, '210300', 'Remuneraciones y cargas por pagar', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo corriente', true, true),
      (p_organization_id, '610200', 'Remuneraciones y cargas sociales', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true)
    on conflict (organization_id, account_code) do nothing;

    select id into payable_account_id
    from public.chart_of_accounts
    where organization_id = p_organization_id and account_code = '210300';
    select id into expense_account_id
    from public.chart_of_accounts
    where organization_id = p_organization_id and account_code = '610200';

    insert into public.accounting_entries (
      organization_id, financial_period_id, entry_date, status,
      description, external_reference, source_event_key
    ) values (
      p_organization_id,
      period_row.id,
      revision_row.as_of_date,
      'draft',
      'Movimiento semanal provisión remuneraciones ' || to_char(revision_row.as_of_date, 'YYYY-MM-DD'),
      'PROV-REM-' || to_char(revision_row.as_of_date, 'YYYYMMDD'),
      'payroll-provision-revision:' || revision_row.id::text
    )
    returning * into entry_row;

    if revision_delta > 0 then
      insert into public.accounting_entry_lines (
        organization_id, entry_id, account_id, line_number, description,
        currency_code, functional_debit, functional_credit
      ) values
        (p_organization_id, entry_row.id, expense_account_id, 1, 'Aumento de provisión de remuneraciones', provision_row.currency_code, revision_delta, 0),
        (p_organization_id, entry_row.id, payable_account_id, 2, 'Aumento de remuneraciones por pagar', provision_row.currency_code, 0, revision_delta);
    else
      insert into public.accounting_entry_lines (
        organization_id, entry_id, account_id, line_number, description,
        currency_code, functional_debit, functional_credit
      ) values
        (p_organization_id, entry_row.id, payable_account_id, 1, 'Disminución de remuneraciones por pagar', provision_row.currency_code, abs(revision_delta), 0),
        (p_organization_id, entry_row.id, expense_account_id, 2, 'Reverso de gasto provisionado', provision_row.currency_code, 0, abs(revision_delta));
    end if;

    update public.accounting_entries
    set status = 'posted', posted_at = now(), posted_by = auth.uid()
    where id = entry_row.id and organization_id = p_organization_id;
  end if;

  update public.payroll_provision_revisions
  set status = 'posted',
      total_amount = revision_total,
      accounting_delta = revision_delta,
      accounting_entry_id = entry_row.id,
      posted_at = now(),
      posted_by = auth.uid()
  where id = revision_row.id and organization_id = p_organization_id
  returning * into revision_row;

  update public.payroll_provisions
  set posted_amount = revision_total
  where id = provision_row.id and organization_id = p_organization_id;

  return revision_row;
end;
$$;

-- Cierra la estimación contra la nómina oficial cuando ésta exista. El ajuste
-- final también se contabiliza sólo por diferencia.
create or replace function public.reconcile_payroll_provision_to_actual(
  p_organization_id uuid,
  p_provision_id uuid
)
returns public.payroll_provisions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  provision_row public.payroll_provisions;
  period_row public.financial_periods;
  expense_account_id uuid;
  payable_account_id uuid;
  entry_row public.accounting_entries;
  official_total numeric(18, 2);
  adjustment_delta numeric(18, 2);
  entry_date date;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then
    raise exception 'Finance access required';
  end if;

  select * into provision_row
  from public.payroll_provisions
  where id = p_provision_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Payroll provision not found'; end if;
  if provision_row.status <> 'open' then raise exception 'Payroll provision is already reconciled'; end if;
  if provision_row.posted_amount <= 0 then raise exception 'Post at least one weekly revision before reconciliation'; end if;
  if exists (
    select 1 from public.payroll_provision_revisions
    where provision_id = provision_row.id and status = 'draft'
  ) then
    raise exception 'Post the current weekly draft before reconciliation';
  end if;

  select round(sum(amount), 2) into official_total
  from public.payroll_cost_lines
  where organization_id = p_organization_id
    and period_month = provision_row.period_month
    and data_basis = 'official_payroll';
  if official_total is null then raise exception 'Official payroll is not available for this period'; end if;

  adjustment_delta := round(official_total - provision_row.posted_amount, 2);
  entry_date := (provision_row.period_month + interval '1 month - 1 day')::date;

  select * into period_row
  from public.financial_periods
  where organization_id = p_organization_id
    and period_start = provision_row.period_month
  for update;
  if not found or period_row.status in ('closed', 'locked') then
    raise exception 'Actual payroll adjustment requires an open financial period';
  end if;

  if adjustment_delta <> 0 then
    insert into public.chart_of_accounts (
      organization_id, account_code, account_name, nature, normal_balance,
      statement_area, presentation_group, is_postable, is_active
    ) values
      (p_organization_id, '210300', 'Remuneraciones y cargas por pagar', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo corriente', true, true),
      (p_organization_id, '610200', 'Remuneraciones y cargas sociales', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true)
    on conflict (organization_id, account_code) do nothing;

    select id into payable_account_id from public.chart_of_accounts
    where organization_id = p_organization_id and account_code = '210300';
    select id into expense_account_id from public.chart_of_accounts
    where organization_id = p_organization_id and account_code = '610200';

    insert into public.accounting_entries (
      organization_id, financial_period_id, entry_date, status,
      description, external_reference, source_event_key
    ) values (
      p_organization_id,
      period_row.id,
      entry_date,
      'draft',
      'Ajuste provisión de remuneraciones contra nómina real ' || to_char(provision_row.period_month, 'YYYY-MM'),
      'AJ-PROV-REM-' || to_char(provision_row.period_month, 'YYYYMM'),
      'payroll-provision-actual:' || provision_row.id::text
    )
    returning * into entry_row;

    if adjustment_delta > 0 then
      insert into public.accounting_entry_lines (
        organization_id, entry_id, account_id, line_number, description,
        currency_code, functional_debit, functional_credit
      ) values
        (p_organization_id, entry_row.id, expense_account_id, 1, 'Gasto real sobre provisión', provision_row.currency_code, adjustment_delta, 0),
        (p_organization_id, entry_row.id, payable_account_id, 2, 'Ajuste de remuneraciones por pagar', provision_row.currency_code, 0, adjustment_delta);
    else
      insert into public.accounting_entry_lines (
        organization_id, entry_id, account_id, line_number, description,
        currency_code, functional_debit, functional_credit
      ) values
        (p_organization_id, entry_row.id, payable_account_id, 1, 'Menor obligación real', provision_row.currency_code, abs(adjustment_delta), 0),
        (p_organization_id, entry_row.id, expense_account_id, 2, 'Reverso por menor gasto real', provision_row.currency_code, 0, abs(adjustment_delta));
    end if;

    update public.accounting_entries
    set status = 'posted', posted_at = now(), posted_by = auth.uid()
    where id = entry_row.id and organization_id = p_organization_id;
  end if;

  update public.payroll_provisions
  set status = 'reconciled',
      posted_amount = official_total,
      actual_amount = official_total,
      actual_refreshed_at = now(),
      reconciliation_entry_id = entry_row.id,
      reconciled_at = now(),
      reconciled_by = auth.uid()
  where id = provision_row.id and organization_id = p_organization_id
  returning * into provision_row;

  return provision_row;
end;
$$;

revoke all on function public.refresh_payroll_provision_revision(uuid, date, date) from public, anon;
revoke all on function public.post_payroll_provision_revision(uuid, uuid) from public, anon;
revoke all on function public.reconcile_payroll_provision_to_actual(uuid, uuid) from public, anon;
grant execute on function public.refresh_payroll_provision_revision(uuid, date, date) to authenticated;
grant execute on function public.post_payroll_provision_revision(uuid, uuid) to authenticated;
grant execute on function public.reconcile_payroll_provision_to_actual(uuid, uuid) to authenticated;

-- La obligación de remuneraciones es corriente; no usa la provisión genérica
-- clasificada como pasivo no corriente.
insert into public.chart_of_accounts (
  organization_id, account_code, account_name, nature, normal_balance,
  statement_area, presentation_group, is_postable, is_active
)
select
  organization.id,
  '210300',
  'Remuneraciones y cargas por pagar',
  'liability',
  'credit',
  'statement_of_financial_position',
  'Pasivo corriente',
  true,
  true
from public.organizations organization
on conflict (organization_id, account_code) do nothing;
