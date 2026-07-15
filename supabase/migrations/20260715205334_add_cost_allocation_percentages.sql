-- Un gasto puede repartirse entre varios clientes/servicios. El porcentaje es
-- la fuente de verdad; el monto queda materializado para reportes y auditoría.
alter table public.profitability_cost_allocations
  add column allocation_percentage numeric(7, 4);

update public.profitability_cost_allocations allocation
set allocation_percentage = round((allocation.allocated_amount / nullif(abs(document.net_amount), 0)) * 100, 4)
from public.received_documents document
where document.id = allocation.received_document_id
  and document.organization_id = allocation.organization_id;

alter table public.profitability_cost_allocations
  alter column allocation_percentage set not null,
  add constraint profitability_cost_allocations_percentage_check
    check (allocation_percentage > 0 and allocation_percentage <= 100);

create or replace function public.validate_profitability_cost_allocation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_net numeric(18, 2);
  allocated_total numeric(18, 2);
  expected_amount numeric(18, 2);
  service_customer_id uuid;
begin
  select abs(net_amount) into document_net
  from public.received_documents
  where id = new.received_document_id and organization_id = new.organization_id
  for update;

  if document_net is null or document_net <= 0 then
    raise exception 'allocation requires a received document with a positive net amount';
  end if;

  if new.allocation_percentage is null or new.allocation_percentage <= 0 or new.allocation_percentage > 100 then
    raise exception 'allocation percentage must be between 0 and 100';
  end if;

  -- La última línea puede absorber un redondeo de hasta un centavo para que
  -- el total repartido coincida exactamente con el neto del documento.
  expected_amount := round(document_net * new.allocation_percentage / 100, 2);
  if abs(new.allocated_amount - expected_amount) > 0.01 then
    raise exception 'allocation amount must match the document net and percentage';
  end if;

  if new.customer_service_id is not null then
    select counterparty_id into service_customer_id
    from public.customer_services
    where id = new.customer_service_id and organization_id = new.organization_id;
    if service_customer_id is null or service_customer_id <> new.counterparty_id then
      raise exception 'customer service must belong to the allocated customer';
    end if;
  end if;

  select coalesce(sum(allocated_amount), 0) into allocated_total
  from public.profitability_cost_allocations
  where received_document_id = new.received_document_id
    and organization_id = new.organization_id
    and (tg_op <> 'UPDATE' or id <> old.id);

  if allocated_total + new.allocated_amount > document_net then
    raise exception 'cost allocation exceeds the received document net amount';
  end if;
  return new;
end;
$$;

create or replace function public.replace_profitability_cost_allocations(
  p_organization_id uuid,
  p_received_document_id uuid,
  p_allocations jsonb
)
returns setof public.profitability_cost_allocations
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_net numeric(18, 2);
  allocation jsonb;
  allocation_record public.profitability_cost_allocations;
  customer_id uuid;
  service_id uuid;
  allocation_percentage numeric(7, 4);
  allocation_notes text;
  percentage_total numeric(12, 4) := 0;
  allocated_total numeric(18, 2) := 0;
  allocation_count integer;
  position integer := 0;
  allocation_amount numeric(18, 2);
begin
  if (select auth.uid()) is null or not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  ) then
    raise exception 'finance role is required to allocate costs';
  end if;

  if jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocations must be an array';
  end if;

  allocation_count := jsonb_array_length(p_allocations);
  if allocation_count < 1 or allocation_count > 100 then
    raise exception 'allocation requires between 1 and 100 lines';
  end if;

  select abs(net_amount) into document_net
  from public.received_documents
  where id = p_received_document_id and organization_id = p_organization_id
  for update;

  if document_net is null or document_net <= 0 then
    raise exception 'allocation requires a received document with a positive net amount';
  end if;

  for allocation in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(allocation) <> 'object'
      or coalesce(allocation ->> 'counterpartyId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(allocation ->> 'percentage', '') !~ '^[0-9]+([.][0-9]{1,4})?$' then
      raise exception 'invalid allocation line';
    end if;

    customer_id := (allocation ->> 'counterpartyId')::uuid;
    service_id := nullif(allocation ->> 'customerServiceId', '')::uuid;
    allocation_percentage := (allocation ->> 'percentage')::numeric(7, 4);
    allocation_notes := nullif(btrim(coalesce(allocation ->> 'notes', '')), '');

    if allocation_percentage <= 0 or allocation_percentage > 100
      or allocation_notes is not null and length(allocation_notes) > 2000 then
      raise exception 'invalid allocation line';
    end if;

    percentage_total := percentage_total + allocation_percentage;
  end loop;

  if percentage_total <> 100.0000 then
    raise exception 'allocation percentages must add up to 100';
  end if;

  delete from public.profitability_cost_allocations
  where organization_id = p_organization_id
    and received_document_id = p_received_document_id;

  for allocation in select value from jsonb_array_elements(p_allocations) loop
    position := position + 1;
    customer_id := (allocation ->> 'counterpartyId')::uuid;
    service_id := nullif(allocation ->> 'customerServiceId', '')::uuid;
    allocation_percentage := (allocation ->> 'percentage')::numeric(7, 4);
    allocation_notes := nullif(btrim(coalesce(allocation ->> 'notes', '')), '');
    allocation_amount := case
      when position = allocation_count then document_net - allocated_total
      else round(document_net * allocation_percentage / 100, 2)
    end;

    insert into public.profitability_cost_allocations (
      organization_id, received_document_id, counterparty_id, customer_service_id,
      allocation_percentage, allocated_amount, notes, created_by
    ) values (
      p_organization_id, p_received_document_id, customer_id, service_id,
      allocation_percentage, allocation_amount, allocation_notes, (select auth.uid())
    ) returning * into allocation_record;

    allocated_total := allocated_total + allocation_amount;
    return next allocation_record;
  end loop;
end;
$$;

revoke all on function public.replace_profitability_cost_allocations(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_profitability_cost_allocations(uuid, uuid, jsonb) to authenticated;
