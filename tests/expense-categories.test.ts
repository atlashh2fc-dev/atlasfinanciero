import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyDirectPayable,
  directPayableCategories,
  directPayableCategoryLabel,
  EMPLOYEE_CASH_FLOW_LINE,
  expenseGroup,
  isDirectPayableCategory,
  isPayrollCategory,
  payrollBreakdown,
  payrollCategories,
  payrollCategoryHint,
  SUPPLIER_CASH_FLOW_LINE,
} from "../src/lib/expense-categories.ts";

test("sueldos, leyes sociales y finiquitos son remuneraciones, no gasto de proveedores", () => {
  for (const category of ["payroll", "social_security", "termination"]) {
    assert.ok(isPayrollCategory(category), category);
    assert.equal(expenseGroup(category), "payroll");
  }
  for (const category of ["utilities", "rent", "taxes", "insurance", "subscriptions", "other", null, undefined, "x"]) {
    assert.equal(isPayrollCategory(category), false, String(category));
    assert.equal(expenseGroup(category), "supplier");
  }
  assert.ok(isDirectPayableCategory("social_security"));
  assert.equal(isDirectPayableCategory("payroll_tax"), false);
});

test("las remuneraciones van a 610200 / 210300 y a pagos a empleados (NIC 7)", () => {
  for (const category of payrollCategories) {
    const classification = classifyDirectPayable(category);
    assert.equal(classification.group, "payroll");
    assert.deepEqual(classification.expenseAccount, { code: "610200", name: "Remuneraciones y cargas sociales" });
    assert.equal(classification.liabilityAccount.code, "210300");
    assert.deepEqual(classification.cashFlow, { classification: "operating", line: EMPLOYEE_CASH_FLOW_LINE });
  }
  assert.equal(classifyDirectPayable("rent").expenseAccount.code, "610300");
  assert.equal(classifyDirectPayable("utilities").expenseAccount.code, "610400");
  assert.equal(classifyDirectPayable("other").expenseAccount.code, "610100");
  assert.equal(classifyDirectPayable("other").liabilityAccount.code, "210100");
  assert.equal(classifyDirectPayable("taxes").cashFlow.line, SUPPLIER_CASH_FLOW_LINE);
});

test("etiquetas de categoría", () => {
  assert.equal(directPayableCategoryLabel("termination", "Finiquito"), "Finiquito");
  assert.equal(directPayableCategoryLabel("payroll", null), "Sueldos y remuneraciones");
  assert.equal(directPayableCategoryLabel("payroll", "Sueldo agosto 2026"), "Sueldos y remuneraciones · Sueldo agosto 2026");
  assert.equal(directPayableCategoryLabel("social_security", "Isapre Mas Vida"), "Leyes sociales / cotizaciones · Isapre Mas Vida");
  assert.equal(directPayableCategoryLabel("other", "Mantención"), "Otro · Mantención");
  assert.equal(directPayableCategoryLabel("other", " "), "Otro");
  assert.equal(directPayableCategoryLabel("rent", null), "Arriendo");
  assert.equal(directPayableCategoryLabel(null, null), "No informado");
});

test("detecta remuneraciones escritas como gasto 'Otro'", () => {
  assert.equal(payrollCategoryHint("Finiquito"), "termination");
  assert.equal(payrollCategoryHint("Pago complementario de finiquito"), "termination");
  assert.equal(payrollCategoryHint("Indemnización por años de servicio"), "termination");
  assert.equal(payrollCategoryHint("Cotizaciones Previsionales"), "social_security");
  assert.equal(payrollCategoryHint("Isapre Mas Vida"), "social_security");
  assert.equal(payrollCategoryHint("Leyes sociales agosto"), "social_security");
  assert.equal(payrollCategoryHint("Previred"), "social_security");
  assert.equal(payrollCategoryHint("Sueldo julio"), "payroll");
  assert.equal(payrollCategoryHint("Remuneraciones"), "payroll");
  assert.equal(payrollCategoryHint("Gratificación"), "payroll");
});

test("no confunde honorarios ni gastos comunes con remuneraciones", () => {
  for (const detail of [
    "Servicios BH 10",
    "Honorarios remuneración profesional",
    "Legal Laboral",
    "Telefonia y Enlace",
    "Comisiones",
    "Rendicion de gastos",
    "Prestamo",
    "Compra Insumos",
    "",
    null,
  ])
    assert.equal(payrollCategoryHint(detail), null, String(detail));
});

test("agrupa remuneraciones por tipo en orden fijo e ignora gasto de proveedores", () => {
  assert.deepEqual(
    payrollBreakdown([
      { category: "termination", total: 18_852 },
      { category: "utilities", total: 99_999 },
      { category: "social_security", total: 281_991 },
      { category: "termination", total: 176_906 },
      { category: "payroll", total: Number.NaN },
    ]),
    [
      { category: "payroll", label: "Sueldos y remuneraciones", records: 1, total: 0 },
      { category: "social_security", label: "Leyes sociales / cotizaciones", records: 1, total: 281_991 },
      { category: "termination", label: "Finiquito", records: 2, total: 195_758 },
    ],
  );
  assert.deepEqual(payrollBreakdown([]), []);
});

test("las categorías coinciden con el check de la migración", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260928192310_payroll_direct_payables.sql", import.meta.url),
    "utf8",
  );
  const categoryCheck = migration.slice(migration.indexOf("add constraint direct_payables_category_check"));
  for (const category of directPayableCategories) assert.ok(categoryCheck.includes(`'${category}'`), category);
  const shapeCheck = migration.slice(migration.indexOf("add constraint direct_payables_payroll_shape_check"));
  assert.ok(shapeCheck.includes(`category not in (${payrollCategories.map((item) => `'${item}'`).join(", ")})`));
});
