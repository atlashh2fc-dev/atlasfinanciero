-- Recordatorios por persona dentro de Atlas.
--
-- Hasta ahora sólo existían alertas consolidadas por organización
-- (payment_schedule_alerts, billing_alerts), recalculadas una vez al día y sin
-- destinataria. Un recordatorio apunta a una persona concreta y se repite cada
-- interval_minutes mientras siga activo.
--
-- Cuando está asociado a una aprobación, la persona puede aprobar desde el
-- mismo aviso (public.approve_user_reminder) y el recordatorio se cierra al
-- decidirse esa aprobación por cualquier vía. Cuando está asociado a una
-- cuenta por pagar, también se cierra si la cuenta se paga, anula o rechaza.
--
-- Entrega: la app consulta public.due_user_reminders() al abrir, al volver a
-- la pestaña y cada minuto. "Más tarde" (public.acknowledge_user_reminder)
-- deja el siguiente aviso para ahora + interval_minutes.
--
-- style = 'playful' usa textos lúdicos que cambian con cada aviso
-- (src/lib/reminders.ts); 'standard' muestra sólo title y message.

create table public.user_reminders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  direct_payable_id uuid,
  approval_request_id uuid references public.approval_requests(id) on delete cascade,
  title text not null,
  message text,
  style text not null default 'standard',
  interval_minutes integer not null,
  next_remind_at timestamptz not null default now(),
  snooze_count integer not null default 0,
  last_snoozed_at timestamptz,
  status text not null default 'active',
  completed_at timestamptz,
  completion_reason text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (direct_payable_id, organization_id)
    references public.direct_payables (id, organization_id) on delete cascade,
  check (length(btrim(title)) between 3 and 160),
  check (message is null or length(message) <= 1000),
  check (style in ('standard', 'playful')),
  check (interval_minutes between 15 and 10080),
  check (snooze_count >= 0),
  check (status in ('active', 'completed', 'cancelled')),
  check ((status = 'active') = (completed_at is null))
);

comment on table public.user_reminders is
  'Recordatorio a una persona, repetido cada interval_minutes hasta que se decide su aprobación o se cierra su cuenta por pagar.';

create index user_reminders_recipient_due_idx
  on public.user_reminders (recipient_user_id, next_remind_at)
  where status = 'active';
create index user_reminders_organization_idx
  on public.user_reminders (organization_id);
create index user_reminders_direct_payable_idx
  on public.user_reminders (direct_payable_id, organization_id)
  where direct_payable_id is not null;
create index user_reminders_approval_request_idx
  on public.user_reminders (approval_request_id)
  where approval_request_id is not null;
create index user_reminders_created_by_idx
  on public.user_reminders (created_by)
  where created_by is not null;

create trigger user_reminders_set_updated_at before update on public.user_reminders
for each row execute function public.set_updated_at();

-- La destinataria debe pertenecer a la organización del recordatorio y la
-- aprobación asociada debe ser de esa misma organización.
create or replace function private.validate_user_reminder()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = new.organization_id
      and membership.user_id = new.recipient_user_id
  ) then
    raise exception 'Reminder recipient must belong to the organization';
  end if;
  if new.approval_request_id is not null and not exists (
    select 1
    from public.approval_requests request
    where request.id = new.approval_request_id
      and request.organization_id = new.organization_id
  ) then
    raise exception 'Reminder approval must belong to the organization';
  end if;
  return new;
end;
$$;

create trigger user_reminders_validate
before insert or update of recipient_user_id, organization_id, approval_request_id on public.user_reminders
for each row execute function private.validate_user_reminder();

alter table public.user_reminders enable row level security;

create policy "recipients and finance read reminders"
on public.user_reminders
for select to authenticated
using (
  recipient_user_id = (select auth.uid())
  or exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = user_reminders.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

grant select on public.user_reminders to authenticated;
revoke all on public.user_reminders from anon;

-- Una cuenta pagada, anulada o rechazada ya no requiere seguimiento.
create or replace function private.complete_direct_payable_reminders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('paid', 'cancelled', 'rejected')
     and new.status is distinct from old.status then
    update public.user_reminders reminder
    set status = 'completed',
        completed_at = now(),
        completion_reason = 'direct_payable_' || new.status
    where reminder.direct_payable_id = new.id
      and reminder.organization_id = new.organization_id
      and reminder.status = 'active';
  end if;
  return new;
end;
$$;

create trigger direct_payables_complete_reminders
after update of status on public.direct_payables
for each row execute function private.complete_direct_payable_reminders();

-- Una aprobación decidida (desde el aviso o desde la bandeja) cierra el aviso.
create or replace function private.complete_approval_reminders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'submitted' and new.status <> 'submitted' then
    update public.user_reminders reminder
    set status = 'completed',
        completed_at = now(),
        completion_reason = 'approval_' || new.status
    where reminder.approval_request_id = new.id
      and reminder.status = 'active';
  end if;
  return new;
end;
$$;

create trigger approval_requests_complete_reminders
after update of status on public.approval_requests
for each row execute function private.complete_approval_reminders();

-- Recordatorios vencidos de la persona que consulta, con el contexto de su
-- cuenta por pagar, la semana en que está programada y el paso de aprobación
-- que puede decidir.
create or replace function private.due_user_reminders_for_user()
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  title text,
  message text,
  style text,
  interval_minutes integer,
  next_remind_at timestamptz,
  snooze_count integer,
  payable_number text,
  beneficiary_name text,
  amount numeric,
  currency_code text,
  scheduled_for date,
  batch_status text,
  can_approve boolean,
  approve_only boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    reminder.id,
    reminder.organization_id,
    organization.legal_name,
    reminder.title,
    reminder.message,
    reminder.style,
    reminder.interval_minutes,
    reminder.next_remind_at,
    reminder.snooze_count,
    payable.payable_number,
    coalesce(payable.beneficiary_name, payable.supplier_name),
    coalesce(payable.total_amount, approval.amount),
    coalesce(payable.currency_code, approval.currency_code)::text,
    schedule.scheduled_for,
    schedule.status,
    pending_step.id is not null,
    coalesce((approval.metadata->>'approve_only')::boolean, false)
  from public.user_reminders reminder
  join public.organizations organization
    on organization.id = reminder.organization_id
  left join public.direct_payables payable
    on payable.id = reminder.direct_payable_id
   and payable.organization_id = reminder.organization_id
  left join public.approval_requests approval
    on approval.id = reminder.approval_request_id
   and approval.organization_id = reminder.organization_id
  left join lateral (
    select step.id
    from public.approval_steps step
    join public.organization_memberships membership
      on membership.organization_id = step.organization_id
     and membership.user_id = reminder.recipient_user_id
    where step.approval_request_id = approval.id
      and step.status = 'pending'
      and approval.status = 'submitted'
      and (step.assigned_to is null or step.assigned_to = reminder.recipient_user_id)
      and (membership.role = 'administrator' or membership.role = step.required_role)
    order by step.step_number
    limit 1
  ) pending_step on true
  left join lateral (
    select batch.scheduled_for, batch.status
    from public.payment_batch_items item
    join public.payment_batches batch
      on batch.id = item.payment_batch_id
     and batch.organization_id = item.organization_id
    where item.direct_payable_id = payable.id
      and item.organization_id = payable.organization_id
      and item.authorization_status <> 'cancelled'
      and batch.status <> 'cancelled'
    order by batch.scheduled_for desc
    limit 1
  ) schedule on true
  where (select auth.uid()) is not null
    and reminder.recipient_user_id = (select auth.uid())
    and reminder.status = 'active'
    and reminder.next_remind_at <= now()
    and (payable.id is null or payable.status not in ('paid', 'cancelled', 'rejected'))
    and (approval.id is null or approval.status = 'submitted')
    and exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = reminder.organization_id
        and membership.user_id = reminder.recipient_user_id
    )
  order by reminder.next_remind_at, reminder.created_at;
$$;

create or replace function public.due_user_reminders()
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  title text,
  message text,
  style text,
  interval_minutes integer,
  next_remind_at timestamptz,
  snooze_count integer,
  payable_number text,
  beneficiary_name text,
  amount numeric,
  currency_code text,
  scheduled_for date,
  batch_status text,
  can_approve boolean,
  approve_only boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.due_user_reminders_for_user();
$$;

-- "Más tarde": el siguiente aviso queda para ahora + intervalo.
create or replace function private.acknowledge_user_reminder_for_user(
  p_reminder_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next_remind_at timestamptz;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  update public.user_reminders reminder
  set last_snoozed_at = now(),
      snooze_count = reminder.snooze_count + 1,
      next_remind_at = now() + make_interval(mins => reminder.interval_minutes)
  where reminder.id = p_reminder_id
    and reminder.recipient_user_id = (select auth.uid())
    and reminder.status = 'active'
  returning reminder.next_remind_at into v_next_remind_at;

  if v_next_remind_at is null then
    raise exception 'Reminder not available';
  end if;
  return v_next_remind_at;
end;
$$;

create or replace function public.acknowledge_user_reminder(
  p_reminder_id uuid
)
returns timestamptz
language sql
security invoker
set search_path = ''
as $$
  select private.acknowledge_user_reminder_for_user(p_reminder_id);
$$;

-- Aprobar desde el aviso usa la misma decisión que la bandeja de aprobaciones
-- (public.record_approval_decision valida rol, asignación y estado).
create or replace function private.approve_user_reminder_for_user(
  p_reminder_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_step_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  select step.id into v_step_id
  from public.user_reminders reminder
  join public.approval_requests approval
    on approval.id = reminder.approval_request_id
   and approval.organization_id = reminder.organization_id
   and approval.status = 'submitted'
  join public.approval_steps step
    on step.approval_request_id = approval.id
   and step.status = 'pending'
  where reminder.id = p_reminder_id
    and reminder.recipient_user_id = (select auth.uid())
    and reminder.status = 'active'
  order by step.step_number
  limit 1;

  if v_step_id is null then
    raise exception 'Reminder approval not available';
  end if;

  return public.record_approval_decision(v_step_id, 'approved', 'Aprobado desde el recordatorio');
end;
$$;

create or replace function public.approve_user_reminder(
  p_reminder_id uuid
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select private.approve_user_reminder_for_user(p_reminder_id);
$$;

revoke all on function private.validate_user_reminder() from public, anon, authenticated;
revoke all on function private.complete_direct_payable_reminders() from public, anon, authenticated;
revoke all on function private.complete_approval_reminders() from public, anon, authenticated;
revoke all on function private.due_user_reminders_for_user() from public, anon;
grant execute on function private.due_user_reminders_for_user() to authenticated;
revoke all on function public.due_user_reminders() from public, anon;
grant execute on function public.due_user_reminders() to authenticated;
revoke all on function private.acknowledge_user_reminder_for_user(uuid) from public, anon;
grant execute on function private.acknowledge_user_reminder_for_user(uuid) to authenticated;
revoke all on function public.acknowledge_user_reminder(uuid) from public, anon;
grant execute on function public.acknowledge_user_reminder(uuid) to authenticated;
revoke all on function private.approve_user_reminder_for_user(uuid) from public, anon;
grant execute on function private.approve_user_reminder_for_user(uuid) to authenticated;
revoke all on function public.approve_user_reminder(uuid) from public, anon;
grant execute on function public.approve_user_reminder(uuid) to authenticated;
