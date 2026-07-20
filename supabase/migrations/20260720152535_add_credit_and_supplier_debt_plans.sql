alter table public.asset_financing_plans
  add column plan_kind text not null default 'asset_financing' check (plan_kind in ('asset_financing', 'credit', 'supplier_debt')),
  add column principal_amount numeric(18, 4),
  add column disbursement_date date,
  add column disbursement_amount numeric(18, 4),
  alter column asset_name drop not null,
  alter column asset_acquisition_amount drop not null,
  alter column asset_cost_clp drop not null,
  alter column useful_life_months drop not null,
  alter column amortization_start_month drop not null;

update public.asset_financing_plans set principal_amount = asset_acquisition_amount where principal_amount is null;
alter table public.asset_financing_plans alter column principal_amount set not null;
alter table public.asset_financing_plans add constraint asset_financing_plans_principal_amount_check check (principal_amount > 0);
alter table public.asset_financing_plans add constraint asset_financing_plans_kind_fields_check check (
  (plan_kind = 'asset_financing' and asset_name is not null and asset_acquisition_amount is not null and asset_cost_clp is not null and useful_life_months is not null and amortization_start_month is not null)
  or (plan_kind = 'credit' and disbursement_date is not null and disbursement_amount is not null and disbursement_amount > 0)
  or plan_kind = 'supplier_debt'
);

create index asset_financing_plans_org_kind_status_idx on public.asset_financing_plans (organization_id, plan_kind, status);

create or replace function public.materialize_asset_financing_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
declare plan_row public.asset_financing_plans%rowtype; v_description text;
begin
  if old.status <> 'submitted' or new.status not in ('approved', 'rejected') or new.metadata->>'kind' <> 'asset_financing_plan' then return new; end if;
  select * into plan_row from public.asset_financing_plans where id = new.target_id and organization_id = new.organization_id for update;
  if not found or plan_row.status <> 'review' then return new; end if;
  if new.status = 'rejected' then update public.asset_financing_plans set status = 'rejected' where id = plan_row.id;
  else
    update public.asset_financing_plans set status = 'approved', approved_at = coalesce(new.completed_at, now()), approved_by = auth.uid() where id = plan_row.id;
    v_description := case plan_row.plan_kind when 'credit' then 'Crédito ' || plan_row.plan_number when 'supplier_debt' then 'Deuda con proveedor ' || plan_row.plan_number else plan_row.asset_name end;
    insert into public.direct_payables (organization_id, payable_number, supplier_counterparty_id, supplier_name, category, description, issue_date, due_date, currency_code, total_amount, status, notes, approved_at, approved_by, created_by, asset_financing_installment_id)
    select plan_row.organization_id, plan_row.plan_number || '-' || lpad(installment.installment_number::text, 3, '0'), plan_row.supplier_counterparty_id, plan_row.supplier_name, 'other', v_description || ' · cuota ' || installment.installment_number || '/' || plan_row.installment_count, coalesce(plan_row.disbursement_date, plan_row.first_due_date), installment.due_date, plan_row.currency_code, installment.currency_amount, 'approved', plan_row.notes, coalesce(new.completed_at, now()), auth.uid(), plan_row.created_by, installment.id
    from public.asset_financing_installments installment where installment.plan_id = plan_row.id;
  end if;
  return new;
end;
$$;
revoke all on function public.materialize_asset_financing_plan() from public, anon, authenticated;
