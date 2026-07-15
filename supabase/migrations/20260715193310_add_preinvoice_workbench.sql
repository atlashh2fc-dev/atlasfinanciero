-- Prefacturación: cada prefactura conserva el precio/servicio usado en el
-- período. Nunca modifica la ficha comercial ni intenta emitir un DTE.

create type public.preinvoice_status as enum (
  'draft',
  'review',
  'approved',
  'issued',
  'cancelled'
);

-- Las líneas congeladas deben conservar una referencia compuesta al servicio
-- contratado para impedir cruces entre organizaciones.
alter table public.customer_services
  add constraint customer_services_id_organization_key unique (id, organization_id);

create table public.preinvoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid not null,
  billing_cycle_id uuid,
  period_month date not null,
  status public.preinvoice_status not null default 'draft',
  currency_code char(3) not null default 'CLP',
  net_amount numeric(18, 2) not null default 0 check (net_amount >= 0),
  vat_amount numeric(18, 2) not null default 0 check (vat_amount >= 0),
  total_amount numeric(18, 2) not null default 0 check (total_amount >= 0),
  notes text,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  issued_at timestamptz,
  issued_by uuid references auth.users(id) on delete set null,
  issued_document_id uuid,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancellation_reason text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  foreign key (billing_cycle_id, organization_id)
    references public.billing_cycles (id, organization_id) on delete restrict,
  foreign key (issued_document_id, organization_id)
    references public.issued_documents (id, organization_id) on delete restrict,
  unique (id, organization_id),
  unique (organization_id, counterparty_id, period_month, currency_code),
  unique (billing_cycle_id),
  check (period_month = date_trunc('month', period_month)::date),
  check (currency_code ~ '^[A-Z]{3}$'),
  check ((status <> 'issued') or (issued_document_id is not null and issued_at is not null)),
  check ((status <> 'cancelled') or (cancelled_at is not null and cancellation_reason is not null))
);

create table public.preinvoice_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  preinvoice_id uuid not null,
  customer_service_id uuid,
  service_catalog_id uuid,
  description text not null,
  quantity numeric(18, 4) not null check (quantity > 0),
  unit_price numeric(18, 2) not null check (unit_price >= 0),
  net_amount numeric(18, 2) not null check (net_amount >= 0),
  usage_quantity numeric(18, 4),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (preinvoice_id, organization_id)
    references public.preinvoices (id, organization_id) on delete cascade,
  foreign key (customer_service_id, organization_id)
    references public.customer_services (id, organization_id) on delete restrict,
  foreign key (service_catalog_id, organization_id)
    references public.service_catalog (id, organization_id) on delete restrict,
  unique (preinvoice_id, customer_service_id),
  check (usage_quantity is null or usage_quantity >= 0)
);

create index preinvoices_organization_period_status_idx
  on public.preinvoices (organization_id, period_month desc, status);
create index preinvoices_customer_period_idx
  on public.preinvoices (counterparty_id, organization_id, period_month desc);
create index preinvoice_lines_preinvoice_idx
  on public.preinvoice_lines (preinvoice_id, organization_id, created_at);

create trigger preinvoices_set_updated_at before update on public.preinvoices
for each row execute function public.set_updated_at();
create trigger preinvoice_lines_set_updated_at before update on public.preinvoice_lines
for each row execute function public.set_updated_at();

create or replace function public.preinvoice_actor_has_role(
  p_organization_id uuid,
  p_roles public.organization_role[]
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = any (p_roles)
  );
$$;

create or replace function public.enforce_preinvoice_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = old.status then
    if old.status <> 'draft' then
      raise exception 'Only draft preinvoices can be edited';
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'review' then
    if not public.preinvoice_actor_has_role(new.organization_id, array['administrator', 'finance', 'operations']::public.organization_role[]) then
      raise exception 'Not authorized to submit preinvoice for review';
    end if;
    return new;
  end if;

  if old.status = 'review' and new.status = 'draft' then
    if not public.preinvoice_actor_has_role(new.organization_id, array['administrator', 'finance']::public.organization_role[]) then
      raise exception 'Not authorized to return preinvoice to draft';
    end if;
    return new;
  end if;

  if old.status = 'review' and new.status = 'approved' then
    if not public.preinvoice_actor_has_role(new.organization_id, array['administrator', 'finance']::public.organization_role[]) then
      raise exception 'Not authorized to approve preinvoice';
    end if;
    return new;
  end if;

  if old.status = 'approved' and new.status = 'issued' then
    if new.issued_document_id is null or not public.preinvoice_actor_has_role(new.organization_id, array['administrator', 'finance']::public.organization_role[]) then
      raise exception 'An authorized finance user and issued document are required';
    end if;
    return new;
  end if;

  if old.status in ('draft', 'review', 'approved') and new.status = 'cancelled' then
    if new.cancellation_reason is null or not public.preinvoice_actor_has_role(new.organization_id, array['administrator', 'finance']::public.organization_role[]) then
      raise exception 'An authorized finance user and cancellation reason are required';
    end if;
    return new;
  end if;

  raise exception 'Invalid preinvoice status transition: % to %', old.status, new.status;
end;
$$;

create trigger preinvoices_enforce_transition
before update on public.preinvoices
for each row execute function public.enforce_preinvoice_transition();

create or replace function public.sync_preinvoice_issue_to_billing_cycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'issued' and old.status is distinct from 'issued' and new.billing_cycle_id is not null then
    update public.billing_cycles
    set status = 'issued',
        issued_document_id = new.issued_document_id,
        issued_at = new.issued_at,
        ready_at = coalesce(ready_at, new.approved_at, new.issued_at),
        completed_by = new.issued_by
    where id = new.billing_cycle_id
      and organization_id = new.organization_id;
  end if;
  return new;
end;
$$;

create trigger preinvoices_sync_issued_cycle
after update of status on public.preinvoices
for each row execute function public.sync_preinvoice_issue_to_billing_cycle();

-- Cuando Operación envía una prefactura a revisión, se crea la decisión formal
-- en la bandeja. La decisión aprobada/rechazada devuelve el resultado a la
-- prefactura sin que pueda saltarse el control desde la interfaz.
create or replace function public.sync_preinvoice_approval_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy_id uuid;
begin
  if new.status = 'review' and old.status = 'draft' then
    select id into policy_id
    from public.approval_policies
    where organization_id = new.organization_id
      and target_type = 'preinvoice'
      and is_active
      and currency_code = new.currency_code
      and minimum_amount <= new.total_amount
      and (maximum_amount is null or maximum_amount >= new.total_amount)
    order by minimum_amount desc
    limit 1;

    if policy_id is null then
      raise exception 'No approval policy applies to this preinvoice';
    end if;

    insert into public.approval_requests (
      organization_id, approval_policy_id, target_type, target_id, title,
      description, amount, currency_code, requested_by, metadata
    ) values (
      new.organization_id, policy_id, 'preinvoice', new.id,
      'Prefactura en revisión',
      coalesce(new.notes, 'Prefactura enviada desde el módulo de facturación.'),
      new.total_amount, new.currency_code, new.reviewed_by,
      jsonb_build_object('period_month', new.period_month, 'counterparty_id', new.counterparty_id)
    ) on conflict (organization_id, target_type, target_id) where status = 'submitted' do nothing;
  elsif old.status = 'review' and new.status in ('draft', 'cancelled') then
    update public.approval_requests
    set status = 'cancelled', completed_at = now()
    where organization_id = new.organization_id
      and target_type = 'preinvoice'
      and target_id = new.id
      and status = 'submitted';
  end if;
  return new;
end;
$$;

create trigger preinvoices_sync_approval_request
after update of status on public.preinvoices
for each row execute function public.sync_preinvoice_approval_request();

create or replace function public.sync_approval_decision_to_preinvoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'submitted' and new.target_type = 'preinvoice' then
    if new.status = 'approved' then
      update public.preinvoices
      set status = 'approved', approved_at = coalesce(completed_at, now()), approved_by = auth.uid()
      where id = new.target_id and organization_id = new.organization_id and status = 'review';
    elsif new.status = 'rejected' then
      update public.preinvoices
      set status = 'draft'
      where id = new.target_id and organization_id = new.organization_id and status = 'review';
    end if;
  end if;
  return new;
end;
$$;

create trigger approval_requests_sync_preinvoice
after update of status on public.approval_requests
for each row execute function public.sync_approval_decision_to_preinvoice();

create or replace function public.enforce_preinvoice_line_editability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_preinvoice_id uuid := coalesce(new.preinvoice_id, old.preinvoice_id);
  v_status public.preinvoice_status;
begin
  select status into v_status from public.preinvoices where id = v_preinvoice_id;
  if v_status is distinct from 'draft' then
    raise exception 'Lines can only be changed while the preinvoice is a draft';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger preinvoice_lines_enforce_editability
before insert or update or delete on public.preinvoice_lines
for each row execute function public.enforce_preinvoice_line_editability();

create or replace function public.recalculate_preinvoice_totals()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_preinvoice_id uuid := coalesce(new.preinvoice_id, old.preinvoice_id);
begin
  update public.preinvoices preinvoice
  set net_amount = coalesce((
        select sum(line.net_amount)
        from public.preinvoice_lines line
        where line.preinvoice_id = v_preinvoice_id
      ), 0),
      vat_amount = 0,
      total_amount = coalesce((
        select sum(line.net_amount)
        from public.preinvoice_lines line
        where line.preinvoice_id = v_preinvoice_id
      ), 0)
  where preinvoice.id = v_preinvoice_id;
  return null;
end;
$$;

create trigger preinvoice_lines_recalculate_totals
after insert or update or delete on public.preinvoice_lines
for each row execute function public.recalculate_preinvoice_totals();

alter table public.preinvoices enable row level security;
alter table public.preinvoice_lines enable row level security;

create policy "members read preinvoices" on public.preinvoices
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = preinvoices.organization_id
      and membership.user_id = (select auth.uid())
  )
);
create policy "billing operators manage preinvoices" on public.preinvoices
for all to authenticated using (
  public.preinvoice_actor_has_role(preinvoices.organization_id, array['administrator', 'finance', 'operations']::public.organization_role[])
) with check (
  public.preinvoice_actor_has_role(preinvoices.organization_id, array['administrator', 'finance', 'operations']::public.organization_role[])
);
create policy "members read preinvoice lines" on public.preinvoice_lines
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = preinvoice_lines.organization_id
      and membership.user_id = (select auth.uid())
  )
);
create policy "billing operators manage preinvoice lines" on public.preinvoice_lines
for all to authenticated using (
  public.preinvoice_actor_has_role(preinvoice_lines.organization_id, array['administrator', 'finance', 'operations']::public.organization_role[])
) with check (
  public.preinvoice_actor_has_role(preinvoice_lines.organization_id, array['administrator', 'finance', 'operations']::public.organization_role[])
);

revoke all on function public.preinvoice_actor_has_role(uuid, public.organization_role[]) from public, anon;
revoke all on function public.enforce_preinvoice_transition() from public, anon, authenticated;
revoke all on function public.sync_preinvoice_issue_to_billing_cycle() from public, anon, authenticated;
revoke all on function public.sync_preinvoice_approval_request() from public, anon, authenticated;
revoke all on function public.sync_approval_decision_to_preinvoice() from public, anon, authenticated;
revoke all on function public.enforce_preinvoice_line_editability() from public, anon, authenticated;
revoke all on function public.recalculate_preinvoice_totals() from public, anon, authenticated;
grant execute on function public.preinvoice_actor_has_role(uuid, public.organization_role[]) to authenticated;

revoke all on public.preinvoices, public.preinvoice_lines from anon;
grant select, insert, update, delete on public.preinvoices, public.preinvoice_lines to authenticated;
