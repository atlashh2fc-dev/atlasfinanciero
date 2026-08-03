alter table public.payroll_cost_lines
  add column if not exists data_basis text not null default 'official_payroll'
  check (data_basis in ('official_payroll', 'contractual_estimate'));

update public.payroll_cost_lines
set data_basis = 'contractual_estimate'
where cost_category = 'remuneracion_bruta_contractual';

create index if not exists payroll_cost_lines_basis_period_idx
  on public.payroll_cost_lines (organization_id, data_basis, period_month desc);
