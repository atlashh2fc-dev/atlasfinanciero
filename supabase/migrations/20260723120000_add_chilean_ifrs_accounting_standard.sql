-- Plan de cuentas IFRS / Chile y generación controlada de asientos desde los
-- documentos operativos existentes. La clasificación es una propuesta base:
-- cada empresa puede ampliarla o reclasificarla antes de un cierre formal.

alter table public.accounting_entries
  add column if not exists source_event_key text;

create unique index if not exists accounting_entries_source_event_key_idx
  on public.accounting_entries (organization_id, source_event_key)
  where source_event_key is not null;

create or replace function public.seed_chilean_ifrs_chart_of_accounts(p_organization_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  inserted_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then raise exception 'Finance access required'; end if;

  insert into public.chart_of_accounts (
    organization_id, account_code, account_name, nature, normal_balance, statement_area, presentation_group, is_postable, is_active
  ) values
    (p_organization_id, '110100', 'Bancos', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110110', 'Caja', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110200', 'Deudores comerciales y otras cuentas por cobrar', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110210', 'IVA crédito fiscal', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110220', 'Pagos provisionales mensuales (PPM)', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '110300', 'Anticipos a proveedores', 'asset', 'debit', 'statement_of_financial_position', 'Activo corriente', true, true),
    (p_organization_id, '120100', 'Propiedades, planta y equipo', 'asset', 'debit', 'statement_of_financial_position', 'Activo no corriente', true, true),
    (p_organization_id, '120110', 'Depreciación acumulada', 'asset', 'credit', 'statement_of_financial_position', 'Activo no corriente', true, true),
    (p_organization_id, '120200', 'Activos por derecho de uso', 'asset', 'debit', 'statement_of_financial_position', 'Activo no corriente', true, true),
    (p_organization_id, '210100', 'Proveedores y cuentas por pagar', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo corriente', true, true),
    (p_organization_id, '210200', 'IVA débito fiscal', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo corriente', true, true),
    (p_organization_id, '210210', 'Retenciones y obligaciones tributarias', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo corriente', true, true),
    (p_organization_id, '220100', 'Préstamos y obligaciones financieras', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo no corriente', true, true),
    (p_organization_id, '220200', 'Pasivos por arrendamiento', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo no corriente', true, true),
    (p_organization_id, '230100', 'Provisiones', 'liability', 'credit', 'statement_of_financial_position', 'Pasivo no corriente', true, true),
    (p_organization_id, '310100', 'Capital emitido', 'equity', 'credit', 'statement_of_financial_position', 'Patrimonio', true, true),
    (p_organization_id, '310200', 'Resultados acumulados', 'equity', 'credit', 'statement_of_financial_position', 'Patrimonio', true, true),
    (p_organization_id, '310300', 'Resultado del ejercicio', 'equity', 'credit', 'statement_of_financial_position', 'Patrimonio', true, true),
    (p_organization_id, '410100', 'Ingresos ordinarios', 'revenue', 'credit', 'profit_or_loss', 'Ingresos de actividades ordinarias', true, true),
    (p_organization_id, '410200', 'Otros ingresos', 'revenue', 'credit', 'profit_or_loss', 'Otros ingresos', true, true),
    (p_organization_id, '510100', 'Costo de ventas', 'expense', 'debit', 'profit_or_loss', 'Costo de ventas', true, true),
    (p_organization_id, '610100', 'Gastos operacionales por clasificar', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610200', 'Remuneraciones y cargas sociales', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610300', 'Arriendos y gastos de ocupación', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610400', 'Servicios básicos y comunicaciones', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610500', 'Servicios profesionales', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true),
    (p_organization_id, '610900', 'Depreciación y amortización', 'expense', 'debit', 'profit_or_loss', 'Gastos de administración', true, true)
  on conflict (organization_id, account_code) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.generate_ifrs_source_entries(
  p_organization_id uuid,
  p_cutoff_date date
)
returns table (generated_entries integer, skipped_closed_periods integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.organization_role;
  account_bank uuid;
  account_receivable uuid;
  account_input_vat uuid;
  account_payable uuid;
  account_output_vat uuid;
  account_revenue uuid;
  account_expense uuid;
  source_row record;
  period_row public.financial_periods;
  entry_row public.accounting_entries;
  period_start_date date;
  period_end_date date;
  debit_amount numeric(18, 2);
  vat_amount numeric(18, 2);
  next_line integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_cutoff_date is null then raise exception 'A cutoff date is required'; end if;
  select membership.role into actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id and membership.user_id = auth.uid();
  if actor_role not in ('administrator', 'finance') then raise exception 'Finance access required'; end if;

  perform public.seed_chilean_ifrs_chart_of_accounts(p_organization_id);
  select id into account_bank from public.chart_of_accounts where organization_id = p_organization_id and account_code = '110100';
  select id into account_receivable from public.chart_of_accounts where organization_id = p_organization_id and account_code = '110200';
  select id into account_input_vat from public.chart_of_accounts where organization_id = p_organization_id and account_code = '110210';
  select id into account_payable from public.chart_of_accounts where organization_id = p_organization_id and account_code = '210100';
  select id into account_output_vat from public.chart_of_accounts where organization_id = p_organization_id and account_code = '210200';
  select id into account_revenue from public.chart_of_accounts where organization_id = p_organization_id and account_code = '410100';
  select id into account_expense from public.chart_of_accounts where organization_id = p_organization_id and account_code = '610100';

  generated_entries := 0;
  skipped_closed_periods := 0;

  -- Devengos de documentos emitidos: cliente / ingreso e IVA débito.
  for source_row in
    select document.*
    from public.issued_documents document
    where document.organization_id = p_organization_id
      and document.issue_date is not null
      and document.issue_date <= p_cutoff_date
      and abs(coalesce(document.total_amount, 0)) > 0
      and not exists (
        select 1 from public.accounting_entries entry
        where entry.organization_id = p_organization_id
          and entry.source_event_key = 'ifrs:issued:' || document.id::text
      )
    order by document.issue_date, document.id
  loop
    period_start_date := date_trunc('month', source_row.issue_date)::date;
    period_end_date := (period_start_date + interval '1 month - 1 day')::date;
    select * into period_row from public.financial_periods
      where organization_id = p_organization_id and period_start = period_start_date for update;
    if not found then
      insert into public.financial_periods (organization_id, period_start, period_end, notes)
      values (p_organization_id, period_start_date, period_end_date, 'Creado al generar asientos IFRS desde documentos.')
      returning * into period_row;
    end if;
    if period_row.status in ('closed', 'locked') then skipped_closed_periods := skipped_closed_periods + 1; continue; end if;

    vat_amount := least(abs(coalesce(source_row.vat_amount, 0)), abs(source_row.total_amount));
    debit_amount := abs(source_row.total_amount) - vat_amount;
    insert into public.accounting_entries (organization_id, financial_period_id, entry_date, status, description, external_reference, source_document_id, source_event_key)
    values (p_organization_id, period_row.id, source_row.issue_date, 'draft',
      'Devengo documento emitido ' || coalesce(source_row.document_number, source_row.id::text),
      coalesce(source_row.document_number, source_row.id::text), source_row.id, 'ifrs:issued:' || source_row.id::text)
    returning * into entry_row;
    insert into public.accounting_entry_lines (organization_id, entry_id, account_id, line_number, description, currency_code, functional_debit, functional_credit)
    values (p_organization_id, entry_row.id, account_receivable, 1, 'Documento emitido', 'CLP', abs(source_row.total_amount), 0);
    next_line := 2;
    if debit_amount > 0 then
      insert into public.accounting_entry_lines (organization_id, entry_id, account_id, line_number, description, currency_code, functional_debit, functional_credit)
      values (p_organization_id, entry_row.id, account_revenue, next_line, 'Ingreso ordinario', 'CLP', 0, debit_amount);
      next_line := next_line + 1;
    end if;
    if vat_amount > 0 then
      insert into public.accounting_entry_lines (organization_id, entry_id, account_id, line_number, description, currency_code, functional_debit, functional_credit)
      values (p_organization_id, entry_row.id, account_output_vat, next_line, 'IVA débito fiscal', 'CLP', 0, vat_amount);
    end if;
    update public.accounting_entries set status = 'posted', posted_at = now(), posted_by = auth.uid()
      where id = entry_row.id and organization_id = p_organization_id;
    generated_entries := generated_entries + 1;
  end loop;

  -- Devengos de documentos recibidos: gasto genérico / IVA crédito / proveedor.
  for source_row in
    select document.*
    from public.received_documents document
    where document.organization_id = p_organization_id
      and document.issue_date <= p_cutoff_date
      and abs(coalesce(document.total_amount, 0)) > 0
      and not exists (
        select 1 from public.accounting_entries entry
        where entry.organization_id = p_organization_id
          and entry.source_event_key = 'ifrs:received:' || document.id::text
      )
    order by document.issue_date, document.id
  loop
    period_start_date := date_trunc('month', source_row.issue_date)::date;
    period_end_date := (period_start_date + interval '1 month - 1 day')::date;
    select * into period_row from public.financial_periods
      where organization_id = p_organization_id and period_start = period_start_date for update;
    if not found then
      insert into public.financial_periods (organization_id, period_start, period_end, notes)
      values (p_organization_id, period_start_date, period_end_date, 'Creado al generar asientos IFRS desde documentos.')
      returning * into period_row;
    end if;
    if period_row.status in ('closed', 'locked') then skipped_closed_periods := skipped_closed_periods + 1; continue; end if;

    vat_amount := least(abs(coalesce(source_row.vat_amount, 0)), abs(source_row.total_amount));
    debit_amount := abs(source_row.total_amount) - vat_amount;
    insert into public.accounting_entries (organization_id, financial_period_id, entry_date, status, description, external_reference, source_event_key)
    values (p_organization_id, period_row.id, source_row.issue_date, 'draft',
      'Devengo documento recibido ' || coalesce(source_row.document_number, source_row.id::text),
      coalesce(source_row.document_number, source_row.id::text), 'ifrs:received:' || source_row.id::text)
    returning * into entry_row;
    next_line := 1;
    if debit_amount > 0 then
      insert into public.accounting_entry_lines (organization_id, entry_id, account_id, line_number, description, currency_code, functional_debit, functional_credit)
      values (p_organization_id, entry_row.id, account_expense, next_line, 'Gasto operacional por clasificar', 'CLP', debit_amount, 0);
      next_line := next_line + 1;
    end if;
    if vat_amount > 0 then
      insert into public.accounting_entry_lines (organization_id, entry_id, account_id, line_number, description, currency_code, functional_debit, functional_credit)
      values (p_organization_id, entry_row.id, account_input_vat, next_line, 'IVA crédito fiscal', 'CLP', vat_amount, 0);
      next_line := next_line + 1;
    end if;
    insert into public.accounting_entry_lines (organization_id, entry_id, account_id, line_number, description, currency_code, functional_debit, functional_credit)
    values (p_organization_id, entry_row.id, account_payable, next_line, 'Cuenta por pagar proveedor', 'CLP', 0, abs(source_row.total_amount));
    update public.accounting_entries set status = 'posted', posted_at = now(), posted_by = auth.uid()
      where id = entry_row.id and organization_id = p_organization_id;
    generated_entries := generated_entries + 1;
  end loop;

  -- Cobros y pagos realmente ejecutados. Sólo se contabilizan si su documento
  -- base ya fue incorporado, evitando saldos huérfanos en períodos cerrados.
  for source_row in
    select execution.*
    from public.payment_executions execution
    where execution.organization_id = p_organization_id
      and execution.executed_on <= p_cutoff_date
      and not exists (
        select 1 from public.accounting_entries entry
        where entry.organization_id = p_organization_id
          and entry.source_event_key = 'ifrs:payment:' || execution.id::text
      )
      and (
        (execution.issued_document_id is not null and exists (
          select 1 from public.accounting_entries entry where entry.organization_id = p_organization_id
            and entry.source_event_key = 'ifrs:issued:' || execution.issued_document_id::text
        )) or
        (execution.received_document_id is not null and exists (
          select 1 from public.accounting_entries entry where entry.organization_id = p_organization_id
            and entry.source_event_key = 'ifrs:received:' || execution.received_document_id::text
        ))
      )
    order by execution.executed_on, execution.id
  loop
    period_start_date := date_trunc('month', source_row.executed_on)::date;
    period_end_date := (period_start_date + interval '1 month - 1 day')::date;
    select * into period_row from public.financial_periods
      where organization_id = p_organization_id and period_start = period_start_date for update;
    if not found then
      insert into public.financial_periods (organization_id, period_start, period_end, notes)
      values (p_organization_id, period_start_date, period_end_date, 'Creado al generar asientos IFRS desde pagos.')
      returning * into period_row;
    end if;
    if period_row.status in ('closed', 'locked') then skipped_closed_periods := skipped_closed_periods + 1; continue; end if;

    insert into public.accounting_entries (organization_id, financial_period_id, entry_date, status, description, external_reference, source_event_key)
    values (p_organization_id, period_row.id, source_row.executed_on, 'draft',
      case when source_row.direction = 'inflow' then 'Cobro registrado' else 'Pago registrado' end,
      coalesce(source_row.payment_reference, source_row.id::text), 'ifrs:payment:' || source_row.id::text)
    returning * into entry_row;
    if source_row.direction = 'inflow' then
      insert into public.accounting_entry_lines (organization_id, entry_id, account_id, line_number, description, currency_code, functional_debit, functional_credit)
      values (p_organization_id, entry_row.id, account_bank, 1, 'Cobro en bancos', 'CLP', source_row.amount, 0),
             (p_organization_id, entry_row.id, account_receivable, 2, 'Aplicación a cliente', 'CLP', 0, source_row.amount);
    else
      insert into public.accounting_entry_lines (organization_id, entry_id, account_id, line_number, description, currency_code, functional_debit, functional_credit)
      values (p_organization_id, entry_row.id, account_payable, 1, 'Aplicación a proveedor', 'CLP', source_row.amount, 0),
             (p_organization_id, entry_row.id, account_bank, 2, 'Pago desde bancos', 'CLP', 0, source_row.amount);
    end if;
    update public.accounting_entries set status = 'posted', posted_at = now(), posted_by = auth.uid()
      where id = entry_row.id and organization_id = p_organization_id;
    generated_entries := generated_entries + 1;
  end loop;
  return next;
end;
$$;

revoke all on function public.seed_chilean_ifrs_chart_of_accounts(uuid) from public, anon;
grant execute on function public.seed_chilean_ifrs_chart_of_accounts(uuid) to authenticated;
revoke all on function public.generate_ifrs_source_entries(uuid, date) from public, anon;
grant execute on function public.generate_ifrs_source_entries(uuid, date) to authenticated;
