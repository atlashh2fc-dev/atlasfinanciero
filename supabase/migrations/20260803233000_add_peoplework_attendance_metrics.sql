-- Métricas mensuales del reporte oficial de detalle de asistencia PeopleWork.
-- Se guardan sólo agregados; no se persisten marcas individuales ni ubicaciones.

alter table public.payroll_person_period_metrics
  add column worked_days numeric(8, 2) not null default 0 check (worked_days >= 0),
  add column non_worked_days numeric(8, 2) not null default 0 check (non_worked_days >= 0),
  add column worked_minutes numeric(12, 2) not null default 0 check (worked_minutes >= 0),
  add column overtime_minutes numeric(12, 2) not null default 0 check (overtime_minutes >= 0),
  add column late_minutes numeric(12, 2) not null default 0 check (late_minutes >= 0),
  add column early_departure_minutes numeric(12, 2) not null default 0 check (early_departure_minutes >= 0);
