-- Bandeja de aprobaciones genérica. Las solicitudes sólo se resuelven a través
-- de record_approval_decision para conservar la secuencia y la trazabilidad.

create table public.approval_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  target_type text not null check (target_type in ('preinvoice', 'payment', 'purchase_order')),
  required_role public.organization_role not null default 'finance',
  minimum_amount numeric(18, 2) not null default 0 check (minimum_amount >= 0),
  maximum_amount numeric(18, 2) check (maximum_amount is null or maximum_amount >= minimum_amount),
  currency_code text not null default 'CLP' check (currency_code in ('CLP', 'USD', 'UF')),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, name)
);

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  approval_policy_id uuid not null,
  target_type text not null check (target_type in ('preinvoice', 'payment', 'purchase_order')),
  target_id uuid not null,
  title text not null check (btrim(title) <> ''),
  description text,
  amount numeric(18, 2) not null default 0 check (amount >= 0),
  currency_code text not null default 'CLP' check (currency_code in ('CLP', 'USD', 'UF')),
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'cancelled')),
  requested_by uuid references auth.users(id) on delete set null default auth.uid(),
  submitted_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (approval_policy_id, organization_id) references public.approval_policies (id, organization_id),
  unique (id, organization_id)
);

create table public.approval_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  approval_request_id uuid not null,
  step_number smallint not null default 1 check (step_number > 0),
  required_role public.organization_role not null,
  assigned_to uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'skipped')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (approval_request_id, organization_id) references public.approval_requests (id, organization_id) on delete cascade,
  unique (approval_request_id, step_number)
);

create index approval_policies_org_target_idx on public.approval_policies (organization_id, target_type, is_active);
create index approval_requests_org_status_submitted_idx on public.approval_requests (organization_id, status, submitted_at desc);
create index approval_requests_target_idx on public.approval_requests (organization_id, target_type, target_id);
create unique index approval_requests_one_open_target_idx on public.approval_requests (organization_id, target_type, target_id) where status = 'submitted';
create index approval_steps_inbox_idx on public.approval_steps (organization_id, status, required_role, created_at desc);

create trigger approval_policies_set_updated_at before update on public.approval_policies
for each row execute function public.set_updated_at();
create trigger approval_requests_set_updated_at before update on public.approval_requests
for each row execute function public.set_updated_at();
create trigger approval_steps_set_updated_at before update on public.approval_steps
for each row execute function public.set_updated_at();

create or replace function public.seed_approval_policies_for_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.approval_policies (organization_id, name, target_type, required_role)
  values
    (new.id, 'Aprobación de prefacturas', 'preinvoice', 'finance'),
    (new.id, 'Aprobación de pagos', 'payment', 'finance'),
    (new.id, 'Aprobación de órdenes de compra', 'purchase_order', 'finance')
  on conflict (organization_id, name) do nothing;
  return new;
end;
$$;

create trigger organizations_seed_approval_policies
after insert on public.organizations
for each row execute function public.seed_approval_policies_for_organization();

create or replace function public.initialize_approval_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy_row public.approval_policies%rowtype;
begin
  if new.status <> 'submitted' then
    raise exception 'approval_request_must_start_submitted';
  end if;

  select * into policy_row
  from public.approval_policies
  where id = new.approval_policy_id
    and organization_id = new.organization_id
    and is_active
    and target_type = new.target_type
    and currency_code = new.currency_code
    and minimum_amount <= new.amount
    and (maximum_amount is null or maximum_amount >= new.amount);

  if not found then
    raise exception 'approval_policy_not_applicable';
  end if;

  insert into public.approval_steps (
    organization_id, approval_request_id, step_number, required_role
  ) values (
    new.organization_id, new.id, 1, policy_row.required_role
  );
  return new;
end;
$$;

create trigger approval_requests_initialize
after insert on public.approval_requests
for each row execute function public.initialize_approval_request();

create or replace function public.audit_approval_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entity_kind text := case tg_table when 'approval_requests' then 'approval_request' else 'approval_step' end;
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

create trigger approval_requests_audit_changes
after insert or update or delete on public.approval_requests
for each row execute function public.audit_approval_changes();
create trigger approval_steps_audit_changes
after insert or update or delete on public.approval_steps
for each row execute function public.audit_approval_changes();

create or replace function public.record_approval_decision(
  p_step_id uuid,
  p_decision text,
  p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  step_row public.approval_steps%rowtype;
  request_row public.approval_requests%rowtype;
  has_pending_steps boolean;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid_approval_decision';
  end if;
  if p_comment is not null and char_length(p_comment) > 2000 then
    raise exception 'approval_comment_too_long';
  end if;

  select step.* into step_row
  from public.approval_steps step
  where step.id = p_step_id
  for update;

  if not found then
    raise exception 'approval_step_not_found';
  end if;

  select request.* into request_row
  from public.approval_requests request
  where request.id = step_row.approval_request_id
  for update;
  if step_row.status <> 'pending' or request_row.status <> 'submitted' then
    raise exception 'approval_decision_not_available';
  end if;
  if step_row.assigned_to is not null and step_row.assigned_to <> (select auth.uid()) then
    raise exception 'approval_step_not_assigned_to_user';
  end if;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = step_row.organization_id
      and membership.user_id = (select auth.uid())
      and (membership.role = 'administrator' or membership.role = step_row.required_role)
  ) then
    raise exception 'approval_role_required';
  end if;

  update public.approval_steps
  set status = p_decision,
      decided_by = (select auth.uid()),
      decided_at = now(),
      decision_comment = nullif(btrim(p_comment), '')
  where id = step_row.id;

  if p_decision = 'rejected' then
    update public.approval_requests
    set status = 'rejected', completed_at = now()
    where id = request_row.id;
  else
    select exists (
      select 1 from public.approval_steps
      where approval_request_id = request_row.id and status = 'pending'
    ) into has_pending_steps;
    if not has_pending_steps then
      update public.approval_requests
      set status = 'approved', completed_at = now()
      where id = request_row.id;
    end if;
  end if;

  return request_row.id;
end;
$$;

alter table public.approval_policies enable row level security;
alter table public.approval_requests enable row level security;
alter table public.approval_steps enable row level security;

create policy "members read approval policies" on public.approval_policies
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = approval_policies.organization_id and membership.user_id = (select auth.uid()))
);
create policy "administrators manage approval policies" on public.approval_policies
for all to authenticated using (
  private.is_organization_administrator(organization_id)
) with check (
  private.is_organization_administrator(organization_id)
);

create policy "members read approval requests" on public.approval_requests
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = approval_requests.organization_id and membership.user_id = (select auth.uid()))
);
create policy "authorized roles submit approval requests" on public.approval_requests
for insert to authenticated with check (
  requested_by = (select auth.uid())
  and exists (select 1 from public.organization_memberships membership where membership.organization_id = approval_requests.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
);

create policy "members read approval steps" on public.approval_steps
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = approval_steps.organization_id and membership.user_id = (select auth.uid()))
);

grant select, insert, update, delete on public.approval_policies, public.approval_requests, public.approval_steps to authenticated;
grant execute on function public.record_approval_decision(uuid, text, text) to authenticated;
revoke all on function public.initialize_approval_request() from public, anon, authenticated;
revoke all on function public.audit_approval_changes() from public, anon, authenticated;
revoke all on function public.record_approval_decision(uuid, text, text) from public, anon;
revoke all on function public.seed_approval_policies_for_organization() from public, anon, authenticated;

insert into public.approval_policies (organization_id, name, target_type, required_role)
select organizations.id, defaults.name, defaults.target_type, 'finance'::public.organization_role
from public.organizations organizations
cross join (values
  ('Aprobación de prefacturas', 'preinvoice'),
  ('Aprobación de pagos', 'payment'),
  ('Aprobación de órdenes de compra', 'purchase_order')
) as defaults(name, target_type)
on conflict (organization_id, name) do nothing;
