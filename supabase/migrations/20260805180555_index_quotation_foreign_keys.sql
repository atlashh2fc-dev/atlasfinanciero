create index quotation_catalog_items_created_by_idx on public.quotation_catalog_items (created_by);
create index sales_quotes_counterparty_fk_idx on public.sales_quotes (counterparty_id, organization_id);
create index sales_quotes_opportunity_fk_idx on public.sales_quotes (opportunity_id, organization_id);
create index sales_quotes_created_by_idx on public.sales_quotes (created_by);
