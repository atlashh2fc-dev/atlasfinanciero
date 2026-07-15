-- La consulta se ejecuta con los permisos y RLS del usuario autenticado. La
-- función de transición mantiene su propio contexto protegido al invocarla.
alter function public.financial_close_control_snapshot(uuid) security invoker;
