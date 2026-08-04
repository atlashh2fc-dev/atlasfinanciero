-- El proyecto expone privilegios amplios por default a tablas nuevas. RLS
-- sigue siendo la barrera principal, pero estos grants se reducen al mínimo
-- requerido por la API del perfil digitador.

revoke all on table public.data_entry_income_references from anon, authenticated;
grant select on table public.data_entry_income_references to authenticated;

revoke all on table public.data_entry_supporting_documents from anon, authenticated;
grant select, insert on table public.data_entry_supporting_documents to authenticated;
