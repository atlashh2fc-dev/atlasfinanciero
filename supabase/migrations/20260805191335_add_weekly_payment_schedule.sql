-- Agenda semanal de tesorería. Las propuestas futuras se conservan como
-- borradores editables hasta que Finanzas cierre la semana y las envíe a
-- aprobación. La fecha programada debe ser viernes; las propuestas históricas
-- ya creadas en otros días no se modifican durante esta migración.

create or replace function public.enforce_payment_batch_friday()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if extract(isodow from new.scheduled_for) <> 5 then
    raise exception 'Payment batches must be scheduled for Friday';
  end if;
  if tg_op = 'INSERT' and new.scheduled_for < current_date then
    raise exception 'Payment batches cannot be scheduled in the past';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_batches_enforce_friday on public.payment_batches;
create trigger payment_batches_enforce_friday
before insert or update of scheduled_for on public.payment_batches
for each row execute function public.enforce_payment_batch_friday();

create table public.payment_reschedule_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payment_batch_item_id uuid,
  received_document_id uuid,
  direct_payable_id uuid,
  from_payment_batch_id uuid references public.payment_batches(id) on delete set null,
  to_payment_batch_id uuid references public.payment_batches(id) on delete set null,
  from_scheduled_for date not null,
  to_scheduled_for date not null,
  amount numeric(18, 2) not null check (amount > 0),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  moved_by uuid references auth.users(id) on delete set null default auth.uid(),
  moved_at timestamptz not null default now(),
  check (num_nonnulls(received_document_id, direct_payable_id) = 1),
  check (from_scheduled_for <> to_scheduled_for)
);

create index payment_reschedule_events_organization_moved_idx
  on public.payment_reschedule_events (organization_id, moved_at desc);
create index payment_reschedule_events_item_idx
  on public.payment_reschedule_events (payment_batch_item_id)
  where payment_batch_item_id is not null;
create index payment_reschedule_events_received_document_idx
  on public.payment_reschedule_events (received_document_id)
  where received_document_id is not null;
create index payment_reschedule_events_direct_payable_idx
  on public.payment_reschedule_events (direct_payable_id)
  where direct_payable_id is not null;
create index payment_reschedule_events_from_batch_idx
  on public.payment_reschedule_events (from_payment_batch_id)
  where from_payment_batch_id is not null;
create index payment_reschedule_events_to_batch_idx
  on public.payment_reschedule_events (to_payment_batch_id)
  where to_payment_batch_id is not null;
create index payment_reschedule_events_moved_by_idx
  on public.payment_reschedule_events (moved_by)
  where moved_by is not null;

alter table public.payment_reschedule_events enable row level security;

create policy "finance and audit read payment reschedules"
on public.payment_reschedule_events
for select to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = payment_reschedule_events.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

grant select on public.payment_reschedule_events to authenticated;
revoke all on public.payment_reschedule_events from anon;

-- Una sola operación mueve los ítems elegidos y registra su historia. El lock
-- organizacional evita carreras entre dos personas reprogramando a la vez.
create or replace function private.move_payment_batch_items_internal(
  p_organization_id uuid,
  p_item_ids uuid[],
  p_scheduled_for date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_batch record;
  target_batch_id uuid;
  moved_count integer := 0;
  selected_count integer;
  source_batch_ids uuid[];
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  ) then
    raise exception 'Finance access required';
  end if;
  if p_item_ids is null or cardinality(p_item_ids) < 1 or cardinality(p_item_ids) > 250 then
    raise exception 'Select between 1 and 250 payment items';
  end if;
  if cardinality(p_item_ids) <> (
    select count(distinct selected.item_id)
    from unnest(p_item_ids) as selected(item_id)
  ) then
    raise exception 'Payment item selection contains duplicates';
  end if;
  if p_scheduled_for is null or extract(isodow from p_scheduled_for) <> 5 then
    raise exception 'Target payment date must be Friday';
  end if;
  if p_scheduled_for < current_date then
    raise exception 'Target payment date cannot be in the past';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'A reschedule reason is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 711905));

  select count(*), array_agg(distinct item.payment_batch_id)
    into selected_count, source_batch_ids
  from public.payment_batch_items item
  join public.payment_batches batch
    on batch.id = item.payment_batch_id
   and batch.organization_id = item.organization_id
  where item.organization_id = p_organization_id
    and item.id = any(p_item_ids)
    and batch.status = 'draft';

  if selected_count <> cardinality(p_item_ids) then
    raise exception 'Only items from draft payment weeks can be rescheduled';
  end if;

  for source_batch in
    select distinct
      batch.id,
      batch.bank_account_id,
      batch.currency_code,
      batch.scheduled_for,
      batch.notes
    from public.payment_batches batch
    join public.payment_batch_items item
      on item.payment_batch_id = batch.id
     and item.organization_id = batch.organization_id
    where batch.organization_id = p_organization_id
      and batch.status = 'draft'
      and item.id = any(p_item_ids)
  loop
    if source_batch.scheduled_for = p_scheduled_for then
      continue;
    end if;

    select batch.id into target_batch_id
    from public.payment_batches batch
    where batch.organization_id = p_organization_id
      and batch.status = 'draft'
      and batch.scheduled_for = p_scheduled_for
      and batch.currency_code = source_batch.currency_code
      and batch.bank_account_id is not distinct from source_batch.bank_account_id
    order by batch.created_at
    limit 1
    for update;

    if target_batch_id is null then
      insert into public.payment_batches (
        organization_id,
        bank_account_id,
        scheduled_for,
        currency_code,
        notes,
        created_by
      ) values (
        p_organization_id,
        source_batch.bank_account_id,
        p_scheduled_for,
        source_batch.currency_code,
        coalesce(source_batch.notes, 'Planificación semanal de pagos'),
        (select auth.uid())
      )
      returning id into target_batch_id;
    end if;

    insert into public.payment_reschedule_events (
      organization_id,
      payment_batch_item_id,
      received_document_id,
      direct_payable_id,
      from_payment_batch_id,
      to_payment_batch_id,
      from_scheduled_for,
      to_scheduled_for,
      amount,
      reason,
      moved_by
    )
    select
      item.organization_id,
      item.id,
      item.received_document_id,
      item.direct_payable_id,
      source_batch.id,
      target_batch_id,
      source_batch.scheduled_for,
      p_scheduled_for,
      item.amount,
      btrim(p_reason),
      (select auth.uid())
    from public.payment_batch_items item
    where item.organization_id = p_organization_id
      and item.payment_batch_id = source_batch.id
      and item.id = any(p_item_ids);

    update public.payment_batch_items item
    set payment_batch_id = target_batch_id
    where item.organization_id = p_organization_id
      and item.payment_batch_id = source_batch.id
      and item.id = any(p_item_ids);

    get diagnostics selected_count = row_count;
    moved_count := moved_count + selected_count;
  end loop;

  delete from public.payment_batches batch
  where batch.organization_id = p_organization_id
    and batch.status = 'draft'
    and batch.id = any(source_batch_ids)
    and not exists (
      select 1 from public.payment_batch_items item
      where item.payment_batch_id = batch.id
    );

  return jsonb_build_object(
    'moved_items', moved_count,
    'scheduled_for', p_scheduled_for
  );
end;
$$;

create or replace function public.move_payment_batch_items(
  p_organization_id uuid,
  p_item_ids uuid[],
  p_scheduled_for date,
  p_reason text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.move_payment_batch_items_internal(
    p_organization_id,
    p_item_ids,
    p_scheduled_for,
    p_reason
  );
$$;

revoke all on function private.move_payment_batch_items_internal(uuid, uuid[], date, text) from public, anon;
grant execute on function private.move_payment_batch_items_internal(uuid, uuid[], date, text) to authenticated;
revoke all on function public.move_payment_batch_items(uuid, uuid[], date, text) from public, anon;
grant execute on function public.move_payment_batch_items(uuid, uuid[], date, text) to authenticated;

-- Alertas consolidadas por viernes. No se genera una notificación por deuda:
-- cada alerta mantiene el total y la cantidad vigente de la semana.
create table public.payment_schedule_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scheduled_for date not null,
  alert_type text not null check (alert_type in ('upcoming_week', 'approval_required', 'execution_required')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  item_count integer not null default 0 check (item_count >= 0),
  total_amount numeric(18, 2) not null default 0 check (total_amount >= 0),
  status_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(status_counts) = 'object'),
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (organization_id, scheduled_for, alert_type),
  check ((status = 'resolved') = (resolved_at is not null))
);

create index payment_schedule_alerts_open_organization_date_idx
  on public.payment_schedule_alerts (organization_id, scheduled_for, alert_type)
  where status = 'open';

alter table public.payment_schedule_alerts enable row level security;

create policy "finance and audit read payment schedule alerts"
on public.payment_schedule_alerts
for select to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = payment_schedule_alerts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

grant select on public.payment_schedule_alerts to authenticated;
revoke all on public.payment_schedule_alerts from anon;

create or replace function private.refresh_payment_schedule_alerts_internal(
  p_organization_id uuid,
  p_as_of date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  open_alerts integer;
begin
  update public.payment_schedule_alerts alert
  set status = 'resolved', resolved_at = now(), last_detected_at = now()
  where alert.organization_id = p_organization_id
    and alert.status = 'open';

  insert into public.payment_schedule_alerts (
    organization_id, scheduled_for, alert_type, status, item_count,
    total_amount, status_counts, first_detected_at, last_detected_at, resolved_at
  )
  select
    batch.organization_id,
    batch.scheduled_for,
    'upcoming_week',
    'open',
    count(item.id)::integer,
    coalesce(sum(item.amount), 0),
    jsonb_build_object(
      'draft', count(distinct batch.id) filter (where batch.status = 'draft'),
      'review', count(distinct batch.id) filter (where batch.status = 'review'),
      'approved', count(distinct batch.id) filter (where batch.status = 'approved'),
      'processing', count(distinct batch.id) filter (where batch.status = 'processing')
    ),
    now(), now(), null
  from public.payment_batches batch
  join public.payment_batch_items item
    on item.payment_batch_id = batch.id
   and item.organization_id = batch.organization_id
  where batch.organization_id = p_organization_id
    and batch.status in ('draft', 'review', 'approved', 'processing')
    and batch.scheduled_for between p_as_of and p_as_of + 7
  group by batch.organization_id, batch.scheduled_for
  on conflict (organization_id, scheduled_for, alert_type) do update
  set status = 'open',
      item_count = excluded.item_count,
      total_amount = excluded.total_amount,
      status_counts = excluded.status_counts,
      resolved_at = null,
      last_detected_at = now();

  insert into public.payment_schedule_alerts (
    organization_id, scheduled_for, alert_type, status, item_count,
    total_amount, status_counts, first_detected_at, last_detected_at, resolved_at
  )
  select
    batch.organization_id,
    batch.scheduled_for,
    'approval_required',
    'open',
    count(item.id)::integer,
    coalesce(sum(item.amount), 0),
    jsonb_build_object(
      'draft', count(distinct batch.id) filter (where batch.status = 'draft'),
      'review', count(distinct batch.id) filter (where batch.status = 'review')
    ),
    now(), now(), null
  from public.payment_batches batch
  join public.payment_batch_items item
    on item.payment_batch_id = batch.id
   and item.organization_id = batch.organization_id
  where batch.organization_id = p_organization_id
    and batch.status in ('draft', 'review')
    and batch.scheduled_for between p_as_of and p_as_of + 2
  group by batch.organization_id, batch.scheduled_for
  on conflict (organization_id, scheduled_for, alert_type) do update
  set status = 'open',
      item_count = excluded.item_count,
      total_amount = excluded.total_amount,
      status_counts = excluded.status_counts,
      resolved_at = null,
      last_detected_at = now();

  insert into public.payment_schedule_alerts (
    organization_id, scheduled_for, alert_type, status, item_count,
    total_amount, status_counts, first_detected_at, last_detected_at, resolved_at
  )
  select
    batch.organization_id,
    batch.scheduled_for,
    'execution_required',
    'open',
    count(item.id)::integer,
    coalesce(sum(item.amount), 0),
    jsonb_build_object(
      'approved', count(distinct batch.id) filter (where batch.status = 'approved'),
      'processing', count(distinct batch.id) filter (where batch.status = 'processing')
    ),
    now(), now(), null
  from public.payment_batches batch
  join public.payment_batch_items item
    on item.payment_batch_id = batch.id
   and item.organization_id = batch.organization_id
  where batch.organization_id = p_organization_id
    and batch.status in ('approved', 'processing')
    and batch.scheduled_for <= p_as_of
  group by batch.organization_id, batch.scheduled_for
  on conflict (organization_id, scheduled_for, alert_type) do update
  set status = 'open',
      item_count = excluded.item_count,
      total_amount = excluded.total_amount,
      status_counts = excluded.status_counts,
      resolved_at = null,
      last_detected_at = now();

  select count(*)::integer into open_alerts
  from public.payment_schedule_alerts alert
  where alert.organization_id = p_organization_id
    and alert.status = 'open';

  return open_alerts;
end;
$$;

create or replace function private.refresh_all_payment_schedule_alerts(
  p_as_of date default current_date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization record;
  organization_count integer := 0;
begin
  for organization in select id from public.organizations loop
    perform private.refresh_payment_schedule_alerts_internal(organization.id, p_as_of);
    organization_count := organization_count + 1;
  end loop;
  return organization_count;
end;
$$;

create or replace function private.refresh_payment_schedule_alerts_for_user(
  p_organization_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  ) then
    raise exception 'Finance read access required';
  end if;
  return private.refresh_payment_schedule_alerts_internal(
    p_organization_id,
    current_date
  );
end;
$$;

create or replace function public.refresh_payment_schedule_alerts(
  p_organization_id uuid
)
returns integer
language sql
security invoker
set search_path = ''
as $$
  select private.refresh_payment_schedule_alerts_for_user(p_organization_id);
$$;

revoke all on function private.refresh_payment_schedule_alerts_internal(uuid, date) from public, anon, authenticated;
revoke all on function private.refresh_all_payment_schedule_alerts(date) from public, anon, authenticated;
revoke all on function private.refresh_payment_schedule_alerts_for_user(uuid) from public, anon;
grant execute on function private.refresh_payment_schedule_alerts_for_user(uuid) to authenticated;
revoke all on function public.refresh_payment_schedule_alerts(uuid) from public, anon;
grant execute on function public.refresh_payment_schedule_alerts(uuid) to authenticated;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'atlas-payment-schedule-alerts';
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
  perform cron.schedule(
    'atlas-payment-schedule-alerts',
    '15 11 * * *',
    $cron$select private.refresh_all_payment_schedule_alerts(current_date);$cron$
  );
end;
$$;

select private.refresh_all_payment_schedule_alerts(current_date);

revoke all on function public.enforce_payment_batch_friday() from public, anon, authenticated;
