-- Conserva el libro completo y normaliza las líneas que ya constituyen forecast.
-- El forecast no se deriva: cada línea conserva hoja, fila y columna de origen.

create table public.workbook_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_file_name text not null,
  source_sha256 text,
  total_sheets integer not null,
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (id, organization_id)
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('source-workbooks', 'source-workbooks', false, 52428800, array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

create table public.workbook_cells (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workbook_import_id uuid not null,
  source_sheet_name text not null,
  cell_reference text not null,
  raw_value text,
  numeric_value numeric,
  formula text,
  created_at timestamptz not null default now(),
  foreign key (workbook_import_id, organization_id) references public.workbook_imports (id, organization_id),
  unique (workbook_import_id, source_sheet_name, cell_reference)
);

create table public.forecast_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workbook_import_id uuid,
  forecast_kind text not null,
  commercial_owner text,
  pipeline_stage text,
  counterparty_name text,
  period_month date not null,
  amount numeric(18, 2) not null,
  source_sheet_name text not null,
  source_row integer not null,
  source_column text not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workbook_import_id, organization_id) references public.workbook_imports (id, organization_id)
);

create index workbook_cells_import_sheet_idx on public.workbook_cells (workbook_import_id, source_sheet_name);
create index forecast_lines_org_period_idx on public.forecast_lines (organization_id, period_month);
create index forecast_lines_org_kind_idx on public.forecast_lines (organization_id, forecast_kind);

create trigger forecast_lines_set_updated_at before update on public.forecast_lines
for each row execute function public.set_updated_at();

create or replace function public.audit_forecast_line_changes()
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
    'forecast_line',
    coalesce(new.id, old.id),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger forecast_lines_audit_changes
after insert or update or delete on public.forecast_lines
for each row execute function public.audit_forecast_line_changes();

revoke all on function public.audit_forecast_line_changes() from public, anon, authenticated;

alter table public.workbook_imports enable row level security;
alter table public.workbook_cells enable row level security;
alter table public.forecast_lines enable row level security;

create policy "finance and audit read workbook imports" on public.workbook_imports
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = workbook_imports.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

create policy "members read their source workbooks" on storage.objects
for select to authenticated using (
  bucket_id = 'source-workbooks'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
  )
);

create policy "finance and audit read workbook cells" on public.workbook_cells
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = workbook_cells.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

create policy "members read forecast lines" on public.forecast_lines
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = forecast_lines.organization_id
      and membership.user_id = (select auth.uid())
  )
);
create policy "finance roles create forecast lines" on public.forecast_lines
for insert to authenticated with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = forecast_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);
create policy "finance roles update forecast lines" on public.forecast_lines
for update to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = forecast_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = forecast_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

grant select on public.workbook_imports, public.workbook_cells, public.forecast_lines to authenticated;
grant insert, update on public.forecast_lines to authenticated;
