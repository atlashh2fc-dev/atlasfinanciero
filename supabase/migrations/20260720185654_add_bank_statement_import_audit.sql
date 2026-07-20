-- Auditoría de cartolas: cada carga conserva su archivo, origen y resultado.
create table public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bank_account_id uuid not null,
  file_name text not null,
  storage_path text not null unique,
  file_sha256 text not null,
  imported_rows integer not null default 0 check (imported_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  error_message text,
  imported_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (bank_account_id, file_sha256),
  foreign key (bank_account_id, organization_id)
    references public.bank_accounts (id, organization_id) on delete restrict
);

alter table public.bank_transactions
  add column bank_statement_import_id uuid,
  add constraint bank_transactions_statement_import_organization_fkey
    foreign key (bank_statement_import_id, organization_id)
    references public.bank_statement_imports (id, organization_id) on delete set null;

create index bank_statement_imports_account_created_idx
  on public.bank_statement_imports (bank_account_id, created_at desc);
create index bank_transactions_statement_import_idx
  on public.bank_transactions (bank_statement_import_id)
  where bank_statement_import_id is not null;

create trigger bank_statement_imports_set_updated_at before update on public.bank_statement_imports
for each row execute function public.set_updated_at();

alter table public.bank_statement_imports enable row level security;

create policy "finance and audit read bank statement imports"
on public.bank_statement_imports for select to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_statement_imports.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);
create policy "finance roles manage bank statement imports"
on public.bank_statement_imports for all to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_statement_imports.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = bank_statement_imports.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);
grant select, insert, update, delete on public.bank_statement_imports to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bank-statements', 'bank-statements', false, 10485760, array['text/csv', 'text/plain', 'application/vnd.ms-excel'])
on conflict (id) do nothing;

create policy "members read bank statement objects" on storage.objects
for select to authenticated using (
  bucket_id = 'bank-statements'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);
create policy "finance upload bank statement objects" on storage.objects
for insert to authenticated with check (
  bucket_id = 'bank-statements'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);
