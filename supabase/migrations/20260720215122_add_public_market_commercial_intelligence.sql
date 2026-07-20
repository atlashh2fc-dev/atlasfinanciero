create table public.public_market_radar_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  run_local_hour smallint not null default 8 check (run_local_hour between 0 and 23),
  minimum_score smallint not null default 35 check (minimum_score between 0 and 100),
  search_keywords text[] not null default array[
    'contact center', 'call center', 'mesa de ayuda', 'atencion clientes',
    'desarrollo software', 'plataforma', 'automatizacion', 'integracion', 'crm',
    'bpo', 'back office', 'gestion administrativa', 'outsourcing', 'staffing',
    'cctv', 'monitoreo', 'seguridad', 'business intelligence', 'analitica de datos',
    'eficiencia energetica', 'energia solar'
  ]::text[],
  excluded_keywords text[] not null default array[]::text[],
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.public_market_radar_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_date date not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  source_count integer not null default 0 check (source_count >= 0),
  match_count integer not null default 0 check (match_count >= 0),
  new_count integer not null default 0 check (new_count >= 0),
  summary text,
  error_text text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  triggered_by text not null default 'daily_robot' check (triggered_by in ('daily_robot', 'manual')),
  created_at timestamptz not null default now(),
  unique (organization_id, run_date)
);

create table public.public_market_tenders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  external_code text not null,
  name text not null,
  status text not null,
  status_code integer,
  buyer_code text,
  buyer_name text,
  buyer_tax_id text,
  published_at timestamptz,
  closes_at timestamptz,
  currency_code text not null default 'CLP',
  estimated_amount numeric(20, 4),
  visible_amount boolean not null default false,
  fit_score smallint not null default 0 check (fit_score between 0 and 100),
  fit_tier text not null default 'red' check (fit_tier in ('green', 'yellow', 'red')),
  capability_matches text[] not null default array[]::text[],
  fit_reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(fit_reasons) = 'array'),
  fit_gaps jsonb not null default '[]'::jsonb check (jsonb_typeof(fit_gaps) = 'array'),
  executive_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(executive_summary) = 'object'),
  raw_detail jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_detail) = 'object'),
  source_url text not null,
  enrichment_status text not null default 'radar' check (enrichment_status in ('radar', 'enriching', 'ready', 'partial', 'failed')),
  opportunity_id uuid references public.commercial_opportunities(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  selected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, external_code)
);

create table public.public_market_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tender_id uuid not null,
  category text not null default 'other' check (category in ('administrative', 'technical', 'economic', 'award', 'other')),
  title text not null,
  source_url text not null,
  storage_path text,
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  download_status text not null default 'pending' check (download_status in ('pending', 'downloaded', 'source_only', 'failed')),
  error_text text,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (tender_id, source_url, title),
  foreign key (tender_id, organization_id) references public.public_market_tenders(id, organization_id) on delete cascade
);

create table public.public_market_award_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tender_id uuid not null,
  source_key text not null,
  related_tender_code text not null,
  relationship text not null default 'current_process' check (relationship in ('current_process', 'probable_predecessor')),
  similarity_score smallint check (similarity_score is null or similarity_score between 0 and 100),
  supplier_name text,
  supplier_tax_id text,
  awarded_amount numeric(20, 4),
  awarded_quantity numeric(20, 4),
  currency_code text,
  award_date timestamptz,
  award_document_url text,
  source_url text not null,
  raw_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tender_id, source_key),
  foreign key (tender_id, organization_id) references public.public_market_tenders(id, organization_id) on delete cascade
);

create index public_market_tenders_radar_idx on public.public_market_tenders (organization_id, fit_tier, first_seen_at desc, closes_at);
create index public_market_tenders_buyer_idx on public.public_market_tenders (organization_id, buyer_code, published_at desc);
create index public_market_documents_tender_idx on public.public_market_documents (organization_id, tender_id, category, created_at);
create index public_market_awards_tender_idx on public.public_market_award_history (organization_id, tender_id, award_date desc);
create index public_market_runs_latest_idx on public.public_market_radar_runs (organization_id, run_date desc);
create index public_market_tenders_opportunity_idx on public.public_market_tenders (opportunity_id) where opportunity_id is not null;
create index public_market_documents_tender_org_fk_idx on public.public_market_documents (tender_id, organization_id);
create index public_market_awards_tender_org_fk_idx on public.public_market_award_history (tender_id, organization_id);

create trigger public_market_radar_settings_set_updated_at before update on public.public_market_radar_settings for each row execute function public.set_updated_at();
create trigger public_market_tenders_set_updated_at before update on public.public_market_tenders for each row execute function public.set_updated_at();
create trigger public_market_documents_set_updated_at before update on public.public_market_documents for each row execute function public.set_updated_at();
create trigger public_market_awards_set_updated_at before update on public.public_market_award_history for each row execute function public.set_updated_at();

alter table public.public_market_radar_settings enable row level security;
alter table public.public_market_radar_runs enable row level security;
alter table public.public_market_tenders enable row level security;
alter table public.public_market_documents enable row level security;
alter table public.public_market_award_history enable row level security;

create policy "members read public market radar settings" on public.public_market_radar_settings for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_radar_settings.organization_id and membership.user_id = (select auth.uid())));
create policy "operators insert public market radar settings" on public.public_market_radar_settings for insert to authenticated with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_radar_settings.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "operators update public market radar settings" on public.public_market_radar_settings for update to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_radar_settings.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_radar_settings.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "operators delete public market radar settings" on public.public_market_radar_settings for delete to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_radar_settings.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "members read public market radar runs" on public.public_market_radar_runs for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_radar_runs.organization_id and membership.user_id = (select auth.uid())));
create policy "members read public market tenders" on public.public_market_tenders for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_tenders.organization_id and membership.user_id = (select auth.uid())));
create policy "operators insert public market tenders" on public.public_market_tenders for insert to authenticated with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_tenders.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "operators update public market tenders" on public.public_market_tenders for update to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_tenders.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_tenders.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "operators delete public market tenders" on public.public_market_tenders for delete to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_tenders.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "members read public market documents" on public.public_market_documents for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_documents.organization_id and membership.user_id = (select auth.uid())));
create policy "operators insert public market documents" on public.public_market_documents for insert to authenticated with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_documents.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "operators update public market documents" on public.public_market_documents for update to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_documents.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_documents.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "operators delete public market documents" on public.public_market_documents for delete to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_documents.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "members read public market award history" on public.public_market_award_history for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_award_history.organization_id and membership.user_id = (select auth.uid())));
create policy "operators insert public market award history" on public.public_market_award_history for insert to authenticated with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_award_history.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "operators update public market award history" on public.public_market_award_history for update to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_award_history.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_award_history.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "operators delete public market award history" on public.public_market_award_history for delete to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_award_history.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));

grant select, insert, update, delete on public.public_market_radar_settings, public.public_market_radar_runs, public.public_market_tenders, public.public_market_documents, public.public_market_award_history to authenticated;

insert into public.public_market_radar_settings (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('public-market-documents', 'public-market-documents', false, 15728640, array[
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'text/plain',
  'text/csv',
  'application/octet-stream'
])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "members read public market document objects" on storage.objects for select to authenticated using (
  bucket_id = 'public-market-documents'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = (storage.foldername(name))[1]
      and membership.user_id = (select auth.uid())
  )
);
