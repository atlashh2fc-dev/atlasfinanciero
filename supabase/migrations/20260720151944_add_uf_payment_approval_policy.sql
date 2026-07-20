-- Los financiamientos pactados en UF usan la misma aprobación de pagos, pero
-- requieren una política con moneda UF para que la selección sea determinista.

insert into public.approval_policies (organization_id, name, target_type, required_role, currency_code)
select id, 'Aprobación de pagos en UF', 'payment', 'finance', 'UF'
from public.organizations
on conflict (organization_id, name) do nothing;

create or replace function public.seed_approval_policies_for_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.approval_policies (organization_id, name, target_type, required_role, currency_code)
  values
    (new.id, 'Aprobación de prefacturas', 'preinvoice', 'finance', 'CLP'),
    (new.id, 'Aprobación de pagos', 'payment', 'finance', 'CLP'),
    (new.id, 'Aprobación de pagos en UF', 'payment', 'finance', 'UF'),
    (new.id, 'Aprobación de órdenes de compra', 'purchase_order', 'finance', 'CLP')
  on conflict (organization_id, name) do nothing;
  return new;
end;
$$;

revoke all on function public.seed_approval_policies_for_organization() from public, anon, authenticated;
