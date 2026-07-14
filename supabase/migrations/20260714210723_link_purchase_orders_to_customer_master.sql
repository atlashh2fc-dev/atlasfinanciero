alter table public.customer_purchase_orders
  add column customer_counterparty_id uuid references public.counterparties(id) on delete set null;

create index customer_purchase_orders_customer_idx
  on public.customer_purchase_orders (organization_id, customer_counterparty_id)
  where customer_counterparty_id is not null;
