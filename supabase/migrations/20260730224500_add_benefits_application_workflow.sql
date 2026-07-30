-- Seguimiento operativo de cada postulación. Es visible para Administradores,
-- Finanzas y Digitación, sin dar acceso al perfil tributario de la empresa.

alter table public.benefits_applications
  add column if not exists responsible_name text check (responsible_name is null or char_length(responsible_name) <= 160),
  add column if not exists classification text not null default 'to_review' check (classification in ('to_review', 'eligible', 'partial', 'not_eligible', 'monitoring')),
  add column if not exists workflow_stage text not null default 'new' check (workflow_stage in ('new', 'collecting_documents', 'internal_review', 'ready_for_submission', 'submitted', 'waiting_result', 'awarded', 'not_selected', 'withdrawn')),
  add column if not exists document_status text not null default 'not_started' check (document_status in ('not_started', 'collecting', 'complete', 'observed', 'not_required')),
  add column if not exists last_activity_at timestamptz not null default now();

create table public.benefits_application_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  application_id uuid not null references public.benefits_applications(id) on delete cascade,
  event_type text not null default 'update' check (event_type in ('update', 'note', 'submission', 'result')),
  note text check (note is null or char_length(note) <= 2000),
  snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index benefits_application_events_application_idx
  on public.benefits_application_events (application_id, created_at desc);

alter table public.benefits_application_events enable row level security;

drop policy if exists "finance reads benefits applications" on public.benefits_applications;
drop policy if exists "finance manages benefits applications" on public.benefits_applications;

create policy "benefits workflow roles read applications" on public.benefits_applications
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_applications.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'data_entry')
  )
);

create policy "benefits workflow roles manage applications" on public.benefits_applications
for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_applications.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'data_entry')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_applications.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'data_entry')
  )
);

create policy "benefits workflow roles read events" on public.benefits_application_events
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_application_events.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'data_entry')
  )
);

create policy "benefits workflow roles create events" on public.benefits_application_events
for insert to authenticated with check (
  created_by = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_application_events.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'data_entry')
  )
);

grant select, insert, update on public.benefits_application_events to authenticated;
