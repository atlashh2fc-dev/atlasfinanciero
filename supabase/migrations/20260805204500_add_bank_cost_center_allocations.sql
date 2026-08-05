-- Distribución automática de ingresos y egresos bancarios por centro de costo.
-- La configuración de la cuenta funciona como predeterminado y cada movimiento
-- conserva una copia histórica que luego puede corregirse manualmente.

create table public.bank_account_cost_center_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bank_account_id uuid not null,
  cost_center_id uuid not null,
  allocation_percentage numeric(5, 2) not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (bank_account_id, organization_id)
    references public.bank_accounts(id, organization_id) on delete cascade,
  foreign key (cost_center_id, organization_id)
    references public.cost_centers(id, organization_id) on delete restrict,
  unique (bank_account_id, cost_center_id),
  constraint bank_account_cost_center_percentage_check
    check (allocation_percentage > 0 and allocation_percentage <= 100)
);

create table public.bank_transaction_cost_center_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bank_transaction_id uuid not null,
  cost_center_id uuid not null,
  allocation_percentage numeric(5, 2) not null,
  allocated_amount numeric(18, 2) not null,
  source text not null default 'account_default',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (bank_transaction_id, organization_id)
    references public.bank_transactions(id, organization_id) on delete cascade,
  foreign key (cost_center_id, organization_id)
    references public.cost_centers(id, organization_id) on delete restrict,
  unique (bank_transaction_id, cost_center_id),
  constraint bank_transaction_cost_center_percentage_check
    check (allocation_percentage > 0 and allocation_percentage <= 100),
  constraint bank_transaction_cost_center_amount_check check (allocated_amount >= 0),
  constraint bank_transaction_cost_center_source_check
    check (source in ('account_default', 'manual'))
);

create index bank_account_cost_center_org_idx
  on public.bank_account_cost_center_allocations(organization_id, bank_account_id);
create index bank_transaction_cost_center_org_idx
  on public.bank_transaction_cost_center_allocations(organization_id, bank_transaction_id);
create index bank_transaction_cost_center_center_idx
  on public.bank_transaction_cost_center_allocations(organization_id, cost_center_id);

create trigger bank_account_cost_center_allocations_set_updated_at
before update on public.bank_account_cost_center_allocations
for each row execute function public.set_updated_at();

create trigger bank_transaction_cost_center_allocations_set_updated_at
before update on public.bank_transaction_cost_center_allocations
for each row execute function public.set_updated_at();

alter table public.bank_account_cost_center_allocations enable row level security;
alter table public.bank_transaction_cost_center_allocations enable row level security;

create policy "members read bank account cost centers"
on public.bank_account_cost_center_allocations for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = bank_account_cost_center_allocations.organization_id
    and membership.user_id = (select auth.uid())
));

create policy "finance manages bank account cost centers"
on public.bank_account_cost_center_allocations for all to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = bank_account_cost_center_allocations.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance')
))
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = bank_account_cost_center_allocations.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance')
));

create policy "members read bank transaction cost centers"
on public.bank_transaction_cost_center_allocations for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = bank_transaction_cost_center_allocations.organization_id
    and membership.user_id = (select auth.uid())
));

create policy "finance manages bank transaction cost centers"
on public.bank_transaction_cost_center_allocations for all to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = bank_transaction_cost_center_allocations.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance')
))
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = bank_transaction_cost_center_allocations.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance')
));

grant select, insert, update, delete
  on public.bank_account_cost_center_allocations,
     public.bank_transaction_cost_center_allocations
  to authenticated;

create or replace function public.inherit_bank_transaction_cost_centers()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.bank_transaction_cost_center_allocations (
    organization_id,
    bank_transaction_id,
    cost_center_id,
    allocation_percentage,
    allocated_amount,
    source
  )
  select
    new.organization_id,
    new.id,
    allocation.cost_center_id,
    allocation.allocation_percentage,
    round(abs(new.amount) * allocation.allocation_percentage / 100, 2),
    'account_default'
  from public.bank_account_cost_center_allocations allocation
  where allocation.organization_id = new.organization_id
    and allocation.bank_account_id = new.bank_account_id;

  return new;
end;
$$;

create trigger bank_transactions_inherit_cost_centers
after insert on public.bank_transactions
for each row execute function public.inherit_bank_transaction_cost_centers();

create or replace function public.set_bank_account_cost_center_allocations(
  p_organization_id uuid,
  p_bank_account_id uuid,
  p_allocations jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  allocation_count integer;
  distinct_center_count integer;
  active_center_count integer;
  total_percentage numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then
    raise exception 'Finance access required';
  end if;
  if not exists (
    select 1 from public.bank_accounts account
    where account.id = p_bank_account_id
      and account.organization_id = p_organization_id
      and account.is_active
  ) then raise exception 'Bank account is not available'; end if;
  if jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) < 1
     or jsonb_array_length(p_allocations) > 50 then
    raise exception 'One to fifty allocations are required';
  end if;

  select
    count(*),
    count(distinct allocation.cost_center_id),
    sum(allocation.allocation_percentage)
  into allocation_count, distinct_center_count, total_percentage
  from jsonb_to_recordset(p_allocations)
    as allocation(cost_center_id uuid, allocation_percentage numeric);

  if allocation_count <> distinct_center_count
     or total_percentage is distinct from 100::numeric
     or exists (
       select 1
       from jsonb_to_recordset(p_allocations)
         as allocation(cost_center_id uuid, allocation_percentage numeric)
       where allocation.cost_center_id is null
          or allocation.allocation_percentage <= 0
          or allocation.allocation_percentage > 100
     ) then raise exception 'Allocations must use unique centers and total 100 percent'; end if;

  select count(*) into active_center_count
  from public.cost_centers center
  where center.organization_id = p_organization_id
    and center.is_active
    and center.id in (
      select allocation.cost_center_id
      from jsonb_to_recordset(p_allocations)
        as allocation(cost_center_id uuid, allocation_percentage numeric)
    );
  if active_center_count <> allocation_count then
    raise exception 'One or more cost centers are not available';
  end if;

  delete from public.bank_account_cost_center_allocations
  where organization_id = p_organization_id
    and bank_account_id = p_bank_account_id;

  insert into public.bank_account_cost_center_allocations (
    organization_id,
    bank_account_id,
    cost_center_id,
    allocation_percentage
  )
  select
    p_organization_id,
    p_bank_account_id,
    allocation.cost_center_id,
    round(allocation.allocation_percentage, 2)
  from jsonb_to_recordset(p_allocations)
    as allocation(cost_center_id uuid, allocation_percentage numeric);

  insert into public.bank_transaction_cost_center_allocations (
    organization_id,
    bank_transaction_id,
    cost_center_id,
    allocation_percentage,
    allocated_amount,
    source
  )
  select
    transaction.organization_id,
    transaction.id,
    allocation.cost_center_id,
    round(allocation.allocation_percentage, 2),
    round(abs(transaction.amount) * allocation.allocation_percentage / 100, 2),
    'account_default'
  from public.bank_transactions transaction
  cross join jsonb_to_recordset(p_allocations)
    as allocation(cost_center_id uuid, allocation_percentage numeric)
  where transaction.organization_id = p_organization_id
    and transaction.bank_account_id = p_bank_account_id
    and not exists (
      select 1
      from public.bank_transaction_cost_center_allocations existing
      where existing.bank_transaction_id = transaction.id
    );

  return allocation_count;
end;
$$;

create or replace function public.set_bank_transaction_cost_center_allocations(
  p_organization_id uuid,
  p_bank_transaction_id uuid,
  p_allocations jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  transaction_amount numeric;
  allocation_count integer;
  distinct_center_count integer;
  active_center_count integer;
  total_percentage numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then
    raise exception 'Finance access required';
  end if;

  select abs(transaction.amount) into transaction_amount
  from public.bank_transactions transaction
  where transaction.id = p_bank_transaction_id
    and transaction.organization_id = p_organization_id;
  if transaction_amount is null then raise exception 'Bank transaction is not available'; end if;
  if jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) < 1
     or jsonb_array_length(p_allocations) > 50 then
    raise exception 'One to fifty allocations are required';
  end if;

  select
    count(*),
    count(distinct allocation.cost_center_id),
    sum(allocation.allocation_percentage)
  into allocation_count, distinct_center_count, total_percentage
  from jsonb_to_recordset(p_allocations)
    as allocation(cost_center_id uuid, allocation_percentage numeric);

  if allocation_count <> distinct_center_count
     or total_percentage is distinct from 100::numeric
     or exists (
       select 1
       from jsonb_to_recordset(p_allocations)
         as allocation(cost_center_id uuid, allocation_percentage numeric)
       where allocation.cost_center_id is null
          or allocation.allocation_percentage <= 0
          or allocation.allocation_percentage > 100
     ) then raise exception 'Allocations must use unique centers and total 100 percent'; end if;

  select count(*) into active_center_count
  from public.cost_centers center
  where center.organization_id = p_organization_id
    and center.is_active
    and center.id in (
      select allocation.cost_center_id
      from jsonb_to_recordset(p_allocations)
        as allocation(cost_center_id uuid, allocation_percentage numeric)
    );
  if active_center_count <> allocation_count then
    raise exception 'One or more cost centers are not available';
  end if;

  delete from public.bank_transaction_cost_center_allocations
  where organization_id = p_organization_id
    and bank_transaction_id = p_bank_transaction_id;

  insert into public.bank_transaction_cost_center_allocations (
    organization_id,
    bank_transaction_id,
    cost_center_id,
    allocation_percentage,
    allocated_amount,
    source
  )
  select
    p_organization_id,
    p_bank_transaction_id,
    allocation.cost_center_id,
    round(allocation.allocation_percentage, 2),
    round(transaction_amount * allocation.allocation_percentage / 100, 2),
    'manual'
  from jsonb_to_recordset(p_allocations)
    as allocation(cost_center_id uuid, allocation_percentage numeric);

  return allocation_count;
end;
$$;

revoke all on function public.set_bank_account_cost_center_allocations(uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.set_bank_account_cost_center_allocations(uuid, uuid, jsonb)
  to authenticated;

revoke all on function public.set_bank_transaction_cost_center_allocations(uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.set_bank_transaction_cost_center_allocations(uuid, uuid, jsonb)
  to authenticated;
