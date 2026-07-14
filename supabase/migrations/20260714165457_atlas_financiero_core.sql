-- Atlas Financiero: núcleo multiempresa, trazabilidad y control de acceso.
-- No convierte ni interpreta montos contables: conserva los valores de origen.

create type public.organization_role as enum ('administrator', 'finance', 'operations', 'auditor');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  tax_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.organization_role not null default 'auditor',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_file_name text not null,
  source_sheet_name text,
  source_sha256 text,
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  total_rows integer,
  accepted_rows integer,
  rejected_rows integer,
  status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  unique (id, organization_id)
);

create table public.counterparties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  legal_name text not null,
  trade_name text,
  tax_id text,
  kind text not null default 'customer',
  email text,
  phone text,
  payment_term_days integer,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, tax_id)
);

create table public.issued_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid references public.counterparties(id) on delete set null,
  import_batch_id uuid,
  document_number text,
  issue_date date,
  document_type text,
  issuer_name text,
  issuer_tax_id text,
  client_name text,
  recipient_name text,
  recipient_tax_id text,
  net_amount numeric(18, 2),
  vat_amount numeric(18, 2),
  total_amount numeric(18, 2),
  notes text,
  payment_term_days integer,
  due_date date,
  due_month text,
  payment_status text,
  payment_date date,
  payment_method text,
  origin_account_or_tax_id text,
  destination_bank text,
  destination_account text,
  source_file_name text,
  source_sheet_name text,
  source_row integer,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (import_batch_id, organization_id) references public.import_batches (id, organization_id)
);

create index issued_documents_organization_issue_date_idx on public.issued_documents (organization_id, issue_date desc);
create index issued_documents_organization_status_idx on public.issued_documents (organization_id, payment_status);
create index counterparties_organization_tax_id_idx on public.counterparties (organization_id, tax_id);
create index memberships_user_idx on public.organization_memberships (user_id, organization_id);

create table public.audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at before update on public.organizations
for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger counterparties_set_updated_at before update on public.counterparties
for each row execute function public.set_updated_at();
create trigger issued_documents_set_updated_at before update on public.issued_documents
for each row execute function public.set_updated_at();

create or replace function public.audit_issued_document_changes()
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
    'issued_document',
    coalesce(new.id, old.id),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger issued_documents_audit_changes
after insert or update or delete on public.issued_documents
for each row execute function public.audit_issued_document_changes();

-- Trigger administrado: crea sólo el perfil del nuevo usuario; no asigna roles.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.audit_issued_document_changes() from public, anon, authenticated;

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.import_batches enable row level security;
alter table public.counterparties enable row level security;
alter table public.issued_documents enable row level security;
alter table public.audit_log enable row level security;

create policy "users read their profile" on public.profiles
for select to authenticated using ((select auth.uid()) = id);
create policy "users update their profile" on public.profiles
for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "users read their memberships" on public.organization_memberships
for select to authenticated using ((select auth.uid()) = user_id);

create policy "members read their organizations" on public.organizations
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organizations.id
      and membership.user_id = (select auth.uid())
  )
);

create policy "finance roles read import batches" on public.import_batches
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = import_batches.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "members read counterparties" on public.counterparties
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
  )
);
create policy "finance roles create counterparties" on public.counterparties
for insert to authenticated with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);
create policy "finance roles update counterparties" on public.counterparties
for update to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "members read issued documents" on public.issued_documents
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
  )
);
create policy "authorized roles create issued documents" on public.issued_documents
for insert to authenticated with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);
create policy "finance roles update issued documents" on public.issued_documents
for update to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance roles read organization audit" on public.audit_log
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = audit_log.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

grant select on public.organizations, public.profiles, public.organization_memberships, public.import_batches, public.counterparties, public.issued_documents, public.audit_log to authenticated;
grant insert, update on public.counterparties, public.issued_documents to authenticated;
