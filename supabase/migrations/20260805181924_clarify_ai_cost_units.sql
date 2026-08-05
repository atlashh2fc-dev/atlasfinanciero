update public.quotation_catalog_items
set name = 'Tokens GPT',
    unit_name = '1M tokens'
where name = 'IA GPT'
  and category = 'ai';

update public.quotation_catalog_items
set name = 'Tokens Claude',
    unit_name = '1M tokens'
where name = 'IA Claude'
  and category = 'ai';
