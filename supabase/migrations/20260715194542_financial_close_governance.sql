-- Gobierno de cierre financiero. Complementa financial_periods sin alterar
-- documentos comerciales: el bloqueo se limita a asientos contables y a las
-- evidencias del cierre, que son los registros cuya integridad depende del período.

create type public.financial_close_task_status as enum (
  'pending',
  'completed',
  'not_applicable'
);

create table public.financial_period_close_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  financial_period_id uuid not null,
  task_code text not null,
  title text not null,
  description text,
  status public.financial_close_task_status not null default 'pending',
  evidence_note text,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (financial_period_id, organization_id)
    references public.financial_periods (id, organization_id) on delete cascade,
  unique (financial_period_id, task_code),
  check (length(trim(task_code)) > 0),
  check (length(trim(title)) > 0),
  check ((status = 'completed') = (completed_at is not null and completed_by is not null))
);

create table public.financial_period_close_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  financial_period_id uuid not null,
  from_status public.financial_period_status,
  to_status public.financial_period_status not null,
  reason text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (financial_period_id, organization_id)
    references public.financial_periods (id, organization_id) on delete cascade,
  check (reason is null or length(trim(reason)) > 0)
);

create index financial_period_close_tasks_period_status_idx
  on public.financial_period_close_tasks (financial_period_id, status);
create index financial_period_close_events_period_idx
  on public.financial_period_close_events (financial_period_id, created_at desc);

create trigger financial_period_close_tasks_set_updated_at
before update on public.financial_period_close_tasks
for each row execute function public.set_updated_at();

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
    (new.organization_id, new.id, 'management_review', 'Revisión de gestión', 'Resultado y flujo de caja revisados por Finanzas.')
  on conflict (financial_period_id, task_code) do nothing;
  return new;
end;
$$;

create trigger financial_periods_seed_close_tasks
after insert on public.financial_periods
for each row execute function public.seed_financial_period_close_tasks();

-- Crea el checklist también para períodos que existían antes de esta migración.
insert into public.financial_period_close_tasks (
  organization_id, financial_period_id, task_code, title, description
)
select period.organization_id, period.id, seed.task_code, seed.title, seed.description
from public.financial_periods period
cross join (
  values
    ('documents_reviewed', 'Documentos revisados', 'Facturas de venta y compra del período revisadas y clasificadas.'),
    ('bank_reconciliation', 'Conciliación bancaria', 'Movimientos bancarios del período conciliados o documentados.'),
    ('receivables_payables', 'Saldos por cobrar y pagar', 'Aging, vencimientos y diferencias significativas revisados.'),
    ('journal_entries', 'Asientos contables', 'No existen asientos contables en borrador para el período.'),
    ('management_review', 'Revisión de gestión', 'Resultado y flujo de caja revisados por Finanzas.')
) as seed(task_code, title, description)
on conflict (financial_period_id, task_code) do nothing;

create or replace function public.enforce_financial_close_task_editability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  period_status public.financial_period_status;
begin
  select status into period_status
  from public.financial_periods
  where id = case when tg_op = 'DELETE' then old.financial_period_id else new.financial_period_id end
    and organization_id = case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;

  if period_status in ('closed', 'locked') then
    raise exception 'Close checklist cannot be changed after the financial period is closed';
  end if;

  if tg_op = 'UPDATE' then
    if new.organization_id <> old.organization_id
      or new.financial_period_id <> old.financial_period_id
      or new.task_code <> old.task_code
      or new.title <> old.title
      or new.description is distinct from old.description then
      raise exception 'Close checklist definition is immutable';
    end if;
    if new.status = 'completed' then
      if old.status = 'completed' then
        new.completed_at := old.completed_at;
        new.completed_by := old.completed_by;
      else
        new.completed_at := now();
        new.completed_by := auth.uid();
      end if;
    else
      new.completed_at := null;
      new.completed_by := null;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger financial_period_close_tasks_guard
before update or delete on public.financial_period_close_tasks
for each row execute function public.enforce_financial_close_task_editability();

-- Sólo la función de transición puede cerrar/reabrir un período. Evita que
-- una actualización directa de Data API omita el checklist o la auditoría.
create or replace function public.enforce_financial_period_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
    and current_setting('app.financial_period_transition', true) is distinct from 'on' then
    raise exception 'Financial period status changes must use transition_financial_period';
  end if;
  return new;
end;
$$;

create trigger financial_periods_guard_transition
before update of status on public.financial_periods
for each row execute function public.enforce_financial_period_transition();

create or replace function public.prevent_closed_financial_period_changes()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and old.status <> 'open' then
    raise exception 'Only open financial periods can be deleted';
  end if;
  if tg_op = 'UPDATE'
    and old.status in ('closed', 'locked')
    and current_setting('app.financial_period_transition', true) is distinct from 'on' then
    raise exception 'A closed financial period can only be reopened through transition_financial_period';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger financial_periods_prevent_closed_changes
before update or delete on public.financial_periods
for each row execute function public.prevent_closed_financial_period_changes();

create or replace function public.prevent_closed_period_accounting_changes()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  period_status public.financial_period_status;
  entry_period_id uuid;
begin
  if tg_table_name = 'accounting_entries' then
    entry_period_id := case when tg_op = 'DELETE' then old.financial_period_id else new.financial_period_id end;
  else
    select entry.financial_period_id into entry_period_id
    from public.accounting_entries entry
    where entry.id = case when tg_op = 'DELETE' then old.entry_id else new.entry_id end
      and entry.organization_id = case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
  end if;

  select status into period_status from public.financial_periods where id = entry_period_id;
  if period_status in ('closed', 'locked') then
    raise exception 'Accounting records cannot be changed in a closed financial period';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger accounting_entries_prevent_closed_period_changes
before insert or update or delete on public.accounting_entries
for each row execute function public.prevent_closed_period_accounting_changes();
create trigger accounting_entry_lines_prevent_closed_period_changes
before insert or update or delete on public.accounting_entry_lines
for each row execute function public.prevent_closed_period_accounting_changes();

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
  incomplete_tasks integer;
  draft_entries integer;
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
    select count(*) into incomplete_tasks from public.financial_period_close_tasks task where task.financial_period_id = period_row.id and task.status = 'pending';
    if incomplete_tasks > 0 then raise exception 'Complete or mark not applicable all close checklist tasks before closing'; end if;
    select count(*) into draft_entries from public.accounting_entries entry where entry.financial_period_id = period_row.id and entry.status = 'draft';
    if draft_entries > 0 then raise exception 'Post or reverse all accounting entries before closing'; end if;
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

revoke all on function public.seed_financial_period_close_tasks() from public, anon, authenticated;
revoke all on function public.enforce_financial_close_task_editability() from public, anon, authenticated;
revoke all on function public.enforce_financial_period_transition() from public, anon, authenticated;
revoke all on function public.prevent_closed_financial_period_changes() from public, anon, authenticated;
revoke all on function public.prevent_closed_period_accounting_changes() from public, anon, authenticated;
revoke all on function public.transition_financial_period(uuid, public.financial_period_status, text) from public, anon;
grant execute on function public.transition_financial_period(uuid, public.financial_period_status, text) to authenticated;

alter table public.financial_period_close_tasks enable row level security;
alter table public.financial_period_close_events enable row level security;

create policy "finance and auditors read financial close tasks"
on public.financial_period_close_tasks for select to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_period_close_tasks.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance updates financial close tasks"
on public.financial_period_close_tasks for update to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_period_close_tasks.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_period_close_tasks.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
);
create policy "finance and auditors read financial close events"
on public.financial_period_close_events for select to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_period_close_events.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor'))
);

grant select, update on public.financial_period_close_tasks to authenticated;
grant select on public.financial_period_close_events to authenticated;
