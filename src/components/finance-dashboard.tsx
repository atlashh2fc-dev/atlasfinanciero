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
import {
  facturasEmitidas2026,
  type InvoiceRecord,
} from "@/data/facturas-emitidas-2026";
import { forecastMonthly2026 } from "@/data/forecast-2026";
import { BillingOperations } from "@/components/billing-operations";
import { AccountsReceivable } from "@/components/accounts-receivable";
import { createClient } from "@/lib/supabase/client";
import { AdministrationConsole } from "@/components/administration-console";
import { PayrollDashboard } from "@/components/payroll-dashboard";
import { CustomerPurchaseOrders } from "@/components/customer-purchase-orders";
import { CustomerProfiles } from "@/components/customer-profiles";
import { ReportsDashboard } from "@/components/reports-dashboard";
import { CostCenterManagement } from "@/components/cost-center-management";
import { ExpensesDashboard } from "@/components/expenses-dashboard";
import { PreinvoiceWorkbench } from "@/components/preinvoice-workbench";
import { TreasuryDashboard } from "@/components/treasury-dashboard";
import { ApprovalInbox } from "@/components/approval-inbox";
import { ProcureToPayWorkbench } from "@/components/procure-to-pay-workbench";
import { FinancialPlanningDashboard } from "@/components/financial-planning-dashboard";
import { FinancialCloseWorkbench } from "@/components/financial-close-workbench";
import { ActivityAuditLog } from "@/components/activity-audit-log";
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
  Facturas:
    "Documentos emitidos, estados, pagos, notas de crédito y evolución neta por período.",
  "OC de clientes":
    "Órdenes de compra recibidas de clientes y saldo disponible después de cada facturación parcial.",
  Recurrentes:
    "Calendario y alertas para que las facturas periódicas estén listas antes de su fecha límite.",
  Prefacturación:
    "Borradores desde servicios contratados, revisión financiera y vínculo con la emisión real.",
  Clientes:
    "Evolución comercial y ficha tributaria, facturación y contactos por área de cada cliente.",
  "Cuentas por cobrar":
    "Cartera pendiente por vencimiento, gestión, compromisos de pago y factoring.",
  Proyecciones:
    "Modelo ERP existente con forecast mensual, escenarios y diferencias contra la información real.",
  "Planificación financiera":
    "Presupuesto versionado, caja semanal de 13 semanas y rentabilidad por cliente y servicio.",
  "Cuentas por pagar":
    "Facturas recibidas, proveedores, vencimientos y registro individual de pagos.",
  "Compras y lotes de pago":
    "Solicitudes, órdenes a proveedor y lotes de pago con aprobación antes de ejecutar.",
  Tesorería:
    "Posición por cuenta, movimientos bancarios y conciliación de cobros y pagos.",
  Remuneraciones: "Costo laboral y dotación sincronizados desde PeopleWork.",
  "Centros de costo":
    "Estructura de imputación, personas y clientes que financian cada unidad o proyecto.",
  Aprobaciones:
    "Bandeja de decisiones para prefacturas, pagos y órdenes de compra con trazabilidad.",
  "Cierre financiero":
    "Checklist, pre-cierre, cierre bloqueado y evidencia auditable por período mensual.",
  Administración: "Organizaciones, usuarios, roles e invitaciones de acceso.",
  "Bitácora de actividad": "Cambios registrados por usuario, entidad, fecha y hora para control administrativo.",
  Reportes:
    "Estado de resultados, evolución y análisis financiero por período.",
};

type Module =
  | "Inicio"
  | "Facturas"
  | "OC de clientes"
  | "Proyecciones"
  | "Planificación financiera"
  | "Clientes"
  | "Cuentas por cobrar"
  | "Recurrentes"
  | "Prefacturación"
  | "Cuentas por pagar"
  | "Compras y lotes de pago"
  | "Tesorería"
  | "Remuneraciones"
  | "Centros de costo"
  | "Aprobaciones"
  | "Cierre financiero"
  | "Reportes"
  | "Administración"
  | "Bitácora de actividad";
const navigationGroups: Array<{ label: string; items: Module[] }> = [
  { label: "RESUMEN", items: ["Inicio"] },
  {
    label: "INGRESOS",
    items: [
      "Clientes",
      "Prefacturación",
      "Facturas",
      "Recurrentes",
      "Cuentas por cobrar",
      "OC de clientes",
    ],
  },
  {
    label: "COMPRAS Y CAJA",
    items: ["Compras y lotes de pago", "Cuentas por pagar", "Tesorería"],
  },
  {
    label: "PLANIFICACIÓN Y ANÁLISIS",
    items: ["Proyecciones", "Planificación financiera", "Centros de costo", "Reportes"],
  },
  {
    label: "PERSONAS Y CONTROL",
    items: ["Remuneraciones", "Aprobaciones", "Cierre financiero", "Administración", "Bitácora de actividad"],
  },
];
type OrganizationRole = "administrator" | "finance" | "operations" | "auditor";
type AccessProfile = {
  user: { email: string | null };
  membership: {
    organizationId: string;
    organizationName: string;
    role: OrganizationRole;
  };
  organizations: Array<{ id: string; name: string; role: OrganizationRole }>;
};

type InvoiceDraft = {
  invoiceNumber: string;
  issueDate: string;
  documentType: string;
  issuer: string;
  issuerRut: string;
  client: string;
  recipient: string;
  recipientRut: string;
  netAmount: string;
  vatAmount: string;
  totalAmount: string;
  status: string;
  paymentCondition: string;
};

type DocumentUpdateDraft = {
  status: string;
  paymentDate: string;
  paymentMethod: string;
  paymentCondition: string;
  notes: string;
  factoringEntity: string;
  factoredAt: string;
  factoringSettledAt: string;
  factoringRecourseAt: string;
};

const blankDraft: InvoiceDraft = {
  invoiceNumber: "",
  issueDate: "",
  documentType: "",
  issuer: "",
  issuerRut: "",
  client: "",
  recipient: "",
  recipientRut: "",
  netAmount: "",
  vatAmount: "",
  totalAmount: "",
  status: "",
  paymentCondition: "",
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

function EmptyModule({
  module,
}: {
  module: Exclude<
    Module,
    | "Inicio"
    | "Facturas"
    | "OC de clientes"
    | "Proyecciones"
    | "Planificación financiera"
    | "Clientes"
    | "Cuentas por cobrar"
    | "Recurrentes"
    | "Prefacturación"
    | "Compras y lotes de pago"
    | "Tesorería"
    | "Remuneraciones"
    | "Centros de costo"
    | "Reportes"
    | "Aprobaciones"
    | "Cierre financiero"
    | "Administración"
    | "Bitácora de actividad"
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
  const hasForecastPlan = selectedYear === 2026;
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
  const [isEvolutionExpanded, setIsEvolutionExpanded] = useState(false);
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
  const customerRecords = useMemo(
    () =>
      customerYear === "Todos"
        ? records
        : records.filter((record) => record.year === Number(customerYear)),
    [records, customerYear],
  );
  const customers = buildCustomerEvolution(customerRecords);
  const totalNet = sumRecognizedNet(customerRecords);
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

  return (
    <main className="dashboard customer-dashboard">
      <section className="headline">
        <div>
          <span className="eyebrow">
            ANÁLISIS COMERCIAL ·{" "}
            {customerYear === "Todos" ? "TODOS LOS AÑOS" : customerYear}
          </span>
          <h1>Clientes y evolución</h1>
          <p>
            Facturas y exentos, menos notas de crédito. Las órdenes de compra no
            se contabilizan como ingreso facturado.
          </p>
        </div>
        <div className="headline-actions">
          <label className="period-picker">
            Año
            <select
              value={customerYear}
              onChange={(event) => {
                setCustomerYear(event.target.value);
                setSelectedPendingClient(null);
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
          <span className="refresh">
            ● {number.format(customerRecords.length)} documentos trazables
          </span>
        </div>
      </section>

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

      <CustomerProfiles organizationId={organizationId} canManage={canManage} />

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
                {customers.map((customer) => (
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
                          customerRecords.filter(
                            (record) => record.month === month,
                          ),
                        ),
                      )}
                    </td>
                  ))}
                  <td className="money-col total-column">
                    <strong>{formatMoney(totalNet)}</strong>
                  </td>
                  <td className="money-col">
                    <strong>{number.format(customerRecords.length)}</strong>
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
                {customers.map((customer) => (
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
                    <strong>{formatMoney(totalNet)}</strong>
                  </td>
                  <td className="money-col">
                    <strong>{number.format(customerRecords.length)}</strong>
                  </td>
                  <td className="money-col">{formatMoney(pendingNet)}</td>
                  <td className="money-col">
                    {number.format(paymentDateCount)}
                  </td>
                  <td>{customerYear === "Todos" ? "Todos" : customerYear}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
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
  factored_at: string | null;
  factoring_settled_at: string | null;
  factoring_recourse_at: string | null;
  origin_account_or_tax_id: string | null;
  destination_bank: string | null;
  destination_account: string | null;
  source_file_name: string | null;
  source_sheet_name: string | null;
  source_row: number | null;
};

function mapStoredDocument(document: StoredDocument): InvoiceRecord {
  return {
    id: document.id,
    invoiceNumber: document.document_number,
    year: document.issue_date ? Number(document.issue_date.slice(0, 4)) : null,
    month: document.issue_date ? monthFromDate(document.issue_date) : null,
    issueDate: document.issue_date,
    documentType: document.document_type,
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
  const [showEntry, setShowEntry] = useState(false);
  const [editingRecord, setEditingRecord] = useState<InvoiceRecord | null>(
    null,
  );
  const [editDraft, setEditDraft] = useState<DocumentUpdateDraft>({
    status: "",
    paymentDate: "",
    paymentMethod: "",
    paymentCondition: "",
    notes: "",
    factoringEntity: "",
    factoredAt: "",
    factoringSettledAt: "",
    factoringRecourseAt: "",
  });
  const [draft, setDraft] = useState<InvoiceDraft>(blankDraft);
  const [formError, setFormError] = useState("");
  const [sessionRecords, setSessionRecords] = useState<InvoiceRecord[]>([]);
  const [databaseRecords, setDatabaseRecords] = useState<
    InvoiceRecord[] | null
  >(null);
  const [access, setAccess] = useState<AccessProfile | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/issued-documents", { cache: "no-store" })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ documents: StoredDocument[] }>)
          : null,
      )
      .then((payload) => {
        if (active && payload)
          setDatabaseRecords(payload.documents.map(mapStoredDocument));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

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

  const records = useMemo(
    () => databaseRecords ?? [...facturasEmitidas2026, ...sessionRecords],
    [databaseRecords, sessionRecords],
  );
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
      status: record.status ?? "",
      paymentDate: record.paymentDate ?? "",
      paymentMethod: record.paymentMethod ?? "",
      paymentCondition: record.paymentCondition ?? "",
      notes: record.notes ?? "",
      factoringEntity: record.factoringEntity ?? "",
      factoredAt: record.factoredAt ?? "",
      factoringSettledAt: record.factoringSettledAt ?? "",
      factoringRecourseAt: record.factoringRecourseAt ?? "",
    });
    setFormError("");
  }

  async function submitDocumentEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingRecord || !editDraft.status.trim()) {
      setFormError("Indica el estado actual del documento.");
      return;
    }
    const response = await fetch("/api/issued-documents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editingRecord.id, ...editDraft }),
    });
    if (!response.ok) {
      setFormError(
        "No fue posible actualizar el documento. Revisa tu sesión y permisos.",
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
    setEditingRecord(null);
    setFormError("");
  }

  async function submitEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !draft.issueDate ||
      !draft.documentType ||
      !draft.issuer ||
      !draft.client ||
      !draft.netAmount ||
      !draft.totalAmount ||
      !draft.status ||
      (draft.documentType.toLocaleLowerCase().includes("factura") &&
        !draft.paymentCondition)
    ) {
      setFormError(
        "Completa fecha, tipo, emisor, cliente, montos, estado y condición del servicio para facturas. No se crearán valores de relleno.",
      );
      return;
    }
    const response = await fetch("/api/issued-documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
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
            : "No fue posible guardar el documento. Revisa tus permisos y los datos ingresados.",
      );
      return;
    }
    const payload = (await response.json()) as {
      document: {
        id: string;
        document_number: string | null;
        issue_date: string;
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
        source_file_name: string;
        source_sheet_name: string;
        source_row: number;
      };
    };
    const created = mapStoredDocument({
      ...payload.document,
      notes: null,
      payment_term_days: null,
      due_date: null,
      due_month: null,
      payment_date: null,
      payment_method: null,
      payment_condition:
        draft.paymentCondition === "advance" ||
        draft.paymentCondition === "post_service"
          ? draft.paymentCondition
          : null,
      factoring_entity: null,
      factored_at: null,
      factoring_settled_at: null,
      factoring_recourse_at: null,
      origin_account_or_tax_id: null,
      destination_bank: null,
      destination_account: null,
      source_file_name: payload.document.source_file_name,
      source_sheet_name: payload.document.source_sheet_name,
      source_row: payload.document.source_row,
    });
    if (databaseRecords)
      setDatabaseRecords((current) =>
        current ? [created, ...current] : [created],
      );
    else setSessionRecords((current) => [created, ...current]);
    setDraft(blankDraft);
    setFormError("");
    setShowEntry(false);
    setActiveModule("Facturas");
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
          (item !== "Centros de costo" || canManageCostCenters) &&
          (item !== "Cuentas por pagar" || canReadExpenses) &&
          (item !== "Compras y lotes de pago" || canReadProcurement) &&
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
                  {item === "Inicio"
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
                            : item === "Clientes"
                                ? "◉"
                                : item === "Cuentas por cobrar"
                                  ? "◷"
                                  : item === "Cuentas por pagar"
                                  ? "▣"
                                  : item === "Compras y lotes de pago"
                                    ? "▤"
                                  : item === "Tesorería"
                                    ? "◒"
                                    : item === "Planificación financiera"
                                      ? "⌁"
                                  : item === "Remuneraciones"
                                      ? "◫"
                                      : item === "Centros de costo"
                                        ? "⊞"
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

        {activeModule === "Inicio" ? (
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
        ) : activeModule === "Clientes" ? (
          <CustomerModule
            records={records}
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
          <BillingOperations />
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
        ) : activeModule === "Compras y lotes de pago" ? (
          <ProcureToPayWorkbench
            organizationId={access?.membership.organizationId ?? null}
            canManage={hasEditPermission}
            canManagePayments={access?.membership.role === "administrator" || access?.membership.role === "finance"}
          />
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
            />
          ) : null
        ) : activeModule === "Bitácora de actividad" ? (
          access?.membership.role === "administrator" ? (
            <ActivityAuditLog organizationId={access.membership.organizationId} />
          ) : null
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
                    onClick={() => setShowEntry(true)}
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
                      <th>Documento</th>
                      <th>Emisión</th>
                      <th>Cliente</th>
                      <th>Tipo</th>
                      <th className="money-col">Neto/exento</th>
                      <th>Estado</th>
                      <th>Origen</th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((record) => (
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
                          {hasEditPermission && databaseRecords ? (
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => startDocumentEdit(record)}
                            >
                              Editar
                            </button>
                          ) : (
                            "—"
                          )}
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
                <span className="eyebrow">REGISTRO MANUAL</span>
                <h2 id="entry-title">Registrar documento</h2>
                <p>
                  El documento se guarda en Atlas sólo con una sesión y
                  membresía autorizadas.
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
                  Tipo documento *
                  <input
                    value={draft.documentType}
                    onChange={(event) =>
                      updateDraft("documentType", event.target.value)
                    }
                    placeholder="Ej. Factura"
                  />
                </label>
                <label>
                  Estado *
                  <input
                    value={draft.status}
                    onChange={(event) =>
                      updateDraft("status", event.target.value)
                    }
                    placeholder="Valor definido por el usuario"
                  />
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
                  <input
                    value={draft.issuer}
                    onChange={(event) =>
                      updateDraft("issuer", event.target.value)
                    }
                  />
                </label>
                <label>
                  RUT emisor
                  <input
                    value={draft.issuerRut}
                    onChange={(event) =>
                      updateDraft("issuerRut", event.target.value)
                    }
                  />
                </label>
                <label>
                  Cliente *
                  <input
                    value={draft.client}
                    onChange={(event) =>
                      updateDraft("client", event.target.value)
                    }
                  />
                </label>
                <label>
                  Destinatario
                  <input
                    value={draft.recipient}
                    onChange={(event) =>
                      updateDraft("recipient", event.target.value)
                    }
                  />
                </label>
                <label>
                  RUT destinatario
                  <input
                    value={draft.recipientRut}
                    onChange={(event) =>
                      updateDraft("recipientRut", event.target.value)
                    }
                  />
                </label>
                <label>
                  Monto neto *
                  <input
                    type="number"
                    min="0"
                    value={draft.netAmount}
                    onChange={(event) =>
                      updateDraft("netAmount", event.target.value)
                    }
                  />
                </label>
                <label>
                  IVA
                  <input
                    type="number"
                    min="0"
                    value={draft.vatAmount}
                    onChange={(event) =>
                      updateDraft("vatAmount", event.target.value)
                    }
                  />
                </label>
                <label>
                  Monto total *
                  <input
                    type="number"
                    min="0"
                    value={draft.totalAmount}
                    onChange={(event) =>
                      updateDraft("totalAmount", event.target.value)
                    }
                  />
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
                  Actualiza el estado real, pago directo o ciclo de factoring
                  sin alterar el monto neto/exento original.
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
                    <option value="Nota de credito">Nota de crédito</option>
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
                      <input
                        value={editDraft.factoringEntity}
                        onChange={(event) =>
                          setEditDraft((current) => ({
                            ...current,
                            factoringEntity: event.target.value,
                          }))
                        }
                        placeholder="Nombre de la entidad"
                      />
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
    </div>
  );
}
