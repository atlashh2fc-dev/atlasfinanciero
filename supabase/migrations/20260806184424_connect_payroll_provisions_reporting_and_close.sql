-- Conecta remuneraciones, provisiones, reportes y cierre con una única regla:
-- la nómina oficial prevalece; si no existe, se usa exclusivamente la última
-- provisión contabilizada. Los borradores nunca impactan KPI ni contabilidad.

create table public.payroll_contractual_snapshots (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  current_sync_run_id uuid not null,
  activated_at timestamptz not null default now(),
  activated_by uuid references auth.users(id) on delete set null default auth.uid(),
  primary key (organization_id, fiscal_year),
  foreign key (current_sync_run_id, organization_id)
    references public.payroll_sync_runs(id, organization_id) on delete restrict
);

create index payroll_contractual_snapshots_run_idx
  on public.payroll_contractual_snapshots(current_sync_run_id, organization_id);

alter table public.payroll_contractual_snapshots enable row level security;
create policy "finance and auditors read active contractual snapshots"
on public.payroll_contractual_snapshots for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_contractual_snapshots.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);
create policy "administrators manage active contractual snapshots"
on public.payroll_contractual_snapshots for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_contractual_snapshots.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_contractual_snapshots.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);
grant select, insert, update, delete on public.payroll_contractual_snapshots to authenticated;

alter table public.payroll_provision_revisions
  add column source_sync_run_id uuid;
alter table public.payroll_provision_revisions
  add constraint payroll_provision_revisions_source_sync_run_fkey
  foreign key (source_sync_run_id, organization_id)
  references public.payroll_sync_runs(id, organization_id) on delete restrict;
create index payroll_provision_revisions_source_sync_run_idx
  on public.payroll_provision_revisions(source_sync_run_id, organization_id)
  where source_sync_run_id is not null;

-- La base existente corresponde al último lote exitoso que conserva líneas.
with latest as (
  select distinct on (run.organization_id, extract(year from line.period_month)::integer)
    run.organization_id,
    extract(year from line.period_month)::integer as fiscal_year,
    run.id as sync_run_id
  from public.payroll_sync_runs run
  join public.payroll_cost_lines line
    on line.sync_run_id = run.id
   and line.organization_id = run.organization_id
   and line.data_basis = 'contractual_estimate'
  where run.status = 'succeeded'
  order by run.organization_id, extract(year from line.period_month)::integer, run.created_at desc, run.id desc
)
insert into public.payroll_contractual_snapshots (
  organization_id, fiscal_year, current_sync_run_id, activated_at, activated_by
)
select organization_id, fiscal_year, sync_run_id, now(), null
from latest
on conflict (organization_id, fiscal_year) do update
set current_sync_run_id = excluded.current_sync_run_id,
    activated_at = excluded.activated_at,
    activated_by = excluded.activated_by;

update public.payroll_provision_revisions revision
set source_sync_run_id = snapshot.current_sync_run_id
from public.payroll_provisions provision
join public.payroll_contractual_snapshots snapshot
  on snapshot.organization_id = provision.organization_id
 and snapshot.fiscal_year = extract(year from provision.period_month)::integer
where revision.provision_id = provision.id
  and revision.organization_id = provision.organization_id
  and revision.source_refreshed_at is not null;

create or replace function public.audit_payroll_provision_line_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (
    organization_id, actor_id, entity_type, entity_id, action, before_state, after_state
  ) values (
    coalesce(new.organization_id, old.organization_id),
    auth.uid(),
    'payroll_provision_line',
    coalesce(new.id, old.id),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger payroll_provision_lines_audit_changes
after insert or update or delete on public.payroll_provision_lines
for each row execute function public.audit_payroll_provision_line_changes();

revoke all on function public.audit_payroll_provision_line_changes() from public, anon, authenticated;

drop policy if exists "administrators read payroll integration settings" on public.payroll_integrations;
create policy "finance and auditors read payroll integration settings"
on public.payroll_integrations for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_integrations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

create policy "finance and auditors read payroll cost lines"
on public.payroll_cost_lines for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_cost_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

-- Toda versión de trabajo queda ligada al snapshot contractual activo del año.
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
  active_sync_run_id uuid;
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
  if actor_role not in ('administrator', 'finance') then raise exception 'Finance access required'; end if;

  select current_sync_run_id into active_sync_run_id
  from public.payroll_contractual_snapshots
  where organization_id = p_organization_id
    and fiscal_year = extract(year from p_period_month)::integer;
  if active_sync_run_id is null then
    raise exception 'Synchronize PeopleWork before refreshing the payroll provision';
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
    if revision_row.status <> 'draft' then raise exception 'A posted weekly revision cannot be refreshed'; end if;
  else
    if exists (select 1 from public.payroll_provision_revisions where provision_id = provision_row.id and status = 'draft') then
      raise exception 'Post or keep working on the current draft before opening another week';
    end if;
    if exists (select 1 from public.payroll_provision_revisions where provision_id = provision_row.id and as_of_date > p_as_of_date) then
      raise exception 'Weekly revisions must be created in chronological order';
    end if;

    select id into previous_revision_id
    from public.payroll_provision_revisions
    where provision_id = provision_row.id and as_of_date < p_as_of_date
    order by as_of_date desc
    limit 1;

    insert into public.payroll_provision_revisions (
      organization_id, provision_id, as_of_date, source_refreshed_at, source_sync_run_id
    ) values (
      p_organization_id, provision_row.id, p_as_of_date, now(), active_sync_run_id
    ) returning * into revision_row;

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
   and upper(btrim(center.code)) = upper(btrim(line.cost_center_code))
  where line.organization_id = p_organization_id
    and line.sync_run_id = active_sync_run_id
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
  set source_refreshed_at = now(),
      source_sync_run_id = active_sync_run_id
  where id = revision_row.id and organization_id = p_organization_id
  returning * into revision_row;

  return revision_row;
end;
$$;

create or replace function public.enforce_payroll_provision_snapshot_freshness()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  active_sync_run_id uuid;
  provision_month date;
begin
  if new.status = 'posted' and old.status = 'draft' then
    select provision.period_month into provision_month
    from public.payroll_provisions provision
    where provision.id = new.provision_id and provision.organization_id = new.organization_id;
    select snapshot.current_sync_run_id into active_sync_run_id
    from public.payroll_contractual_snapshots snapshot
    where snapshot.organization_id = new.organization_id
      and snapshot.fiscal_year = extract(year from provision_month)::integer;
    if new.source_sync_run_id is null or new.source_sync_run_id is distinct from active_sync_run_id then
      raise exception 'Refresh the weekly provision from the latest PeopleWork snapshot before posting';
    end if;
  end if;
  return new;
end;
$$;

create trigger payroll_provision_revision_require_fresh_snapshot
before update of status on public.payroll_provision_revisions
for each row execute function public.enforce_payroll_provision_snapshot_freshness();

revoke all on function public.enforce_payroll_provision_snapshot_freshness() from public, anon, authenticated;

-- Activa el snapshot anual bajo bloqueo. Una sincronización antigua que termina
-- después no puede reemplazar a una más nueva ni borrar su información.
create or replace function public.activate_peoplework_contractual_snapshot(
  p_organization_id uuid,
  p_sync_run_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  candidate public.payroll_sync_runs;
  current_run public.payroll_sync_runs;
  snapshot_row public.payroll_contractual_snapshots;
  refreshed_drafts integer := 0;
  draft_row record;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id and membership.user_id = auth.uid();
  if actor_role <> 'administrator' then raise exception 'Administrator access required'; end if;

  select * into candidate
  from public.payroll_sync_runs
  where id = p_sync_run_id and organization_id = p_organization_id
  for update;
  if not found or candidate.status <> 'succeeded' then raise exception 'A succeeded PeopleWork run is required'; end if;
  if not exists (
    select 1 from public.payroll_cost_lines line
    where line.organization_id = p_organization_id
      and line.sync_run_id = candidate.id
      and line.data_basis = 'contractual_estimate'
      and extract(year from line.period_month)::integer = extract(year from candidate.period_month)::integer
  ) then raise exception 'The PeopleWork run has no contractual payroll snapshot'; end if;

  insert into public.payroll_contractual_snapshots (
    organization_id, fiscal_year, current_sync_run_id, activated_at, activated_by
  ) values (
    p_organization_id, extract(year from candidate.period_month)::integer,
    candidate.id, now(), auth.uid()
  ) on conflict (organization_id, fiscal_year) do nothing;

  select * into snapshot_row
  from public.payroll_contractual_snapshots
  where organization_id = p_organization_id
    and fiscal_year = extract(year from candidate.period_month)::integer
  for update;

  select * into current_run
  from public.payroll_sync_runs
  where id = snapshot_row.current_sync_run_id and organization_id = p_organization_id;

  if current_run.id <> candidate.id
    and (current_run.created_at, current_run.id) >= (candidate.created_at, candidate.id) then
    delete from public.payroll_cost_lines
    where organization_id = p_organization_id
      and sync_run_id = candidate.id
      and data_basis = 'contractual_estimate';
    return jsonb_build_object('activated', false, 'refreshedDrafts', 0, 'activeSyncRunId', current_run.id);
  end if;

  update public.payroll_contractual_snapshots
  set current_sync_run_id = candidate.id,
      activated_at = now(),
      activated_by = auth.uid()
  where organization_id = p_organization_id
    and fiscal_year = extract(year from candidate.period_month)::integer;

  for draft_row in
    select revision.as_of_date, provision.period_month
    from public.payroll_provision_revisions revision
    join public.payroll_provisions provision
      on provision.id = revision.provision_id
     and provision.organization_id = revision.organization_id
    where revision.organization_id = p_organization_id
      and revision.status = 'draft'
      and extract(year from provision.period_month)::integer = extract(year from candidate.period_month)::integer
  loop
    perform public.refresh_payroll_provision_revision(
      p_organization_id, draft_row.period_month, draft_row.as_of_date
    );
    refreshed_drafts := refreshed_drafts + 1;
  end loop;

  update public.payroll_integrations
  set is_active = true,
      last_sync_at = now(),
      last_sync_status = 'succeeded',
      last_period_month = candidate.period_month
  where organization_id = p_organization_id and provider = 'peoplework';

  if current_run.id is distinct from candidate.id then
    delete from public.payroll_cost_lines
    where organization_id = p_organization_id
      and sync_run_id = current_run.id
      and data_basis = 'contractual_estimate';
  end if;

  return jsonb_build_object(
    'activated', true,
    'refreshedDrafts', refreshed_drafts,
    'activeSyncRunId', candidate.id
  );
end;
$$;

revoke all on function public.activate_peoplework_contractual_snapshot(uuid, uuid) from public, anon;
grant execute on function public.activate_peoplework_contractual_snapshot(uuid, uuid) to authenticated;

-- Permite ingresar la nómina liquidada real por centro de costo cuando el
-- proveedor no la expone. La sustitución completa ocurre en una transacción.
create or replace function public.replace_manual_official_payroll(
  p_organization_id uuid,
  p_period_month date,
  p_lines jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  integration_row public.payroll_integrations;
  run_row public.payroll_sync_runs;
  provision_row public.payroll_provisions;
  period_status public.financial_period_status;
  invalid_centers integer;
  result_total numeric(18, 2);
  result_lines integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_period_month is null or p_period_month <> date_trunc('month', p_period_month)::date then
    raise exception 'Official payroll period must be the first day of a month';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
    or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 200 then
    raise exception 'Official payroll requires between 1 and 200 cost center lines';
  end if;

  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then
    raise exception 'Finance access required';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_lines) as item("costCenterId" text, amount numeric)
    where item.amount is null or item.amount <= 0
      or (nullif(item."costCenterId", '') is not null
        and item."costCenterId" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  ) then raise exception 'Official payroll contains an invalid amount or cost center'; end if;

  select count(*) into invalid_centers
  from (
    select distinct nullif(item."costCenterId", '')::uuid as cost_center_id
    from jsonb_to_recordset(p_lines) as item("costCenterId" text, amount numeric)
    where nullif(item."costCenterId", '') is not null
  ) requested
  left join public.cost_centers center
    on center.id = requested.cost_center_id
   and center.organization_id = p_organization_id
  where center.id is null;
  if invalid_centers > 0 then raise exception 'Official payroll contains a cost center outside the organization'; end if;

  select * into integration_row
  from public.payroll_integrations
  where organization_id = p_organization_id and provider = 'peoplework';
  if not found then raise exception 'Configure PeopleWork before loading official payroll'; end if;

  select status into period_status
  from public.financial_periods
  where organization_id = p_organization_id and period_start = p_period_month;
  if period_status in ('closed', 'locked') then
    raise exception 'Official payroll cannot be changed in a closed period';
  end if;

  select * into provision_row
  from public.payroll_provisions
  where organization_id = p_organization_id and period_month = p_period_month
  for update;
  if found and provision_row.status = 'reconciled' then
    raise exception 'Reopen the payroll reconciliation before replacing official payroll';
  end if;

  insert into public.payroll_sync_runs (
    organization_id, integration_id, period_month, status, started_at,
    finished_at, source_reference, records_received, records_accepted,
    initiated_by
  ) values (
    p_organization_id, integration_row.id, p_period_month, 'succeeded', now(),
    now(), 'Carga manual de nómina liquidada oficial', jsonb_array_length(p_lines),
    jsonb_array_length(p_lines), auth.uid()
  ) returning * into run_row;

  delete from public.payroll_cost_lines
  where organization_id = p_organization_id
    and period_month = p_period_month
    and data_basis = 'official_payroll';

  with parsed as (
    select
      nullif(item."costCenterId", '')::uuid as cost_center_id,
      round(sum(item.amount), 2) as amount
    from jsonb_to_recordset(p_lines) as item("costCenterId" text, amount numeric)
    group by nullif(item."costCenterId", '')::uuid
  )
  insert into public.payroll_cost_lines (
    organization_id, sync_run_id, period_month, cost_category, data_basis,
    cost_center_code, cost_center_name, amount, currency_code,
    source_record_sha256
  )
  select
    p_organization_id,
    run_row.id,
    p_period_month,
    'remuneracion_liquidada_oficial',
    'official_payroll',
    center.code,
    coalesce(center.name, 'Sin centro asignado'),
    parsed.amount,
    'CLP',
    encode(extensions.digest(convert_to(
      p_period_month::text || '|' || coalesce(parsed.cost_center_id::text, 'sin-centro') || '|' || parsed.amount::text || '|' || run_row.id::text,
      'UTF8'
    ), 'sha256'), 'hex')
  from parsed
  left join public.cost_centers center
    on center.id = parsed.cost_center_id
   and center.organization_id = p_organization_id;

  select coalesce(sum(amount), 0), count(*)
  into result_total, result_lines
  from public.payroll_cost_lines
  where organization_id = p_organization_id
    and period_month = p_period_month
    and data_basis = 'official_payroll';

  return jsonb_build_object(
    'total', result_total,
    'lines', result_lines,
    'syncRunId', run_row.id
  );
end;
$$;

revoke all on function public.replace_manual_official_payroll(uuid, date, jsonb) from public, anon;
grant execute on function public.replace_manual_official_payroll(uuid, date, jsonb) to authenticated;

-- El control de cierre exige provisión contabilizada cuando existe base laboral.
-- Si ya existe nómina oficial, exige además la conciliación contra el real.
create or replace function public.financial_close_control_snapshot(
  p_financial_period_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  period_row public.financial_periods;
  unclassified_documents integer;
  unreconciled_transactions integer;
  draft_entries integer;
  aging_without_due_date integer;
  document_count integer;
  contractual_payroll numeric(18, 2);
  official_payroll numeric(18, 2);
  payroll_provision public.payroll_provisions;
  payroll_drafts integer;
  payroll_issues integer := 0;
  payroll_summary text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select period.* into period_row
  from public.financial_periods period
  where period.id = p_financial_period_id;
  if not found then raise exception 'Financial period not found'; end if;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = period_row.organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('administrator', 'finance', 'auditor')
  ) then raise exception 'Financial close access required'; end if;

  select count(*) into document_count from (
    select document.id from public.issued_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date between period_row.period_start and period_row.period_end
    union all
    select document.id from public.received_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date between period_row.period_start and period_row.period_end
    union all
    select payable.id from public.direct_payables payable
    where payable.organization_id = period_row.organization_id
      and payable.issue_date between period_row.period_start and period_row.period_end
      and payable.status <> 'cancelled'
  ) documents;

  select count(*) into unclassified_documents from (
    select document.id from public.issued_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date between period_row.period_start and period_row.period_end
      and nullif(btrim(coalesce(document.document_type, '')), '') is null
    union all
    select document.id from public.received_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date between period_row.period_start and period_row.period_end
      and nullif(btrim(coalesce(document.document_type, '')), '') is null
    union all
    select payable.id from public.direct_payables payable
    where payable.organization_id = period_row.organization_id
      and payable.issue_date between period_row.period_start and period_row.period_end
      and payable.status <> 'cancelled'
      and payable.cost_center_id is null
  ) documents;

  select count(*) into unreconciled_transactions
  from public.bank_transactions transaction
  where transaction.organization_id = period_row.organization_id
    and transaction.booked_on between period_row.period_start and period_row.period_end
    and transaction.reconciliation_status <> 'reconciled';

  select count(*) into draft_entries
  from public.accounting_entries entry
  where entry.organization_id = period_row.organization_id
    and entry.financial_period_id = period_row.id
    and entry.status = 'draft';

  select count(*) into aging_without_due_date from (
    select document.id from public.issued_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date <= period_row.period_end
      and coalesce(nullif(btrim(coalesce(document.payment_status, '')), ''), 'Pendiente') not in ('Pagada', 'pagada', 'Paid', 'paid')
      and document.due_date is null
    union all
    select document.id from public.received_documents document
    where document.organization_id = period_row.organization_id
      and document.issue_date <= period_row.period_end
      and coalesce(nullif(btrim(coalesce(document.payment_status, '')), ''), 'Pendiente') not in ('Pagada', 'pagada', 'Paid', 'paid')
      and document.due_date is null
    union all
    select payable.id from public.direct_payables payable
    where payable.organization_id = period_row.organization_id
      and payable.issue_date <= period_row.period_end
      and payable.status not in ('paid', 'cancelled')
      and payable.due_date is null
  ) documents;

  select coalesce(sum(line.amount), 0)
  into contractual_payroll
  from public.payroll_cost_lines line
  join public.payroll_contractual_snapshots snapshot
    on snapshot.organization_id = line.organization_id
   and snapshot.fiscal_year = extract(year from line.period_month)::integer
   and snapshot.current_sync_run_id = line.sync_run_id
  where line.organization_id = period_row.organization_id
    and line.period_month = period_row.period_start
    and line.data_basis = 'contractual_estimate';

  select coalesce(sum(amount), 0)
  into official_payroll
  from public.payroll_cost_lines
  where organization_id = period_row.organization_id
    and period_month = period_row.period_start
    and data_basis = 'official_payroll';

  select * into payroll_provision
  from public.payroll_provisions
  where organization_id = period_row.organization_id
    and period_month = period_row.period_start;

  select count(*) into payroll_drafts
  from public.payroll_provision_revisions revision
  join public.payroll_provisions provision on provision.id = revision.provision_id
  where provision.organization_id = period_row.organization_id
    and provision.period_month = period_row.period_start
    and revision.status = 'draft';

  if contractual_payroll = 0 and official_payroll = 0 and payroll_provision.id is null then
    payroll_summary := 'No existe base laboral para este período; el control no aplica.';
  elsif payroll_provision.id is null or payroll_provision.posted_amount <= 0 then
    payroll_issues := payroll_issues + 1;
    payroll_summary := 'Falta contabilizar la provisión de remuneraciones del período.';
  elsif payroll_drafts > 0 then
    payroll_issues := payroll_issues + payroll_drafts;
    payroll_summary := payroll_drafts || ' versión(es) semanal(es) continúan en borrador.';
  elsif official_payroll > 0 and payroll_provision.status <> 'reconciled' then
    payroll_issues := payroll_issues + 1;
    payroll_summary := 'La nómina real está disponible y debe conciliarse contra la provisión.';
  elsif official_payroll > 0 then
    payroll_summary := 'Nómina real conciliada por ' || official_payroll || ' CLP.';
  else
    payroll_summary := 'Provisión contabilizada por ' || payroll_provision.posted_amount || ' CLP; nómina real aún no disponible.';
  end if;

  return jsonb_build_object(
    'documents_reviewed', jsonb_build_object(
      'state', case when unclassified_documents = 0 then 'passed' else 'blocked' end,
      'issues', unclassified_documents,
      'observed', document_count,
      'summary', case when unclassified_documents = 0 then document_count || ' documento(s) y cuenta(s) clasificado(s).' else unclassified_documents || ' documento(s) o cuenta(s) sin clasificación o centro de costo.' end
    ),
    'bank_reconciliation', jsonb_build_object(
      'state', case when unreconciled_transactions = 0 then 'passed' else 'blocked' end,
      'issues', unreconciled_transactions,
      'summary', case when unreconciled_transactions = 0 then 'Todos los movimientos del período están conciliados.' else unreconciled_transactions || ' movimiento(s) bancario(s) sin conciliar.' end
    ),
    'receivables_payables', jsonb_build_object(
      'state', case when aging_without_due_date = 0 then 'passed' else 'blocked' end,
      'issues', aging_without_due_date,
      'summary', case when aging_without_due_date = 0 then 'Aging generado desde documentos y cuentas por pagar con vencimiento.' else aging_without_due_date || ' saldo(s) abierto(s) sin fecha de vencimiento.' end
    ),
    'journal_entries', jsonb_build_object(
      'state', case when draft_entries = 0 then 'passed' else 'blocked' end,
      'issues', draft_entries,
      'summary', case when draft_entries = 0 then 'No existen asientos en borrador.' else draft_entries || ' asiento(s) contable(s) en borrador.' end
    ),
    'payroll_provision', jsonb_build_object(
      'state', case when payroll_issues = 0 then 'passed' else 'blocked' end,
      'issues', payroll_issues,
      'observed', coalesce(payroll_provision.posted_amount, 0),
      'summary', payroll_summary
    )
  );
end;
$$;

-- La nueva validación automática debe aparecer también en el checklist visual.
create or replace function public.seed_financial_period_close_tasks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.financial_period_close_tasks (
    organization_id, financial_period_id, task_code, title, description
  ) values
    (new.organization_id, new.id, 'documents_reviewed', 'Documentos revisados', 'Facturas de venta y compra del período revisadas y clasificadas.'),
    (new.organization_id, new.id, 'bank_reconciliation', 'Conciliación bancaria', 'Movimientos bancarios del período conciliados o documentados.'),
    (new.organization_id, new.id, 'receivables_payables', 'Saldos por cobrar y pagar', 'Aging, vencimientos y diferencias significativas revisados.'),
    (new.organization_id, new.id, 'journal_entries', 'Asientos contables', 'No existen asientos contables en borrador para el período.'),
    (new.organization_id, new.id, 'payroll_provision', 'Provisión de remuneraciones', 'Provisión semanal contabilizada y conciliada cuando existe nómina real.'),
    (new.organization_id, new.id, 'management_review', 'Revisión de gestión', 'Resultado y flujo de caja revisados por Finanzas.')
  on conflict (financial_period_id, task_code) do nothing;
  return new;
end;
$$;

insert into public.financial_period_close_tasks (
  organization_id, financial_period_id, task_code, title, description
)
select
  period.organization_id,
  period.id,
  'payroll_provision',
  'Provisión de remuneraciones',
  'Provisión semanal contabilizada y conciliada cuando existe nómina real.'
from public.financial_periods period
on conflict (financial_period_id, task_code) do nothing;

create or replace function public.transition_financial_period(
  p_financial_period_id uuid,
  p_target_status public.financial_period_status,
  p_reason text default null
)
returns public.financial_periods
language plpgsql
security definer
set search_path = ''
as $$
declare
  period_row public.financial_periods;
  previous_status public.financial_period_status;
  actor_role public.organization_role;
  management_review_pending integer;
  controls jsonb;
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select period.* into period_row from public.financial_periods period where period.id = p_financial_period_id for update;
  if not found then raise exception 'Financial period not found'; end if;
  previous_status := period_row.status;
  select membership.role into actor_role from public.organization_memberships membership
  where membership.organization_id = period_row.organization_id and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then raise exception 'Finance access required'; end if;
  if p_target_status = previous_status then return period_row; end if;
  if p_target_status = 'soft_closed' then
    if previous_status <> 'open' then raise exception 'Only open periods can be soft closed'; end if;
  elsif p_target_status in ('closed', 'locked') then
    if previous_status not in ('open', 'soft_closed')
      and not (p_target_status = 'locked' and previous_status = 'closed') then
      raise exception 'Only open or soft closed periods can be closed';
    end if;
    controls := public.financial_close_control_snapshot(period_row.id);
    if controls->'documents_reviewed'->>'state' = 'blocked' then raise exception '%', controls->'documents_reviewed'->>'summary'; end if;
    if controls->'bank_reconciliation'->>'state' = 'blocked' then raise exception '%', controls->'bank_reconciliation'->>'summary'; end if;
    if controls->'receivables_payables'->>'state' = 'blocked' then raise exception '%', controls->'receivables_payables'->>'summary'; end if;
    if controls->'journal_entries'->>'state' = 'blocked' then raise exception '%', controls->'journal_entries'->>'summary'; end if;
    if controls->'payroll_provision'->>'state' = 'blocked' then raise exception '%', controls->'payroll_provision'->>'summary'; end if;
    select count(*) into management_review_pending from public.financial_period_close_tasks task
    where task.financial_period_id = period_row.id
      and task.task_code = 'management_review'
      and task.status = 'pending';
    if management_review_pending > 0 then raise exception 'Management review must be completed or marked not applicable before closing'; end if;
  elsif p_target_status = 'open' then
    if previous_status not in ('soft_closed', 'closed', 'locked') then raise exception 'Invalid period reopening'; end if;
    if actor_role <> 'administrator' then raise exception 'Only administrators can reopen a period'; end if;
    if normalized_reason is null then raise exception 'A reason is required to reopen a financial period'; end if;
  else
    raise exception 'Unsupported financial period transition';
  end if;
  perform set_config('app.financial_period_transition', 'on', true);
  update public.financial_periods set
    status = p_target_status,
    closed_at = case when p_target_status in ('closed', 'locked') then now() else null end,
    closed_by = case when p_target_status in ('closed', 'locked') then auth.uid() else null end
  where id = period_row.id returning * into period_row;
  insert into public.financial_period_close_events (organization_id, financial_period_id, from_status, to_status, reason, actor_id)
  values (period_row.organization_id, period_row.id, previous_status, p_target_status, normalized_reason, auth.uid());
  return period_row;
end;
$$;

revoke all on function public.financial_close_control_snapshot(uuid) from public, anon;
grant execute on function public.financial_close_control_snapshot(uuid) to authenticated;
revoke all on function public.seed_financial_period_close_tasks() from public, anon, authenticated;
revoke all on function public.transition_financial_period(uuid, public.financial_period_status, text) from public, anon;
grant execute on function public.transition_financial_period(uuid, public.financial_period_status, text) to authenticated;
