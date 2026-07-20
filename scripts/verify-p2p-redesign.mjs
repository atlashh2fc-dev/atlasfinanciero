#!/usr/bin/env node

/**
 * Contrato estructural del flujo P2P.
 *
 * No sustituye un navegador con sesión autenticada: protege la estructura que
 * hace posible el E2E y falla cuando se vuelve a una bandeja monolítica, se
 * pierden acciones o se filtra la nomenclatura técnica "lote" al usuario.
 * Ejecutar: node scripts/verify-p2p-redesign.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const ui = read("src/components/procure-to-pay-workbench.tsx");
const api = read("src/app/api/procure-to-pay/route.ts");
const financialEvents = read(
  "supabase/migrations/20260715212017_unify_financial_events_and_end_to_end_controls.sql",
);
const creditPlans = read(
  "supabase/migrations/20260720152535_add_credit_and_supplier_debt_plans.sql",
);

const failures = [];
function requireContract(condition, message) {
  if (!condition) failures.push(message);
}
function contains(source, value) {
  return source.includes(value);
}

// 1. Navegación: exactamente seis vistas explícitas y paneles condicionados.
const expectedViews = {
  summary: "Resumen",
  requests: "Solicitudes",
  orders: "Órdenes y recepciones",
  payables: "Cuentas por pagar",
  proposals: "Propuestas de pago",
  financing: "Financiamientos",
};
const viewDeclaration = ui.match(/useState<([^>]+)>\("summary"\)/)?.[1] ?? "";
for (const [view, visibleLabel] of Object.entries(expectedViews)) {
  requireContract(
    contains(viewDeclaration, `"${view}"`),
    `Falta la vista P2P \`${view}\` en el estado de navegación.`,
  );
  requireContract(
    contains(ui, `["${view}", "${visibleLabel}"]`),
    `La vista \`${view}\` no tiene control de navegación visible.`,
  );
  requireContract(
    new RegExp(`tab\\s*===\\s*"${view}"`).test(ui),
    `La vista \`${view}\` no tiene render condicional; existe riesgo de scroll monolítico.`,
  );
}
requireContract(
  contains(ui, "setTab(value)"),
  "La navegación declarativa no cambia la vista activa.",
);
requireContract(
  (ui.match(/tab\s*===/g) ?? []).length >= Object.keys(expectedViews).length,
  "Las seis vistas no están aisladas por condición de render.",
);

// 2. Acciones que no se pueden perder al rediseñar la interfaz.
const actionContracts = [
  ["create_purchase_request", "Crear solicitud"],
  ["create_purchase_order_from_request", "Crear OC"],
  ["record_purchase_receipt", "Registrar recepción"],
  ["create_direct_payable", "Crear cuenta por pagar"],
  ["create_asset_financing_plan", "Crear plan de financiamiento"],
  ["create_payment_batch", "Crear propuesta de pago"],
];
for (const [action, label] of actionContracts) {
  requireContract(
    contains(api, `action === "${action}"`),
    `API: falta contrato para ${label} (${action}).`,
  );
  requireContract(
    contains(ui, `action: "${action}"`),
    `UI: ${label} no invoca ${action}.`,
  );
}

// 3. Máquina de estados: propuesta -> orden -> ejecución -> conciliación.
for (const action of [
  "submit_payment_batch",
  "start_payment_batch",
  "mark_payment_batch_paid",
]) {
  requireContract(
    new RegExp(`${action}:\\s*\\{[\\s\\S]*?table:\\s*"payment_batches"`).test(
      api,
    ),
    `Falta transición de pago ${action}.`,
  );
}
requireContract(
  contains(financialEvents, "payment_batches_create_executions"),
  "Un pago confirmado no materializa ejecución financiera.",
);
requireContract(
  contains(financialEvents, "payment_executions") &&
    contains(financialEvents, "source = 'payment_batch'"),
  "La ejecución no conserva origen de propuesta de pago.",
);
requireContract(
  contains(
    financialEvents,
    "bank_reconciliation_matches_materialize_execution",
  ),
  "La conciliación bancaria no confirma la ejecución de pago.",
);
requireContract(
  contains(financialEvents, "status = 'reconciled'"),
  "La conciliación no deja estado reconciled trazable.",
);

// 4. Clasificación financiera explícita: compras operativas, activos inversión,
// créditos/deuda financiamiento. Se valida la taxonomía persistida y el flujo.
requireContract(
  contains(ui, 'planKind === "asset_financing"'),
  "La interfaz no diferencia activo financiado (inversión).",
);
requireContract(
  contains(ui, 'planKind === "credit"'),
  "La interfaz no diferencia crédito/préstamo (financiamiento).",
);
requireContract(
  contains(ui, 'item.plan_kind === "supplier_debt"') ||
    contains(ui, 'value="supplier_debt"'),
  "La interfaz no diferencia deuda de proveedor (operación/financiamiento contractual).",
);
requireContract(
  contains(
    creditPlans,
    "plan_kind in ('asset_financing', 'credit', 'supplier_debt')",
  ),
  "Persistencia: faltan las tres categorías de operación financiera.",
);
requireContract(
  contains(api, "asset_amortization_schedules"),
  "Un activo financiado no genera su calendario de amortización contable.",
);
requireContract(
  contains(api, "direct_payables"),
  "Las cuotas financiadas no quedan conectadas a CxP.",
);

// 5. Nomenclatura. Identificadores internos payment_batch siguen permitidos;
// esto sólo revisa textos que se presentan al usuario (literales JSX/mensajes).
const userFacingLote = [
  /"[^"\n]*\blote(?:s)?\b[^"\n]*"/iu,
  /`[^`\n]*\blote(?:s)?\b[^`\n]*`/iu,
  />[^<\n]*\blote(?:s)?\b[^<\n]*</iu,
];
for (const expression of userFacingLote) {
  requireContract(
    !expression.test(ui),
    `Nomenclatura visible prohibida: se encontró \"lote\" con ${expression}. Usa \"propuesta de pago\", \"orden de pago\" o \"ejecución\".`,
  );
}

if (failures.length) {
  console.error("\nP2P REDESIGN CONTRACT: FAIL\n");
  for (const [index, failure] of failures.entries())
    console.error(`${index + 1}. ${failure}`);
  console.error(
    "\nConsulta docs/quality/p2p-redesign-risks.md antes de aprobar el despliegue.\n",
  );
  process.exitCode = 1;
} else {
  console.log(
    "P2P REDESIGN CONTRACT: PASS — seis vistas, acciones, estados, trazabilidad y nomenclatura verificados.",
  );
}
