-- Limpieza de cuentas por pagar directas que duplican una factura recibida.
--
-- Causa raíz: la misma factura del proveedor se registró dos veces, como
-- documento recibido (con folio) y como "Nueva obligación" en Compras. Pagar
-- la cuenta directa no rebajaba la factura, y la deuda figuraba dos veces.
-- La prevención queda en la migración de gastos con documento pendiente
-- (bloqueo por proveedor + folio entre ambas tablas).
--
-- Sólo se anulan cuentas sin pagos, sin conciliación y sin ítems en
-- propuestas activas, cuya factura del mismo proveedor y folio existe.
-- CXP-20260810-BFCD39DA (folio 4371, $826.745 frente a factura de $694.876)
-- está en una propuesta aprobada y queda para revisión manual.
do $$
declare
  v_payable record;
begin
  for v_payable in
    select payable.id, payable.payable_number,
      document.document_number, document.document_type
    from public.direct_payables payable
    join public.counterparties supplier on supplier.id = payable.supplier_counterparty_id
    join lateral (
      select candidate.document_number, candidate.document_type
      from public.received_documents candidate
      where candidate.organization_id = payable.organization_id
        and private.received_document_supplier_key(candidate.supplier_tax_id, candidate.supplier_counterparty_id, candidate.supplier_name)
          = private.received_document_supplier_key(supplier.tax_id, supplier.id, supplier.legal_name)
        and private.normalize_folio(candidate.document_number) = private.normalize_folio(payable.invoice_number)
      limit 1
    ) document on true
    where payable.payable_number in (
        'CXP-20260226-65EE1EE2', -- NC 256 registrada como cuenta por pagar
        'CXP-20260905-47AE8755', -- factura 3151940 ya pagada (PP-2026-00037)
        'CXP-20260224-6948B13B', -- factura 2378 ya pagada
        'CXP-20260224-8AFDA1CE', -- factura 2377
        'CXP-20260325-D09CF19A', -- factura 2389
        'CXP-20260821-7B91B3FD', -- factura 004210045
        'CXP-20260810-1A6F9E52'  -- segunda cuenta de la factura 4371
      )
      and payable.status in ('draft', 'review', 'approved', 'rejected')
      and not exists (select 1 from public.payment_executions e where e.direct_payable_id = payable.id)
      and not exists (select 1 from public.bank_reconciliation_matches m where m.direct_payable_id = payable.id)
      and not exists (
        select 1 from public.payment_batch_items item
        join public.payment_batches batch on batch.id = item.payment_batch_id
        where item.direct_payable_id = payable.id
          and batch.status in ('draft', 'review', 'approved', 'processing')
      )
  loop
    update public.direct_payables
    set status = 'cancelled',
        cancelled_at = now(),
        cancellation_reason = format(
          'Duplicado: el documento %s N° %s ya está registrado en documentos recibidos (limpieza 2026-09-28).',
          lower(v_payable.document_type), v_payable.document_number
        )
    where id = v_payable.id;
  end loop;
end;
$$;
