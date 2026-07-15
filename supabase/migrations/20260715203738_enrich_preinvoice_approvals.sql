-- Una aprobación debe tener contexto suficiente para que Finanzas decida sin
-- volver a buscar la prefactura: cliente, período, líneas y solicitante.

create or replace function public.sync_preinvoice_approval_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy_id uuid;
  customer_name text;
  requester_name text;
  line_items jsonb;
begin
  if new.status = 'review' and old.status = 'draft' then
    select id into policy_id
    from public.approval_policies
    where organization_id = new.organization_id
      and target_type = 'preinvoice'
      and is_active
      and currency_code = new.currency_code
      and minimum_amount <= new.total_amount
      and (maximum_amount is null or maximum_amount >= new.total_amount)
    order by minimum_amount desc
    limit 1;

    if policy_id is null then
      raise exception 'No approval policy applies to this preinvoice';
    end if;

    select coalesce(nullif(counterparty.trade_name, ''), counterparty.legal_name, 'Cliente')
    into customer_name
    from public.counterparties counterparty
    where counterparty.id = new.counterparty_id
      and counterparty.organization_id = new.organization_id;

    select coalesce(nullif(profile.full_name, ''), nullif(profile.email, ''), 'Usuario no identificado')
    into requester_name
    from public.profiles profile
    where profile.id = new.reviewed_by;

    select coalesce(jsonb_agg(jsonb_build_object(
      'description', line.description,
      'quantity', line.quantity,
      'unit_price', line.unit_price,
      'net_amount', line.net_amount,
      'source_currency', line.source_currency,
      'source_unit_price', line.source_unit_price,
      'conversion_rate_to_clp', line.conversion_rate_to_clp,
      'pricing_date', line.pricing_date
    ) order by line.created_at), '[]'::jsonb)
    into line_items
    from public.preinvoice_lines line
    where line.preinvoice_id = new.id
      and line.organization_id = new.organization_id;

    insert into public.approval_requests (
      organization_id, approval_policy_id, target_type, target_id, title,
      description, amount, currency_code, requested_by, metadata
    ) values (
      new.organization_id, policy_id, 'preinvoice', new.id,
      'Prefactura · ' || coalesce(customer_name, 'Cliente') || ' · ' || to_char(new.period_month, 'MM/YYYY'),
      'Revisión de servicios contratados antes de emitir la factura.',
      new.total_amount, new.currency_code, new.reviewed_by,
      jsonb_build_object(
        'period_month', to_char(new.period_month, 'YYYY-MM'),
        'counterparty_id', new.counterparty_id,
        'customer_name', coalesce(customer_name, 'Cliente'),
        'requester_name', coalesce(requester_name, 'Usuario no identificado'),
        'line_items', line_items
      )
    ) on conflict (organization_id, target_type, target_id) where status = 'submitted' do nothing;
  elsif old.status = 'review' and new.status in ('draft', 'cancelled') then
    update public.approval_requests
    set status = 'cancelled', completed_at = now()
    where organization_id = new.organization_id
      and target_type = 'preinvoice'
      and target_id = new.id
      and status = 'submitted';
  end if;
  return new;
end;
$$;

-- Completa las solicitudes que ya estaban en la bandeja al instalar la mejora.
update public.approval_requests request
set title = 'Prefactura · ' || coalesce(nullif(customer.trade_name, ''), customer.legal_name, 'Cliente') || ' · ' || to_char(preinvoice.period_month, 'MM/YYYY'),
    description = 'Revisión de servicios contratados antes de emitir la factura.',
    metadata = request.metadata || jsonb_build_object(
      'period_month', to_char(preinvoice.period_month, 'YYYY-MM'),
      'counterparty_id', preinvoice.counterparty_id,
      'customer_name', coalesce(nullif(customer.trade_name, ''), customer.legal_name, 'Cliente'),
      'requester_name', coalesce((
        select coalesce(nullif(profile.full_name, ''), nullif(profile.email, ''), 'Usuario no identificado')
        from public.profiles profile
        where profile.id = request.requested_by
      ), 'Usuario no identificado'),
      'line_items', coalesce(lines.items, '[]'::jsonb)
    )
from public.preinvoices preinvoice
join public.counterparties customer
  on customer.id = preinvoice.counterparty_id
 and customer.organization_id = preinvoice.organization_id
left join lateral (
  select jsonb_agg(jsonb_build_object(
    'description', line.description,
    'quantity', line.quantity,
    'unit_price', line.unit_price,
    'net_amount', line.net_amount,
    'source_currency', line.source_currency,
    'source_unit_price', line.source_unit_price,
    'conversion_rate_to_clp', line.conversion_rate_to_clp,
    'pricing_date', line.pricing_date
  ) order by line.created_at) as items
  from public.preinvoice_lines line
  where line.preinvoice_id = preinvoice.id
    and line.organization_id = preinvoice.organization_id
) lines on true
where request.target_type = 'preinvoice'
  and request.target_id = preinvoice.id
  and request.organization_id = preinvoice.organization_id;

revoke all on function public.sync_preinvoice_approval_request() from public, anon, authenticated;
