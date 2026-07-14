-- La actualización manual conserva RLS del usuario autenticado; sólo el trabajo
-- diario de cron mantiene privilegios elevados y no es ejecutable por clientes.

alter function public.refresh_recurrent_billing_alerts_internal(uuid, date) security invoker;
alter function public.refresh_recurrent_billing_alerts(uuid) security invoker;

create index billing_recurrence_rules_counterparty_organization_idx on public.billing_recurrence_rules (counterparty_id, organization_id);

create policy "finance creates billing alerts" on public.billing_alerts
for insert to authenticated with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = billing_alerts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance updates billing alerts" on public.billing_alerts
for update to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = billing_alerts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = billing_alerts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

grant execute on function public.refresh_recurrent_billing_alerts_internal(uuid, date) to authenticated;
grant select, insert, update on public.billing_alerts to authenticated;
