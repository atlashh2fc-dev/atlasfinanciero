"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type InvoiceRecord } from "@/data/facturas-emitidas-2026";
import { forecastMonthly2026 } from "@/data/forecast-2026";
import { BillingOperations } from "@/components/billing-operations";
import { AccountsReceivable } from "@/components/accounts-receivable";
import { createClient } from "@/lib/supabase/client";
import { AdministrationConsole } from "@/components/administration-console";
import { PayrollDashboard } from "@/components/payroll-dashboard";
import { CustomerPurchaseOrders } from "@/components/customer-purchase-orders";
import { CustomerProfiles } from "@/components/customer-profiles";
import { CommercialControl } from "@/components/commercial-control";
import { PublicMarketCrm } from "@/components/public-market-crm";
import { ReportsDashboard } from "@/components/reports-dashboard";
import { CostCenterManagement } from "@/components/cost-center-management";
import { CostCenterImputationInbox } from "@/components/cost-center-imputation-inbox";
import { ExpensesDashboard } from "@/components/expenses-dashboard";
import { PreinvoiceWorkbench } from "@/components/preinvoice-workbench";
import { TreasuryDashboard } from "@/components/treasury-dashboard";
import { ApprovalInbox } from "@/components/approval-inbox";
import { ProcureToPayWorkbench } from "@/components/procure-to-pay-workbench";
import { FinancialPlanningDashboard } from "@/components/financial-planning-dashboard";
import { FinancialCloseWorkbench } from "@/components/financial-close-workbench";
import { ActivityAuditLog } from "@/components/activity-audit-log";
import { SupplierConsolidation } from "@/components/supplier-consolidation";
import { AtlasAssistant } from "@/components/atlas-assistant";
import { ManagementCenter } from "@/components/management-center";
import { PlatformSuperAdminDashboard } from "@/components/platform-super-admin-dashboard";
import { AccountingWorkbench } from "@/components/accounting-workbench";
import {
  isCreditNoteDocument,
  isPurchaseOrderDocument,
  recognizedNetAmount,
} from "@/lib/document-revenue";

const calendarMonths = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];
const pieColors = [
  "#18a877",
  "#eeb34d",
  "#5968df",
  "#d85f6c",
  "#8b97aa",
  "#2a8aa6",
  "#9d72d7",
];
const modulePreviews: Record<Module, string> = {
  Inicio:
    "Cockpit ejecutivo: crecimiento, cobranza, concentración y referencias de mercado.",
  "Gestión 360": "Prioridades operativas anuales que abren directamente cobranza, pagos, aprobaciones, tesorería e imputaciones.",
  Contabilidad: "Libro diario, mayor, balance y asientos manuales con cuadratura y bloqueo de períodos.",
  Facturas:
    "Documentos emitidos, estados, pagos, notas de crédito y evolución neta por período.",
  "OC de clientes":
    "Órdenes de compra recibidas de clientes y saldo disponible después de cada facturación parcial.",
  Recurrentes:
    "Calendario y alertas para que las facturas periódicas estén listas antes de su fecha límite.",
  Prefacturación:
    "Borradores desde servicios contratados, revisión financiera y vínculo con la emisión real.",
  "CRM y clientes":
    "Resumen, pipeline, clientes 360, contratos, proyectos y evolución comercial en un workspace integrado.",
  "Mercado Público":
    "Búsqueda oficial de licitaciones ChileCompra y conversión trazable a oportunidades del CRM.",
  "Cuentas por cobrar":
    "Cartera pendiente por vencimiento, gestión, compromisos de pago y factoring.",
  Proyecciones:
    "Modelo ERP existente con forecast mensual, escenarios y diferencias contra la información real.",
  "Planificación financiera":
    "Presupuesto versionado, caja semanal de 13 semanas y rentabilidad por cliente y servicio.",
  "Cuentas por pagar":
    "Facturas recibidas, proveedores, vencimientos y registro individual de pagos.",
  Proveedores:
    "Directorio único de proveedores para compras, gastos, cuentas por pagar y factoring.",
  "Compras, obligaciones y pagos":
    "Solicitudes, órdenes de compra, obligaciones y propuestas de pago con trazabilidad integral.",
  Tesorería:
    "Posición por cuenta, movimientos bancarios y conciliación de cobros y pagos.",
  Remuneraciones: "Costo laboral y dotación sincronizados desde PeopleWork.",
  "Centros de costo":
    "Estructura de imputación, personas y clientes que financian cada unidad o proyecto.",
  "Imputaciones pendientes":
    "Bandeja única para asignar centro de costo a ingresos, gastos, presupuesto y compromisos.",
  Aprobaciones:
    "Bandeja de decisiones para prefacturas, pagos y órdenes de compra con trazabilidad.",
  "Cierre financiero":
    "Checklist, pre-cierre, cierre bloqueado y evidencia auditable por período mensual.",
  Administración: "Organizaciones, usuarios, roles e invitaciones de acceso.",
  "Bitácora de actividad": "Cambios registrados por usuario, entidad, fecha y hora para control administrativo.",
  "Control SaaS": "Portafolio transversal de empresas, usuarios y resultados para Super Admin.",
  Reportes:
    "Estado de resultados, evolución y análisis financiero por período.",
};

type Module =
  | "Inicio"
  | "Gestión 360"
  | "Contabilidad"
  | "Facturas"
  | "OC de clientes"
  | "Proyecciones"
  | "Planificación financiera"
  | "CRM y clientes"
  | "Mercado Público"
  | "Cuentas por cobrar"
  | "Recurrentes"
  | "Prefacturación"
  | "Cuentas por pagar"
  | "Proveedores"
  | "Compras, obligaciones y pagos"
  | "Tesorería"
  | "Remuneraciones"
  | "Centros de costo"
  | "Imputaciones pendientes"
  | "Aprobaciones"
  | "Cierre financiero"
  | "Reportes"
  | "Administración"
  | "Bitácora de actividad"
  | "Control SaaS";
const navigationGroups: Array<{ label: string; items: Module[] }> = [
  { label: "RESUMEN", items: ["Gestión 360", "Inicio"] },
  {
    label: "INGRESOS",
    items: [
      "CRM y clientes",
      "Mercado Público",
      "Prefacturación",
      "Facturas",
      "Recurrentes",
      "Cuentas por cobrar",
      "OC de clientes",
    ],
  },
  {
    label: "COMPRAS Y CAJA",
    items: ["Compras, obligaciones y pagos", "Cuentas por pagar", "Proveedores", "Tesorería"],
  },
  {
    label: "PLANIFICACIÓN Y ANÁLISIS",
    items: ["Contabilidad", "Proyecciones", "Planificación financiera", "Centros de costo", "Imputaciones pendientes", "Reportes"],
  },
  {
    label: "PERSONAS Y CONTROL",
    items: ["Remuneraciones", "Aprobaciones", "Cierre financiero", "Administración", "Bitácora de actividad", "Control SaaS"],
  },
];
type OrganizationRole = "administrator" | "finance" | "operations" | "auditor";
type AccessProfile = {
  user: { email: string | null };
  isSuperAdmin: boolean;
  membership: {
    organizationId: string;
    organizationName: string;
    organizationTaxId: string | null;
    role: OrganizationRole;
  };
  organizations: Array<{ id: string; name: string; role: OrganizationRole }>;
};

type InvoiceDraft = {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  documentType: string;
  issuerName: string;
  issuerTaxId: string;
  clientId: string;
  contactId: string;
  netAmount: string;
  status: string;
  paymentCondition: string;
};

type DocumentCustomer = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type FactoringProvider = { id: string; name: string; taxId: string | null };
type DocumentContact = { id: string; counterparty_id: string; full_name: string; contact_area: string | null; email: string | null; is_primary: boolean };

type DocumentUpdateDraft = {
  documentType: string;
  status: string;
  paymentDate: string;
  paymentMethod: string;
  paymentCondition: string;
  notes: string;
  factoringEntity: string;
  factoringCounterpartyId: string;
  factoredAt: string;
  factoringSettledAt: string;
  factoringRecourseAt: string;
};

type DocumentSortColumn =
  | "invoiceNumber"
  | "issueDate"
  | "client"
  | "documentType"
  | "netAmount"
  | "status"
  | "origin";

type DocumentSort = {
  column: DocumentSortColumn;
  direction: "asc" | "desc";
};

const blankDraft: InvoiceDraft = {
  invoiceNumber: "",
  issueDate: "",
  dueDate: "",
  documentType: "Factura afecta",
  issuerName: "",
  issuerTaxId: "",
  clientId: "",
  contactId: "",
  netAmount: "",
  status: "Pendiente",
  paymentCondition: "post_service",
};

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });

function formatMoney(value: number) {
  return money.format(value);
}

type MarketIndicator = {
  code: string;
  name: string;
  unit: string;
  date: string;
  value: number;
};
type MarketIndicatorsPayload = {
  updatedAt: string | null;
  indicators: MarketIndicator[];
  source: { name: string; url: string };
  references: Array<{ name: string; url: string }>;
};

function formatIndicator(indicator: MarketIndicator) {
  if (indicator.unit === "Pesos") return formatMoney(indicator.value);
  if (indicator.unit === "Porcentaje")
    return `${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(indicator.value)}%`;
  return number.format(indicator.value);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function roleLabel(role: OrganizationRole) {
  return {
    administrator: "Administrador",
    finance: "Finanzas",
    operations: "Operación",
    auditor: "Auditor",
  }[role];
}

function initialsFromEmail(email: string | null) {
  if (!email) return "AT";
  return email.slice(0, 2).toUpperCase();
}

function monthFromDate(value: string) {
  return calendarMonths[new Date(`${value}T00:00:00`).getMonth()] ?? null;
}

function sum(records: InvoiceRecord[], field: "netAmount" | "totalAmount") {
  return records.reduce((total, record) => total + (record[field] ?? 0), 0);
}

function sumRecognizedNet(records: InvoiceRecord[]) {
  return records.reduce(
    (total, record) => total + recognizedNetAmount(record),
    0,
  );
}

function statusClass(status: string | null) {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("pagada")) return "status paid";
  if (normalized.includes("pendiente")) return "status pending";
  if (normalized.includes("anulada") || normalized.includes("credito"))
    return "status cancelled";
  return "status neutral";
}

function compareText(first: string | null | undefined, second: string | null | undefined) {
  if (!first && !second) return 0;
  if (!first) return 1;
  if (!second) return -1;
  return first.localeCompare(second, "es", { numeric: true, sensitivity: "base" });
}

function compareInvoiceNumber(first: InvoiceRecord, second: InvoiceRecord) {
  const byNumber = compareText(first.invoiceNumber, second.invoiceNumber);
  if (byNumber !== 0) return byNumber;
  return compareText(first.issueDate, second.issueDate);
}

function EmptyModule({
  module,
}: {
  module: Exclude<
    Module,
    | "Inicio"
    | "Gestión 360"
    | "Contabilidad"
    | "Facturas"
    | "OC de clientes"
    | "Proyecciones"
    | "Planificación financiera"
    | "CRM y clientes"
    | "Mercado Público"
    | "Cuentas por cobrar"
    | "Recurrentes"
    | "Prefacturación"
    | "Proveedores"
    | "Compras, obligaciones y pagos"
    | "Tesorería"
    | "Remuneraciones"
    | "Centros de costo"
    | "Imputaciones pendientes"
    | "Reportes"
    | "Aprobaciones"
    | "Cierre financiero"
    | "Administración"
    | "Bitácora de actividad"
    | "Control SaaS"
  >;
}) {
  const detail: Record<typeof module, string> = {
    "Cuentas por pagar":
      "Preparado para documentos recibidos, órdenes de compra, centros de costo y proveedores. Requiere fuente de gastos aprobada.",
  };

  return (
    <main className="module-placeholder">
      <span className="eyebrow">Módulo en preparación</span>
      <h1>{module}</h1>
      <p>{detail[module]}</p>
      <div className="placeholder-grid">
        <article>
          <strong>Fuente requerida</strong>
          <span>Importación validada o registro autorizado</span>
        </article>
        <article>
          <strong>Responsable</strong>
          <span>Definido en la matriz de permisos</span>
        </article>
        <article>
          <strong>Salida</strong>
          <span>Tablas, trazabilidad y KPI sin datos inventados</span>
        </article>
      </div>
    </main>
  );
}

function ExecutiveDashboard({ records }: { records: InvoiceRecord[] }) {
  const [marketData, setMarketData] = useState<MarketIndicatorsPayload | null>(
    null,
  );
  const [marketError, setMarketError] = useState(false);
  const [year, setYear] = useState(String(new Date().getFullYear()));

  useEffect(() => {
    let active = true;
    fetch("/api/market-indicators")
      .then((response) =>
        response.ok
          ? (response.json() as Promise<MarketIndicatorsPayload>)
          : Promise.reject(new Error("Indicators unavailable")),
      )
      .then((payload) => {
        if (active) setMarketData(payload);
      })
      .catch(() => {
        if (active) setMarketError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const asOf = new Date();
  const currentDate = asOf.toISOString().slice(0, 10);
  const currentMonthIndex = asOf.getMonth();
  const currentMonthStart = `${currentDate.slice(0, 8)}01`;
  const availableYears = useMemo(
    () =>
      Array.from(
        new Set(
          records
            .map((record) => record.year)
            .filter((value): value is number => typeof value === "number"),
        ),
      ).sort((first, second) => second - first),
    [records],
  );
  const selectedYear = Number(year);
  const recordsForYear = useMemo(
    () => records.filter((record) => record.year === selectedYear),
    [records, selectedYear],
  );
  const isCurrentYear = selectedYear === asOf.getFullYear();
  // El forecast histórico del prototipo no pertenece a los tenants nuevos.
  // Las proyecciones reales se consultan desde Planificación financiera.
  const hasForecastPlan = false;
  const periodRecords = recordsForYear.filter(
    (record) =>
      !isCurrentYear || !record.issueDate || record.issueDate <= currentDate,
  );
  const closedMonthRecords = recordsForYear.filter(
    (record) =>
      !isCurrentYear ||
      !record.issueDate ||
      record.issueDate < currentMonthStart,
  );
  const netDocumented = sumRecognizedNet(periodRecords);
  const netDocumentedYtd = sumRecognizedNet(periodRecords);
  const netDocumentedClosedMonths = sumRecognizedNet(closedMonthRecords);
  const pending = periodRecords.filter(
    (record) =>
      !isPurchaseOrderDocument(record) &&
      !isCreditNoteDocument(record) &&
      record.status?.toLowerCase().includes("pendiente"),
  );
  const pendingAmount = sumRecognizedNet(pending);
  const overdue = pending.filter(
    (record) => Boolean(record.dueDate) && record.dueDate! < currentDate,
  );
  const overdueAmount = sum(overdue, "netAmount");
  const paymentObserved = periodRecords.filter(
    (record) => record.issueDate && record.paymentDate,
  );
  const observedPaymentDays = paymentObserved.map((record) =>
    Math.round(
      (new Date(`${record.paymentDate}T00:00:00`).getTime() -
        new Date(`${record.issueDate}T00:00:00`).getTime()) /
        86400000,
    ),
  );
  const averagePaymentDays = observedPaymentDays.length
    ? observedPaymentDays.reduce((total, days) => total + days, 0) /
      observedPaymentDays.length
    : null;
  const customers = buildCustomerEvolution(periodRecords);
  const topCustomer = customers[0];
  const topFiveShare = netDocumented
    ? customers
        .slice(0, 5)
        .reduce((total, customer) => total + customer.total, 0) / netDocumented
    : 0;
  const budgetClosedMonths = (hasForecastPlan ? forecastMonthly2026 : [])
    .slice(0, isCurrentYear ? currentMonthIndex : 12)
    .reduce((total, item) => total + item.projectedRevenue, 0);
  const annualBudget = (hasForecastPlan ? forecastMonthly2026 : []).reduce(
    (total, item) => total + item.projectedRevenue,
    0,
  );
  const planExecution = budgetClosedMonths
    ? netDocumentedClosedMonths / budgetClosedMonths
    : null;
  const closingBase = hasForecastPlan
    ? netDocumentedYtd +
      forecastMonthly2026
        .slice(isCurrentYear ? currentMonthIndex + 1 : 12)
        .reduce((total, item) => total + item.projectedRevenue, 0)
    : null;
  const plannedResult = (hasForecastPlan ? forecastMonthly2026 : []).reduce(
    (total, item) => total + item.projectedRevenue - item.projectedExpense,
    0,
  );
  const monthlyExecutive = calendarMonths.map((month, index) => ({
    month: month.slice(0, 3),
    documented:
      !isCurrentYear || index < currentMonthIndex
        ? sumRecognizedNet(
            closedMonthRecords.filter((record) => record.month === month),
          )
        : null,
    budget: hasForecastPlan
      ? (forecastMonthly2026[index]?.projectedRevenue ?? 0)
      : null,
  }));
  const clientRanking = customers.slice(0, 6).map((customer) => ({
    client: customer.client,
    montoNeto: customer.total,
  }));
  const visibleIndicators = ["uf", "utm", "dolar", "euro", "ipc", "tpm"]
    .map((code) => marketData?.indicators.find((item) => item.code === code))
    .filter((item): item is MarketIndicator => Boolean(item));

  return (
    <main className="dashboard executive-dashboard">
      <section className="headline">
        <div>
          <span className="eyebrow">COCKPIT EJECUTIVO · {year}</span>
          <h1>Panorama para decisión</h1>
          <p>
            Lectura de crecimiento, cobranza, concentración y cierre base. Cada
            métrica se deriva de documentos y proyecciones disponibles.
          </p>
        </div>
        <div className="headline-actions">
          <label className="period-picker">
            Año
            <select
              value={year}
              onChange={(event) => setYear(event.target.value)}
            >
              {availableYears.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <span className="refresh">
            ●{" "}
            {isCurrentYear
              ? `Corte ${formatDate(currentDate)}`
              : "Período completo"}
          </span>
        </div>
      </section>

      <section className="kpis kpis-five" aria-label="Indicadores ejecutivos">
        <article
          className="kpi-card"
          data-help="Suma neta documentada hasta la fecha de corte: facturas y exentos menos notas de crédito; no considera órdenes de compra."
        >
          <span>Facturado neto acumulado</span>
          <strong>{formatMoney(netDocumentedYtd)}</strong>
          <small>
            Facturas y exentos, menos notas de crédito. OCs excluidas.
          </small>
        </article>
        <article
          className="kpi-card"
          data-help="Facturación neta de meses cerrados dividida por el presupuesto de esos mismos meses. Mide avance, no caja."
        >
          <span>Ejecución del plan cerrado</span>
          <strong>
            {planExecution === null
              ? "—"
              : new Intl.NumberFormat("es-CL", {
                  style: "percent",
                  maximumFractionDigits: 1,
                }).format(planExecution)}
          </strong>
          <small>
            {formatMoney(netDocumentedClosedMonths - budgetClosedMonths)} frente
            a meses ya cerrados
          </small>
        </article>
        <article
          className="kpi-card"
          data-help="Facturación neta observada a la fecha más el presupuesto de los meses futuros. Es un escenario base, no una predicción de caja."
        >
          <span>Cierre anual base</span>
          <strong>
            {closingBase === null ? "—" : formatMoney(closingBase)}
          </strong>
          <small>
            {hasForecastPlan && closingBase !== null
              ? `${formatMoney(closingBase - annualBudget)} contra el plan anual`
              : "Sin presupuesto cargado para este año"}
          </small>
        </article>
        <article
          className="kpi-card accent"
          data-help="Documentos pendientes cuya fecha de vencimiento ya pasó. Se calcula en neto/exento y requiere gestión de cobranza."
        >
          <span>Cartera vencida</span>
          <strong>{formatMoney(overdueAmount)}</strong>
          <small>
            {pendingAmount
              ? new Intl.NumberFormat("es-CL", {
                  style: "percent",
                  maximumFractionDigits: 1,
                }).format(overdueAmount / pendingAmount)
              : "0%"}{" "}
            de la cartera pendiente
          </small>
        </article>
        <article
          className="kpi-card"
          data-help="Proporción del facturado neto que concentran los cinco clientes de mayor monto. Indica dependencia comercial."
        >
          <span>Concentración Top 5</span>
          <strong>
            {new Intl.NumberFormat("es-CL", {
              style: "percent",
              maximumFractionDigits: 1,
            }).format(topFiveShare)}
          </strong>
          <small>
            {topCustomer
              ? `Mayor cliente: ${topCustomer.client}`
              : "Sin cliente informado"}
          </small>
        </article>
      </section>

      <section
        className="analysis-strip executive-insights"
        aria-label="Lecturas prioritarias de gerencia"
      >
        <article>
          <span>CRECIMIENTO</span>
          <strong>
            {!hasForecastPlan
              ? "Sin plan cargado"
              : planExecution !== null && planExecution >= 1
                ? "Sobre el plan cerrado"
                : "Bajo el plan cerrado"}
          </strong>
          <p>
            {hasForecastPlan
              ? `${formatMoney(netDocumentedClosedMonths)} documentados frente a ${formatMoney(budgetClosedMonths)} en meses cerrados.`
              : "Carga presupuesto anual para comparar la ejecución del período."}
          </p>
        </article>
        <article>
          <span>COBRANZA</span>
          <strong>
            {overdue.length
              ? `${overdue.length} documento(s) vencido(s)`
              : "Sin vencimientos pendientes"}
          </strong>
          <p>
            {overdue.length
              ? `${formatMoney(overdueAmount)} requiere gestión prioritaria.`
              : "La cartera pendiente no registra vencimientos superados."}
          </p>
        </article>
        <article>
          <span>CLIENTES</span>
          <strong>{topCustomer?.client ?? "Sin cliente informado"}</strong>
          <p>
            El Top 5 representa{" "}
            {new Intl.NumberFormat("es-CL", {
              style: "percent",
              maximumFractionDigits: 1,
            }).format(topFiveShare)}{" "}
            del monto documentado.
          </p>
        </article>
        <article>
          <span>LIQUIDEZ</span>
          <strong>
            {averagePaymentDays === null
              ? "Sin ciclo observado"
              : `${number.format(averagePaymentDays)} días de cobro observado`}
          </strong>
          <p>
            Basado sólo en documentos que registran emisión y fecha de pago;
            saldo bancario y gastos reales aún no están integrados.
          </p>
        </article>
      </section>

      <section className="executive-grid">
        <article className="panel executive-chart">
          <div className="panel-heading">
            <div>
              <span className="panel-label">EJECUCIÓN VS. PLAN</span>
              <h2>Meses cerrados y presupuesto</h2>
            </div>
            <span className="unit">CLP neto</span>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={monthlyExecutive}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <XAxis
                  dataKey="month"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#7e8ba0", fontSize: 12 }}
                />
                <YAxis hide />
                <Tooltip
                  formatter={(value) => formatMoney(Number(value))}
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid #e6e9ef",
                  }}
                />
                <Bar
                  dataKey="documented"
                  name="Documentado en mes cerrado"
                  fill="#5867db"
                  radius={[5, 5, 0, 0]}
                />
                <Bar
                  dataKey="budget"
                  name="Presupuesto"
                  fill="#9eabc7"
                  radius={[5, 5, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>
        <article className="panel executive-chart">
          <div className="panel-heading">
            <div>
              <span className="panel-label">CONCENTRACIÓN</span>
              <h2>Clientes por monto documentado</h2>
            </div>
            <span className="unit">Top 6</span>
          </div>
          <div className="ranking-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={clientRanking}
                layout="vertical"
                margin={{ left: 0, right: 24 }}
              >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="client"
                  width={150}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#58657a", fontSize: 11 }}
                />
                <Tooltip
                  formatter={(value) => formatMoney(Number(value))}
                  cursor={{ fill: "#f6f7fb" }}
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid #e6e9ef",
                  }}
                />
                <Bar dataKey="montoNeto" radius={[0, 6, 6, 0]} fill="#20a67a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>
      </section>

      <section className="panel executive-decision-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-label">LECTURA DE CIERRE</span>
            <h2>Escenario base del año</h2>
            <p>
              Facturación documentada a la fecha más presupuesto de los meses
              posteriores. No es una probabilidad ni una estimación de caja.
            </p>
          </div>
          <span className="unit">CLP neto</span>
        </div>
        <div className="decision-grid">
          <article>
            <span>Base de cierre</span>
            <strong>
              {closingBase === null ? "—" : formatMoney(closingBase)}
            </strong>
            <small>
              {hasForecastPlan
                ? "No incorpora saldo no documentado del mes en curso"
                : "Sin presupuesto anual cargado"}
            </small>
          </article>
          <article>
            <span>Resultado planificado</span>
            <strong>
              {hasForecastPlan ? formatMoney(plannedResult) : "—"}
            </strong>
            <small>
              {hasForecastPlan
                ? "Ingresos proyectados menos gastos proyectados"
                : "Sin plan de ingresos y gastos para este año"}
            </small>
          </article>
          <article>
            <span>Dato pendiente</span>
            <strong>Banco y gastos reales</strong>
            <small>
              Requeridos para cobertura de caja, margen real y runway.
            </small>
          </article>
        </div>
      </section>

      <section className="market-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-label">REFERENCIAS DE MERCADO</span>
            <h2>Indicadores públicos</h2>
            <p>
              Se actualizan desde una fuente pública; cada tarjeta muestra su
              propia fecha de referencia.
            </p>
          </div>
          {marketData && (
            <a
              className="market-source"
              href={marketData.source.url}
              target="_blank"
              rel="noreferrer"
            >
              Ver fuente ↗
            </a>
          )}
        </div>
        {marketError ? (
          <p className="market-unavailable">
            Indicadores temporalmente no disponibles.
          </p>
        ) : (
          <div className="market-cards">
            {visibleIndicators.length
              ? visibleIndicators.map((indicator) => (
                  <article key={indicator.code}>
                    <span>{indicator.code.toUpperCase()}</span>
                    <strong>{formatIndicator(indicator)}</strong>
                    <small>{formatDate(indicator.date.slice(0, 10))}</small>
                  </article>
                ))
              : Array.from({ length: 6 }, (_, index) => (
                  <article className="market-loading" key={index}>
                    <span>Actualizando</span>
                    <strong>—</strong>
                    <small>Fuente pública</small>
                  </article>
                ))}
          </div>
        )}
        {marketData && (
          <p className="market-references">
            Referencias oficiales:{" "}
            {marketData.references.map((reference, index) => (
              <span key={reference.url}>
                {index ? " · " : ""}
                <a href={reference.url} target="_blank" rel="noreferrer">
                  {reference.name}
                </a>
              </span>
            ))}
          </p>
        )}
      </section>
    </main>
  );
}

type CustomerEvolution = {
  client: string;
  total: number;
  documents: number;
  withPaymentDate: number;
  pendingNet: number;
  byMonth: Record<string, number>;
};

type CustomerWorkspaceView =
  | "summary"
  | "pipeline"
  | "customers"
  | "contracts"
  | "evolution";

const customerWorkspaceViews: Array<{
  key: CustomerWorkspaceView;
  label: string;
  eyebrow: string;
  title: string;
  description: string;
}> = [
  {
    key: "summary",
    label: "Resumen",
    eyebrow: "CRM · VISIÓN EJECUTIVA",
    title: "Clientes y evolución",
    description:
      "Una vista ejecutiva de clientes, facturación y seguimiento comercial.",
  },
  {
    key: "pipeline",
    label: "Pipeline",
    eyebrow: "CRM · OPORTUNIDADES",
    title: "Pipeline comercial",
    description:
      "Avanza oportunidades por etapa y mantén visible la próxima acción.",
  },
  {
    key: "customers",
    label: "Clientes 360",
    eyebrow: "CRM · CLIENTES",
    title: "Clientes 360",
    description:
      "Directorio, contactos, documentos, alertas e historia financiera por cliente.",
  },
  {
    key: "contracts",
    label: "Contratos y proyectos",
    eyebrow: "CRM · EJECUCIÓN COMERCIAL",
    title: "Contratos y proyectos",
    description:
      "Conecta ventas ganadas con contratos, centros de costo, proyectos y renovación.",
  },
  {
    key: "evolution",
    label: "Evolución",
    eyebrow: "CRM · ANÁLISIS COMERCIAL",
    title: "Evolución de clientes",
    description:
      "Compara facturación, concentración y seguimiento por cliente y período.",
  },
];

function buildCustomerEvolution(records: InvoiceRecord[]) {
  const result = records.reduce<Record<string, CustomerEvolution>>(
    (accumulator, record) => {
      if (isPurchaseOrderDocument(record)) return accumulator;
      const client = record.client || record.recipient || "No informado";
      accumulator[client] ??= {
        client,
        total: 0,
        documents: 0,
        withPaymentDate: 0,
        pendingNet: 0,
        byMonth: {},
      };
      const current = accumulator[client];
      const amount = recognizedNetAmount(record);
      current.total += amount;
      current.documents += 1;
      if (record.paymentDate) current.withPaymentDate += 1;
      if (record.status === "Pendiente") current.pendingNet += amount;
      if (record.month)
        current.byMonth[record.month] =
          (current.byMonth[record.month] ?? 0) + amount;
      return accumulator;
    },
    {},
  );
  return Object.values(result).sort(
    (first, second) => second.total - first.total,
  );
}

function CustomerModule({
  records,
  organizationId,
  canManage,
}: {
  records: InvoiceRecord[];
  organizationId: string | null;
  canManage: boolean;
}) {
  const [workspaceView, setWorkspaceView] =
    useState<CustomerWorkspaceView>("summary");
  const [isEvolutionExpanded, setIsEvolutionExpanded] = useState(false);
  const [evolutionSearch, setEvolutionSearch] = useState("");
  const [customerYear, setCustomerYear] = useState(
    String(new Date().getFullYear()),
  );
  const [selectedPendingClient, setSelectedPendingClient] =
    useState<CustomerEvolution | null>(null);
  const availableYears = useMemo(
    () =>
      Array.from(
        new Set(
          records
            .map((record) => record.year)
            .filter((value): value is number => typeof value === "number"),
        ),
      ).sort((first, second) => second - first),
    [records],
  );
  useEffect(() => {
    if (
      availableYears.length > 0 &&
      !availableYears.includes(Number(customerYear))
    ) {
      setCustomerYear(String(availableYears[0]));
    }
  }, [availableYears, customerYear]);
  const customerRecords = useMemo(
    () =>
      customerYear === "Todos"
        ? records
        : records.filter((record) => record.year === Number(customerYear)),
    [records, customerYear],
  );
  const customers = buildCustomerEvolution(customerRecords);
  const totalNet = sumRecognizedNet(customerRecords);
  const evolutionRecords = useMemo(() => {
    const needle = evolutionSearch.trim().toLocaleLowerCase("es-CL");
    if (!needle) return customerRecords;
    return customerRecords.filter((record) => (record.client || record.recipient || "No informado").toLocaleLowerCase("es-CL").includes(needle));
  }, [customerRecords, evolutionSearch]);
  const evolutionCustomers = buildCustomerEvolution(evolutionRecords);
  const evolutionTotalNet = sumRecognizedNet(evolutionRecords);
  const evolutionPendingNet = evolutionCustomers.reduce((total, client) => total + client.pendingNet, 0);
  const evolutionPaymentDateCount = evolutionCustomers.reduce((total, client) => total + client.withPaymentDate, 0);
  const topClient = customers[0];
  const pendingNet = customers.reduce(
    (total, client) => total + client.pendingNet,
    0,
  );
  const paymentDateCount = customers.reduce(
    (total, client) => total + client.withPaymentDate,
    0,
  );
  const pendingClientDocuments = useMemo(
    () =>
      selectedPendingClient
        ? customerRecords.filter(
            (record) =>
              !isPurchaseOrderDocument(record) &&
              (record.client || record.recipient || "No informado") ===
                selectedPendingClient.client &&
              record.status === "Pendiente",
          )
        : [],
    [customerRecords, selectedPendingClient],
  );
  const pendingWithoutDueDate = pendingClientDocuments.filter(
    (record) => !record.dueDate,
  );
  const overduePending = pendingClientDocuments.filter(
    (record) =>
      record.dueDate && record.dueDate < new Date().toISOString().slice(0, 10),
  );
  const pendingWithoutCondition = pendingClientDocuments.filter(
    (record) => !record.paymentCondition,
  );
  const activeWorkspaceView =
    customerWorkspaceViews.find((item) => item.key === workspaceView) ??
    customerWorkspaceViews[0];
  const showYearFilter =
    workspaceView === "summary" || workspaceView === "evolution";

  return (
    <main className="dashboard customer-dashboard">
      <section className="headline">
        <div>
          <span className="eyebrow">{activeWorkspaceView.eyebrow}</span>
          <h1>{activeWorkspaceView.title}</h1>
          <p>{activeWorkspaceView.description}</p>
        </div>
        <div className="headline-actions">
          {showYearFilter && (
            <label className="period-picker">
              Año
              <select
                value={customerYear}
                onChange={(event) => {
                  setCustomerYear(event.target.value);
                  setSelectedPendingClient(null);
                }}
              >
                {availableYears.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          )}
          {showYearFilter && (
            <span className="refresh">
              ● {number.format(customerRecords.length)} documentos trazables
            </span>
          )}
        </div>
      </section>

      <section
        className="panel customer-workspace-navigation"
        aria-label="Navegación de CRM y clientes"
      >
        <div className="table-actions" role="tablist" aria-label="CRM y clientes">
          {customerWorkspaceViews.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={workspaceView === item.key}
              className={
                workspaceView === item.key
                  ? "primary-button"
                  : "secondary-button"
              }
              key={item.key}
              onClick={() => {
                setWorkspaceView(item.key);
                setSelectedPendingClient(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>

      {workspaceView === "summary" && (
        <section className="customer-workspace-content" role="tabpanel">
      <section className="kpis" aria-label="Indicadores de clientes">
        <article className="kpi-card">
          <span>Clientes con documentos</span>
          <strong>{number.format(customers.length)}</strong>
          <small>Clientes o destinatarios informados</small>
        </article>
        <article className="kpi-card">
          <span>Mayor cliente documentado</span>
          <strong className="kpi-name">{topClient?.client ?? "—"}</strong>
          <small>
            {topClient ? formatMoney(topClient.total) : "Sin datos"}
          </small>
        </article>
        <article className="kpi-card accent">
          <span>Monto con estado “Pendiente”</span>
          <strong>{formatMoney(pendingNet)}</strong>
          <small>Valor literal del estado en la fuente</small>
        </article>
        <article className="kpi-card">
          <span>Con fecha de pago registrada</span>
          <strong>{number.format(paymentDateCount)}</strong>
          <small>
            De {number.format(customerRecords.length)} documentos · no equivale
            a caja conciliada
          </small>
        </article>
      </section>

          <section className="customer-workspace-overview-grid">
            <article className="table-section customer-workspace-focus">
              <div className="table-heading">
                <div>
                  <span className="panel-label">CONCENTRACIÓN COMERCIAL</span>
                  <h2>Principales clientes</h2>
                  <p>Participación sobre el ingreso documentado del año seleccionado.</p>
                </div>
              </div>
              <div className="customer-workspace-ranking">
                {customers.slice(0, 5).map((customer, index) => (
                  <div key={customer.client}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{customer.client}</strong><small>{customer.documents} documento(s)</small></div>
                    <b>{formatMoney(customer.total)}<small>{totalNet ? `${number.format(customer.total / totalNet * 100)}%` : "0%"}</small></b>
                  </div>
                ))}
                {!customers.length && <p className="billing-empty">Sin ingresos documentados para este período.</p>}
              </div>
            </article>
            <article className="table-section customer-workspace-focus">
              <div className="table-heading">
                <div>
                  <span className="panel-label">ACCIÓN COMERCIAL Y COBRANZA</span>
                  <h2>Clientes por gestionar</h2>
                  <p>Mayores saldos con estado pendiente en la fuente.</p>
                </div>
              </div>
              <div className="customer-workspace-ranking is-pending">
                {customers.filter((customer) => customer.pendingNet > 0).sort((left, right) => right.pendingNet - left.pendingNet).slice(0, 5).map((customer) => (
                  <button type="button" key={customer.client} onClick={() => setSelectedPendingClient(customer)}>
                    <div><strong>{customer.client}</strong><small>Revisar documentos y vencimientos</small></div>
                    <b>{formatMoney(customer.pendingNet)}<small>Ver detalle →</small></b>
                  </button>
                ))}
                {!customers.some((customer) => customer.pendingNet > 0) && <p className="billing-empty">Sin clientes pendientes para este período.</p>}
              </div>
            </article>
          </section>

          <section className="panel customer-workspace-summary">
            <div className="panel-heading">
              <div>
                <span className="panel-label">LECTURA EJECUTIVA</span>
                <h2>Del cliente a la ejecución</h2>
                <p>
                  Usa las vistas superiores para gestionar oportunidades,
                  clientes, contratos y evolución sin recorrer una página
                  interminable.
                </p>
              </div>
            </div>
            <div className="table-actions">
              {customerWorkspaceViews.slice(1).map((item) => (
                <button
                  type="button"
                  className="secondary-button"
                  key={item.key}
                  onClick={() => setWorkspaceView(item.key)}
                >
                  Abrir {item.label}
                </button>
              ))}
            </div>
          </section>
        </section>
      )}

      {workspaceView === "pipeline" && (
        <section className="customer-workspace-content" role="tabpanel">
          <CommercialControl
            organizationId={organizationId}
            canManage={canManage}
            initialView="pipeline"
            allowedViews={["pipeline"]}
          />
        </section>
      )}

      {workspaceView === "customers" && (
        <section className="customer-workspace-content" role="tabpanel">
          <CustomerProfiles
            organizationId={organizationId}
            canManage={canManage}
          />
        </section>
      )}

      {workspaceView === "contracts" && (
        <section className="customer-workspace-content" role="tabpanel">
          <CommercialControl
            organizationId={organizationId}
            canManage={canManage}
            initialView="contracts"
            allowedViews={["contracts", "projects"]}
          />
        </section>
      )}

      {workspaceView === "evolution" && (
        <section className="customer-workspace-content" role="tabpanel">
      <section className="table-section evolution-matrix-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">CLIENTES</span>
            <h2>
              {isEvolutionExpanded
                ? "Evolución mensual por cliente"
                : "Resumen de clientes"}
            </h2>
            <p>
              {isEvolutionExpanded
                ? "Meses en columnas para revisar trayectoria y estacionalidad."
                : "Despliega los meses sólo cuando necesites revisar el evolutivo."}
            </p>
          </div>
          <div className="table-actions">
            <label className="customer-evolution-search">Buscar cliente<input type="search" value={evolutionSearch} onChange={(event) => setEvolutionSearch(event.target.value)} placeholder="Nombre del cliente" /></label>
            <span className="unit">CLP neto</span>
            <button
              type="button"
              className="secondary-button matrix-toggle"
              aria-expanded={isEvolutionExpanded}
              onClick={() => setIsEvolutionExpanded((current) => !current)}
            >
              {isEvolutionExpanded ? "Ocultar meses" : "Ver evolución mensual"}
            </button>
          </div>
        </div>
        {isEvolutionExpanded ? (
          <div className="table-scroll">
            <table className="evolution-matrix customer-matrix">
              <thead>
                <tr>
                  <th>Cliente</th>
                  {calendarMonths.map((month) => (
                    <th className="money-col" key={month}>
                      {month.slice(0, 3)}
                    </th>
                  ))}
                  <th className="money-col total-column">Total</th>
                  <th className="money-col">Docs.</th>
                  <th>Seguimiento</th>
                </tr>
              </thead>
              <tbody>
                {evolutionCustomers.map((customer) => (
                  <tr key={customer.client}>
                    <td>
                      <strong>{customer.client}</strong>
                      <small>
                        {customer.pendingNet
                          ? `Pendiente: ${formatMoney(customer.pendingNet)}`
                          : "Sin pendiente exacto"}
                      </small>
                    </td>
                    {calendarMonths.map((month) => (
                      <td className="money-col matrix-value" key={month}>
                        {customer.byMonth[month]
                          ? formatMoney(customer.byMonth[month])
                          : "—"}
                      </td>
                    ))}
                    <td className="money-col total-column">
                      <strong>{formatMoney(customer.total)}</strong>
                    </td>
                    <td className="money-col">
                      {number.format(customer.documents)}
                    </td>
                    <td>
                      {customer.pendingNet ? (
                        <button
                          type="button"
                          className="status pending review-pending-button"
                          onClick={() => setSelectedPendingClient(customer)}
                        >
                          Revisar pendiente
                        </button>
                      ) : (
                        <span className="status paid">
                          Sin pendiente exacto
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    <strong>Total neto/exento</strong>
                  </td>
                  {calendarMonths.map((month) => (
                    <td className="money-col" key={month}>
                      {formatMoney(
                        sumRecognizedNet(
                          evolutionRecords.filter(
                            (record) => record.month === month,
                          ),
                        ),
                      )}
                    </td>
                  ))}
                  <td className="money-col total-column">
                    <strong>{formatMoney(evolutionTotalNet)}</strong>
                  </td>
                  <td className="money-col">
                    <strong>{number.format(evolutionRecords.length)}</strong>
                  </td>
                  <td>{customerYear === "Todos" ? "Todos" : customerYear}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="customer-summary">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th className="money-col">Monto neto/exento</th>
                  <th className="money-col">Documentos</th>
                  <th className="money-col">Pendiente exacto</th>
                  <th className="money-col">Fecha de pago registrada</th>
                  <th>Seguimiento</th>
                </tr>
              </thead>
              <tbody>
                {evolutionCustomers.map((customer) => (
                  <tr key={customer.client}>
                    <td>
                      <strong>{customer.client}</strong>
                    </td>
                    <td className="money-col">
                      <strong>{formatMoney(customer.total)}</strong>
                    </td>
                    <td className="money-col">
                      {number.format(customer.documents)}
                    </td>
                    <td className="money-col">
                      {customer.pendingNet
                        ? formatMoney(customer.pendingNet)
                        : "—"}
                    </td>
                    <td className="money-col">
                      {number.format(customer.withPaymentDate)}
                    </td>
                    <td>
                      {customer.pendingNet ? (
                        <button
                          type="button"
                          className="status pending review-pending-button"
                          onClick={() => setSelectedPendingClient(customer)}
                        >
                          Revisar pendiente
                        </button>
                      ) : (
                        <span className="status paid">
                          Sin pendiente exacto
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    <strong>Total neto/exento</strong>
                  </td>
                  <td className="money-col">
                    <strong>{formatMoney(evolutionTotalNet)}</strong>
                  </td>
                  <td className="money-col">
                    <strong>{number.format(evolutionRecords.length)}</strong>
                  </td>
                  <td className="money-col">{formatMoney(evolutionPendingNet)}</td>
                  <td className="money-col">
                    {number.format(evolutionPaymentDateCount)}
                  </td>
                  <td>{customerYear === "Todos" ? "Todos" : customerYear}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
        </section>
      )}

      {selectedPendingClient && (
        <div
          className="modal-backdrop customer-review-backdrop"
          role="presentation"
        >
          <section
            className="entry-modal customer-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pending-review-title"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">
                  REVISIÓN DE COBRANZA ·{" "}
                  {customerYear === "Todos" ? "TODOS LOS AÑOS" : customerYear}
                </span>
                <h2 id="pending-review-title">
                  {selectedPendingClient.client}
                </h2>
                <p>
                  {formatMoney(selectedPendingClient.pendingNet)} pendiente en{" "}
                  {pendingClientDocuments.length} documento(s).
                </p>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setSelectedPendingClient(null)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <section className="customer-review-summary">
              <article>
                <span>Vencido</span>
                <strong>{overduePending.length}</strong>
                <small>Contactar y dejar gestión responsable.</small>
              </article>
              <article>
                <span>Sin vencimiento</span>
                <strong>{pendingWithoutDueDate.length}</strong>
                <small>Registrar fecha para programar caja.</small>
              </article>
              <article>
                <span>Sin condición</span>
                <strong>{pendingWithoutCondition.length}</strong>
                <small>Definir anticipado o post servicio.</small>
              </article>
            </section>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Documento</th>
                    <th>Condición</th>
                    <th>Vencimiento</th>
                    <th className="money-col">Pendiente neto</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingClientDocuments.map((record) => (
                    <tr key={record.id}>
                      <td>
                        <strong>N° {record.invoiceNumber ?? "—"}</strong>
                        <small>{record.documentType ?? "Documento"}</small>
                      </td>
                      <td>
                        {record.paymentCondition === "advance"
                          ? "Anticipado"
                          : record.paymentCondition === "post_service"
                            ? "Vencido / post servicio"
                            : "Sin definir"}
                      </td>
                      <td>
                        {record.dueDate
                          ? formatDate(record.dueDate)
                          : "Registrar"}
                      </td>
                      <td className="money-col">
                        {formatMoney(recognizedNetAmount(record))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setSelectedPendingClient(null)}
              >
                Cerrar revisión
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function ForecastModule() {
  const rows = forecastMonthly2026.map((item) => ({
    ...item,
    month:
      calendarMonths[new Date(`${item.period}T00:00:00`).getMonth()] ??
      item.period,
    projectedMargin: item.projectedRevenue - item.projectedExpense,
  }));
  const totals = rows.reduce(
    (total, item) => ({
      projectedRevenue: total.projectedRevenue + item.projectedRevenue,
      actualRevenue: total.actualRevenue + item.actualRevenue,
      projectedExpense: total.projectedExpense + item.projectedExpense,
      projectedMargin: total.projectedMargin + item.projectedMargin,
    }),
    {
      projectedRevenue: 0,
      actualRevenue: 0,
      projectedExpense: 0,
      projectedMargin: 0,
    },
  );
  const negativeMonths = rows.filter((item) => item.projectedMargin < 0);
  const largestExpenseMonth = rows.reduce(
    (current, item) =>
      item.projectedExpense > current.projectedExpense ? item : current,
    rows[0],
  );
  const largestRevenueMonth = rows.reduce(
    (current, item) =>
      item.projectedRevenue > current.projectedRevenue ? item : current,
    rows[0],
  );
  const matrixRows = [
    {
      label: "Ingresos proyectados",
      values: rows.map((row) => row.projectedRevenue),
      total: totals.projectedRevenue,
      tone: "income",
    },
    {
      label: "Gastos proyectados",
      values: rows.map((row) => row.projectedExpense),
      total: totals.projectedExpense,
      tone: "expense",
    },
    {
      label: "Resultado simple proyectado",
      values: rows.map((row) => row.projectedMargin),
      total: totals.projectedMargin,
      tone: "result",
    },
    {
      label: "Bloque “Real 2026”",
      values: rows.map((row) => row.actualRevenue),
      total: totals.actualRevenue,
      tone: "actual",
    },
    {
      label: "Desviación bloque Real vs. proyección",
      values: rows.map((row) => row.actualRevenue - row.projectedRevenue),
      total: totals.actualRevenue - totals.projectedRevenue,
      tone: "variance",
    },
  ];

  return (
    <main className="dashboard forecast-dashboard">
      <section className="headline">
        <div>
          <span className="eyebrow">PRESUPUESTO Y FORECAST · 2026</span>
          <h1>Proyecciones</h1>
        </div>
      </section>

      <section className="kpis" aria-label="Indicadores de proyección">
        <article className="kpi-card">
          <span>Ingresos proyectados</span>
          <strong>{formatMoney(totals.projectedRevenue)}</strong>
          <small>Presupuesto 2026 · monto neto</small>
        </article>
        <article className="kpi-card">
          <span>Gastos proyectados</span>
          <strong>{formatMoney(totals.projectedExpense)}</strong>
          <small>Gastos Proyectados 2026</small>
        </article>
        <article className="kpi-card accent">
          <span>Diferencia simple proyectada</span>
          <strong>{formatMoney(totals.projectedMargin)}</strong>
          <small>Ingresos proyectados menos gastos proyectados</small>
        </article>
        <article className="kpi-card">
          <span>Bloque “Real 2026”</span>
          <strong>{formatMoney(totals.actualRevenue)}</strong>
          <small>Tal como está registrado en el libro</small>
        </article>
      </section>

      <section className="analysis-strip" aria-label="Lecturas del forecast">
        <article>
          <span>ALERTA DE PLAN</span>
          <strong>
            {negativeMonths.length
              ? `${negativeMonths.length} mes con resultado negativo`
              : "Sin meses negativos"}
          </strong>
          <p>
            {negativeMonths.length
              ? `${negativeMonths.map((item) => item.month).join(", ")}: ${formatMoney(negativeMonths[0].projectedMargin)}.`
              : "Ingresos proyectados superan gastos proyectados en todos los meses."}
          </p>
        </article>
        <article>
          <span>PICO DE INGRESOS</span>
          <strong>{largestRevenueMonth.month}</strong>
          <p>
            {formatMoney(largestRevenueMonth.projectedRevenue)} de ingresos
            proyectados en la hoja fuente.
          </p>
        </article>
        <article>
          <span>PICO DE GASTOS</span>
          <strong>{largestExpenseMonth.month}</strong>
          <p>
            {formatMoney(largestExpenseMonth.projectedExpense)} de gastos
            proyectados en la hoja fuente.
          </p>
        </article>
        <article>
          <span>CONCENTRACIÓN</span>
          <strong>GRUPO LS SPA</strong>
          <p>
            25,5% del ingreso proyectado anual fuente. No es una probabilidad ni
            ajuste.
          </p>
        </article>
      </section>

      <section className="panel forecast-chart-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-label">COMPARATIVO MENSUAL</span>
            <h2>Forecast de ingresos y gastos</h2>
          </div>
          <span className="unit">CLP neto</span>
        </div>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={rows}
              margin={{ top: 8, right: 10, left: 0, bottom: 0 }}
            >
              <XAxis
                dataKey="month"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "#7e8ba0", fontSize: 12 }}
              />
              <YAxis hide />
              <Tooltip
                formatter={(value) => formatMoney(Number(value))}
                contentStyle={{ borderRadius: 12, border: "1px solid #e6e9ef" }}
              />
              <Line
                type="monotone"
                dataKey="projectedRevenue"
                name="Ingresos proyectados"
                stroke="#5968df"
                strokeWidth={2.5}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="projectedExpense"
                name="Gastos proyectados"
                stroke="#d85f6c"
                strokeWidth={2.5}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="actualRevenue"
                name="Bloque Real 2026"
                stroke="#20a67a"
                strokeWidth={2.5}
                strokeDasharray="5 4"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="table-section evolution-matrix-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">EVOLUCIÓN MENSUAL</span>
            <h2>Resultados y desviaciones</h2>
            <p>
              Meses en columnas. “Bloque Real 2026” es el nombre de la fuente;
              no se declara caja conciliada ni resultado contable cerrado.
            </p>
          </div>
          <span className="unit">CLP neto</span>
        </div>
        <div className="table-scroll">
          <table className="evolution-matrix">
            <thead>
              <tr>
                <th>Línea de análisis</th>
                {rows.map((row) => (
                  <th className="money-col" key={row.period}>
                    {row.month.slice(0, 3)}
                  </th>
                ))}
                <th className="money-col total-column">Total 2026</th>
              </tr>
            </thead>
            <tbody>
              {matrixRows.map((line) => (
                <tr key={line.label} className={`matrix-row ${line.tone}`}>
                  <td>
                    <strong>{line.label}</strong>
                  </td>
                  {line.values.map((value, index) => (
                    <td
                      className={`money-col matrix-value ${value < 0 ? "is-negative" : ""}`}
                      key={`${line.label}-${rows[index].period}`}
                    >
                      {formatMoney(value)}
                    </td>
                  ))}
                  <td
                    className={`money-col total-column ${line.total < 0 ? "is-negative" : ""}`}
                  >
                    <strong>{formatMoney(line.total)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

type StoredDocument = {
  id: string;
  document_number: string | null;
  issue_date: string | null;
  document_type: string | null;
  issuer_name: string | null;
  issuer_tax_id: string | null;
  client_name: string | null;
  recipient_name: string | null;
  recipient_tax_id: string | null;
  net_amount: number | null;
  vat_amount: number | null;
  total_amount: number | null;
  notes: string | null;
  payment_term_days: number | null;
  due_date: string | null;
  due_month: string | null;
  payment_status: string | null;
  payment_date: string | null;
  payment_method: string | null;
  payment_condition: "advance" | "post_service" | null;
  factoring_entity: string | null;
  factoring_counterparty_id: string | null;
  factored_at: string | null;
  factoring_settled_at: string | null;
  factoring_recourse_at: string | null;
  origin_account_or_tax_id: string | null;
  destination_bank: string | null;
  destination_account: string | null;
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_mime_type: string | null;
  attachment_size: number | null;
  source_file_name: string | null;
  source_sheet_name: string | null;
  source_row: number | null;
};

function normalizeDocumentType(value: string | null) {
  const normalized = value
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es-CL");
  return (
    ({
      factura: "Factura afecta",
      "factura afecta": "Factura afecta",
      "factura exenta": "Factura exenta",
      "nota de credito": "Nota de crédito",
      "nota de debito": "Nota de débito",
    } as Record<string, string>)[normalized ?? ""] ?? value
  );
}

function mapStoredDocument(document: StoredDocument): InvoiceRecord {
  return {
    id: document.id,
    invoiceNumber: document.document_number,
    year: document.issue_date ? Number(document.issue_date.slice(0, 4)) : null,
    month: document.issue_date ? monthFromDate(document.issue_date) : null,
    issueDate: document.issue_date,
    documentType: normalizeDocumentType(document.document_type),
    issuer: document.issuer_name,
    issuerRut: document.issuer_tax_id,
    client: document.client_name,
    recipient: document.recipient_name,
    recipientRut: document.recipient_tax_id,
    netAmount:
      document.net_amount === null ? null : Number(document.net_amount),
    vatAmount:
      document.vat_amount === null ? null : Number(document.vat_amount),
    totalAmount:
      document.total_amount === null ? null : Number(document.total_amount),
    notes: document.notes,
    paymentTermDays:
      document.payment_term_days === null
        ? null
        : Number(document.payment_term_days),
    dueDate: document.due_date,
    dueMonth: document.due_month,
    status: document.payment_status,
    paymentDate: document.payment_date,
    paymentMethod: document.payment_method,
    paymentCondition: document.payment_condition,
    factoringEntity: document.factoring_entity,
    factoringCounterpartyId: document.factoring_counterparty_id,
    factoredAt: document.factored_at,
    factoringSettledAt: document.factoring_settled_at,
    factoringRecourseAt: document.factoring_recourse_at,
    originAccountRut: document.origin_account_or_tax_id,
    destinationBank: document.destination_bank,
    destinationAccount: document.destination_account,
    source: {
      file: document.source_file_name ?? "Atlas Financiero",
      sheet: document.source_sheet_name ?? "Registro manual",
      row: document.source_row ?? 0,
    },
  };
}

export function FinanceDashboard() {
  const [activeModule, setActiveModule] = useState<Module>("Inicio");
  const [expandedNavigationGroups, setExpandedNavigationGroups] = useState<string[]>([
    "RESUMEN",
  ]);
  const [year, setYear] = useState("Todos");
  const [month, setMonth] = useState("Todos");
  const [status, setStatus] = useState("Todos");
  const [documentSort, setDocumentSort] = useState<DocumentSort>({
    column: "invoiceNumber",
    direction: "asc",
  });
  const [showEntry, setShowEntry] = useState(false);
  const [editingRecord, setEditingRecord] = useState<InvoiceRecord | null>(
    null,
  );
  const [editDraft, setEditDraft] = useState<DocumentUpdateDraft>({
    documentType: "Factura afecta",
    status: "",
    paymentDate: "",
    paymentMethod: "",
    paymentCondition: "",
    notes: "",
    factoringEntity: "",
    factoringCounterpartyId: "",
    factoredAt: "",
    factoringSettledAt: "",
    factoringRecourseAt: "",
  });
  const [draft, setDraft] = useState<InvoiceDraft>(blankDraft);
  const [documentCustomers, setDocumentCustomers] = useState<DocumentCustomer[]>([]);
  const [documentContacts, setDocumentContacts] = useState<DocumentContact[]>([]);
  const [factoringProviders, setFactoringProviders] = useState<FactoringProvider[]>([]);
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [editDocumentFile, setEditDocumentFile] = useState<File | null>(null);
  const [loadingDocumentSources, setLoadingDocumentSources] = useState(false);
  const [attachmentByDocument, setAttachmentByDocument] = useState<Record<string, boolean>>({});
  const [formError, setFormError] = useState("");
  const [sessionRecords, setSessionRecords] = useState<InvoiceRecord[]>([]);
  const [databaseRecords, setDatabaseRecords] = useState<InvoiceRecord[]>([]);
  const [access, setAccess] = useState<AccessProfile | null>(null);

  useEffect(() => {
    if (!access?.membership.organizationId) return;
    let active = true;
    setDatabaseRecords([]);
    setAttachmentByDocument({});
    fetch("/api/issued-documents", { cache: "no-store" })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ documents: StoredDocument[] }>)
          : null,
      )
      .then((payload) => {
        if (active && payload) {
          setDatabaseRecords(payload.documents.map(mapStoredDocument));
          setAttachmentByDocument(Object.fromEntries(payload.documents.map((document) => [document.id, Boolean(document.attachment_path)])));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [access?.membership.organizationId]);

  useEffect(() => {
    const organizationId = access?.membership.organizationId;
    if (!showEntry || !organizationId) return;
    let active = true;
    setLoadingDocumentSources(true);
    fetch(`/api/customer-profiles?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ profiles: DocumentCustomer[]; contacts: DocumentContact[] }> : null)
      .then((payload) => {
        if (!active || !payload) return;
        setDocumentCustomers(Array.isArray(payload.profiles) ? payload.profiles : []);
        setDocumentContacts(Array.isArray(payload.contacts) ? payload.contacts : []);
      })
      .catch(() => undefined)
      .finally(() => { if (active) setLoadingDocumentSources(false); });
    return () => { active = false; };
  }, [showEntry, access?.membership.organizationId]);

  useEffect(() => {
    if (!showEntry || !access) return;
    setDraft((current) => ({
      ...current,
      issuerName: current.issuerName || access.membership.organizationName,
      issuerTaxId: current.issuerTaxId || access.membership.organizationTaxId || "",
    }));
  }, [showEntry, access]);

  useEffect(() => {
    const organizationId = access?.membership.organizationId;
    if (!editingRecord || !organizationId) return;
    fetch(`/api/supplier-consolidation?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ suppliers: FactoringProvider[] }> : null)
      .then((payload) => setFactoringProviders(payload?.suppliers ?? []))
      .catch(() => setFactoringProviders([]));
  }, [editingRecord, access?.membership.organizationId]);

  useEffect(() => {
    let active = true;
    fetch("/api/session", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign("/login");
          return null;
        }
        return response.ok ? (response.json() as Promise<AccessProfile>) : null;
      })
      .then((payload) => {
        if (active && payload) setAccess(payload);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const records = useMemo(() => [...databaseRecords, ...sessionRecords], [databaseRecords, sessionRecords]);
  const contactsForDraftCustomer = useMemo(() => (documentContacts ?? []).filter((contact) => contact.counterparty_id === draft.clientId), [documentContacts, draft.clientId]);
  const selectedDraftCustomer = useMemo(() => (documentCustomers ?? []).find((customer) => customer.id === draft.clientId) ?? null, [documentCustomers, draft.clientId]);
  const entryNetAmount = Number(draft.netAmount || 0);
  const entryVatAmount = draft.documentType === "Factura afecta" ? Math.round(entryNetAmount * 0.19 * 100) / 100 : 0;
  const entryTotalAmount = Math.round((entryNetAmount + entryVatAmount) * 100) / 100;
  const availableYears = useMemo(
    () =>
      Array.from(
        new Set(
          records
            .map((record) => record.year)
            .filter((value): value is number => typeof value === "number"),
        ),
      ).sort((first, second) => second - first),
    [records],
  );
  const yearFilteredRecords = useMemo(
    () =>
      year === "Todos"
        ? records
        : records.filter((record) => record.year === Number(year)),
    [records, year],
  );
  const months = useMemo(
    () =>
      calendarMonths.filter((item) =>
        yearFilteredRecords.some((record) => record.month === item),
      ),
    [yearFilteredRecords],
  );
  const statuses = useMemo(() => {
    const values = yearFilteredRecords
      .map((record) => record.status)
      .filter((item): item is string => Boolean(item));
    return Array.from(new Set(values)).sort();
  }, [yearFilteredRecords]);
  const filtered = useMemo(
    () =>
      yearFilteredRecords.filter(
        (record) =>
          (month === "Todos" || record.month === month) &&
          (status === "Todos" || record.status === status),
      ),
    [yearFilteredRecords, month, status],
  );
  const orderedDocuments = useMemo(
    () =>
      [...filtered].sort((first, second) => {
        let result = 0;
        switch (documentSort.column) {
          case "invoiceNumber":
            result = compareInvoiceNumber(first, second);
            break;
          case "issueDate":
            result = compareText(first.issueDate, second.issueDate);
            break;
          case "client":
            result = compareText(first.client, second.client);
            break;
          case "documentType":
            result = compareText(first.documentType, second.documentType);
            break;
          case "netAmount":
            result = recognizedNetAmount(first) - recognizedNetAmount(second);
            break;
          case "status":
            result = compareText(first.status, second.status);
            break;
          case "origin":
            result = compareText(
              `${first.source.file} ${first.source.sheet} ${first.source.row}`,
              `${second.source.file} ${second.source.sheet} ${second.source.row}`,
            );
            break;
        }

        if (result === 0 && documentSort.column !== "invoiceNumber") {
          result = compareInvoiceNumber(first, second);
        }
        return documentSort.direction === "asc" ? result : -result;
      }),
    [filtered, documentSort],
  );

  const toggleDocumentSort = (column: DocumentSortColumn) => {
    setDocumentSort((current) => ({
      column,
      direction:
        current.column === column && current.direction === "asc" ? "desc" : "asc",
    }));
  };
  const documentSortIndicator = (column: DocumentSortColumn) =>
    documentSort.column === column
      ? documentSort.direction === "asc"
        ? " ↑"
        : " ↓"
      : " ↕";
  const documentAriaSort = (column: DocumentSortColumn) =>
    documentSort.column !== column
      ? "none"
      : documentSort.direction === "asc"
        ? "ascending"
        : "descending";

  const monthly = useMemo(
    () =>
      months.map((item) => {
        const matching = yearFilteredRecords.filter(
          (record) => record.month === item,
        );
        return {
          month: item.slice(0, 3),
          montoNeto: sumRecognizedNet(matching),
          documentos: matching.filter(
            (record) => !isPurchaseOrderDocument(record),
          ).length,
        };
      }),
    [months, yearFilteredRecords],
  );
  const statusesChart = useMemo(
    () =>
      statuses.map((item) => ({
        name: item,
        value: yearFilteredRecords.filter((record) => record.status === item)
          .length,
      })),
    [yearFilteredRecords, statuses],
  );
  const clientRanking = useMemo(
    () =>
      Object.values(
        yearFilteredRecords.reduce<
          Record<string, { client: string; montoNeto: number }>
        >((accumulator, record) => {
          const client = record.client || "No informado";
          accumulator[client] ??= { client, montoNeto: 0 };
          if (!isPurchaseOrderDocument(record))
            accumulator[client].montoNeto += recognizedNetAmount(record);
          return accumulator;
        }, {}),
      )
        .sort((a, b) => b.montoNeto - a.montoNeto)
        .slice(0, 6),
    [yearFilteredRecords],
  );

  const pendingCount = yearFilteredRecords.filter(
    (record) =>
      !isPurchaseOrderDocument(record) &&
      !isCreditNoteDocument(record) &&
      record.status === "Pendiente",
  ).length;
  const currentDate = new Date().toISOString().slice(0, 10);
  const overdueRecords = yearFilteredRecords.filter(
    (record) =>
      !isPurchaseOrderDocument(record) &&
      !isCreditNoteDocument(record) &&
      record.status === "Pendiente" &&
      Boolean(record.dueDate) &&
      record.dueDate! < currentDate,
  );
  const overdueAmount = sumRecognizedNet(overdueRecords);
  const creditNotesAmount = yearFilteredRecords
    .filter(isCreditNoteDocument)
    .reduce((total, record) => total + Math.abs(record.netAmount ?? 0), 0);
  const hasEditPermission =
    access !== null &&
    ["administrator", "finance", "operations"].includes(access.membership.role);

  function updateDraft(field: keyof InvoiceDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function startDocumentEdit(record: InvoiceRecord) {
    setEditingRecord(record);
    setEditDraft({
      documentType: normalizeDocumentType(record.documentType) ?? "Factura afecta",
      status: record.status ?? "",
      paymentDate: record.paymentDate ?? "",
      paymentMethod: record.paymentMethod ?? "",
      paymentCondition: record.paymentCondition ?? "",
      notes: record.notes ?? "",
      factoringEntity: record.factoringEntity ?? "",
      factoringCounterpartyId: record.factoringCounterpartyId ?? "",
      factoredAt: record.factoredAt ?? "",
      factoringSettledAt: record.factoringSettledAt ?? "",
      factoringRecourseAt: record.factoringRecourseAt ?? "",
    });
    setEditDocumentFile(null);
    setFormError("");
  }

  async function submitDocumentEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingRecord || !editDraft.status.trim()) {
      setFormError("Indica el estado actual del documento.");
      return;
    }
    const formData = new FormData();
    formData.set("id", editingRecord.id);
    Object.entries(editDraft).forEach(([field, value]) =>
      formData.set(field, value),
    );
    if (editDocumentFile) formData.set("file", editDocumentFile);
    const response = await fetch("/api/issued-documents", {
      method: "PATCH",
      body: formData,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setFormError(
        payload?.error === "invalid_document_attachment"
          ? "El adjunto debe ser PDF, JPG o PNG y pesar como máximo 50 MB."
          : payload?.error === "invalid_document_update"
            ? "Revisa el tipo de documento, estado y fecha de pago antes de guardar."
            : payload?.error === "unable_to_upload_document_attachment"
              ? "No fue posible subir el respaldo. Intenta nuevamente con el mismo archivo."
              : "No fue posible actualizar el documento. Revisa tu sesión, permisos y datos.",
      );
      return;
    }
    const payload = (await response.json()) as { document: StoredDocument };
    const updated = mapStoredDocument(payload.document);
    setDatabaseRecords((current) =>
      current
        ? current.map((record) => (record.id === updated.id ? updated : record))
        : current,
    );
    setAttachmentByDocument((current) => ({
      ...current,
      [updated.id]: Boolean(payload.document.attachment_path),
    }));
    setEditDocumentFile(null);
    setEditingRecord(null);
    setFormError("");
  }

  async function submitEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !draft.issueDate ||
      !draft.documentType ||
      !draft.issuerName.trim() ||
      !draft.clientId ||
      !draft.netAmount ||
      !draft.status ||
      (draft.documentType.toLocaleLowerCase().includes("factura") &&
        (!draft.paymentCondition || !draft.dueDate))
    ) {
      setFormError(
        "Completa fecha de emisión y vencimiento, tipo, emisor, cliente, monto neto, estado y condición del servicio para facturas.",
      );
      return;
    }
    const formData = new FormData();
    formData.set("invoiceNumber", draft.invoiceNumber);
    formData.set("issueDate", draft.issueDate);
    formData.set("dueDate", draft.dueDate);
    formData.set("documentType", draft.documentType);
    formData.set("issuerName", draft.issuerName);
    formData.set("issuerTaxId", draft.issuerTaxId);
    formData.set("clientId", draft.clientId);
    formData.set("contactId", draft.contactId);
    formData.set("netAmount", draft.netAmount);
    formData.set("status", draft.status);
    formData.set("paymentCondition", draft.paymentCondition);
    if (documentFile) formData.set("file", documentFile);
    const response = await fetch("/api/issued-documents", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setFormError(
        payload?.error === "authentication_required"
          ? "Inicia sesión con un usuario autorizado para guardar el documento."
          : payload?.error === "organization_selection_required"
            ? "Selecciona la empresa activa antes de registrar documentos."
            : payload?.error === "invalid_document_attachment"
              ? "El adjunto debe ser PDF, JPG o PNG y pesar como máximo 50 MB."
            : "No fue posible guardar el documento. Revisa tus permisos y los datos ingresados.",
      );
      return;
    }
    const payload = (await response.json()) as {
      document: {
        id: string;
        document_number: string | null;
        issue_date: string;
        due_date: string | null;
        due_month: string | null;
        document_type: string;
        issuer_name: string;
        issuer_tax_id: string | null;
        client_name: string;
        recipient_name: string | null;
        recipient_tax_id: string | null;
        net_amount: number;
        vat_amount: number | null;
        total_amount: number;
        payment_status: string;
        attachment_path: string | null;
        attachment_name: string | null;
        attachment_mime_type: string | null;
        attachment_size: number | null;
        source_file_name: string;
        source_sheet_name: string;
        source_row: number;
      };
    };
    const created = mapStoredDocument({
      ...payload.document,
      notes: null,
      payment_term_days: null,
      due_date: payload.document.due_date,
      due_month: payload.document.due_month,
      payment_date: null,
      payment_method: null,
      payment_condition:
        draft.paymentCondition === "advance" ||
        draft.paymentCondition === "post_service"
          ? draft.paymentCondition
          : null,
      factoring_entity: null,
      factoring_counterparty_id: null,
      factored_at: null,
      factoring_settled_at: null,
      factoring_recourse_at: null,
      origin_account_or_tax_id: null,
      destination_bank: null,
      destination_account: null,
      attachment_path: payload.document.attachment_path,
      attachment_name: payload.document.attachment_name,
      attachment_mime_type: payload.document.attachment_mime_type,
      attachment_size: payload.document.attachment_size,
      source_file_name: payload.document.source_file_name,
      source_sheet_name: payload.document.source_sheet_name,
      source_row: payload.document.source_row,
    });
    if (databaseRecords)
      setDatabaseRecords((current) =>
        current ? [created, ...current] : [created],
      );
    else setSessionRecords((current) => [created, ...current]);
    if (payload.document.attachment_path) setAttachmentByDocument((current) => ({ ...current, [created.id]: true }));
    setDraft(blankDraft);
    setDocumentFile(null);
    setFormError("");
    setShowEntry(false);
    setActiveModule("Facturas");
  }

  async function openDocumentAttachment(documentId: string) {
    const response = await fetch(`/api/issued-documents?fileId=${encodeURIComponent(documentId)}`);
    const payload = await response.json().catch(() => null) as { signedUrl?: string } | null;
    if (response.ok && payload?.signedUrl) window.open(payload.signedUrl, "_blank", "noopener,noreferrer");
    else setFormError("No fue posible abrir el archivo adjunto.");
  }

  async function signOut() {
    await createClient().auth.signOut();
    window.location.assign("/login");
  }

  async function changeActiveOrganization(organizationId: string) {
    if (!organizationId || organizationId === access?.membership.organizationId)
      return;
    const response = await fetch("/api/session/active-organization", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId }),
    });
    if (response.ok) window.location.assign("/");
  }

  const canManageCostCenters =
    access?.membership.role === "administrator" ||
    access?.membership.role === "finance";
  const canReadExpenses =
    access?.membership.role === "administrator" ||
    access?.membership.role === "finance" ||
    access?.membership.role === "auditor";
  const canReadProcurement = access !== null;
  const visibleNavigationGroups = navigationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (item !== "Administración" && item !== "Bitácora de actividad" ||
            access?.membership.role === "administrator") &&
          (item !== "Control SaaS" || access?.isSuperAdmin) &&
          (item !== "Centros de costo" || canManageCostCenters) &&
          (item !== "Imputaciones pendientes" || canManageCostCenters) &&
          (item !== "Cuentas por pagar" || canReadExpenses) &&
          (item !== "Proveedores" || canReadExpenses) &&
          (item !== "Compras, obligaciones y pagos" || canReadProcurement) &&
          (item !== "Tesorería" || canReadExpenses) &&
          (item !== "Planificación financiera" || canReadExpenses) &&
          (item !== "Cierre financiero" || canReadExpenses),
      ),
    }))
    .filter((group) => group.items.length);
  const activeNavigationGroup =
    visibleNavigationGroups.find((group) => group.items.includes(activeModule))
      ?.label ?? "RESUMEN";

  function selectModule(module: Module, groupLabel: string) {
    setActiveModule(module);
    // Tras elegir una vista, conservamos una sola sección abierta: el menú
    // sigue siendo breve y el contexto del usuario queda siempre visible.
    setExpandedNavigationGroups([groupLabel]);
  }

  function toggleNavigationGroup(groupLabel: string) {
    if (groupLabel === activeNavigationGroup) return;
    setExpandedNavigationGroups((current) =>
      current.includes(groupLabel) ? [] : [groupLabel],
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/atlas-financiero-logo.png" alt="" />
          <span className="brand-name">Atlas <b>Financiero</b></span>
        </div>
        <div className="workspace-label">ESPACIO DE TRABAJO</div>
        <select
          className="workspace-switcher"
          value={access?.membership.organizationId ?? ""}
          onChange={(event) =>
            void changeActiveOrganization(event.target.value)
          }
          disabled={!access || access.organizations.length < 2}
          aria-label="Organización activa"
        >
          {access ? (
            access.organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))
          ) : (
            <option>Cargando</option>
          )}
        </select>
        <nav aria-label="Navegación principal">
          {visibleNavigationGroups.map((group) => (
            <section
              className="navigation-group"
              key={group.label}
              aria-label={group.label}
            >
              <button
                className={`navigation-group-toggle ${group.label === activeNavigationGroup ? "is-active-group" : ""}`}
                type="button"
                onClick={() => toggleNavigationGroup(group.label)}
                aria-expanded={expandedNavigationGroups.includes(group.label) || group.label === activeNavigationGroup}
                aria-controls={`navigation-group-${group.label.replaceAll(" ", "-")}`}
              >
                <span>{group.label}</span>
                <span className="navigation-group-chevron" aria-hidden="true">⌄</span>
              </button>
              <div
                className={`navigation-group-items ${(expandedNavigationGroups.includes(group.label) || group.label === activeNavigationGroup) ? "is-open" : ""}`}
                id={`navigation-group-${group.label.replaceAll(" ", "-")}`}
              >
              {group.items.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`nav-item ${activeModule === item ? "active" : ""}`}
                  onClick={() => selectModule(item, group.label)}
                  aria-describedby={`module-preview-${item.replaceAll(" ", "-")}`}
                >
                  <span className="nav-icon">
                  {item === "Gestión 360"
                      ? "◈"
                      : item === "Contabilidad"
                        ? "⌘"
                      : item === "Inicio"
                      ? "⌂"
                      : item === "Facturas"
                        ? "▤"
                        : item === "OC de clientes"
                          ? "⌑"
                          : item === "Proyecciones"
                            ? "⌁"
                          : item === "Recurrentes"
                            ? "↻"
                            : item === "Prefacturación"
                              ? "✦"
                            : item === "CRM y clientes"
                                ? "◉"
                                : item === "Mercado Público"
                                  ? "◎"
                                : item === "Cuentas por cobrar"
                                  ? "◷"
                                  : item === "Cuentas por pagar"
                                  ? "▣"
                                  : item === "Compras, obligaciones y pagos"
                                    ? "▤"
                                  : item === "Tesorería"
                                    ? "◒"
                                    : item === "Planificación financiera"
                                      ? "⌁"
                                  : item === "Remuneraciones"
                                      ? "◫"
                                      : item === "Centros de costo"
                                        ? "⊞"
                                        : item === "Imputaciones pendientes"
                                          ? "◌"
                                        : item === "Aprobaciones"
                                          ? "✓"
                                          : item === "Cierre financiero"
                                            ? "◉"
                                        : item === "Reportes"
                                          ? "◔"
                                          : item === "Bitácora de actividad"
                                            ? "◷"
                                          : "⚙"}
                  </span>
                  {item}
                  {item === "Facturas" && (
                    <span className="nav-count">{records.length}</span>
                  )}
                  <span
                    className="nav-preview"
                    id={`module-preview-${item.replaceAll(" ", "-")}`}
                    role="tooltip"
                  >
                    <b>{item}</b>
                    {modulePreviews[item]}
                  </span>
                </button>
              ))}
              </div>
            </section>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {access?.membership.role === "administrator" && (
            <button
              className="settings-button"
              type="button"
              onClick={() => selectModule("Administración", "PERSONAS Y CONTROL")}
            >
              ⚙ Administración
            </button>
          )}
          <p>v0.2</p>
        </div>
      </aside>

      <section className="content-area">
        <header className="topbar">
          <div className="breadcrumb">
            Finanzas <span>/</span> {activeModule}
          </div>
          <div className="topbar-actions">
            {access && (
              <>
                <span className="access-role">
                  {roleLabel(access.membership.role)}
                </span>
                <button
                  className="avatar"
                  type="button"
                  onClick={signOut}
                  aria-label="Cerrar sesión"
                  title={`Cerrar sesión de ${access.user.email ?? "usuario"}`}
                >
                  {initialsFromEmail(access.user.email)}
                </button>
              </>
            )}
          </div>
        </header>

        {activeModule === "Gestión 360" ? (
          <ManagementCenter
            organizationId={access?.membership.organizationId ?? null}
            onNavigate={(module) => selectModule(module, navigationGroups.find((group) => group.items.includes(module))?.label ?? "RESUMEN")}
          />
        ) : activeModule === "Contabilidad" ? (
          canReadExpenses ? <AccountingWorkbench organizationId={access?.membership.organizationId ?? null} /> : null
        ) : activeModule === "Inicio" ? (
          <ExecutiveDashboard records={records} />
        ) : activeModule === "OC de clientes" ? (
          <CustomerPurchaseOrders
            organizationId={access?.membership.organizationId ?? null}
            records={records}
            canManage={hasEditPermission}
          />
        ) : activeModule === "Proyecciones" ? (
          <ForecastModule />
        ) : activeModule === "Planificación financiera" ? (
          canReadExpenses ? (
            <FinancialPlanningDashboard
              organizationId={access?.membership.organizationId ?? null}
            />
          ) : null
        ) : activeModule === "CRM y clientes" ? (
          <CustomerModule
            records={records}
            organizationId={access?.membership.organizationId ?? null}
            canManage={hasEditPermission}
          />
        ) : activeModule === "Mercado Público" ? (
          <PublicMarketCrm
            organizationId={access?.membership.organizationId ?? null}
            canManage={hasEditPermission}
          />
        ) : activeModule === "Cuentas por cobrar" ? (
          <AccountsReceivable
            records={records}
            organizationId={access?.membership.organizationId ?? null}
            canManage={hasEditPermission}
            isPersisted={Boolean(databaseRecords)}
            onEditDocument={(record) => {
              setActiveModule("Facturas");
              startDocumentEdit(record);
            }}
          />
        ) : activeModule === "Recurrentes" ? (
          <BillingOperations organizationId={access?.membership.organizationId ?? null} />
        ) : activeModule === "Prefacturación" ? (
          <PreinvoiceWorkbench
            organizationId={access?.membership.organizationId ?? null}
            onOpenApprovals={() => selectModule("Aprobaciones", "PERSONAS Y CONTROL")}
          />
        ) : activeModule === "Cuentas por pagar" ? (
          canReadExpenses ? (
            <ExpensesDashboard
              organizationId={access?.membership.organizationId ?? null}
              canManage={access?.membership.role === "administrator" || access?.membership.role === "finance"}
            />
          ) : null
        ) : activeModule === "Compras, obligaciones y pagos" ? (
          <ProcureToPayWorkbench
            organizationId={access?.membership.organizationId ?? null}
            canManage={hasEditPermission}
            canManagePayments={access?.membership.role === "administrator" || access?.membership.role === "finance"}
          />
        ) : activeModule === "Proveedores" ? (
          canReadExpenses ? (
            <SupplierConsolidation
              organizationId={access?.membership.organizationId ?? null}
              canManage={access?.membership.role === "administrator" || access?.membership.role === "finance"}
            />
          ) : null
        ) : activeModule === "Tesorería" ? (
          canReadExpenses ? (
            <TreasuryDashboard
              organizationId={access?.membership.organizationId ?? null}
              canManage={access?.membership.role === "administrator" || access?.membership.role === "finance"}
            />
          ) : null
        ) : activeModule === "Remuneraciones" ? (
          <PayrollDashboard
            organizationId={access?.membership.organizationId ?? null}
            canSynchronize={access?.membership.role === "administrator"}
          />
        ) : activeModule === "Centros de costo" ? (
          canManageCostCenters ? (
            <CostCenterManagement
              organizationId={access?.membership.organizationId ?? null}
            />
          ) : null
        ) : activeModule === "Imputaciones pendientes" ? (
          canManageCostCenters ? (
            <CostCenterImputationInbox
              organizationId={access?.membership.organizationId ?? null}
            />
          ) : null
        ) : activeModule === "Reportes" ? (
          <ReportsDashboard
            organizationId={access?.membership.organizationId ?? null}
          />
        ) : activeModule === "Aprobaciones" ? (
          <ApprovalInbox
            organizationId={access?.membership.organizationId ?? null}
          />
        ) : activeModule === "Cierre financiero" ? (
          canReadExpenses ? (
            <FinancialCloseWorkbench
              organizationId={access?.membership.organizationId ?? null}
            />
          ) : null
        ) : activeModule === "Administración" ? (
          access?.membership.role === "administrator" ? (
            <AdministrationConsole
              activeOrganizationId={access.membership.organizationId}
              isSuperAdmin={access.isSuperAdmin}
            />
          ) : null
        ) : activeModule === "Bitácora de actividad" ? (
          access?.membership.role === "administrator" ? (
            <ActivityAuditLog organizationId={access.membership.organizationId} />
          ) : null
        ) : activeModule === "Control SaaS" ? (
          access?.isSuperAdmin ? <PlatformSuperAdminDashboard /> : null
        ) : activeModule !== "Facturas" ? (
          <EmptyModule module={activeModule} />
        ) : (
          <main className="dashboard">
            <section className="headline">
              <div>
                <span className="eyebrow">
                  OPERACIÓN · {year === "Todos" ? "TODOS LOS AÑOS" : year}
                </span>
                <h1>Facturas emitidas</h1>
                <p>
                  Gestión documental, estados, vencimientos y trazabilidad por
                  documento.
                </p>
              </div>
              <div className="headline-actions">
                <label className="period-picker">
                  Año
                  <select
                    value={year}
                    onChange={(event) => {
                      setYear(event.target.value);
                      setMonth("Todos");
                      setStatus("Todos");
                    }}
                  >
                    <option value="Todos">Todos los años</option>
                    {availableYears.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="refresh">● Datos importados del libro</span>
                {hasEditPermission ? (
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => {
                      setDraft({
                        ...blankDraft,
                        issuerName: access?.membership.organizationName ?? "",
                        issuerTaxId: access?.membership.organizationTaxId ?? "",
                      });
                      setShowEntry(true);
                    }}
                  >
                    ＋ Registrar documento
                  </button>
                ) : (
                  <span className="permission-note">
                    El rol Auditor no registra documentos
                  </span>
                )}
              </div>
            </section>

            <section
              className="kpis kpis-five"
              aria-label="Indicadores principales"
            >
              <article
                className="kpi-card"
                data-help="Cantidad de documentos emitidos para el año seleccionado. Incluye facturas, exentos, notas de crédito y órdenes de compra registradas."
              >
                <span>Documentos emitidos</span>
                <strong>{number.format(yearFilteredRecords.length)}</strong>
                <small>
                  {databaseRecords
                    ? `Año ${year === "Todos" ? "seleccionado" : year}`
                    : sessionRecords.length
                      ? `${sessionRecords.length} registro(s) guardado(s) en Atlas`
                      : "Año 2026"}
                </small>
              </article>
              <article
                className="kpi-card"
                data-help="Ingreso reconocido: facturas y documentos exentos, menos notas de crédito. Las órdenes de compra no son venta facturada."
              >
                <span>Facturado neto</span>
                <strong>
                  {formatMoney(sumRecognizedNet(yearFilteredRecords))}
                </strong>
                <small>
                  Facturas y exentos, menos notas de crédito. OCs excluidas.
                </small>
              </article>
              <article
                className="kpi-card"
                data-help="Valor neto que rebajó el ingreso por notas de crédito emitidas en el período filtrado."
              >
                <span>Notas de crédito emitidas</span>
                <strong>{formatMoney(creditNotesAmount)}</strong>
                <small>Rebaja ya incorporada en facturado neto</small>
              </article>
              <article
                className="kpi-card accent"
                data-help="Número de documentos cuyo estado actual es Pendiente. El importe asociado se revisa en Cuentas por cobrar."
              >
                <span>Estado “Pendiente”</span>
                <strong>{number.format(pendingCount)}</strong>
                <small>Documentos con ese estado exacto</small>
              </article>
              <article
                className="kpi-card"
                data-help="Monto neto/exento de documentos pendientes cuya fecha de vencimiento ya pasó. Requiere gestión prioritaria."
              >
                <span>Cartera vencida</span>
                <strong>{formatMoney(overdueAmount)}</strong>
                <small>
                  {number.format(overdueRecords.length)} pendiente(s) vencido(s)
                  a la fecha
                </small>
              </article>
            </section>

            <section className="visual-grid">
              <article className="panel trend-panel">
                <div className="panel-heading">
                  <div>
                    <span className="panel-label">EVOLUCIÓN</span>
                    <h2>Facturación neta por mes</h2>
                  </div>
                  <span className="unit">CLP neto/exento</span>
                </div>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={monthly}
                      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient
                          id="netFill"
                          x1="0"
                          x2="0"
                          y1="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="#5968df"
                            stopOpacity={0.26}
                          />
                          <stop
                            offset="100%"
                            stopColor="#5968df"
                            stopOpacity={0.01}
                          />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="month"
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: "#7e8ba0", fontSize: 12 }}
                      />
                      <YAxis hide />
                      <Tooltip
                        formatter={(value) => formatMoney(Number(value))}
                        contentStyle={{
                          borderRadius: 12,
                          border: "1px solid #e6e9ef",
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="montoNeto"
                        stroke="#5968df"
                        strokeWidth={2.5}
                        fill="url(#netFill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </article>
              <article className="panel status-panel">
                <div className="panel-heading">
                  <div>
                    <span className="panel-label">DISTRIBUCIÓN</span>
                    <h2>Documentos por estado</h2>
                  </div>
                </div>
                <div className="donut-row">
                  <div className="donut">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={statusesChart}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={57}
                          outerRadius={78}
                          paddingAngle={3}
                          stroke="none"
                        >
                          {statusesChart.map((entry, index) => (
                            <Cell
                              key={entry.name}
                              fill={pieColors[index % pieColors.length]}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value) => `${value} documento(s)`}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="donut-center">
                      <strong>{yearFilteredRecords.length}</strong>
                      <span>documentos</span>
                    </div>
                  </div>
                  <div className="legend">
                    {statusesChart.map((item, index) => (
                      <div key={item.name}>
                        <i
                          style={{
                            backgroundColor:
                              pieColors[index % pieColors.length],
                          }}
                        />
                        <span>{item.name}</span>
                        <b>{item.value}</b>
                      </div>
                    ))}
                  </div>
                </div>
              </article>
            </section>

            <section className="panel ranking-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-label">CLIENTES</span>
                  <h2>Mayor monto neto documentado</h2>
                </div>
                <span className="unit">Top 6</span>
              </div>
              <div className="ranking-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={clientRanking}
                    layout="vertical"
                    margin={{ left: 0, right: 24 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="client"
                      width={145}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: "#58657a", fontSize: 12 }}
                    />
                    <Tooltip
                      formatter={(value) => formatMoney(Number(value))}
                      cursor={{ fill: "#f6f7fb" }}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid #e6e9ef",
                      }}
                    />
                    <Bar
                      dataKey="montoNeto"
                      radius={[0, 6, 6, 0]}
                      fill="#20a67a"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="table-section" id="facturas">
              <div className="table-heading">
                <div>
                  <span className="panel-label">REGISTRO TRAZABLE</span>
                  <h2>Documentos emitidos</h2>
                  <p>{filtered.length} resultado(s) con los filtros actuales</p>
                </div>
                <div className="filters">
                  <label>
                    Año
                    <select
                      value={year}
                      onChange={(event) => {
                        setYear(event.target.value);
                        setMonth("Todos");
                        setStatus("Todos");
                      }}
                    >
                      <option value="Todos">Todos los años</option>
                      {availableYears.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Mes
                    <select
                      value={month}
                      onChange={(event) => setMonth(event.target.value)}
                    >
                      <option>Todos</option>
                      {months.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Estado
                    <select
                      value={status}
                      onChange={(event) => setStatus(event.target.value)}
                    >
                      <option>Todos</option>
                      {statuses.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th aria-sort={documentAriaSort("invoiceNumber")}>
                        <button type="button" className="table-sort-button" onClick={() => toggleDocumentSort("invoiceNumber")}>
                          Documento{documentSortIndicator("invoiceNumber")}
                        </button>
                      </th>
                      <th aria-sort={documentAriaSort("issueDate")}>
                        <button type="button" className="table-sort-button" onClick={() => toggleDocumentSort("issueDate")}>
                          Emisión{documentSortIndicator("issueDate")}
                        </button>
                      </th>
                      <th aria-sort={documentAriaSort("client")}>
                        <button type="button" className="table-sort-button" onClick={() => toggleDocumentSort("client")}>
                          Cliente{documentSortIndicator("client")}
                        </button>
                      </th>
                      <th aria-sort={documentAriaSort("documentType")}>
                        <button type="button" className="table-sort-button" onClick={() => toggleDocumentSort("documentType")}>
                          Tipo{documentSortIndicator("documentType")}
                        </button>
                      </th>
                      <th className="money-col" aria-sort={documentAriaSort("netAmount")}>
                        <button type="button" className="table-sort-button" onClick={() => toggleDocumentSort("netAmount")}>
                          Neto/exento{documentSortIndicator("netAmount")}
                        </button>
                      </th>
                      <th aria-sort={documentAriaSort("status")}>
                        <button type="button" className="table-sort-button" onClick={() => toggleDocumentSort("status")}>
                          Estado{documentSortIndicator("status")}
                        </button>
                      </th>
                      <th aria-sort={documentAriaSort("origin")}>
                        <button type="button" className="table-sort-button" onClick={() => toggleDocumentSort("origin")}>
                          Origen{documentSortIndicator("origin")}
                        </button>
                      </th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderedDocuments.map((record) => (
                      <tr key={record.id}>
                        <td>
                          <strong>N° {record.invoiceNumber ?? "—"}</strong>
                          <small>{record.issuer}</small>
                        </td>
                        <td>
                          {formatDate(record.issueDate)}
                          <small>{record.month ?? "—"}</small>
                        </td>
                        <td>
                          <strong>{record.client ?? "No informado"}</strong>
                          <small>{record.recipient ?? "—"}</small>
                        </td>
                        <td>{record.documentType ?? "—"}</td>
                        <td
                          className={`money-col ${recognizedNetAmount(record) < 0 ? "is-negative" : ""}`}
                        >
                          {formatMoney(recognizedNetAmount(record))}
                        </td>
                        <td>
                          <span className={statusClass(record.status)}>
                            {record.status ?? "No informado"}
                          </span>
                        </td>
                        <td>
                          <span className="origin">
                            {record.source.sheet}
                            <b>fila {record.source.row || "sesión"}</b>
                          </span>
                        </td>
                        <td>
                          <div className="document-row-actions">
                            {attachmentByDocument[record.id] && <button type="button" className="text-button" onClick={() => void openDocumentAttachment(record.id)}>Ver adjunto</button>}
                            {hasEditPermission && databaseRecords && <button type="button" className="secondary-button" onClick={() => startDocumentEdit(record)}>Editar</button>}
                            {!attachmentByDocument[record.id] && !(hasEditPermission && databaseRecords) && "—"}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </main>
        )}
      </section>

      {showEntry && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="entry-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="entry-title"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">REGISTRO CONTROLADO</span>
                <h2 id="entry-title">Registrar factura o documento</h2>
                <p>
                  El emisor se propone desde la empresa activa y puede corregirse.
                  Cliente y destinatario provienen de las fichas comerciales. IVA y
                  total se calculan automáticamente.
                </p>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setShowEntry(false)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <form onSubmit={submitEntry}>
              <div className="form-grid">
                <label>
                  N° documento
                  <input
                    value={draft.invoiceNumber}
                    onChange={(event) =>
                      updateDraft("invoiceNumber", event.target.value)
                    }
                  />
                </label>
                <label>
                  Fecha emisión *
                  <input
                    type="date"
                    value={draft.issueDate}
                    onChange={(event) =>
                      updateDraft("issueDate", event.target.value)
                    }
                  />
                </label>
                <label>
                  Fecha vencimiento (facturas) *
                  <input
                    type="date"
                    value={draft.dueDate}
                    onChange={(event) =>
                      updateDraft("dueDate", event.target.value)
                    }
                  />
                </label>
                <label>
                  Tipo documento *
                  <select
                    value={draft.documentType}
                    onChange={(event) =>
                      updateDraft("documentType", event.target.value)
                    }
                  ><option value="Factura afecta">Factura afecta</option><option value="Factura exenta">Factura exenta</option><option value="Nota de crédito">Nota de crédito</option><option value="Nota de débito">Nota de débito</option></select>
                </label>
                <label>
                  Estado *
                  <select
                    value={draft.status}
                    onChange={(event) =>
                      updateDraft("status", event.target.value)
                    }
                  ><option value="Pendiente">Pendiente</option><option value="Pagada">Pagada</option><option value="Factorizada">Factorizada</option><option value="Pagada al factoring">Pagada al factoring</option><option value="Recomprada al factoring">Recomprada al factoring</option><option value="Anulada">Anulada</option><option value="Nota de crédito">Nota de crédito</option></select>
                </label>
                <label>
                  Condición del servicio (facturas) *
                  <select
                    value={draft.paymentCondition}
                    onChange={(event) =>
                      updateDraft("paymentCondition", event.target.value)
                    }
                  >
                    <option value="">Sin definir</option>
                    <option value="advance">Anticipado</option>
                    <option value="post_service">
                      Vencido / post servicio
                    </option>
                  </select>
                </label>
                <label>
                  Empresa emisora *
                  <input value={draft.issuerName} onChange={(event) => updateDraft("issuerName", event.target.value)} placeholder="Empresa emisora" required />
                </label>
                <label>
                  RUT emisor
                  <input value={draft.issuerTaxId} onChange={(event) => updateDraft("issuerTaxId", event.target.value)} placeholder="RUT emisor" />
                </label>
                <label>
                  Cliente *
                  <select value={draft.clientId} disabled={loadingDocumentSources} onChange={(event) => { updateDraft("clientId", event.target.value); updateDraft("contactId", ""); }} required><option value="">{loadingDocumentSources ? "Cargando clientes…" : "Selecciona cliente"}</option>{documentCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.trade_name || customer.legal_name}{customer.tax_id ? ` · ${customer.tax_id}` : ""}</option>)}</select>
                </label>
                <label>
                  Destinatario
                  <select value={draft.contactId} disabled={!draft.clientId || loadingDocumentSources} onChange={(event) => updateDraft("contactId", event.target.value)}><option value="">Facturación general del cliente</option>{contactsForDraftCustomer.map((contact) => <option key={contact.id} value={contact.id}>{contact.full_name}{contact.contact_area ? ` · ${contact.contact_area}` : ""}</option>)}</select>
                </label>
                <label>
                  RUT destinatario
                  <input value={selectedDraftCustomer?.tax_id || "Se obtiene del cliente seleccionado"} readOnly />
                </label>
                <label>
                  Monto neto *
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={draft.netAmount}
                    onChange={(event) =>
                      updateDraft("netAmount", event.target.value)
                    }
                  />
                </label>
                <label>
                  IVA
                  <input value={money.format(entryVatAmount)} readOnly />
                </label>
                <label>
                  Monto total
                  <input value={money.format(entryTotalAmount)} readOnly />
                </label>
                <label>
                  Adjuntar factura
                  <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(event) => setDocumentFile(event.target.files?.[0] ?? null)} />
                  <small>PDF, JPG o PNG · máximo 50 MB</small>
                </label>
              </div>
              {formError && <p className="form-error">{formError}</p>}
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setShowEntry(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="primary-button">
                  Guardar documento
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {editingRecord && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="entry-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-document-title"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">COBRANZA Y PAGO</span>
                <h2 id="edit-document-title">
                  Documento N° {editingRecord.invoiceNumber ?? "—"}
                </h2>
                <p>
                  Completa el respaldo tributario, corrige el tipo documental y
                  actualiza el estado real, pago directo o ciclo de factoring.
                </p>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => {
                  setEditingRecord(null);
                  setFormError("");
                }}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <form onSubmit={submitDocumentEdit}>
              <div className="form-grid">
                <label>
                  Tipo de documento *
                  <select
                    value={editDraft.documentType}
                    onChange={(event) =>
                      setEditDraft((current) => ({
                        ...current,
                        documentType: event.target.value,
                      }))
                    }
                  >
                    <option value="Factura afecta">Factura afecta</option>
                    <option value="Factura exenta">Factura exenta</option>
                    <option value="Nota de crédito">Nota de crédito</option>
                    <option value="Nota de débito">Nota de débito</option>
                  </select>
                  <small>
                    Al cambiarlo se recalcula IVA y total desde el monto neto.
                  </small>
                </label>
                <label>
                  Estado *
                  <select
                    value={editDraft.status}
                    onChange={(event) =>
                      setEditDraft((current) => ({
                        ...current,
                        status: event.target.value,
                      }))
                    }
                  >
                    <option value="Pendiente">Pendiente</option>
                    <option value="Pagada">Pagada</option>
                    <option value="Factorizada">Factorizada</option>
                    <option value="Pagada al factoring">
                      Pagada al factoring
                    </option>
                    <option value="Recomprada al factoring">
                      Recomprada al factoring
                    </option>
                    <option value="Anulada">Anulada</option>
                    <option value="Nota de crédito">Nota de crédito</option>
                  </select>
                </label>
                <label>
                  Condición del servicio
                  <select
                    value={editDraft.paymentCondition}
                    onChange={(event) =>
                      setEditDraft((current) => ({
                        ...current,
                        paymentCondition: event.target.value,
                      }))
                    }
                  >
                    <option value="">Sin definir</option>
                    <option value="advance">Anticipado</option>
                    <option value="post_service">
                      Vencido / post servicio
                    </option>
                  </select>
                </label>
                <label>
                  Fecha pago directo
                  <input
                    type="date"
                    value={editDraft.paymentDate}
                    onChange={(event) =>
                      setEditDraft((current) => ({
                        ...current,
                        paymentDate: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Medio de pago
                  <input
                    value={editDraft.paymentMethod}
                    onChange={(event) =>
                      setEditDraft((current) => ({
                        ...current,
                        paymentMethod: event.target.value,
                      }))
                    }
                    placeholder="Transferencia, depósito…"
                  />
                </label>
                {[
                  "Factorizada",
                  "Pagada al factoring",
                  "Recomprada al factoring",
                ].includes(editDraft.status) && (
                  <>
                    <label>
                      Entidad de factoring *
                      <select
                        required
                        value={editDraft.factoringCounterpartyId}
                        onChange={(event) =>
                          { const provider = factoringProviders.find((item) => item.id === event.target.value); setEditDraft((current) => ({ ...current, factoringCounterpartyId: event.target.value, factoringEntity: provider?.name ?? "" })); }
                        }
                      ><option value="">Selecciona una empresa existente</option>{factoringProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.taxId ? ` · ${provider.taxId}` : ""}</option>)}</select>
                    </label>
                    <label>
                      Fecha cesión / factoraje
                      <input
                        type="date"
                        value={editDraft.factoredAt}
                        onChange={(event) =>
                          setEditDraft((current) => ({
                            ...current,
                            factoredAt: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Fecha pago al factoring
                      <input
                        type="date"
                        value={editDraft.factoringSettledAt}
                        onChange={(event) =>
                          setEditDraft((current) => ({
                            ...current,
                            factoringSettledAt: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Fecha recompra GEIMSER
                      <input
                        type="date"
                        value={editDraft.factoringRecourseAt}
                        onChange={(event) =>
                          setEditDraft((current) => ({
                            ...current,
                            factoringRecourseAt: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </>
                )}
                <label>
                  Observación
                  <input
                    value={editDraft.notes}
                    onChange={(event) =>
                      setEditDraft((current) => ({
                        ...current,
                        notes: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Respaldo de factura
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                    onChange={(event) =>
                      setEditDocumentFile(event.target.files?.[0] ?? null)
                    }
                  />
                  <small>
                    {attachmentByDocument[editingRecord.id]
                      ? "Al cargar otro archivo, reemplaza el respaldo vigente."
                      : "PDF, JPG o PNG · máximo 50 MB"}
                  </small>
                </label>
              </div>
              {formError && <p className="form-error">{formError}</p>}
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setEditingRecord(null);
                    setFormError("");
                  }}
                >
                  Cancelar
                </button>
                <button type="submit" className="primary-button">
                  Guardar actualización
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {access && <AtlasAssistant organizationId={access.membership.organizationId} />}
    </div>
  );
}
