/**
 * Categorías de cuentas por pagar directas y su clasificación de gasto.
 *
 * Los sueldos, finiquitos y leyes sociales son remuneraciones: no son
 * facturas de proveedor. Se registran contra la persona (o institución
 * previsional) beneficiaria, sin folio ni documento tributario pendiente, y
 * se presentan como "Remuneraciones" (cuenta 610200) y no como gasto de
 * proveedores. Replica los checks direct_payables_category_check y
 * direct_payables_payroll_shape_check de
 * supabase/migrations/20260928192310_payroll_direct_payables.sql.
 * Sin dependencias para poder usarse en cliente, servidor y pruebas de Node.
 */

export const directPayableCategories = [
  "utilities",
  "rent",
  "taxes",
  "insurance",
  "subscriptions",
  "payroll",
  "social_security",
  "termination",
  "other",
] as const;
export type DirectPayableCategory = (typeof directPayableCategories)[number];

/** Categorías que son remuneraciones (cuenta 610200), no gasto de proveedor. */
export const payrollCategories = ["payroll", "social_security", "termination"] as const;
export type PayrollCategory = (typeof payrollCategories)[number];

export const directPayableCategoryLabels: Record<DirectPayableCategory, string> = {
  utilities: "Servicios básicos",
  rent: "Arriendo",
  taxes: "Impuestos / contribuciones",
  insurance: "Seguros",
  subscriptions: "Suscripciones",
  payroll: "Sueldos y remuneraciones",
  social_security: "Leyes sociales / cotizaciones",
  termination: "Finiquito",
  other: "Otro",
};

/** Detalle fijo que se guarda en category_detail para cada categoría. */
export const payrollCategoryDetails: Record<PayrollCategory, string | null> = {
  payroll: null,
  social_security: null,
  termination: "Finiquito",
};

export const PAYROLL_GROUP_KEY = "__remuneraciones__";
export const PAYROLL_GROUP_LABEL = "Remuneraciones";

export function isDirectPayableCategory(value: unknown): value is DirectPayableCategory {
  return typeof value === "string" && (directPayableCategories as readonly string[]).includes(value);
}

export function isPayrollCategory(value: unknown): value is PayrollCategory {
  return typeof value === "string" && (payrollCategories as readonly string[]).includes(value);
}

export type ExpenseGroup = "payroll" | "supplier";

export function expenseGroup(category: string | null | undefined): ExpenseGroup {
  return isPayrollCategory(category) ? "payroll" : "supplier";
}

export function directPayableCategoryLabel(
  category: string | null | undefined,
  detail?: string | null,
) {
  const base = isDirectPayableCategory(category) ? directPayableCategoryLabels[category] : null;
  if (!base) return "No informado";
  const extra = (detail ?? "").trim();
  if (category === "other") return extra ? `Otro · ${extra}` : "Otro";
  if (isPayrollCategory(category) && extra && extra.toLowerCase() !== base.toLowerCase())
    return `${base} · ${extra}`;
  return base;
}

export type AccountRef = { code: string; name: string };
export type DirectPayableClassification = {
  group: ExpenseGroup;
  /** Cuenta de resultado (plan de cuentas IFRS Chile sembrado en la base). */
  expenseAccount: AccountRef;
  /** Pasivo que se reconoce mientras la obligación está impaga. */
  liabilityAccount: AccountRef;
  /** NIC 7: siempre operación; la línea distingue proveedores de empleados. */
  cashFlow: { classification: "operating"; line: string };
};

// Códigos de supabase/migrations/20260723120000_add_chilean_ifrs_accounting_standard.sql
// (seed_chilean_ifrs_chart_of_accounts) y 20260806183000_add_payroll_provisions.sql (210300).
const accounts = {
  unclassified: { code: "610100", name: "Gastos operacionales por clasificar" },
  payroll: { code: "610200", name: "Remuneraciones y cargas sociales" },
  rent: { code: "610300", name: "Arriendos y gastos de ocupación" },
  utilities: { code: "610400", name: "Servicios básicos y comunicaciones" },
  suppliers: { code: "210100", name: "Proveedores y cuentas por pagar" },
  payrollPayable: { code: "210300", name: "Remuneraciones y cargas por pagar" },
} as const satisfies Record<string, AccountRef>;

export const EMPLOYEE_CASH_FLOW_LINE = "Pagos a y por cuenta de los empleados";
export const SUPPLIER_CASH_FLOW_LINE = "Pagos a proveedores por el suministro de bienes y servicios";

export function classifyDirectPayable(category: string | null | undefined): DirectPayableClassification {
  if (isPayrollCategory(category))
    return {
      group: "payroll",
      expenseAccount: accounts.payroll,
      liabilityAccount: accounts.payrollPayable,
      cashFlow: { classification: "operating", line: EMPLOYEE_CASH_FLOW_LINE },
    };
  return {
    group: "supplier",
    expenseAccount:
      category === "rent" ? accounts.rent : category === "utilities" ? accounts.utilities : accounts.unclassified,
    liabilityAccount: accounts.suppliers,
    cashFlow: { classification: "operating", line: SUPPLIER_CASH_FLOW_LINE },
  };
}

/** Remuneraciones agrupadas por categoría (sueldos, leyes sociales, finiquitos). */
export function payrollBreakdown(items: Array<{ category: string | null | undefined; total: number }>) {
  const byCategory = new Map<PayrollCategory, { category: PayrollCategory; label: string; records: number; total: number }>();
  for (const item of items) {
    if (!isPayrollCategory(item.category)) continue;
    const current = byCategory.get(item.category) ?? {
      category: item.category,
      label: directPayableCategoryLabels[item.category],
      records: 0,
      total: 0,
    };
    current.records += 1;
    current.total += Number.isFinite(item.total) ? item.total : 0;
    byCategory.set(item.category, current);
  }
  return payrollCategories.flatMap((category) => byCategory.get(category) ?? []);
}

function normalizedText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Detecta un tipo de gasto escrito a mano que en realidad es una remuneración
 * ("Finiquito", "Sueldo julio", "Cotizaciones previsionales"). Se aplica sólo
 * al detalle de la categoría "Otro": la descripción o el nombre de un
 * proveedor (p. ej. una empresa que calcula remuneraciones) no bastan.
 * Honorarios no son remuneraciones: se respaldan con boleta del prestador.
 */
export function payrollCategoryHint(detail: string | null | undefined): PayrollCategory | null {
  const text = normalizedText(detail);
  if (!text.trim() || /honorario/.test(text)) return null;
  if (/finiquit|indemnizacion|desahucio/.test(text)) return "termination";
  if (/leyes? social|imposicion|cotizacion|previred|isapre|\bafp\b|fonasa|seguro de cesantia/.test(text))
    return "social_security";
  if (/sueldo|remuneracion|liquidacion de sueldo|gratificacion|aguinaldo|salario/.test(text)) return "payroll";
  return null;
}

export const PAYROLL_NOT_SUPPLIER_MESSAGE =
  "Los finiquitos, sueldos, remuneraciones y leyes sociales no son facturas de proveedor: regístralos con el tipo «Sueldos y remuneraciones», «Leyes sociales / cotizaciones» o «Finiquito», indicando a la persona beneficiaria.";
