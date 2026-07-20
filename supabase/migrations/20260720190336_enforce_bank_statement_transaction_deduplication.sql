-- A bank movement can only be imported once for the same account.
create unique index bank_transactions_account_source_external_id_key
  on public.bank_transactions (bank_account_id, source_external_id)
  where source_external_id is not null;
