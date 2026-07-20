-- Las cuentas directas se imputan al mismo centro de costo que el compromiso
-- de pago que les dio origen. Se mantiene nullable para no alterar el
-- histórico existente; las nuevas altas se validan desde la API.
alter table public.direct_payables
  add column cost_center_id uuid,
  add constraint direct_payables_cost_center_organization_fkey
    foreign key (cost_center_id, organization_id)
    references public.cost_centers (id, organization_id) on delete restrict;

create index direct_payables_org_cost_center_idx
  on public.direct_payables (organization_id, cost_center_id)
  where cost_center_id is not null;

-- Las cuotas creadas desde un activo, crédito o deuda heredan su imputación.
create or replace function public.materialize_asset_financing_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
declare plan_row public.asset_financing_plans%rowtype; v_description text;
begin
  if old.status <> 'submitted' or new.status not in ('approved', 'rejected') or new.metadata->>'kind' <> 'asset_financing_plan' then return new; end if;
  select * into plan_row from public.asset_financing_plans where id = new.target_id and organization_id = new.organization_id for update;
  if not found or plan_row.status <> 'review' then return new; end if;
  if new.status = 'rejected' then
    update public.asset_financing_plans set status = 'rejected' where id = plan_row.id;
  else
    update public.asset_financing_plans set status = 'approved', approved_at = coalesce(new.completed_at, now()), approved_by = auth.uid() where id = plan_row.id;
    v_description := case plan_row.plan_kind when 'credit' then 'Crédito ' || plan_row.plan_number when 'supplier_debt' then 'Deuda con proveedor ' || plan_row.plan_number else plan_row.asset_name end;
    insert into public.direct_payables (organization_id, payable_number, supplier_counterparty_id, supplier_name, category, description, issue_date, due_date, currency_code, total_amount, status, notes, approved_at, approved_by, created_by, asset_financing_installment_id, cost_center_id)
    select plan_row.organization_id, plan_row.plan_number || '-' || lpad(installment.installment_number::text, 3, '0'), plan_row.supplier_counterparty_id, plan_row.supplier_name, 'other', v_description || ' · cuota ' || installment.installment_number || '/' || plan_row.installment_count, coalesce(plan_row.disbursement_date, plan_row.first_due_date), installment.due_date, plan_row.currency_code, installment.currency_amount, 'approved', plan_row.notes, coalesce(new.completed_at, now()), auth.uid(), plan_row.created_by, installment.id, plan_row.cost_center_id
    from public.asset_financing_installments installment where installment.plan_id = plan_row.id;
  end if;
  return new;
end;
$$;

revoke all on function public.materialize_asset_financing_plan() from public, anon, authenticated;
