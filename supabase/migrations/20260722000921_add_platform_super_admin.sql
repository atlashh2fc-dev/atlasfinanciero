-- Capa SaaS transversal. Los administradores de una empresa conservan un
-- alcance exclusivo a su tenant; sólo los usuarios registrados aquí pueden
-- consultar el portafolio completo.
create table public.platform_administrators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now()
);

alter table public.platform_administrators enable row level security;
grant select on public.platform_administrators to authenticated;

create or replace function private.is_platform_administrator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.platform_administrators administrator
      where administrator.user_id = (select auth.uid())
    );
$$;

revoke all on function private.is_platform_administrator() from public, anon;
grant execute on function private.is_platform_administrator() to authenticated;

create policy "users read their platform administrator assignment"
on public.platform_administrators
for select to authenticated
using ((select auth.uid()) = user_id);

-- Sólo los dos responsables indicados administran el portafolio completo.
insert into public.platform_administrators (user_id)
select id
from auth.users
where lower(email) in ('h2fc24@gmail.com', 'laura@geimser.cl')
on conflict (user_id) do nothing;

create policy "platform administrators read organizations"
on public.organizations
for select to authenticated
using (private.is_platform_administrator());

create policy "platform administrators read memberships"
on public.organization_memberships
for select to authenticated
using (private.is_platform_administrator());

create policy "platform administrators read profiles"
on public.profiles
for select to authenticated
using (private.is_platform_administrator());

create policy "platform administrators read issued documents"
on public.issued_documents
for select to authenticated
using (private.is_platform_administrator());

create policy "platform administrators read received documents"
on public.received_documents
for select to authenticated
using (private.is_platform_administrator());

create policy "platform administrators read direct payables"
on public.direct_payables
for select to authenticated
using (private.is_platform_administrator());

create or replace function public.platform_super_admin_overview(p_year integer)
returns table (
  organization_id uuid,
  legal_name text,
  tax_id text,
  members_count bigint,
  revenue numeric,
  expenses numeric,
  operating_result numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with issued as (
    select
      document.organization_id,
      sum(
        case
          when lower(coalesce(document.document_type, '')) like '%orden de compra%' then 0
          when lower(coalesce(document.document_type, '')) like '%nota de crédito%'
            or lower(coalesce(document.document_type, '')) like '%nota de credito%'
            then -abs(coalesce(document.net_amount, 0))
          else coalesce(document.net_amount, 0)
        end
      ) as revenue
    from public.issued_documents document
    where document.issue_date >= make_date(p_year, 1, 1)
      and document.issue_date < make_date(p_year + 1, 1, 1)
    group by document.organization_id
  ), received as (
    select
      document.organization_id,
      sum(
        case
          when lower(coalesce(document.document_type, '')) like '%guía de despacho%'
            or lower(coalesce(document.document_type, '')) like '%guia de despacho%' then 0
          when lower(coalesce(document.document_type, '')) like '%nota de crédito%'
            or lower(coalesce(document.document_type, '')) like '%nota de credito%'
            then -abs(coalesce(document.net_amount, 0))
          else coalesce(document.net_amount, 0)
        end
      ) as expenses
    from public.received_documents document
    where document.issue_date >= make_date(p_year, 1, 1)
      and document.issue_date < make_date(p_year + 1, 1, 1)
    group by document.organization_id
  ), direct as (
    select payable.organization_id, sum(payable.total_amount) as expenses
    from public.direct_payables payable
    where payable.issue_date >= make_date(p_year, 1, 1)
      and payable.issue_date < make_date(p_year + 1, 1, 1)
      and payable.status in ('approved', 'paid')
      and payable.currency_code = 'CLP'
      and payable.asset_financing_installment_id is null
    group by payable.organization_id
  ), members as (
    select membership.organization_id, count(*) as members_count
    from public.organization_memberships membership
    group by membership.organization_id
  )
  select
    organization.id,
    organization.legal_name,
    organization.tax_id,
    coalesce(members.members_count, 0),
    coalesce(issued.revenue, 0),
    coalesce(received.expenses, 0) + coalesce(direct.expenses, 0),
    coalesce(issued.revenue, 0) - coalesce(received.expenses, 0) - coalesce(direct.expenses, 0)
  from public.organizations organization
  left join issued on issued.organization_id = organization.id
  left join received on received.organization_id = organization.id
  left join direct on direct.organization_id = organization.id
  left join members on members.organization_id = organization.id
  where private.is_platform_administrator()
  order by organization.legal_name;
$$;

revoke all on function public.platform_super_admin_overview(integer) from public, anon;
grant execute on function public.platform_super_admin_overview(integer) to authenticated;
