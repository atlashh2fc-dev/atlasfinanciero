alter table public.issued_documents
  add column payment_condition text check (payment_condition in ('advance', 'post_service'));

comment on column public.issued_documents.payment_condition is
  'Condición comercial del servicio: advance = cobro anticipado; post_service = cobro vencido/post servicio.';
