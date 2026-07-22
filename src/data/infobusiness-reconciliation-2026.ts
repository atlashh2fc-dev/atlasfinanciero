import type { InvoiceRecord } from "@/data/facturas-emitidas-2026";

type InfobusinessReconciliation = {
  month: string;
  netToInvoice: number;
  paidGross: number;
  outstandingNet: number;
  outstandingVat: number;
};

// Cuadratura entregada por Finanzas: Forecast Q1 - 2026 móvil.
// El abono se registra en bruto; el saldo exigible es neto pendiente + IVA.
const infobusinessReconciliations: InfobusinessReconciliation[] = [
  { month: "2026-04", netToInvoice: 3_906_331, paidGross: 1_000_000, outstandingNet: 2_906_331, outstandingVat: 742_203 },
  { month: "2026-05", netToInvoice: 14_601_978, paidGross: 12_378_782, outstandingNet: 2_223_196, outstandingVat: 2_774_376 },
  { month: "2026-06", netToInvoice: 15_526_182, paidGross: 13_721_830, outstandingNet: 1_804_352, outstandingVat: 2_953_833 },
  { month: "2026-07", netToInvoice: 16_124_606, paidGross: 12_351_136, outstandingNet: 3_773_470, outstandingVat: 2_953_834 },
];

const monthName = new Intl.DateTimeFormat("es-CL", { month: "long" });

function reconciliationRecord(item: InfobusinessReconciliation): InvoiceRecord {
  const issueDate = `${item.month}-01`;
  const grossAmount = item.netToInvoice + item.outstandingVat;
  return {
    id: `infobusiness-reconciliation-${item.month}`,
    invoiceNumber: "XX",
    year: 2026,
    month: monthName.format(new Date(`${issueDate}T00:00:00`)),
    issueDate,
    documentType: "Cobranza pendiente de regularización",
    issuer: "GEIMSER",
    issuerRut: "77361894-1",
    client: "Infobusiness",
    recipient: "GEO INFORMACIÓN CHILE SPA",
    recipientRut: "77284455-7",
    netAmount: item.netToInvoice,
    vatAmount: item.outstandingVat,
    totalAmount: grossAmount,
    notes: `Conciliación ${monthName.format(new Date(`${issueDate}T00:00:00`))}: neto facturable ${item.netToInvoice}; abono bruto ${item.paidGross}; saldo neto ${item.outstandingNet} + IVA ${item.outstandingVat}.`,
    paymentTermDays: null,
    dueDate: null,
    dueMonth: null,
    status: "Abonada",
    paymentDate: null,
    paymentMethod: "Abonos conciliados",
    originAccountRut: null,
    destinationBank: null,
    destinationAccount: null,
    source: {
      file: "Forecast Q1 - 2026 móvil",
      sheet: "Q1",
      row: 54,
    },
  };
}

function isInfobusiness(record: InvoiceRecord) {
  return /info\s*business/i.test(`${record.client ?? ""} ${record.recipient ?? ""}`);
}

export function reconciledReceivablesForYear(
  records: InvoiceRecord[],
  year: number | null,
) {
  const withoutInfobusiness2026 = records.filter(
    (record) => !(record.year === 2026 && isInfobusiness(record)),
  );
  const reconciled = infobusinessReconciliations
    .filter((item) => year === null || year === 2026)
    .map(reconciliationRecord);
  return [...withoutInfobusiness2026, ...reconciled];
}

export function reconciledPaidAmount(recordId: string) {
  const month = recordId.replace("infobusiness-reconciliation-", "");
  return infobusinessReconciliations.find((item) => item.month === month)?.paidGross ?? 0;
}

export function reconciledBalanceBreakdown(recordId: string) {
  const month = recordId.replace("infobusiness-reconciliation-", "");
  const item = infobusinessReconciliations.find((entry) => entry.month === month);
  return item
    ? { net: item.outstandingNet, vat: item.outstandingVat }
    : null;
}
