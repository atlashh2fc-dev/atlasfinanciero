-- Secretaria Virtual is provisioned only inside the existing Geimser tenant.
-- This migration never creates or renames an organization.

alter table public.bank_reconciliation_matches
  add constraint bank_reconciliation_matches_id_organization_key unique (id, organization_id);

create table public.service_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null check (char_length(code) between 2 and 40),
  name text not null check (char_length(name) between 2 and 180),
  description text,
  currency_code char(3) not null default 'CLP' check (currency_code in ('CLP', 'UF', 'USD')),
  tax_treatment text not null default 'configurable' check (tax_treatment in ('taxable', 'exempt', 'configurable')),
  tax_rate numeric(7,4) not null default 19 check (tax_rate between 0 and 100),
  cost_center_id uuid,
  revenue_account_id uuid,
  deferred_revenue_account_id uuid,
  billing_rule text not null default 'advance' check (billing_rule in ('advance', 'arrears')),
  activation_rule text not null default 'validated_payment' check (activation_rule in ('validated_payment', 'authorized_exception')),
  revenue_recognition_rule text not null default 'monthly' check (revenue_recognition_rule in ('daily', 'monthly')),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, code),
  foreign key (cost_center_id, organization_id) references public.cost_centers(id, organization_id) on delete set null,
  foreign key (revenue_account_id, organization_id) references public.chart_of_accounts(id, organization_id) on delete set null,
  foreign key (deferred_revenue_account_id, organization_id) references public.chart_of_accounts(id, organization_id) on delete set null
);

create table public.service_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  code text not null check (char_length(code) between 2 and 40),
  name text not null check (char_length(name) between 2 and 180),
  duration_months integer not null check (duration_months between 1 and 120),
  renewal_months integer not null check (renewal_months between 1 and 120),
  individual_net_price numeric(18,2) not null default 0 check (individual_net_price >= 0),
  company_net_price numeric(18,2) not null default 0 check (company_net_price >= 0),
  currency_code char(3) not null default 'CLP' check (currency_code in ('CLP', 'UF', 'USD')),
  is_exceptional boolean not null default false,
  requires_approval boolean not null default false,
  grace_period_days integer not null default 5 check (grace_period_days between 0 and 90),
  alert_days integer[] not null default array[30,15,7,3,1],
  auto_renew_default boolean not null default true,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, code),
  foreign key (product_id, organization_id) references public.service_products(id, organization_id) on delete restrict,
  check (duration_months >= 3 or (is_exceptional and requires_approval)),
  check (0 < all(alert_days))
);

create table public.service_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_code text not null default ('SV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6))),
  product_id uuid not null,
  plan_id uuid not null,
  counterparty_id uuid not null,
  customer_type text not null check (customer_type in ('individual', 'company')),
  billing_contact_email text not null,
  operational_contact_email text not null,
  sales_owner_id uuid references auth.users(id) on delete set null,
  service_owner_id uuid references auth.users(id) on delete set null,
  opportunity_id uuid,
  quote_id uuid,
  contract_id uuid,
  issued_document_id uuid,
  status text not null default 'draft' check (status in ('draft','pending_payment','payment_validation','paid_pending_activation','active','expiring','expired_pending_payment','suspended_nonpayment','cancelled','voided')),
  currency_code char(3) not null default 'CLP' check (currency_code in ('CLP', 'UF', 'USD')),
  list_net_amount numeric(18,2) not null default 0 check (list_net_amount >= 0),
  discount_amount numeric(18,2) not null default 0 check (discount_amount >= 0),
  net_amount numeric(18,2) not null default 0 check (net_amount >= 0),
  tax_rate numeric(7,4) not null default 19 check (tax_rate between 0 and 100),
  tax_amount numeric(18,2) not null default 0 check (tax_amount >= 0),
  gross_amount numeric(18,2) not null default 0 check (gross_amount >= 0),
  validated_paid_amount numeric(18,2) not null default 0 check (validated_paid_amount >= 0),
  payment_validation_amount numeric(18,2) not null default 0 check (payment_validation_amount >= 0),
  outstanding_amount numeric(18,2) not null default 0 check (outstanding_amount >= 0),
  contracted_months integer not null check (contracted_months between 1 and 120),
  projected_start_on date not null,
  current_start_on date,
  current_end_on date,
  next_renewal_on date,
  due_on date not null,
  grace_period_days integer not null default 5 check (grace_period_days between 0 and 90),
  automatic_renewal boolean not null default true,
  sale_origin text,
  special_conditions text,
  activated_at timestamptz,
  activated_by uuid references auth.users(id) on delete set null,
  activation_exception_reason text,
  activation_exception_expires_at timestamptz,
  suspension_reason text,
  suspended_at timestamptz,
  cancellation_reason text,
  cancelled_at timestamptz,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, subscription_code),
  foreign key (product_id, organization_id) references public.service_products(id, organization_id) on delete restrict,
  foreign key (plan_id, organization_id) references public.service_plans(id, organization_id) on delete restrict,
  foreign key (counterparty_id, organization_id) references public.counterparties(id, organization_id) on delete restrict,
  foreign key (opportunity_id, organization_id) references public.commercial_opportunities(id, organization_id) on delete set null,
  foreign key (quote_id, organization_id) references public.sales_quotes(id, organization_id) on delete set null,
  foreign key (contract_id, organization_id) references public.commercial_contracts(id, organization_id) on delete set null,
  foreign key (issued_document_id, organization_id) references public.issued_documents(id, organization_id) on delete set null,
  check (discount_amount <= list_net_amount),
  check (net_amount + tax_amount = gross_amount),
  check (validated_paid_amount + outstanding_amount <= gross_amount + payment_validation_amount),
  check (current_end_on is null or current_start_on is null or current_end_on >= current_start_on)
);

create table public.subscription_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid not null,
  sequence_number integer not null check (sequence_number > 0),
  kind text not null check (kind in ('initial','renewal','reactivation')),
  status text not null default 'projected' check (status in ('projected','payment_pending','paid','active','completed','cancelled')),
  starts_on date not null,
  ends_on date not null,
  net_amount numeric(18,2) not null check (net_amount >= 0),
  tax_amount numeric(18,2) not null check (tax_amount >= 0),
  gross_amount numeric(18,2) not null check (gross_amount >= 0),
  paid_at timestamptz,
  activated_at timestamptz,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (subscription_id, sequence_number),
  foreign key (subscription_id, organization_id) references public.service_subscriptions(id, organization_id) on delete restrict,
  check (ends_on >= starts_on),
  check (net_amount + tax_amount = gross_amount)
);

create table public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid not null,
  period_id uuid,
  payment_method text not null check (payment_method in ('gateway','bank_transfer')),
  provider_code text not null check (char_length(provider_code) between 2 and 80),
  external_transaction_id text,
  idempotency_key text not null,
  purchase_order text,
  provider_status text,
  amount numeric(18,2) not null check (amount > 0),
  currency_code char(3) not null check (currency_code in ('CLP','UF','USD')),
  paid_at timestamptz not null,
  validation_status text not null default 'pending' check (validation_status in ('pending','validated','rejected','reversed')),
  validated_at timestamptz,
  validated_by uuid references auth.users(id) on delete set null,
  reconciliation_match_id uuid,
  origin_bank text,
  origin_account_holder text,
  transfer_reference text,
  destination_account text,
  evidence_path text,
  evidence_name text,
  notification_evidence jsonb not null default '{}'::jsonb,
  observations text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, provider_code, idempotency_key),
  foreign key (subscription_id, organization_id) references public.service_subscriptions(id, organization_id) on delete restrict,
  foreign key (period_id, organization_id) references public.subscription_periods(id, organization_id) on delete restrict,
  foreign key (reconciliation_match_id, organization_id) references public.bank_reconciliation_matches(id, organization_id) on delete restrict,
  check (payment_method <> 'bank_transfer' or (evidence_path is not null and transfer_reference is not null))
);

create table public.subscription_payment_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid not null,
  payment_id uuid,
  exception_type text not null check (exception_type in ('duplicate','amount_mismatch','unknown_reference','overpayment','expired_subscription','unknown_customer','currency_mismatch','security_validation')),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  details jsonb not null default '{}'::jsonb,
  resolution text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (subscription_id, organization_id) references public.service_subscriptions(id, organization_id) on delete restrict,
  foreign key (payment_id, organization_id) references public.subscription_payments(id, organization_id) on delete restrict
);

create table public.subscription_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid not null,
  alert_type text not null check (alert_type in ('renewal','collection','activation','exception')),
  alert_on date not null,
  status text not null default 'open' check (status in ('open','completed','dismissed')),
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  assigned_to uuid references auth.users(id) on delete set null,
  amount numeric(18,2) not null default 0,
  action_recommended text,
  last_contact_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, subscription_id, alert_type, alert_on),
  foreign key (subscription_id, organization_id) references public.service_subscriptions(id, organization_id) on delete restrict
);

create table public.subscription_revenue_schedule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid not null,
  period_id uuid not null,
  recognition_on date not null,
  amount numeric(18,2) not null check (amount >= 0),
  status text not null default 'scheduled' check (status in ('scheduled','recognized','reversed')),
  accounting_entry_id uuid,
  recognized_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, period_id, recognition_on),
  foreign key (subscription_id, organization_id) references public.service_subscriptions(id, organization_id) on delete restrict,
  foreign key (period_id, organization_id) references public.subscription_periods(id, organization_id) on delete restrict,
  foreign key (accounting_entry_id, organization_id) references public.accounting_entries(id, organization_id) on delete restrict
);

create table public.subscription_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid not null,
  event_type text not null,
  from_status text,
  to_status text,
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (subscription_id, organization_id) references public.service_subscriptions(id, organization_id) on delete restrict
);

create index service_subscriptions_worklist_idx on public.service_subscriptions (organization_id, status, current_end_on, outstanding_amount);
create index service_subscriptions_customer_idx on public.service_subscriptions (organization_id, counterparty_id, created_at desc);
create index subscription_payments_validation_idx on public.subscription_payments (organization_id, validation_status, paid_at desc);
create unique index subscription_payments_external_transaction_key on public.subscription_payments(organization_id, provider_code, external_transaction_id) where external_transaction_id is not null;
create index subscription_alerts_worklist_idx on public.subscription_alerts (organization_id, status, alert_on, priority);
create index subscription_revenue_schedule_idx on public.subscription_revenue_schedule (organization_id, status, recognition_on);
create index subscription_events_timeline_idx on public.subscription_events (organization_id, subscription_id, created_at desc);

create trigger service_products_set_updated_at before update on public.service_products for each row execute function public.set_updated_at();
create trigger service_plans_set_updated_at before update on public.service_plans for each row execute function public.set_updated_at();
create trigger service_subscriptions_set_updated_at before update on public.service_subscriptions for each row execute function public.set_updated_at();
create trigger subscription_payments_set_updated_at before update on public.subscription_payments for each row execute function public.set_updated_at();

create or replace function public.prevent_subscription_financial_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.subscription_payments p where p.subscription_id = old.id)
    or exists (select 1 from public.subscription_periods p where p.subscription_id = old.id and p.status <> 'projected')
    or old.status not in ('draft','voided') then
    raise exception 'Subscriptions with financial or operational activity cannot be deleted';
  end if;
  return old;
end;
$$;
create trigger service_subscriptions_prevent_financial_delete before delete on public.service_subscriptions for each row execute function public.prevent_subscription_financial_delete();

create or replace function public.audit_subscription_changes()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log(organization_id, actor_id, entity_type, entity_id, action, before_state, after_state)
  values(coalesce(new.organization_id, old.organization_id), auth.uid(), 'service_subscription', coalesce(new.id, old.id), lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;
create trigger service_subscriptions_audit after insert or update or delete on public.service_subscriptions for each row execute function public.audit_subscription_changes();

create or replace function public.transition_service_subscription(
  p_organization_id uuid, p_subscription_id uuid, p_to_status text, p_reason text default null, p_evidence jsonb default '{}'::jsonb
) returns public.service_subscriptions
language plpgsql security definer set search_path = '' as $$
declare
  current_row public.service_subscriptions;
  previous_status text;
  actor_role text;
  allowed boolean := false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role::text into actor_role from public.organization_memberships membership
   where membership.organization_id = p_organization_id and membership.user_id = auth.uid();
  if actor_role is null then raise exception 'Organization access required'; end if;
  select * into current_row from public.service_subscriptions
   where id = p_subscription_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Subscription not found'; end if;
  previous_status := current_row.status;

  allowed := case current_row.status
    when 'draft' then p_to_status in ('pending_payment','voided')
    when 'pending_payment' then p_to_status in ('payment_validation','paid_pending_activation','voided')
    when 'payment_validation' then p_to_status in ('pending_payment','paid_pending_activation')
    when 'paid_pending_activation' then p_to_status in ('active','voided')
    when 'active' then p_to_status in ('expiring','suspended_nonpayment','cancelled')
    when 'expiring' then p_to_status in ('active','expired_pending_payment','cancelled')
    when 'expired_pending_payment' then p_to_status in ('paid_pending_activation','suspended_nonpayment','cancelled')
    when 'suspended_nonpayment' then p_to_status in ('paid_pending_activation','cancelled')
    else false end;
  if not allowed then raise exception 'Invalid subscription state transition: % -> %', current_row.status, p_to_status; end if;
  if p_to_status in ('voided','suspended_nonpayment','cancelled') and nullif(btrim(p_reason), '') is null then
    raise exception 'A reason is required for this transition';
  end if;
  if p_to_status = 'voided' and exists(select 1 from public.subscription_payments p where p.subscription_id=current_row.id) then
    raise exception 'A subscription with payment activity cannot be voided';
  end if;
  if p_to_status = 'paid_pending_activation' and current_row.validated_paid_amount < current_row.gross_amount then
    raise exception 'Validated payment does not cover the subscription';
  end if;
  if p_to_status = 'active' then
    if actor_role not in ('administrator','finance','operations') then raise exception 'Activation is not authorized'; end if;
    if current_row.validated_paid_amount < current_row.gross_amount
       and not (actor_role in ('administrator','finance') and nullif(btrim(p_reason), '') is not null
         and current_row.activation_exception_expires_at > now()) then
      raise exception 'Activation requires validated full payment or a current authorized exception';
    end if;
  end if;
  if p_to_status in ('cancelled','voided') and actor_role not in ('administrator','finance') then
    raise exception 'Cancellation requires an authorized role';
  end if;
  if p_to_status = 'cancelled' and exists (
    select 1 from public.subscription_payments p where p.subscription_id = current_row.id and p.validation_status = 'pending'
  ) then raise exception 'A payment is still under validation'; end if;

  update public.service_subscriptions set
    status = p_to_status,
    activated_at = case when p_to_status = 'active' then now() else activated_at end,
    activated_by = case when p_to_status = 'active' then auth.uid() else activated_by end,
    suspended_at = case when p_to_status = 'suspended_nonpayment' then now() else suspended_at end,
    suspension_reason = case when p_to_status = 'suspended_nonpayment' then p_reason else suspension_reason end,
    cancelled_at = case when p_to_status in ('cancelled','voided') then now() else cancelled_at end,
    cancellation_reason = case when p_to_status in ('cancelled','voided') then p_reason else cancellation_reason end
  where id = current_row.id returning * into current_row;
  insert into public.subscription_events(organization_id, subscription_id, event_type, from_status, to_status, reason, evidence, actor_id)
  values(p_organization_id, p_subscription_id, 'status_transition', previous_status, p_to_status, p_reason, coalesce(p_evidence, '{}'::jsonb), auth.uid());
  return current_row;
end;
$$;

create or replace function public.refresh_subscription_amounts(p_organization_id uuid, p_subscription_id uuid)
returns public.service_subscriptions language plpgsql security definer set search_path = '' as $$
declare result public.service_subscriptions; validated numeric; pending numeric; target_period uuid;
begin
  if auth.uid() is null or not exists(select 1 from public.organization_memberships m where m.organization_id=p_organization_id and m.user_id=auth.uid()) then
    raise exception 'Organization access required';
  end if;
  select id into target_period from public.subscription_periods
   where organization_id=p_organization_id and subscription_id=p_subscription_id and status in ('payment_pending','paid')
   order by sequence_number desc limit 1;
  select coalesce(sum(amount) filter(where validation_status='validated'),0), coalesce(sum(amount) filter(where validation_status='pending'),0)
    into validated,pending from public.subscription_payments where organization_id=p_organization_id and subscription_id=p_subscription_id
      and period_id is not distinct from target_period;
  update public.service_subscriptions set validated_paid_amount=validated, payment_validation_amount=pending,
    outstanding_amount=greatest(gross_amount-validated,0),
    status=case when validated>=gross_amount and status in ('pending_payment','payment_validation','expiring','expired_pending_payment','suspended_nonpayment') then 'paid_pending_activation'
                when pending>0 and status='pending_payment' then 'payment_validation'
                when pending=0 and validated<gross_amount and status='payment_validation' then 'pending_payment' else status end
  where organization_id=p_organization_id and id=p_subscription_id returning * into result;
  return result;
end;
$$;

revoke all on function public.prevent_subscription_financial_delete() from public, anon, authenticated;
revoke all on function public.audit_subscription_changes() from public, anon, authenticated;
revoke all on function public.transition_service_subscription(uuid,uuid,text,text,jsonb) from public, anon;
revoke all on function public.refresh_subscription_amounts(uuid,uuid) from public, anon;
grant execute on function public.transition_service_subscription(uuid,uuid,text,text,jsonb) to authenticated;
grant execute on function public.refresh_subscription_amounts(uuid,uuid) to authenticated;

alter table public.service_products enable row level security;
alter table public.service_plans enable row level security;
alter table public.service_subscriptions enable row level security;
alter table public.subscription_periods enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.subscription_payment_exceptions enable row level security;
alter table public.subscription_alerts enable row level security;
alter table public.subscription_revenue_schedule enable row level security;
alter table public.subscription_events enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['service_products','service_plans','service_subscriptions','subscription_periods','subscription_payments','subscription_payment_exceptions','subscription_alerts','subscription_revenue_schedule','subscription_events'] loop
    execute format('create policy "members read %1$s" on public.%1$I for select to authenticated using (exists (select 1 from public.organization_memberships m where m.organization_id = %1$I.organization_id and m.user_id = (select auth.uid())))', table_name);
  end loop;
end $$;

create policy "finance manages service products" on public.service_products for all to authenticated
using (exists(select 1 from public.organization_memberships m where m.organization_id=service_products.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')))
with check (exists(select 1 from public.organization_memberships m where m.organization_id=service_products.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')));
create policy "finance manages service plans" on public.service_plans for all to authenticated
using (exists(select 1 from public.organization_memberships m where m.organization_id=service_plans.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')))
with check (exists(select 1 from public.organization_memberships m where m.organization_id=service_plans.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')));
create policy "operators create subscriptions" on public.service_subscriptions for insert to authenticated
with check (exists(select 1 from public.organization_memberships m where m.organization_id=service_subscriptions.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance','operations')));
create policy "operators update subscriptions" on public.service_subscriptions for update to authenticated
using (exists(select 1 from public.organization_memberships m where m.organization_id=service_subscriptions.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance','operations')))
with check (exists(select 1 from public.organization_memberships m where m.organization_id=service_subscriptions.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance','operations')));
create policy "operators create periods" on public.subscription_periods for insert to authenticated
with check (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_periods.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance','operations')));
create policy "finance manages periods" on public.subscription_periods for update to authenticated
using (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_periods.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')))
with check (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_periods.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')));
create policy "operators submit payments" on public.subscription_payments for insert to authenticated
with check (validation_status='pending' and exists(select 1 from public.organization_memberships m where m.organization_id=subscription_payments.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance','operations')));
create policy "treasury validates payments" on public.subscription_payments for update to authenticated
using (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_payments.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')))
with check (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_payments.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')));
create policy "operators manage alerts" on public.subscription_alerts for all to authenticated
using (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_alerts.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance','operations')))
with check (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_alerts.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance','operations')));
create policy "finance manages payment exceptions" on public.subscription_payment_exceptions for all to authenticated
using (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_payment_exceptions.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')))
with check (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_payment_exceptions.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')));
create policy "finance manages revenue schedule" on public.subscription_revenue_schedule for all to authenticated
using (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_revenue_schedule.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')))
with check (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_revenue_schedule.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance')));
create policy "operators create subscription events" on public.subscription_events for insert to authenticated
with check (exists(select 1 from public.organization_memberships m where m.organization_id=subscription_events.organization_id and m.user_id=(select auth.uid()) and m.role in ('administrator','finance','operations')));

grant select, insert, update on public.service_products, public.service_plans, public.service_subscriptions, public.subscription_periods,
  public.subscription_payments, public.subscription_payment_exceptions, public.subscription_alerts, public.subscription_revenue_schedule, public.subscription_events to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('subscription-payment-evidence', 'subscription-payment-evidence', false, 52428800, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do nothing;
create policy "members read subscription payment evidence" on storage.objects for select to authenticated using (
  bucket_id='subscription-payment-evidence' and exists(select 1 from public.organization_memberships m where m.organization_id::text=split_part(name,'/',1) and m.user_id=(select auth.uid()))
);
create policy "operators upload subscription payment evidence" on storage.objects for insert to authenticated with check (
  bucket_id='subscription-payment-evidence' and exists(select 1 from public.organization_memberships m where m.organization_id::text=split_part(name,'/',1) and m.user_id=(select auth.uid()) and m.role in ('administrator','finance','operations'))
);
create policy "finance delete subscription payment evidence" on storage.objects for delete to authenticated using (
  bucket_id='subscription-payment-evidence' and exists(select 1 from public.organization_memberships m where m.organization_id::text=split_part(name,'/',1) and m.user_id=(select auth.uid()) and m.role in ('administrator','finance'))
);

-- Seed only the already-existing Geimser tenant. No organization is inserted.
insert into public.service_products(organization_id, code, name, description)
select id, 'SECRETARIA-VIRTUAL', 'Secretaria Virtual', 'Suscripción anticipada de asistencia y secretaria virtual'
from public.organizations
where lower(regexp_replace(legal_name, '[^[:alnum:]]+', '', 'g')) like '%geimser%'
on conflict (organization_id, code) do update set name=excluded.name, description=excluded.description;

insert into public.service_plans(organization_id, product_id, code, name, duration_months, renewal_months, is_exceptional, requires_approval)
select product.organization_id, product.id, seed.code, seed.name, seed.months, seed.months, seed.exceptional, seed.approval
from public.service_products product
cross join (values
  ('SV-1M','Mensual',1,true,true),
  ('SV-3M','Trimestral',3,false,false),
  ('SV-6M','Semestral',6,false,false),
  ('SV-12M','Anual',12,false,false)
) seed(code,name,months,exceptional,approval)
where product.code='SECRETARIA-VIRTUAL'
on conflict (organization_id, code) do nothing;
