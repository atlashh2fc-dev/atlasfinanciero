-- El número es la referencia estable de una propuesta contra sus facturas y
-- cuentas incluidas. Se asigna en la base para evitar duplicados por carreras
-- entre personas que preparan pagos al mismo tiempo.
create or replace function public.assign_payment_batch_number()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  proposal_year text;
  next_number bigint;
begin
  proposal_year := to_char(new.scheduled_for, 'YYYY');

  perform pg_advisory_xact_lock(
    hashtextextended(new.organization_id::text, 968451)
  );

  select coalesce(
    max((regexp_match(batch_number, '^PP-' || proposal_year || '-([0-9]+)$'))[1]::bigint),
    0
  ) + 1
  into next_number
  from public.payment_batches
  where organization_id = new.organization_id
    and batch_number ~ ('^PP-' || proposal_year || '-[0-9]+$');

  new.batch_number := format(
    'PP-%s-%s',
    proposal_year,
    lpad(next_number::text, 5, '0')
  );
  return new;
end;
$$;

drop trigger if exists payment_batches_assign_number on public.payment_batches;
create trigger payment_batches_assign_number
before insert on public.payment_batches
for each row execute function public.assign_payment_batch_number();

revoke all on function public.assign_payment_batch_number() from public, anon, authenticated;
