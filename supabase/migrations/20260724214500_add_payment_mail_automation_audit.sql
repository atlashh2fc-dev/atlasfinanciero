create table public.mail_payment_processed_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  message_id text not null,
  imap_uid bigint,
  processing_status text not null check (processing_status in ('imported', 'ignored', 'failed')),
  detail text,
  processed_at timestamptz not null default now(),
  unique (organization_id, message_id)
);

create index mail_payment_processed_messages_lookup_idx
  on public.mail_payment_processed_messages (organization_id, processed_at desc);

alter table public.mail_payment_processed_messages enable row level security;

create policy "finance and audit read processed payment mail"
on public.mail_payment_processed_messages for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = mail_payment_processed_messages.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));

grant select on public.mail_payment_processed_messages to authenticated;
