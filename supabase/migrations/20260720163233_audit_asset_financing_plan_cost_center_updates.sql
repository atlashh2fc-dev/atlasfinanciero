-- Las imputaciones de compromisos también se reflejan en la bitácora, igual
-- que los documentos y las líneas de presupuesto.
create or replace function public.audit_asset_financing_plan_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (organization_id, actor_id, entity_type, entity_id, action, before_state, after_state)
  values (new.organization_id, auth.uid(), 'asset_financing_plan', new.id, 'update', to_jsonb(old), to_jsonb(new));
  return new;
end;
$$;

create trigger asset_financing_plans_audit_changes
after update on public.asset_financing_plans
for each row execute function public.audit_asset_financing_plan_changes();

revoke all on function public.audit_asset_financing_plan_changes() from public, anon, authenticated;
