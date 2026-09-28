"use client";

import { useEffect, useMemo, useState } from "react";
import { SiiDteIntegration } from "@/components/sii-dte-integration";
import { matchesSearch } from "@/lib/search";
import {
  directPayableCategoryLabel,
  expenseGroup,
  PAYROLL_GROUP_KEY,
  PAYROLL_GROUP_LABEL,
  payrollBreakdown,
  type ExpenseGroup,
} from "@/lib/expense-categories";

type ReceivedDocument = {
  id: string;
  supplier_counterparty_id: string | null;
  supplier_name: string;
  supplier_tax_id: string | null;
  document_number: string | null;
  issue_date: string;
  document_type: string;
  net_amount: number | string;
  vat_amount: number | string;
  additional_tax_amount: number | string;
  total_amount: number | string;
  notes: string | null;
  payment_term_days: number | null;
  due_date: string | null;
  payment_status: string | null;
  payment_method: string | null;
  payment_bank: string | null;
  payment_reference: string | null;
  payment_date: string | null;
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_mime_type: string | null;
  attachment_size: number | null;
  payment_proof_path: string | null;
  payment_proof_name: string | null;
  payment_proof_mime_type: string | null;
  payment_proof_size: number | null;
  sii_document_type: number | null;
  sii_folio: number | string | null;
  sii_received_at: string | null;
  sii_response_deadline: string | null;
  sii_event_status: string | null;
  sii_last_checked_at: string | null;
  // Documento ya respaldado por una cuenta directa (gasto con documento
  // pendiente vinculado): se paga y se cuenta a través de esa cuenta.
  covered_by_direct_payable_id?: string | null;
  covered_by_direct_payable_number?: string | null;
};
type DirectPayable = {
  id: string;
  payable_number: string;
  supplier_counterparty_id: string | null;
  supplier_name: string;
  beneficiary_name?: string | null;
  invoice_number: string | null;
  category: string;
  category_detail: string | null;
  description: string;
  issue_date: string;
  due_date: string | null;
  total_amount: number | string;
  paid_amount?: number | string;
  outstanding_amount?: number | string;
  currency_code: string;
  status: "draft" | "review" | "approved" | "rejected" | "paid";
  notes: string | null;
  payment_reference: string | null;
  paid_at: string | null;
  factoring_issued_document_id: string | null;
  is_reference: boolean;
  document_status?: "not_required" | "pending_document" | "documented";
  expected_document_type?: string | null;
  reference_settled_at: string | null;
  reference_settlement_note: string | null;
};
// Vínculo persistente del flujo documental (tabla received_document_links).
type DocumentLink = {
  id: string;
  source_document_id: string;
  target_document_id: string | null;
  vendor_purchase_order_id: string | null;
  link_type: "credit_note" | "debit_note" | "dispatch_guide" | "purchase_order";
  reference_folio: string | null;
  origin: "dte_reference" | "notes_reference" | "amount_rule" | "manual";
  status: "confirmed" | "suggested";
};
type Payable = {
  id: string;
  source: "received" | "direct";
  // Remuneraciones (sueldos, leyes sociales, finiquitos) no son gasto de
  // proveedores: se agrupan aparte como "Remuneraciones".
  expense_group: ExpenseGroup;
  category: string | null;
  category_detail: string | null;
  supplier_counterparty_id: string | null;
  supplier_name: string;
  supplier_tax_id: string | null;
  document_number: string | null;
  payable_number?: string | null;
  issue_date: string;
  document_type: string;
  net_amount: number | string;
  vat_amount: number | string;
  additional_tax_amount: number | string;
  total_amount: number | string;
  paid_amount?: number | string;
  outstanding_amount?: number | string;
  currency_code: string;
  notes: string | null;
  payment_term_days: number | null;
  due_date: string | null;
  payment_status: string | null;
  payment_method: string | null;
  payment_bank: string | null;
  payment_reference: string | null;
  payment_date: string | null;
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_mime_type: string | null;
  attachment_size: number | null;
  payment_proof_path?: string | null;
  payment_proof_name?: string | null;
  payment_proof_mime_type?: string | null;
  payment_proof_size?: number | null;
  sii_document_type: number | null;
  sii_folio: number | string | null;
  sii_received_at: string | null;
  sii_response_deadline: string | null;
  sii_event_status: string | null;
  sii_last_checked_at: string | null;
  workflow_status: DirectPayable["status"] | null;
  factoring_issued_document_id: string | null;
  is_reference: boolean;
  reference_settled_at: string | null;
  reference_settlement_note: string | null;
};
type DocumentDraft = {
  supplierName: string;
  supplierTaxId: string;
  documentNumber: string;
  documentType: string;
  issueDate: string;
  dueDate: string;
  paymentTermDays: string;
  netAmount: string;
  vatAmount: string;
  additionalTaxAmount: string;
  siiDocumentType: string;
  siiFolio: string;
  notes: string;
};
type DirectAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  signedUrl: string | null;
};
export type PayablePaymentSelection = {
  receivedDocumentIds: string[];
  directPayableIds: string[];
};

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});
const date = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const amount = (value: number | string | null | undefined) =>
  Number(value ?? 0);
const displayDate = (value: string | null) =>
  value ? date.format(new Date(`${value}T00:00:00`)) : "—";
const displayAmount = (value: number | string, currency: string) =>
  currency === "UF"
    ? `${Number(value).toLocaleString("es-CL", { maximumFractionDigits: 4 })} UF`
    : money.format(amount(value));
const normal = (value: string | null | undefined) =>
  value?.trim().toLocaleLowerCase() ?? "";
const directStatusLabel: Record<DirectPayable["status"], string> = {
  draft: "Borrador",
  review: "Pendiente de aprobación",
  approved: "Aprobada para pago",
  rejected: "Rechazada",
  paid: "Pagada",
};
const isCredit = (document: Payable) =>
  normal(document.document_type).includes("nota de credito");
const isGuide = (document: Payable) =>
  normal(document.document_type).includes("guia de despacho");
const isInvoice = (document: Payable) =>
  !isCredit(document) && !isGuide(document);
const signedTotal = (document: Payable) =>
  isCredit(document)
    ? -amount(document.total_amount)
    : isGuide(document)
      ? 0
      : amount(document.total_amount);
const statusClass = (status: string | null) =>
  normal(status).includes("pagada") || normal(status).includes("liquidada")
    ? "status paid"
    : normal(status).includes("pendiente")
      ? "status pending"
      : normal(status).includes("rechazada") || normal(status).includes("nota")
        ? "status cancelled"
        : "status neutral";
const countsAsExpense = (item: Payable) =>
  item.source === "received" ||
  (!item.factoring_issued_document_id &&
    (item.workflow_status === "approved" || item.workflow_status === "paid"));
const supplierKey = (
  item: Pick<
    Payable,
    | "expense_group"
    | "supplier_counterparty_id"
    | "supplier_tax_id"
    | "supplier_name"
  >,
) =>
  item.expense_group === "payroll"
    ? PAYROLL_GROUP_KEY
    : item.supplier_counterparty_id || item.supplier_tax_id || item.supplier_name;
type Queue =
  | "todo"
  | "decidir"
  | "aprobar"
  | "pagar"
  | "pagadas"
  | "referencial";
const queueLabels: Record<Queue, string> = {
  todo: "Todo",
  decidir: "Decidir SII",
  aprobar: "Aprobar",
  pagar: "Pagar",
  pagadas: "Pagadas",
  referencial: "Sin pago directo",
};
const queueHints: Record<Queue, string> = {
  todo: "Todos los documentos del periodo filtrado.",
  decidir: "Documentos recibidos que esperan aceptación o reclamo ante el SII.",
  aprobar: "Cuentas directas en borrador o revisión que requieren aprobación.",
  pagar: "Documentos aprobados con saldo por pagar.",
  pagadas: "Documentos pagados, liquidados o anulados.",
  referencial:
    "Documentos que se registran pero no generan un pago propio: facturas cedidas en factoring, guías de despacho, notas de crédito aplicadas y facturas anuladas por nota de crédito.",
};
const isSettled = (item: Pick<Payable, "payment_status">) => {
  const status = normal(item.payment_status);
  return (
    status.includes("pagada") ||
    status.includes("liquidada") ||
    status.includes("anulada") ||
    status.includes("nota de crédito") ||
    status.includes("nota de credito")
  );
};
const outstandingOf = (item: Payable) =>
  item.source === "direct"
    ? amount(item.outstanding_amount ?? item.total_amount)
    : amount(item.total_amount);
const parseAnnulledFolio = (notes: string | null) =>
  notes?.match(/anula\s+factura\s*(?:n[°º]?\s*)?(\d+)/i)?.[1] ?? null;

export function ExpensesDashboard({
  organizationId,
  canManage,
  canConfigureSii,
  onPreparePayments,
}: {
  organizationId: string | null;
  canManage: boolean;
  canConfigureSii: boolean;
  onPreparePayments?: (selection: PayablePaymentSelection) => void;
}) {
  const onPrepareReceivedDocumentPayment = onPreparePayments
    ? (documentId: string) =>
        onPreparePayments({
          receivedDocumentIds: [documentId],
          directPayableIds: [],
        })
    : undefined;
  const [documents, setDocuments] = useState<ReceivedDocument[]>([]);
  const [directPayables, setDirectPayables] = useState<DirectPayable[]>([]);
  const [documentLinks, setDocumentLinks] = useState<DocumentLink[]>([]);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [supplier, setSupplier] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [referenceToSettle, setReferenceToSettle] = useState<Payable | null>(
    null,
  );
  const [referenceDate, setReferenceDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [referenceNote, setReferenceNote] = useState("");
  const [savingReference, setSavingReference] = useState(false);
  const [openingDocumentId, setOpeningDocumentId] = useState<string | null>(
    null,
  );
  const [selectedDocument, setSelectedDocument] =
    useState<ReceivedDocument | null>(null);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [paymentProofUrl, setPaymentProofUrl] = useState<string | null>(null);
  const [documentDraft, setDocumentDraft] = useState<DocumentDraft | null>(
    null,
  );
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [savingDocument, setSavingDocument] = useState(false);
  const [directPayableDetail, setDirectPayableDetail] =
    useState<Payable | null>(null);
  const [directAttachments, setDirectAttachments] = useState<
    DirectAttachment[]
  >([]);
  const [directSupplierName, setDirectSupplierName] = useState("");
  const [directInvoiceNumber, setDirectInvoiceNumber] = useState("");
  const [directAttachmentFile, setDirectAttachmentFile] = useState<File | null>(
    null,
  );
  const [loadingDirectAttachments, setLoadingDirectAttachments] =
    useState(false);
  const [savingDirectPayable, setSavingDirectPayable] = useState(false);
  const [queueFilter, setQueueFilter] = useState<Queue>("todo");
  const [siiOpen, setSiiOpen] = useState(false);
  const [expandedSuppliers, setExpandedSuppliers] = useState<Set<string>>(
    new Set(),
  );
  const [selectedPaymentKeys, setSelectedPaymentKeys] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    if (!organizationId) {
      setDocuments([]);
      setDirectPayables([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    fetch(
      `/api/received-documents?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then(async (response) =>
        response.ok
          ? (response.json() as Promise<{
              documents: ReceivedDocument[];
              directPayables: DirectPayable[];
              documentLinks?: DocumentLink[];
            }>)
          : Promise.reject(new Error("Unable to load accounts payable")),
      )
      .then((payload) => {
        if (active) {
          setDocuments(payload.documents ?? []);
          setDirectPayables(payload.directPayables ?? []);
          setDocumentLinks(payload.documentLinks ?? []);
          setMessage("");
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            "No fue posible cargar las cuentas por pagar y proveedores.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);

  async function refreshDocuments() {
    if (!organizationId) return;
    const response = await fetch(
      `/api/received-documents?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    );
    const payload = (await response.json().catch(() => null)) as {
      documents?: ReceivedDocument[];
      directPayables?: DirectPayable[];
      documentLinks?: DocumentLink[];
    } | null;
    if (!response.ok || !payload?.documents) {
      setMessage("No fue posible refrescar los documentos recibidos.");
      return;
    }
    setDocuments(payload.documents);
    if (payload.directPayables) setDirectPayables(payload.directPayables);
    if (payload.documentLinks) setDocumentLinks(payload.documentLinks);
  }

  const payables = useMemo<Payable[]>(
    () => [
      // Una factura cubierta por una cuenta directa ya está representada por
      // esa cuenta: listarla también la contaría y pagaría dos veces.
      ...documents
        .filter((document) => !document.covered_by_direct_payable_id)
        .map((document) => ({
        ...document,
        source: "received" as const,
        expense_group: "supplier" as const,
        category: null,
        category_detail: null,
        currency_code: "CLP",
        workflow_status: null,
        factoring_issued_document_id: null,
        is_reference: false,
        reference_settled_at: null,
        reference_settlement_note: null,
      })),
      ...directPayables.map((payable) => {
        const group = expenseGroup(payable.category);
        return {
          id: payable.id,
          source: "direct" as const,
          expense_group: group,
          category: payable.category,
          category_detail: payable.category_detail,
          supplier_counterparty_id: payable.supplier_counterparty_id,
          // En remuneraciones el acreedor es la persona o institución beneficiaria.
          supplier_name:
            group === "payroll"
              ? payable.beneficiary_name || payable.supplier_name
              : payable.supplier_name,
          supplier_tax_id: null,
          document_number: payable.invoice_number || payable.payable_number,
          payable_number: payable.payable_number,
          issue_date: payable.issue_date,
          document_type: payable.is_reference
            ? "Referencia de factoring"
            : group === "payroll"
              ? `Remuneración · ${directPayableCategoryLabel(payable.category, payable.category_detail)}`
              : payable.document_status === "pending_document"
                ? `Gasto con documento pendiente${payable.expected_document_type ? ` (${payable.expected_document_type.toLowerCase()})` : ""}`
                : payable.document_status === "documented"
                  ? "Cuenta directa documentada"
                  : "Cuenta por pagar directa",
          net_amount: payable.total_amount,
          vat_amount: 0,
          additional_tax_amount: 0,
          total_amount: payable.total_amount,
          paid_amount: payable.paid_amount,
          outstanding_amount: payable.outstanding_amount,
          currency_code: payable.currency_code,
          notes: payable.notes || payable.description,
          payment_term_days: null,
          due_date: payable.due_date,
          payment_status: payable.is_reference
            ? payable.reference_settled_at
              ? "Liquidada (referencial)"
              : "Pendiente de referencia"
            : payable.status === "paid"
              ? "Pagada"
              : amount(payable.paid_amount ?? 0) > 0
                ? "Abono registrado"
                : directStatusLabel[payable.status],
          payment_method: payable.is_reference
            ? "Control de factoring"
            : payable.status === "paid" || amount(payable.paid_amount ?? 0) > 0
              ? "Orden de pago"
              : null,
          payment_bank: null,
          payment_reference: payable.is_reference
            ? payable.reference_settlement_note
            : payable.payment_reference,
          payment_date: payable.is_reference
            ? (payable.reference_settled_at?.slice(0, 10) ?? null)
            : (payable.paid_at?.slice(0, 10) ?? null),
          attachment_path: null,
          attachment_name: null,
          attachment_mime_type: null,
          attachment_size: null,
          sii_document_type: null,
          sii_folio: null,
          sii_received_at: null,
          sii_response_deadline: null,
          sii_event_status: null,
          sii_last_checked_at: null,
          workflow_status: payable.status,
          factoring_issued_document_id: payable.factoring_issued_document_id,
          is_reference: payable.is_reference,
          reference_settled_at: payable.reference_settled_at,
          reference_settlement_note: payable.reference_settlement_note,
        };
      }),
    ],
    [documents, directPayables],
  );
  // Vinculación documental persistida en la base (received_document_links):
  // NC/ND con su factura, guías con la factura que las cobra y referencias a
  // OC. La base la recalcula al registrar o corregir cualquier documento.
  const netting = useMemo(() => {
    const creditLinks = new Map<string, string>();
    const invoiceNetted = new Map<string, string>();
    const guideLinks = new Map<string, string>();
    const suggestedLinks = new Map<string, string>();
    const purchaseOrders = new Map<string, string[]>();
    const creditedAmount = new Map<string, number>();
    const byId = new Map(
      payables
        .filter((item) => item.source === "received")
        .map((item) => [item.id, item]),
    );
    const numberById = new Map(
      payables.map((item) => [item.id, item.document_number]),
    );
    for (const link of documentLinks) {
      if (link.link_type === "purchase_order") {
        if (link.reference_folio)
          purchaseOrders.set(link.source_document_id, [
            ...(purchaseOrders.get(link.source_document_id) ?? []),
            link.reference_folio,
          ]);
        continue;
      }
      const target = link.target_document_id;
      if (!target) continue;
      if (link.status === "suggested") {
        suggestedLinks.set(link.source_document_id, target);
        continue;
      }
      if (link.link_type === "dispatch_guide") {
        guideLinks.set(link.source_document_id, target);
        continue;
      }
      creditLinks.set(link.source_document_id, target);
      if (link.link_type === "credit_note") {
        const credit = byId.get(link.source_document_id);
        creditedAmount.set(
          target,
          (creditedAmount.get(target) ?? 0) +
            (credit ? amount(credit.total_amount) : 0),
        );
        invoiceNetted.set(target, link.source_document_id);
      }
    }
    // Una NC parcial (abono) no anula la factura: sólo sale de "Pagar" si
    // las notas de crédito cubren el total.
    for (const [invoiceId] of invoiceNetted) {
      const invoice = byId.get(invoiceId);
      if (
        invoice &&
        (creditedAmount.get(invoiceId) ?? 0) < amount(invoice.total_amount) - 1
      )
        invoiceNetted.delete(invoiceId);
    }
    // Folios relacionados de cada documento, para que buscar el folio de una
    // guía, NC u OC encuentre también la factura y viceversa.
    const relatedFolios = new Map<string, string[]>();
    const relate = (id: string, folio: string | null | undefined) => {
      if (folio) relatedFolios.set(id, [...(relatedFolios.get(id) ?? []), folio]);
    };
    for (const link of documentLinks) {
      if (link.status !== "confirmed") continue;
      if (link.target_document_id) {
        relate(link.source_document_id, numberById.get(link.target_document_id));
        relate(link.target_document_id, numberById.get(link.source_document_id));
      } else relate(link.source_document_id, link.reference_folio);
    }
    return {
      creditLinks,
      invoiceNetted,
      guideLinks,
      suggestedLinks,
      purchaseOrders,
      creditedAmount,
      relatedFolios,
      numberById,
    };
  }, [payables, documentLinks]);

  const years = useMemo(
    () =>
      [...new Set(payables.map((item) => item.issue_date.slice(0, 4)))].sort(
        (a, b) => b.localeCompare(a),
      ),
    [payables],
  );
  const suppliers = useMemo(
    () =>
      [
        ...new Map(payables.map((item) => [supplierKey(item), item])).values(),
      ].sort((a, b) => a.supplier_name.localeCompare(b.supplier_name, "es")),
    [payables],
  );
  const statuses = useMemo(
    () =>
      [
        ...new Set(
          payables
            .map((item) => item.payment_status)
            .filter((item): item is string => Boolean(item)),
        ),
      ].sort((a, b) => a.localeCompare(b, "es")),
    [payables],
  );
  const visible = useMemo(
    () =>
      payables.filter((item) => {
        // Una búsqueda activa recorre todos los años: un folio antiguo no
        // debe quedar oculto por el filtro de año por defecto.
        const matchesYear =
          search.trim() !== "" ||
          year === "all" ||
          item.issue_date.startsWith(`${year}-`);
        const matchesSupplier =
          supplier === "all" || supplierKey(item) === supplier;
        const matchesStatus =
          status === "all" || item.payment_status === status;
        return (
          matchesYear &&
          matchesSupplier &&
          matchesStatus &&
          matchesSearch(search, [
            item.supplier_name,
            item.supplier_tax_id,
            item.document_number,
            item.sii_folio,
            item.payable_number,
            item.notes,
            ...(netting.relatedFolios.get(item.id) ?? []),
            ...(netting.purchaseOrders.get(item.id) ?? []).map(
              (folio) => `OC ${folio}`,
            ),
          ])
        );
      }),
    [payables, year, supplier, status, search, netting],
  );
  const summary = useMemo(() => {
    const recognized = visible
      .filter(countsAsExpense)
      .filter((item) => item.currency_code === "CLP");
    const invoices = recognized.filter(isInvoice);
    const paid = invoices.reduce(
      (total, item) =>
        total +
        (item.source === "direct"
          ? amount(item.paid_amount ?? 0)
          : normal(item.payment_status).includes("pagada")
            ? amount(item.total_amount)
            : 0),
      0,
    );
    const expense = recognized.reduce(
      (total, item) => total + signedTotal(item),
      0,
    );
    const payroll = recognized
      .filter((item) => item.expense_group === "payroll")
      .reduce((total, item) => total + signedTotal(item), 0);
    return {
      expense,
      payroll,
      paid,
      pending: expense - paid,
      invoices: invoices.length,
      credits: recognized.filter(isCredit).length,
      suppliers: new Set(
        visible
          .filter((item) => item.expense_group === "supplier")
          .map(supplierKey),
      ).size,
      directPendingApproval: visible.filter(
        (item) => item.source === "direct" && item.workflow_status === "review",
      ).length,
    };
  }, [visible]);
  const supplierSummary = useMemo(() => {
    const bySupplier = new Map<
      string,
      { name: string; taxId: string | null; documents: number; total: number }
    >();
    for (const item of visible
      .filter(countsAsExpense)
      .filter(
        (item) =>
          item.currency_code === "CLP" &&
          !isGuide(item) &&
          item.expense_group === "supplier",
      )) {
      const key = supplierKey(item);
      const current = bySupplier.get(key) ?? {
        name: item.supplier_name,
        taxId: item.supplier_tax_id,
        documents: 0,
        total: 0,
      };
      current.documents += 1;
      current.total += signedTotal(item);
      bySupplier.set(key, current);
    }
    return [...bySupplier.values()];
  }, [visible]);
  // Sueldos, leyes sociales y finiquitos: cuenta 610200, fuera de la
  // concentración de proveedores.
  const payrollSummary = useMemo(
    () =>
      payrollBreakdown(
        visible
          .filter(countsAsExpense)
          .filter(
            (item) =>
              item.currency_code === "CLP" && item.expense_group === "payroll",
          )
          .map((item) => ({ category: item.category, total: signedTotal(item) })),
      ),
    [visible],
  );

  const todayValue = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  }, []);
  const daysUntilDue = (item: Payable) =>
    item.due_date
      ? Math.round(
          (new Date(`${item.due_date}T00:00:00`).valueOf() - todayValue) /
            86_400_000,
        )
      : null;


  const queueOf = (item: Payable): Exclude<Queue, "todo"> => {
    if (item.is_reference || isGuide(item)) return "referencial";
    if (isCredit(item))
      return netting.creditLinks.has(item.id) ? "referencial" : "pagar";
    if (netting.invoiceNetted.has(item.id)) return "referencial";
    if (
      item.source === "received" &&
      item.sii_document_type &&
      item.sii_folio &&
      !item.sii_event_status
    )
      return "decidir";
    if (
      item.source === "direct" &&
      (item.workflow_status === "review" || item.workflow_status === "draft")
    )
      return "aprobar";
    if (isSettled(item)) return "pagadas";
    return "pagar";
  };

  const queued = useMemo(
    () => visible.map((item) => ({ item, queue: queueOf(item) })),
    [visible, netting],
  );

  const isSelectableForPayment = (item: Payable) =>
    queueOf(item) === "pagar" &&
    !item.is_reference &&
    !isCredit(item) &&
    !isGuide(item) &&
    !isSettled(item) &&
    item.currency_code === "CLP" &&
    (item.source === "received" || item.workflow_status === "approved");
  const paymentKey = (item: Payable) => `${item.source}:${item.id}`;
  const selectableVisiblePayables = useMemo(
    () =>
      queued
        .filter(
          (entry) => queueFilter === "todo" || entry.queue === queueFilter,
        )
        .map((entry) => entry.item)
        .filter(isSelectableForPayment),
    [queued, queueFilter],
  );
  const selectedPayables = useMemo(
    () =>
      payables.filter(
        (item) =>
          selectedPaymentKeys.has(paymentKey(item)) &&
          isSelectableForPayment(item),
      ),
    [payables, selectedPaymentKeys, netting],
  );
  const selectedPaymentTotal = useMemo(
    () =>
      selectedPayables.reduce(
        (total, item) =>
          total + (item.currency_code === "CLP" ? outstandingOf(item) : 0),
        0,
      ),
    [selectedPayables],
  );
  function togglePaymentSelection(items: Payable[]) {
    const selectable = items.filter(isSelectableForPayment);
    setSelectedPaymentKeys((current) => {
      const next = new Set(current);
      const shouldSelect = selectable.some(
        (item) => !next.has(paymentKey(item)),
      );
      for (const item of selectable) {
        if (shouldSelect) next.add(paymentKey(item));
        else next.delete(paymentKey(item));
      }
      return next;
    });
  }

  function prepareSelectedPayments() {
    if (!onPreparePayments || !selectedPayables.length) return;
    onPreparePayments({
      receivedDocumentIds: selectedPayables
        .filter((item) => item.source === "received")
        .map((item) => item.id),
      directPayableIds: selectedPayables
        .filter((item) => item.source === "direct")
        .map((item) => item.id),
    });
  }

  const queueSummary = useMemo(() => {
    const counts: Record<Queue, number> = {
      todo: queued.length,
      decidir: 0,
      aprobar: 0,
      pagar: 0,
      pagadas: 0,
      referencial: 0,
    };
    let overdue = 0,
      overdueCount = 0,
      dueSoon = 0,
      dueSoonCount = 0,
      pendingTotal = 0,
      approvalTotal = 0;
    for (const { item, queue } of queued) {
      counts[queue] += 1;
      if (
        (queue === "pagar" || queue === "decidir") &&
        item.currency_code === "CLP" &&
        !isSettled(item)
      ) {
        const value = isCredit(item)
          ? -outstandingOf(item)
          : outstandingOf(item);
        pendingTotal += value;
        const days = daysUntilDue(item);
        if (days !== null && days < 0) {
          overdue += value;
          overdueCount += 1;
        } else if (days !== null && days <= 7) {
          dueSoon += value;
          dueSoonCount += 1;
        }
      }
      if (queue === "aprobar" && item.currency_code === "CLP")
        approvalTotal += amount(item.total_amount);
    }
    return {
      counts,
      overdue,
      overdueCount,
      dueSoon,
      dueSoonCount,
      pendingTotal,
      approvalTotal,
    };
  }, [queued]);

  type DisplayEntry = {
    item?: Payable;
    group?: {
      key: string;
      name: string;
      taxId: string | null;
      items: Payable[];
      total: number;
      first: string;
      last: string;
      overdue: number;
    };
  };
  const displayItems = useMemo<DisplayEntry[]>(() => {
    const dueRank = (item: Payable) => {
      const days = daysUntilDue(item);
      return days === null ? 9_999 : days;
    };
    const list = queued.filter(
      (entry) => queueFilter === "todo" || entry.queue === queueFilter,
    );
    const items =
      queueFilter === "pagar"
        ? [...list]
            .sort((a, b) => dueRank(a.item) - dueRank(b.item))
            .map((entry) => entry.item)
        : list.map((entry) => entry.item);
    if (queueFilter !== "pagar") return items.map((item) => ({ item }));
    const counts = new Map<string, number>();
    for (const item of items)
      counts.set(supplierKey(item), (counts.get(supplierKey(item)) ?? 0) + 1);
    const rendered = new Set<string>();
    const entries: DisplayEntry[] = [];
    for (const item of items) {
      const key = supplierKey(item);
      if ((counts.get(key) ?? 0) <= 3) {
        entries.push({ item });
        continue;
      }
      if (rendered.has(key)) continue;
      rendered.add(key);
      const groupItems = items.filter(
        (candidate) => supplierKey(candidate) === key,
      );
      const dates = groupItems.map((candidate) => candidate.issue_date).sort();
      entries.push({
        group: {
          key,
          name: key === PAYROLL_GROUP_KEY ? PAYROLL_GROUP_LABEL : item.supplier_name,
          taxId: key === PAYROLL_GROUP_KEY ? null : item.supplier_tax_id,
          items: groupItems,
          total: groupItems.reduce(
            (total, candidate) =>
              total +
              (candidate.currency_code === "CLP"
                ? outstandingOf(candidate)
                : 0),
            0,
          ),
          first: dates[0],
          last: dates[dates.length - 1],
          overdue: groupItems.filter((candidate) => {
            const days = daysUntilDue(candidate);
            return days !== null && days < 0;
          }).length,
        },
      });
      if (expandedSuppliers.has(key))
        for (const groupItem of groupItems) entries.push({ item: groupItem });
    }
    return entries;
  }, [queued, queueFilter, expandedSuppliers]);

  const agingBadge = (item: Payable) => {
    if (item.is_reference || isGuide(item) || isCredit(item) || isSettled(item))
      return null;
    const days = daysUntilDue(item);
    if (days === null) return null;
    if (days < 0)
      return { text: `Vencida hace ${-days} día(s)`, negative: true };
    if (days <= 7)
      return {
        text: days === 0 ? "Vence hoy" : `Vence en ${days} día(s)`,
        negative: false,
      };
    return null;
  };

  const linkNote = (item: Payable) => {
    const notes: string[] = [];
    const creditTarget = netting.creditLinks.get(item.id);
    if (creditTarget)
      notes.push(
        `${isCredit(item) ? "Aplicada a" : "Ajusta"} la factura ${netting.numberById.get(creditTarget) || ""}`.trim(),
      );
    const nettedBy = netting.invoiceNetted.get(item.id);
    if (nettedBy)
      notes.push(`Anulada por NC ${netting.numberById.get(nettedBy) || ""}`.trim());
    else if (netting.creditedAmount.has(item.id))
      notes.push(
        `NC aplicadas por ${money.format(netting.creditedAmount.get(item.id) ?? 0)}`,
      );
    const guideTarget = netting.guideLinks.get(item.id);
    if (guideTarget)
      notes.push(
        `Cobrada en factura ${netting.numberById.get(guideTarget) || ""} · sin doble conteo`.trim(),
      );
    const suggested = netting.suggestedLinks.get(item.id);
    if (suggested)
      notes.push(
        `Posible vínculo con factura ${netting.numberById.get(suggested) || ""} (por confirmar)`.trim(),
      );
    const orders = netting.purchaseOrders.get(item.id);
    if (orders?.length) notes.push(`OC ${orders.join(", ")}`);
    return notes.length ? notes.join(" · ") : null;
  };
  // Explica por qué un documento cae en "Sin pago directo" y no en "Pagar".
  const referenceReason = (item: Payable) => {
    if (item.is_reference)
      return "Factura cedida en factoring: la paga el factoring; aquí solo se controla su liquidación.";
    if (isGuide(item) && amount(item.total_amount) === 0)
      return "Guía sin valor (entrega o retiro): respalda un movimiento físico, no genera factura ni pago.";
    if (isGuide(item))
      return netting.guideLinks.has(item.id)
        ? "Guía de despacho: se paga a través de su factura vinculada."
        : "Guía de despacho: no se paga; queda a la espera de su factura.";
    if (netting.creditLinks.has(item.id))
      return "Nota de crédito ya aplicada a su factura: no genera pago ni descuento adicional.";
    if (netting.invoiceNetted.has(item.id))
      return "Factura anulada por nota de crédito: no hay saldo que pagar.";
    return null;
  };

  const toggleSupplier = (key: string) =>
    setExpandedSuppliers((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const siiPendingDecisions = queueSummary.counts.decidir;

  function openReferenceControl(item: Payable) {
    setReferenceToSettle(item);
    setReferenceDate(
      item.reference_settled_at?.slice(0, 10) ??
        new Date().toISOString().slice(0, 10),
    );
    setReferenceNote(item.reference_settlement_note ?? "");
    setMessage("");
  }

  function closeDocumentDetail() {
    setSelectedDocument(null);
    setDocumentUrl(null);
    setPaymentProofUrl(null);
    setDocumentDraft(null);
    setAttachmentFile(null);
  }

  async function openDocumentDetail(item: ReceivedDocument) {
    setSelectedDocument(item);
    setDocumentUrl(null);
    setPaymentProofUrl(null);
    setAttachmentFile(null);
    setDocumentDraft({
      supplierName: item.supplier_name,
      supplierTaxId: item.supplier_tax_id ?? "",
      documentNumber: item.document_number ?? "",
      documentType: item.document_type,
      issueDate: item.issue_date,
      dueDate: item.due_date ?? "",
      paymentTermDays: item.payment_term_days?.toString() ?? "",
      netAmount: amount(item.net_amount).toString(),
      vatAmount: amount(item.vat_amount).toString(),
      additionalTaxAmount: amount(item.additional_tax_amount).toString(),
      siiDocumentType: item.sii_document_type?.toString() ?? "",
      siiFolio: item.sii_folio?.toString() ?? "",
      notes: item.notes ?? "",
    });
    if (!organizationId || (!item.attachment_path && !item.payment_proof_path))
      return;
    setOpeningDocumentId(item.id);
    setMessage("");
    const [documentResponse, proofResponse] = await Promise.all([
      item.attachment_path
        ? fetch(
            `/api/received-documents?organizationId=${encodeURIComponent(organizationId)}&fileId=${encodeURIComponent(item.id)}`,
            { cache: "no-store" },
          )
        : Promise.resolve(null),
      item.payment_proof_path
        ? fetch(
            `/api/received-documents?organizationId=${encodeURIComponent(organizationId)}&fileId=${encodeURIComponent(item.id)}&fileKind=payment-proof`,
            { cache: "no-store" },
          )
        : Promise.resolve(null),
    ]);
    const payload = documentResponse
      ? ((await documentResponse.json().catch(() => null)) as {
          signedUrl?: string;
        } | null)
      : null;
    const proofPayload = proofResponse
      ? ((await proofResponse.json().catch(() => null)) as {
          signedUrl?: string;
        } | null)
      : null;
    setOpeningDocumentId(null);
    if (documentResponse && (!documentResponse.ok || !payload?.signedUrl)) {
      setMessage("No fue posible abrir el respaldo de esta factura.");
    }
    if (payload?.signedUrl) setDocumentUrl(payload.signedUrl);
    if (proofPayload?.signedUrl) setPaymentProofUrl(proofPayload.signedUrl);
  }

  async function saveDocumentDetail() {
    if (!organizationId || !selectedDocument || !documentDraft || !canManage)
      return;
    setSavingDocument(true);
    setMessage("");
    const updateResponse = await fetch("/api/received-documents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_received_document",
        organizationId,
        documentId: selectedDocument.id,
        ...documentDraft,
      }),
    });
    const updatePayload = (await updateResponse.json().catch(() => null)) as {
      document?: ReceivedDocument;
    } | null;
    if (!updateResponse.ok || !updatePayload?.document) {
      setSavingDocument(false);
      setMessage("No fue posible guardar los datos de la factura.");
      return;
    }
    if (attachmentFile) {
      const form = new FormData();
      form.set("organizationId", organizationId);
      form.set("recordId", selectedDocument.id);
      form.set("kind", "received");
      form.set("invoiceNumber", documentDraft.documentNumber);
      form.set("file", attachmentFile);
      const uploadResponse = await fetch("/api/document-normalization", {
        method: "POST",
        body: form,
      });
      if (!uploadResponse.ok) {
        setSavingDocument(false);
        setMessage(
          "Los datos se guardaron, pero no fue posible cargar el respaldo.",
        );
        return;
      }
    }
    const refreshedResponse = await fetch(
      `/api/received-documents?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    );
    const refreshedPayload = (await refreshedResponse
      .json()
      .catch(() => null)) as {
      documents?: ReceivedDocument[];
      documentLinks?: DocumentLink[];
    } | null;
    if (refreshedResponse.ok && refreshedPayload?.documents) {
      setDocuments(refreshedPayload.documents);
      if (refreshedPayload.documentLinks)
        setDocumentLinks(refreshedPayload.documentLinks);
    }
    setSavingDocument(false);
    closeDocumentDetail();
    setMessage("Factura actualizada correctamente.");
  }

  async function loadDirectAttachments(payableId: string) {
    if (!organizationId) return;
    setLoadingDirectAttachments(true);
    const response = await fetch(
      `/api/direct-payable-attachments?organizationId=${encodeURIComponent(organizationId)}&payableId=${encodeURIComponent(payableId)}`,
      { cache: "no-store" },
    );
    const payload = (await response.json().catch(() => null)) as {
      files?: DirectAttachment[];
    } | null;
    setLoadingDirectAttachments(false);
    if (!response.ok || !payload?.files) {
      setMessage("No fue posible cargar los respaldos de esta cuenta.");
      return;
    }
    setDirectAttachments(payload.files);
  }

  function closeDirectPayableDetail() {
    setDirectPayableDetail(null);
    setDirectAttachments([]);
    setDirectAttachmentFile(null);
    setDirectInvoiceNumber("");
    setDirectSupplierName("");
  }

  function openDirectPayableDetail(item: Payable) {
    if (item.source !== "direct") return;
    setDirectPayableDetail(item);
    setDirectSupplierName(item.supplier_name);
    setDirectInvoiceNumber(item.document_number ?? "");
    setDirectAttachmentFile(null);
    setDirectAttachments([]);
    void loadDirectAttachments(item.id);
  }

  async function saveDirectPayableDetail() {
    if (!organizationId || !directPayableDetail || !canManage) return;
    setSavingDirectPayable(true);
    setMessage("");
    try {
      const invoiceChanged =
        directInvoiceNumber.trim() !==
        (directPayableDetail.document_number ?? "");
      const supplierChanged =
        directSupplierName.trim() !== directPayableDetail.supplier_name;
      if (invoiceChanged || supplierChanged) {
        const updateResponse = await fetch("/api/direct-payable-attachments", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            payableId: directPayableDetail.id,
            invoiceNumber: directInvoiceNumber,
            supplierName: directSupplierName,
          }),
        });
        if (!updateResponse.ok) {
          setMessage(
            "No fue posible actualizar el proveedor o folio de la cuenta directa.",
          );
          return;
        }
      }
      if (directAttachmentFile) {
        const form = new FormData();
        form.set("organizationId", organizationId);
        form.set("payableId", directPayableDetail.id);
        form.set("file", directAttachmentFile);
        const attachmentResponse = await fetch(
          "/api/direct-payable-attachments",
          { method: "POST", body: form },
        );
        if (!attachmentResponse.ok) {
          setMessage(
            "Los datos se guardaron, pero no fue posible cargar el respaldo.",
          );
          return;
        }
      }
      const refreshedResponse = await fetch(
        `/api/received-documents?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const refreshedPayload = (await refreshedResponse
        .json()
        .catch(() => null)) as {
        documents?: ReceivedDocument[];
        directPayables?: DirectPayable[];
      } | null;
      if (!refreshedResponse.ok || !refreshedPayload?.directPayables) {
        closeDirectPayableDetail();
        window.dispatchEvent(new CustomEvent("payable-updated"));
        setMessage(
          "Cuenta actualizada. No fue posible refrescar la lista automáticamente.",
        );
        return;
      }
      setDocuments(refreshedPayload.documents ?? []);
      setDirectPayables(refreshedPayload.directPayables);
      closeDirectPayableDetail();
      window.dispatchEvent(new CustomEvent("payable-updated"));
      setMessage("Cuenta directa actualizada correctamente.");
    } catch {
      setMessage("No fue posible guardar los cambios de la cuenta directa.");
    } finally {
      setSavingDirectPayable(false);
    }
  }

  async function saveReferenceControl() {
    if (!organizationId || !referenceToSettle) return;
    setSavingReference(true);
    const response = await fetch("/api/received-documents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "settle_factoring_reference",
        organizationId,
        referenceId: referenceToSettle.id,
        settledAt: referenceDate,
        note: referenceNote,
      }),
    });
    const payload = (await response.json().catch(() => null)) as {
      reference?: {
        reference_settled_at: string;
        reference_settlement_note: string | null;
      };
    } | null;
    setSavingReference(false);
    if (!response.ok || !payload?.reference) {
      setMessage("No fue posible actualizar la referencia de factoring.");
      return;
    }
    setDirectPayables((current) =>
      current.map((item) =>
        item.id === referenceToSettle.id
          ? {
              ...item,
              reference_settled_at: payload.reference!.reference_settled_at,
              reference_settlement_note:
                payload.reference!.reference_settlement_note,
            }
          : item,
      ),
    );
    setReferenceToSettle(null);
    setMessage(
      "Referencia de factoring actualizada. No se generó salida de caja ni pago en Tesorería.",
    );
  }

  const documentDraftTotal = documentDraft
    ? (Number(documentDraft.netAmount) || 0) +
      (Number(documentDraft.vatAmount) || 0) +
      (Number(documentDraft.additionalTaxAmount) || 0)
    : 0;

  return (
    <main className="dashboard">
      <section className="headline">
        <div>
          <span className="eyebrow">
            GESTIÓN INTERNA · {year === "all" ? "TODOS LOS AÑOS" : year}
          </span>
          <h1>Cuentas por pagar y proveedores</h1>
          <p>
            Facturas recibidas y cuentas directas, con su aprobación,
            vencimiento, propuesta y pago conectados en una sola bandeja.
          </p>
        </div>
        <div className="headline-actions">
          <label className="period-picker">
            Año
            <select
              value={year}
              onChange={(event) => setYear(event.target.value)}
            >
              <option value="all">Todos</option>
              {years.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {message && <p className="operation-message">{message}</p>}
      <section className="kpis kpis-six">
        <article className="kpi-card">
          <span>Vencido</span>
          <strong className={queueSummary.overdue > 0 ? "is-negative" : ""}>
            {money.format(queueSummary.overdue)}
          </strong>
          <small>
            {queueSummary.overdueCount} documento(s) con vencimiento cumplido
          </small>
        </article>
        <article className="kpi-card">
          <span>Vence en 7 días</span>
          <strong>{money.format(queueSummary.dueSoon)}</strong>
          <small>{queueSummary.dueSoonCount} documento(s) próximos</small>
        </article>
        <article className="kpi-card">
          <span>SII por decidir</span>
          <strong>{siiPendingDecisions}</strong>
          <small>Plazo de 8 días corriendo</small>
        </article>
        <article className="kpi-card">
          <span>Por aprobar</span>
          <strong>{queueSummary.counts.aprobar}</strong>
          <small>
            {money.format(queueSummary.approvalTotal)} comprometidos
          </small>
        </article>
        <article className="kpi-card">
          <span>Pendiente de pago</span>
          <strong
            className={queueSummary.pendingTotal > 0 ? "is-negative" : ""}
          >
            {money.format(queueSummary.pendingTotal)}
          </strong>
          <small>
            {queueSummary.counts.pagar + queueSummary.counts.decidir}{" "}
            documento(s) abiertos
          </small>
        </article>
        <article className="kpi-card accent">
          <span>Pagado</span>
          <strong>{money.format(summary.paid)}</strong>
          <small>
            Gasto del filtro: {money.format(summary.expense)}
            {summary.payroll !== 0 &&
              ` · Remuneraciones: ${money.format(summary.payroll)}`}
          </small>
        </article>
      </section>
      <section className="table-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">SII</span>
            <h2>Conexión tributaria</h2>
            <p>
              {siiPendingDecisions > 0
                ? `${siiPendingDecisions} DTE esperando aceptación o reclamo dentro del plazo.`
                : "Sin decisiones pendientes ante el SII."}{" "}
              El RCV se sincroniza a diario y el correo aporta el XML de
              detalle.
            </p>
          </div>
          <button
            type="button"
            className={siiPendingDecisions > 0 ? "primary-button" : "secondary-button"}
            onClick={() => setQueueFilter("decidir")}
          >
            Bandeja de decisión SII ({siiPendingDecisions})
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setSiiOpen((current) => !current)}
          >
            {siiOpen ? "Ocultar detalle SII" : "Ver detalle SII"}
          </button>
        </div>
      </section>
      {siiOpen && (
        <SiiDteIntegration
          organizationId={organizationId}
          canConfigure={canConfigureSii}
          documents={documents}
          onRefreshDocuments={refreshDocuments}
        />
      )}
      <section className="table-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">COLAS DE TRABAJO</span>
            <h2>Qué hay que hacer</h2>
            <p>
              Filtra por acción: decidir ante el SII, aprobar, pagar por
              urgencia de vencimiento, o revisar lo que no genera pago (guías
              vinculadas, notas de crédito aplicadas y factoring).
            </p>
          </div>
          <div className="payable-proposal-actions">
            {canManage && onPreparePayments && (
              <>
                {selectedPayables.length > 0 && (
                  <>
                    <span className="payable-selection-summary">
                      {selectedPayables.length} seleccionada(s) ·{" "}
                      {money.format(selectedPaymentTotal)}
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setSelectedPaymentKeys(new Set())}
                    >
                      Quitar selección
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="primary-button"
                  disabled={!selectedPayables.length}
                  onClick={prepareSelectedPayments}
                >
                  {selectedPayables.length
                    ? `Preparar abono conjunto (${selectedPayables.length})`
                    : "Selecciona cuentas para abonar"}
                </button>
              </>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setSupplier("all");
                setStatus("all");
                setSearch("");
                setQueueFilter("todo");
                setYear(String(new Date().getFullYear()));
              }}
            >
              Limpiar filtros
            </button>
          </div>
        </div>
        <div className="cycle-actions expense-queue-tabs">
          {(Object.keys(queueLabels) as Queue[]).map((queue) => (
            <button
              key={queue}
              type="button"
              className={
                queueFilter === queue ? "primary-button" : "secondary-button"
              }
              onClick={() => setQueueFilter(queue)}
              title={queueHints[queue]}
            >
              {queueLabels[queue]} ({queueSummary.counts[queue]})
            </button>
          ))}
        </div>
        <div className="expense-filter-row">
          <label>
            <span>Proveedor</span>
            <select
              value={supplier}
              onChange={(event) => setSupplier(event.target.value)}
            >
              <option value="all">Todos los proveedores</option>
              {suppliers.map((item) => (
                <option key={supplierKey(item)} value={supplierKey(item)}>
                  {item.expense_group === "payroll"
                    ? `${PAYROLL_GROUP_LABEL} (sueldos, leyes sociales y finiquitos)`
                    : `${item.supplier_name}${item.supplier_tax_id ? ` · ${item.supplier_tax_id}` : ""}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Estado</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">Todos los estados</option>
              {statuses.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Buscar</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Proveedor, folio o detalle"
            />
          </label>
        </div>
        {queueFilter === "referencial" && (
          <p className="form-note">{queueHints.referencial}</p>
        )}
        {queueFilter === "decidir" ? (
          // La bandeja se muestra aquí mismo, no debajo de otras secciones.
          <SiiDteIntegration
            organizationId={organizationId}
            canConfigure={canConfigureSii}
            documents={documents}
            onRefreshDocuments={refreshDocuments}
            view="decisions"
          />
        ) : loading ? (
          <p className="billing-empty">Cargando cuentas por pagar…</p>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="expense-select-col">
                      {canManage && onPreparePayments && (
                        <input
                          type="checkbox"
                          aria-label="Seleccionar todas las cuentas visibles"
                          disabled={!selectableVisiblePayables.length}
                          checked={
                            selectableVisiblePayables.length > 0 &&
                            selectableVisiblePayables.every((item) =>
                              selectedPaymentKeys.has(paymentKey(item)),
                            )
                          }
                          onChange={() =>
                            togglePaymentSelection(selectableVisiblePayables)
                          }
                        />
                      )}
                    </th>
                    <th>Documento / cuenta</th>
                    <th>Proveedor</th>
                    <th>Emisión / vencimiento</th>
                    <th>Detalle</th>
                    <th className="money-col">Neto</th>
                    <th className="money-col">IVA</th>
                    <th className="money-col">Total</th>
                    <th>Estado</th>
                    <th>Control</th>
                  </tr>
                </thead>
                <tbody>
                  {displayItems.length ? (
                    displayItems.map((entry) =>
                      entry.group ? (
                        <tr
                          key={`group-${entry.group.key}`}
                          className="expense-document-row"
                        >
                          <td className="expense-select-col">
                            {canManage && onPreparePayments && (
                              <input
                                type="checkbox"
                                aria-label={`Seleccionar cuentas de ${entry.group.name}`}
                                disabled={
                                  !entry.group.items.some(
                                    isSelectableForPayment,
                                  )
                                }
                                checked={
                                  entry.group.items.some(
                                    isSelectableForPayment,
                                  ) &&
                                  entry.group.items
                                    .filter(isSelectableForPayment)
                                    .every((item) =>
                                      selectedPaymentKeys.has(paymentKey(item)),
                                    )
                                }
                                onChange={() =>
                                  togglePaymentSelection(entry.group!.items)
                                }
                              />
                            )}
                          </td>
                          <td>
                            <strong>Grupo de facturas</strong>
                            <small>
                              {entry.group.items.length} documento(s) del mismo
                              proveedor
                            </small>
                          </td>
                          <td>
                            <strong>{entry.group.name}</strong>
                            <small>{entry.group.taxId || "Sin RUT"}</small>
                          </td>
                          <td>
                            {displayDate(entry.group.first)}
                            <small>hasta {displayDate(entry.group.last)}</small>
                          </td>
                          <td>
                            <small>
                              Agrupadas para revisión o propuesta en lote
                            </small>
                          </td>
                          <td className="money-col">—</td>
                          <td className="money-col">—</td>
                          <td className="money-col">
                            {money.format(entry.group.total)}
                          </td>
                          <td>
                            <span
                              className={
                                entry.group.overdue > 0
                                  ? "status cancelled"
                                  : "status pending"
                              }
                            >
                              {entry.group.overdue > 0
                                ? `${entry.group.overdue} vencida(s)`
                                : "Al día"}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => toggleSupplier(entry.group!.key)}
                            >
                              {expandedSuppliers.has(entry.group.key)
                                ? "Ocultar"
                                : `Ver ${entry.group.items.length}`}
                            </button>
                          </td>
                        </tr>
                      ) : (
                        (() => {
                          const item = entry.item!;
                          const aging = agingBadge(item);
                          const link = linkNote(item);
                          const reason = referenceReason(item);
                          return (
                            <tr
                              key={`${item.source}-${item.id}`}
                              className="expense-document-row"
                            >
                              <td className="expense-select-col">
                                {canManage && onPreparePayments && (
                                  <input
                                    type="checkbox"
                                    aria-label={`Seleccionar ${item.document_number || item.supplier_name}`}
                                    disabled={!isSelectableForPayment(item)}
                                    checked={selectedPaymentKeys.has(
                                      paymentKey(item),
                                    )}
                                    onChange={() =>
                                      togglePaymentSelection([item])
                                    }
                                  />
                                )}
                              </td>
                              <td>
                                <strong>{item.document_type}</strong>
                                <small>
                                  {item.is_reference
                                    ? "Control referencial"
                                    : item.source === "direct"
                                      ? "Cuenta directa"
                                      : "Documento recibido"}{" "}
                                  · Folio: {item.document_number || "—"}
                                </small>
                                {link && <small>{link}</small>}
                                {reason && <small>{reason}</small>}
                              </td>
                              <td>
                                <strong>{item.supplier_name}</strong>
                                <small>
                                  {item.supplier_tax_id || "Sin RUT"}
                                </small>
                              </td>
                              <td>
                                {displayDate(item.issue_date)}
                                <small>
                                  {item.is_reference
                                    ? "Referencia: sin salida de caja"
                                    : `Vence: ${displayDate(item.due_date)}`}
                                </small>
                                {aging && (
                                  <small
                                    className={
                                      aging.negative ? "is-negative" : ""
                                    }
                                  >
                                    {aging.text}
                                  </small>
                                )}
                              </td>
                              <td>
                                <small>{item.notes || "Sin observación"}</small>
                              </td>
                              <td className="money-col">
                                {displayAmount(
                                  item.net_amount,
                                  item.currency_code,
                                )}
                              </td>
                              <td className="money-col">
                                {item.currency_code === "CLP"
                                  ? money.format(
                                      amount(item.vat_amount) +
                                        amount(item.additional_tax_amount),
                                    )
                                  : "—"}
                              </td>
                              <td
                                className={`money-col ${isCredit(item) ? "is-negative" : ""}`}
                              >
                                {isCredit(item) ? "−" : ""}
                                {displayAmount(
                                  item.total_amount,
                                  item.currency_code,
                                )}
                              </td>
                              <td>
                                <span
                                  className={statusClass(item.payment_status)}
                                >
                                  {item.payment_status || "Sin estado"}
                                </span>
                                <small>
                                  {[
                                    item.payment_method,
                                    item.payment_bank,
                                    displayDate(item.payment_date),
                                  ]
                                    .filter((value) => value && value !== "—")
                                    .join(" · ") ||
                                    (item.is_reference
                                      ? "Pendiente de control referencial"
                                      : item.source === "direct" &&
                                          item.workflow_status === "review"
                                        ? "Pendiente de decisión en Aprobaciones"
                                        : "Pendiente de propuesta o conciliación")}
                                </small>
                                {item.payment_reference && (
                                  <small>Ref.: {item.payment_reference}</small>
                                )}
                              </td>
                              <td>
                                {item.source === "received" ? (
                                  <button
                                    type="button"
                                    className="secondary-button"
                                    disabled={openingDocumentId === item.id}
                                    onClick={() =>
                                      void openDocumentDetail(
                                        item as ReceivedDocument,
                                      )
                                    }
                                  >
                                    {openingDocumentId === item.id
                                      ? "Abriendo…"
                                      : "Ver ficha"}
                                  </button>
                                ) : item.source === "direct" ? (
                                  <button
                                    type="button"
                                    className="secondary-button"
                                    onClick={() =>
                                      openDirectPayableDetail(item)
                                    }
                                  >
                                    Ver ficha
                                  </button>
                                ) : item.is_reference && canManage ? (
                                  <button
                                    type="button"
                                    className="secondary-button"
                                    onClick={() => openReferenceControl(item)}
                                  >
                                    {item.reference_settled_at
                                      ? "Actualizar control"
                                      : "Liquidar referencia"}
                                  </button>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          );
                        })()
                      ),
                    )
                  ) : (
                    <tr>
                      <td colSpan={10}>
                        No hay registros para los filtros seleccionados.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section className="table-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">PROVEEDORES</span>
            <h2>Concentración de gasto registrado</h2>
            <p>
              Incluye documentos y cuentas directas aprobadas; las pendientes de
              aprobación se exhiben arriba, pero aún no alteran el gasto. Las
              remuneraciones se muestran aparte: no son gasto de proveedores.
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Proveedor</th>
                <th>RUT</th>
                <th className="money-col">Registros</th>
                <th className="money-col">Gasto registrado</th>
              </tr>
            </thead>
            <tbody>
              {supplierSummary
                .sort((a, b) => b.total - a.total)
                .slice(0, 20)
                .map((item) => (
                  <tr key={item.taxId || item.name}>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>{item.taxId || "—"}</td>
                    <td className="money-col">{item.documents}</td>
                    <td
                      className={`money-col ${item.total < 0 ? "is-negative" : ""}`}
                    >
                      {money.format(item.total)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
      {payrollSummary.length > 0 && (
        <section className="table-section">
          <div className="table-heading">
            <div>
              <span className="panel-label">REMUNERACIONES</span>
              <h2>Sueldos, leyes sociales y finiquitos</h2>
              <p>
                Obligaciones con personas o instituciones previsionales. Se
                imputan a 610200 Remuneraciones y cargas sociales y se pagan
                como flujo operacional a empleados; no son facturas de
                proveedor.
              </p>
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th className="money-col">Registros</th>
                  <th className="money-col">Gasto registrado</th>
                </tr>
              </thead>
              <tbody>
                {payrollSummary.map((item) => (
                  <tr key={item.category}>
                    <td>
                      <strong>{item.label}</strong>
                    </td>
                    <td className="money-col">{item.records}</td>
                    <td className="money-col">{money.format(item.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {selectedDocument && documentDraft && (
        <div
          className="modal-backdrop received-document-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDocumentDetail();
          }}
        >
          <section
            className="entry-modal received-document-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="received-document-title"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">
                  FACTURA RECIBIDA ·{" "}
                  {selectedDocument.document_number || "SIN FOLIO"}
                </span>
                <h2 id="received-document-title">
                  {selectedDocument.supplier_name}
                </h2>
                <p>
                  {selectedDocument.attachment_name
                    ? `Respaldo: ${selectedDocument.attachment_name}`
                    : "Sin respaldo cargado todavía. Puedes adjuntarlo desde esta ficha."}
                </p>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={closeDocumentDetail}
                aria-label="Cerrar detalle"
              >
                ×
              </button>
            </div>
            <div className="received-document-layout">
              <section className="received-document-preview">
                <div className="received-document-preview-heading">
                  <span className="panel-label">RESPALDO</span>
                  {documentUrl && (
                    <a
                      className="text-button"
                      href={documentUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Abrir en pestaña
                    </a>
                  )}
                </div>
                {openingDocumentId === selectedDocument.id ? (
                  <p className="billing-empty">Cargando respaldo…</p>
                ) : documentUrl ? (
                  selectedDocument.attachment_mime_type?.startsWith(
                    "image/",
                  ) ? (
                    <img
                      src={documentUrl}
                      alt={`Respaldo ${selectedDocument.document_number || "factura"}`}
                    />
                  ) : (
                    <iframe
                      src={documentUrl}
                      title={`Respaldo ${selectedDocument.document_number || "factura"}`}
                    />
                  )
                ) : (
                  <div className="received-document-empty">
                    <strong>
                      {selectedDocument.attachment_path
                        ? "No fue posible previsualizar el archivo"
                        : "Esta factura aún no tiene respaldo"}
                    </strong>
                    <small>
                      {canManage
                        ? "Carga un PDF o imagen desde el formulario."
                        : "Solicita a Finanzas que adjunte el respaldo."}
                    </small>
                  </div>
                )}
              </section>
              <form
                className="received-document-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDocumentDetail();
                }}
              >
                <div className="received-document-form-heading">
                  <span className="panel-label">DATOS DE LA FACTURA</span>
                  <span
                    className={statusClass(selectedDocument.payment_status)}
                  >
                    {selectedDocument.payment_status || "Sin estado"}
                  </span>
                </div>
                <div className="form-grid">
                  <label>
                    Proveedor *
                    <input
                      required
                      disabled={!canManage}
                      value={documentDraft.supplierName}
                      maxLength={300}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, supplierName: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    RUT proveedor
                    <input
                      disabled={!canManage}
                      value={documentDraft.supplierTaxId}
                      maxLength={30}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, supplierTaxId: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Tipo *
                    <select
                      disabled={!canManage}
                      value={documentDraft.documentType}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, documentType: event.target.value }
                            : current,
                        )
                      }
                    >
                      <option>Factura</option>
                      <option>Factura Exenta</option>
                      <option>Nota de credito</option>
                      <option>Guia de despacho</option>
                    </select>
                  </label>
                  <label>
                    Folio interno
                    <input
                      disabled={!canManage}
                      value={documentDraft.documentNumber}
                      maxLength={80}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, documentNumber: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Tipo DTE SII
                    <input
                      disabled={!canManage}
                      type="number"
                      min="1"
                      max="999"
                      value={documentDraft.siiDocumentType}
                      placeholder="Ej. 33"
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? {
                                ...current,
                                siiDocumentType: event.target.value,
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Folio DTE SII
                    <input
                      disabled={!canManage}
                      type="number"
                      min="1"
                      step="1"
                      value={documentDraft.siiFolio}
                      placeholder="Folio del SII"
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, siiFolio: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Fecha emisión *
                    <input
                      required
                      disabled={!canManage}
                      type="date"
                      value={documentDraft.issueDate}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, issueDate: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Vencimiento
                    <input
                      disabled={!canManage}
                      type="date"
                      value={documentDraft.dueDate}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, dueDate: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Plazo de pago (días)
                    <input
                      disabled={!canManage}
                      type="number"
                      min="0"
                      max="3650"
                      value={documentDraft.paymentTermDays}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? {
                                ...current,
                                paymentTermDays: event.target.value,
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Adjuntar / reemplazar respaldo
                    <input
                      disabled={!canManage}
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      onChange={(event) =>
                        setAttachmentFile(event.target.files?.[0] ?? null)
                      }
                    />
                    <small>
                      {attachmentFile
                        ? attachmentFile.name
                        : "PDF, JPG o PNG · máximo 50 MB"}
                    </small>
                  </label>
                  <label>
                    Monto neto *
                    <input
                      required
                      disabled={!canManage}
                      type="number"
                      min="0"
                      step="0.01"
                      value={documentDraft.netAmount}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, netAmount: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    IVA *
                    <input
                      required
                      disabled={!canManage}
                      type="number"
                      min="0"
                      step="0.01"
                      value={documentDraft.vatAmount}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, vatAmount: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Impuesto adicional *
                    <input
                      required
                      disabled={!canManage}
                      type="number"
                      min="0"
                      step="0.01"
                      value={documentDraft.additionalTaxAmount}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? {
                                ...current,
                                additionalTaxAmount: event.target.value,
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Total calculado
                    <input readOnly value={money.format(documentDraftTotal)} />
                  </label>
                  <label className="form-wide">
                    Observación
                    <textarea
                      disabled={!canManage}
                      value={documentDraft.notes}
                      maxLength={2000}
                      onChange={(event) =>
                        setDocumentDraft((current) =>
                          current
                            ? { ...current, notes: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                </div>
                <p className="form-note">
                  El respaldo de factura y el comprobante de abono son archivos
                  distintos. El comprobante se adjunta al registrar el pago.
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={closeDocumentDetail}
                  >
                    Cerrar
                  </button>
                  {canManage &&
                    onPrepareReceivedDocumentPayment &&
                    !isSettled(selectedDocument) && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          onPrepareReceivedDocumentPayment(selectedDocument.id)
                        }
                      >
                        Preparar abono
                      </button>
                    )}
                  {canManage && (
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={savingDocument}
                    >
                      {savingDocument ? "Guardando…" : "Guardar cambios"}
                    </button>
                  )}
                </div>
              </form>
            </div>
          </section>
        </div>
      )}
      {directPayableDetail && (
        <div
          className="modal-backdrop received-document-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget)
              closeDirectPayableDetail();
          }}
        >
          <section
            className="entry-modal received-document-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="direct-payable-title"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">
                  {directPayableDetail.expense_group === "payroll"
                    ? "REMUNERACIÓN · CUENTA DIRECTA"
                    : "CUENTA POR PAGAR DIRECTA"}
                </span>
                <h2 id="direct-payable-title">
                  {directPayableDetail.supplier_name}
                </h2>
                <p>
                  {directPayableDetail.notes ||
                    "Cuenta directa sin observación adicional."}
                </p>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={closeDirectPayableDetail}
                aria-label="Cerrar detalle"
              >
                ×
              </button>
            </div>
            <div className="received-document-layout">
              <section className="received-document-preview">
                <div className="received-document-preview-heading">
                  <span className="panel-label">RESPALDOS</span>
                  <span>{directAttachments.length} archivo(s)</span>
                </div>
                {loadingDirectAttachments ? (
                  <p className="billing-empty">Cargando respaldos…</p>
                ) : directAttachments[0]?.signedUrl ? (
                  directAttachments[0].mimeType.startsWith("image/") ? (
                    <img
                      src={directAttachments[0].signedUrl}
                      alt={directAttachments[0].fileName}
                    />
                  ) : (
                    <iframe
                      src={directAttachments[0].signedUrl}
                      title={directAttachments[0].fileName}
                    />
                  )
                ) : (
                  <div className="received-document-empty">
                    <strong>No hay respaldos cargados</strong>
                    <small>
                      {canManage
                        ? "Adjunta el documento desde esta ficha."
                        : "Solicita a Finanzas que adjunte el documento."}
                    </small>
                  </div>
                )}
                <div className="direct-payable-files">
                  {directAttachments.map((file) =>
                    file.signedUrl ? (
                      <a
                        key={file.id}
                        href={file.signedUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {file.fileName}
                      </a>
                    ) : (
                      <span key={file.id}>{file.fileName}</span>
                    ),
                  )}
                </div>
              </section>
              <form
                className="received-document-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDirectPayableDetail();
                }}
              >
                <div className="received-document-form-heading">
                  <span className="panel-label">DATOS DE LA CUENTA</span>
                  <span
                    className={statusClass(directPayableDetail.payment_status)}
                  >
                    {directPayableDetail.payment_status}
                  </span>
                </div>
                <div className="form-grid">
                  <label>
                    {directPayableDetail.expense_group === "payroll"
                      ? "Persona beneficiaria"
                      : "Proveedor"}
                    <input
                      required
                      disabled={!canManage}
                      value={directSupplierName}
                      maxLength={300}
                      onChange={(event) =>
                        setDirectSupplierName(event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Monto aprobado
                    <input
                      readOnly
                      value={displayAmount(
                        directPayableDetail.total_amount,
                        directPayableDetail.currency_code,
                      )}
                    />
                  </label>
                  <label>
                    Fecha emisión
                    <input
                      readOnly
                      value={displayDate(directPayableDetail.issue_date)}
                    />
                  </label>
                  <label>
                    Vencimiento
                    <input
                      readOnly
                      value={displayDate(directPayableDetail.due_date)}
                    />
                  </label>
                  {directPayableDetail.expense_group !== "payroll" && (
                    <label>
                      Folio de factura
                      <input
                        disabled={!canManage}
                        value={directInvoiceNumber}
                        maxLength={80}
                        placeholder="Ingresa el folio del respaldo"
                        onChange={(event) =>
                          setDirectInvoiceNumber(event.target.value)
                        }
                      />
                    </label>
                  )}
                  <label>
                    Agregar respaldo
                    <input
                      disabled={!canManage}
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      onChange={(event) =>
                        setDirectAttachmentFile(event.target.files?.[0] ?? null)
                      }
                    />
                    <small>
                      {directAttachmentFile
                        ? directAttachmentFile.name
                        : "PDF, JPG o PNG · máximo 50 MB"}
                    </small>
                  </label>
                  <label className="form-wide">
                    Detalle
                    <input
                      readOnly
                      value={directPayableDetail.notes || "Sin detalle"}
                    />
                  </label>
                </div>
                <p className="form-note">
                  {directPayableDetail.expense_group === "payroll"
                    ? "Remuneración: no lleva folio de factura. Después de aprobación puedes corregir la persona beneficiaria y adjuntar respaldos (liquidación, finiquito firmado). El monto, fechas y aprobación se mantienen protegidos."
                    : "Después de aprobación puedes corregir proveedor y folio, y adjuntar respaldos. El monto, fechas y aprobación se mantienen protegidos."}
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={closeDirectPayableDetail}
                  >
                    Cerrar
                  </button>
                  {canManage && (
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={savingDirectPayable}
                    >
                      {savingDirectPayable ? "Guardando…" : "Guardar cambios"}
                    </button>
                  )}
                </div>
              </form>
            </div>
          </section>
        </div>
      )}
      {referenceToSettle && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="entry-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="factoring-reference-title"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">CONTROL REFERENCIAL · FACTORING</span>
                <h2 id="factoring-reference-title">Liquidar referencia</h2>
                <p>
                  {referenceToSettle.supplier_name} ·{" "}
                  {referenceToSettle.document_number || "Sin folio"}. Este
                  control no genera gasto, pago ni movimiento en Tesorería.
                </p>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setReferenceToSettle(null)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="form-grid">
              <label>
                Fecha de liquidación *
                <input
                  required
                  type="date"
                  value={referenceDate}
                  onChange={(event) => setReferenceDate(event.target.value)}
                />
              </label>
              <label className="p2p-form-wide">
                Referencia / observación
                <input
                  maxLength={2000}
                  value={referenceNote}
                  onChange={(event) => setReferenceNote(event.target.value)}
                  placeholder="Ej. Liquidación informada por factoring"
                />
              </label>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setReferenceToSettle(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={savingReference || !referenceDate}
                onClick={() => void saveReferenceControl()}
              >
                {savingReference ? "Guardando…" : "Guardar control"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
