-- La bandeja conserva sólo metadatos operacionales: nunca el cuerpo del correo.
-- Así Finanzas puede trazar la llegada y el procesamiento sin convertir Atlas
-- en un repositorio de comunicaciones privadas.
alter table public.sii_mail_processed_messages
  add column if not exists email_subject text,
  add column if not exists sender_name text,
  add column if not exists sender_address text,
  add column if not exists received_at timestamptz,
  add column if not exists attachment_count integer not null default 0 check (attachment_count >= 0),
  add column if not exists dte_attachment_count integer not null default 0 check (dte_attachment_count >= 0);

alter table public.mail_payment_processed_messages
  add column if not exists email_subject text,
  add column if not exists sender_name text,
  add column if not exists sender_address text,
  add column if not exists received_at timestamptz,
  add column if not exists attachment_count integer not null default 0 check (attachment_count >= 0);
