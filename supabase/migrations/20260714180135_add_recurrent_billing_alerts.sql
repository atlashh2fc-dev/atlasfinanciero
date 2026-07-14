-- Operación de facturación recurrente.
-- Una recurrencia explícitamente aprobada abre un ciclo mensual y debe quedar
-- lista a más tardar el día 2. No se infieren recurrencias desde facturas históricas.

create extension if not exists pg_cron;

create type public.billing_recurrence_status as enum ('active', 'paused', 'archived');
create type public.billing_cycle_status as enum ('pending', 'ready', 'issued', 'skipped');
create type public.billing_alert_type as enum ('preparation_required', 'deadline_breached');
create type public.billing_alert_status as enum ('open', 'resolved');

alter table public.counterparties
  add constraint counterparties_id_organization_key unique (id, organization_id);
alter table public.issued_documents
  add constraint issued_documents_id_organization_key unique (id, organization_id);

create table public.billing_recurrence_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid not null,
  name text not null,
  expected_net_amount numeric(18, 2),
  currency_code char(3) not null default 'CLP',
  deadline_day smallint not null default 2,
  reminder_days_before smallint not null default 3,
  status public.billing_recurrence_status not null default 'active',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (counterparty_id, organization_id) references public.counterparties (id, organization_id) on delete restrict,
  unique (id, organization_id),
  check (length(trim(name)) > 0),
  check (expected_net_amount is null or expected_net_amount >= 0),
  check (currency_code ~ '^[A-Z]{3}$'),
  check (deadline_day between 1 and 2),
  check (reminder_days_before between 1 and 15)
);

create table public.billing_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  recurrence_rule_id uuid not null,
  period_month date not null,
  due_date date not null,
  expected_net_amount numeric(18, 2),
  currency_code char(3) not null,
  status public.billing_cycle_status not null default 'pending',
  issued_document_id uuid,
  ready_at timestamptz,
  issued_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (recurrence_rule_id, organization_id) references public.billing_recurrence_rules (id, organization_id) on delete cascade,
  foreign key (issued_document_id, organization_id) references public.issued_documents (id, organization_id) on delete restrict,
  unique (recurrence_rule_id, period_month),
  unique (id, organization_id),
  check (period_month = date_trunc('month', period_month)::date),
  check (due_date >= period_month and due_date < (period_month + interval '1 month')::date),
  check (expected_net_amount is null or expected_net_amount >= 0),
  check (currency_code ~ '^[A-Z]{3}$'),
  check ((status <> 'issued') or issued_document_id is not null),
  check ((status <> 'issued') or issued_at is not null)
);

create table public.billing_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  billing_cycle_id uuid not null,
  alert_type public.billing_alert_type not null,
  status public.billing_alert_status not null default 'open',
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (billing_cycle_id, organization_id) references public.billing_cycles (id, organization_id) on delete cascade,
  unique (billing_cycle_id, alert_type),
  check ((status = 'resolved') = (resolved_at is not null))
);

create index billing_recurrence_rules_organization_status_idx on public.billing_recurrence_rules (organization_id, status);
create index billing_recurrence_rules_created_by_idx on public.billing_recurrence_rules (created_by) where created_by is not null;
create index billing_cycles_organization_period_status_idx on public.billing_cycles (organization_id, period_month desc, status);
create index billing_cycles_rule_organization_idx on public.billing_cycles (recurrence_rule_id, organization_id);
create index billing_cycles_issued_document_organization_idx on public.billing_cycles (issued_document_id, organization_id) where issued_document_id is not null;
create index billing_cycles_completed_by_idx on public.billing_cycles (completed_by) where completed_by is not null;
create index billing_alerts_organization_status_detected_idx on public.billing_alerts (organization_id, status, last_detected_at desc);
create index billing_alerts_cycle_organization_idx on public.billing_alerts (billing_cycle_id, organization_id);

create trigger billing_recurrence_rules_set_updated_at before update on public.billing_recurrence_rules
for each row execute function public.set_updated_at();
create trigger billing_cycles_set_updated_at before update on public.billing_cycles
for each row execute function public.set_updated_at();

create or replace function public.resolve_billing_cycle_alerts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'pending' then
    update public.billing_alerts
      set status = 'resolved', resolved_at = now()
    where billing_cycle_id = new.id and status = 'open';
  end if;
  return new;
end;
$$;

create trigger billing_cycles_resolve_alerts
after update of status on public.billing_cycles
for each row execute function public.resolve_billing_cycle_alerts();

create or replace function public.refresh_recurrent_billing_alerts_internal(
  p_organization_id uuid,
  p_as_of date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open_alerts integer;
begin
  insert into public.billing_cycles (
    organization_id,
    recurrence_rule_id,
    period_month,
    due_date,
    expected_net_amount,
    currency_code
  )
  select
    rule.organization_id,
    rule.id,
    period.period_month,
    make_date(
      extract(year from period.period_month)::integer,
      extract(month from period.period_month)::integer,
      rule.deadline_day
    ),
    rule.expected_net_amount,
    rule.currency_code
  from public.billing_recurrence_rules rule
  cross join (
    values
      (date_trunc('month', p_as_of)::date),
      ((date_trunc('month', p_as_of) + interval '1 month')::date)
  ) as period(period_month)
  where rule.organization_id = p_organization_id
    and rule.status = 'active'
  on conflict (recurrence_rule_id, period_month) do nothing;

  update public.billing_alerts alert
    set status = 'resolved', resolved_at = now()
  from public.billing_cycles cycle
  where alert.billing_cycle_id = cycle.id
    and alert.status = 'open'
    and cycle.status <> 'pending';

  insert into public.billing_alerts (
    organization_id,
    billing_cycle_id,
    alert_type,
    status,
    first_detected_at,
    last_detected_at
  )
  select
    cycle.organization_id,
    cycle.id,
    'preparation_required'::public.billing_alert_type,
    'open'::public.billing_alert_status,
    now(),
    now()
  from public.billing_cycles cycle
  join public.billing_recurrence_rules rule on rule.id = cycle.recurrence_rule_id
  where cycle.organization_id = p_organization_id
    and cycle.status = 'pending'
    and p_as_of between (cycle.due_date - rule.reminder_days_before) and cycle.due_date
  on conflict (billing_cycle_id, alert_type) do update
    set status = 'open', resolved_at = null, last_detected_at = now();

  insert into public.billing_alerts (
    organization_id,
    billing_cycle_id,
    alert_type,
    status,
    first_detected_at,
    last_detected_at
  )
  select
    cycle.organization_id,
    cycle.id,
    'deadline_breached'::public.billing_alert_type,
    'open'::public.billing_alert_status,
    now(),
    now()
  from public.billing_cycles cycle
  where cycle.organization_id = p_organization_id
    and cycle.status = 'pending'
    and p_as_of > cycle.due_date
  on conflict (billing_cycle_id, alert_type) do update
    set status = 'open', resolved_at = null, last_detected_at = now();

  select count(*)::integer into v_open_alerts
  from public.billing_alerts
  where organization_id = p_organization_id and status = 'open';

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'as_of', p_as_of,
    'open_alerts', v_open_alerts
  );
end;
$$;

create or replace function public.refresh_recurrent_billing_alerts(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  ) then
    raise exception 'Not authorized to refresh recurrent billing alerts';
  end if;

  return public.refresh_recurrent_billing_alerts_internal(p_organization_id, current_date);
end;
$$;

create or replace function public.refresh_all_recurrent_billing_alerts(p_as_of date default current_date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization record;
  v_organizations integer := 0;
begin
  for organization in select id from public.organizations loop
    perform public.refresh_recurrent_billing_alerts_internal(organization.id, p_as_of);
    v_organizations := v_organizations + 1;
  end loop;
  return v_organizations;
end;
$$;

create view public.billing_alert_inbox
with (security_invoker = true)
as
select
  alert.id,
  alert.organization_id,
  alert.alert_type,
  alert.status,
  alert.first_detected_at,
  alert.last_detected_at,
  cycle.id as billing_cycle_id,
  cycle.period_month,
  cycle.due_date,
  cycle.status as cycle_status,
  rule.name as recurrence_name,
  counterparty.legal_name as counterparty_name
from public.billing_alerts alert
join public.billing_cycles cycle on cycle.id = alert.billing_cycle_id
join public.billing_recurrence_rules rule on rule.id = cycle.recurrence_rule_id
join public.counterparties counterparty on counterparty.id = rule.counterparty_id;

alter table public.billing_recurrence_rules enable row level security;
alter table public.billing_cycles enable row level security;
alter table public.billing_alerts enable row level security;

create policy "finance manages billing recurrence rules" on public.billing_recurrence_rules
for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = billing_recurrence_rules.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = billing_recurrence_rules.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance manages billing cycles" on public.billing_cycles
for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = billing_cycles.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = billing_cycles.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance reads billing alerts" on public.billing_alerts
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = billing_alerts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

revoke all on function public.resolve_billing_cycle_alerts() from public, anon, authenticated;
revoke all on function public.refresh_recurrent_billing_alerts_internal(uuid, date) from public, anon, authenticated;
revoke all on function public.refresh_all_recurrent_billing_alerts(date) from public, anon, authenticated;
revoke all on function public.refresh_recurrent_billing_alerts(uuid) from public, anon;
grant execute on function public.refresh_recurrent_billing_alerts(uuid) to authenticated;

revoke all on public.billing_recurrence_rules, public.billing_cycles, public.billing_alerts from anon;
grant select, insert, update, delete on public.billing_recurrence_rules, public.billing_cycles to authenticated;
grant select on public.billing_alerts, public.billing_alert_inbox to authenticated;

select cron.schedule(
  'atlas-recurrent-billing-alerts',
  '10 5 * * *',
  $$select public.refresh_all_recurrent_billing_alerts(current_date);$$
);
