-- La función conserva las RLS del usuario autenticado; no requiere privilegios
-- elevados para calcular sus controles.
alter function public.financial_close_control_snapshot(uuid) security invoker;
