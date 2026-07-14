-- Seguimiento operativo de cobranzas. No modifica el estado ni los montos de
-- los documentos fuente; registra la gestión y compromisos asociados.
create table public.collection_followups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  issued_document_id uuid not null unique references public.issued_documents(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'committed', 'resolved')),
  responsible_name text,
  next_action_on date,
  promised_payment_date date,
  note text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(responsible_name) <= 180),
  check (char_length(note) <= 2000)
);

create index collection_followups_org_status_next_action_idx
  on public.collection_followups (organization_id, status, next_action_on);

create trigger collection_followups_set_updated_at
before update on public.collection_followups
for each row execute function public.set_updated_at();

alter table public.collection_followups enable row level security;

grant select, insert, update, delete on public.collection_followups to authenticated;

create policy "members read collection followups" on public.collection_followups
for select to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = collection_followups.organization_id
      and membership.user_id = (select auth.uid())
  )
);

create policy "finance roles create collection followups" on public.collection_followups
for insert to authenticated
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = collection_followups.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);

create policy "finance roles update collection followups" on public.collection_followups
for update to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = collection_followups.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
)
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = collection_followups.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);

create policy "finance roles delete collection followups" on public.collection_followups
for delete to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = collection_followups.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);
