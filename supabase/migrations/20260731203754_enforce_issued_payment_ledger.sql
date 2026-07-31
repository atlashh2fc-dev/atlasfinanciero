-- Los estados de cobro son derivados del libro de pagos. La excepción es una
-- actualización anidada hecha por sus propios triggers de conciliación.
create or replace function public.prevent_direct_document_payment_status_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if pg_trigger_depth() = 1
     and new.payment_status is distinct from old.payment_status
     and new.payment_status in ('Abonada', 'Pagada') then
    raise exception 'Documents can only be settled through payment_executions';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_direct_issued_document_payment_status_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.payment_status in ('Abonada', 'Pagada') then
    raise exception 'Documents can only be settled through payment_executions';
  end if;
  return new;
end;
$$;

create trigger issued_documents_prevent_direct_payment_insert
before insert on public.issued_documents
for each row execute function public.prevent_direct_issued_document_payment_status_insert();

revoke all on function public.prevent_direct_document_payment_status_change() from public, anon, authenticated;
revoke all on function public.prevent_direct_issued_document_payment_status_insert() from public, anon, authenticated;
