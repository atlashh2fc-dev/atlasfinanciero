-- The descriptive proposal name remains editable. Its stable business
-- reference is assigned independently and atomically by organization/year.
create or replace function public.assign_sales_quote_number()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  quote_year text;
  next_number bigint;
begin
  quote_year := to_char(coalesce(new.created_at, now()), 'YYYY');

  perform pg_advisory_xact_lock(
    hashtextextended(new.organization_id::text || ':' || quote_year, 724913)
  );

  select coalesce(
    max((regexp_match(quote.quote_number, '^COT-' || quote_year || '-([0-9]+)$'))[1]::bigint),
    0
  ) + 1
  into next_number
  from public.sales_quotes quote
  where quote.organization_id = new.organization_id
    and quote.quote_number ~ ('^COT-' || quote_year || '-[0-9]+$');

  new.quote_number := format(
    'COT-%s-%s',
    quote_year,
    lpad(next_number::text, 5, '0')
  );
  return new;
end;
$$;

drop trigger if exists sales_quotes_assign_number on public.sales_quotes;
create trigger sales_quotes_assign_number
before insert on public.sales_quotes
for each row execute function public.assign_sales_quote_number();

revoke all on function public.assign_sales_quote_number() from public, anon, authenticated;

comment on function public.assign_sales_quote_number() is
  'Assigns organization-scoped yearly quote numbers such as COT-2026-00001.';
