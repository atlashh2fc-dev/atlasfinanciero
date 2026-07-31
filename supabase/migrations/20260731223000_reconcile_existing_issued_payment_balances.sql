-- La regla de liquidación CLP ahora redondea el total del documento a pesos
-- enteros. Reejecuta el trigger para abonos preexistentes cuyo estado quedó
-- calculado con centavos (por ejemplo, total 291457,18 y abono 291457).
with document_balances as (
  select
    document.id,
    document.payment_status,
    case
      when sum(payment.amount) >= round(coalesce(document.total_amount, 0), 0)
        then 'Pagada'
      when sum(payment.amount) > 0 then 'Abonada'
      else 'Pendiente'
    end as expected_status
  from public.issued_documents document
  join public.issued_document_payments payment
    on payment.issued_document_id = document.id
  where coalesce(document.payment_status, 'Pendiente') not in (
    'Factorizada', 'Pagada al factoring', 'Recomprada al factoring',
    'Anulada', 'Nota de crédito'
  )
  group by document.id, document.payment_status
), payments_to_reconcile as (
  select distinct on (payment.issued_document_id) payment.id
  from public.issued_document_payments payment
  join document_balances balance
    on balance.id = payment.issued_document_id
  where balance.payment_status is distinct from balance.expected_status
  order by payment.issued_document_id, payment.paid_on desc, payment.created_at desc
)
update public.issued_document_payments payment
set amount = payment.amount
from payments_to_reconcile target
where payment.id = target.id;
