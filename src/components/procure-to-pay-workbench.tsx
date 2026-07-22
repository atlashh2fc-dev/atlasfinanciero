"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type PurchaseRequest = {
  id: string;
  request_number: string;
  supplier_counterparty_id: string | null;
  supplier_name: string;
  description: string;
  requested_on: string;
  needed_by: string | null;
  cost_center_id: string | null;
  estimated_amount: number | string;
  total_amount?: number | string;
  status: string;
  notes?: string | null;
};
type PurchaseOrder = {
  id: string;
  purchase_order_number: string;
  purchase_request_id: string | null;
  supplier_name: string;
  ordered_on: string;
  expected_on: string | null;
  net_amount: number | string;
  total_amount: number | string;
  status: string;
  notes?: string | null;
};
type PurchaseOrderLine = {
  id: string;
  purchase_order_id: string;
  line_number: number;
  description: string;
  quantity: number | string;
  unit_price: number | string;
  net_amount: number | string;
  received_quantity: number | string;
  cost_center_id: string | null;
};
type PurchaseReceipt = {
  id: string;
  purchase_order_id: string;
  received_on: string;
  notes: string | null;
  created_at: string;
};
type PurchaseReceiptLine = {
  id: string;
  receipt_id: string;
  purchase_order_line_id: string;
  received_quantity: number | string;
};
type PaymentBatch = {
  id: string;
  batch_number: string;
  scheduled_for: string;
  total_amount: number | string;
  status: string;
  payment_reference: string | null;
};
type PaymentItem = {
  id: string;
  payment_batch_id: string;
  received_document_id: string | null;
  direct_payable_id: string | null;
  supplier_name_snapshot: string;
  document_number_snapshot: string | null;
  due_date_snapshot: string | null;
  amount: number | string;
  cash_flow_category: "operating" | "investing" | "financing";
};
type Document = {
  id: string;
  supplier_counterparty_id: string | null;
  supplier_name: string;
  document_number: string | null;
  issue_date: string;
  due_date: string | null;
  net_amount: number | string;
  total_amount: number | string;
  payment_status: string | null;
  status: string;
  vendor_purchase_order_id: string | null;
  payment_eligible: boolean;
  payment_block_reason: string | null;
};
type DirectPayable = {
  id: string;
  payable_number: string;
  supplier_counterparty_id: string | null;
  supplier_name: string;
  beneficiary_name: string | null;
  invoice_number: string | null;
  category: string;
  category_detail: string | null;
  description: string;
  issue_date: string;
  due_date: string | null;
  total_amount: number | string;
  currency_code: string;
  cost_center_id: string | null;
  status: string;
  notes: string | null;
  payment_reference: string | null;
  is_reference: boolean;
  reference_settled_at: string | null;
  payment_eligible: boolean;
  payment_block_reason: string | null;
};
type FinancingPlan = {
  id: string;
  plan_number: string;
  plan_kind: "asset_financing" | "credit" | "supplier_debt";
  supplier_name: string;
  asset_name: string | null;
  currency_code: "CLP" | "UF";
  cost_center_id: string | null;
  principal_amount: number | string;
  financing_total_amount: number | string;
  total_amount?: number | string;
  asset_cost_clp: number | string | null;
  installment_count: number;
  first_due_date: string;
  useful_life_months: number | null;
  disbursement_date: string | null;
  disbursement_amount: number | string | null;
  status: string;
};
type Supplier = {
  id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string | null;
};
type Account = {
  id: string;
  name: string;
  bank_name: string | null;
  account_number_masked: string | null;
};
type CostCenter = { id: string; code: string; name: string };
type Payload = {
  purchaseRequests: PurchaseRequest[];
  purchaseOrders: PurchaseOrder[];
  purchaseOrderLines: PurchaseOrderLine[];
  purchaseOrderReceipts: PurchaseReceipt[];
  purchaseOrderReceiptLines: PurchaseReceiptLine[];
  paymentBatches: PaymentBatch[];
  paymentBatchItems: PaymentItem[];
  receivedDocuments: Document[];
  directPayables: DirectPayable[];
  financingPlans: FinancingPlan[];
  suppliers: Supplier[];
  bankAccounts: Account[];
  costCenters: CostCenter[];
};
const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});
const dates = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const amount = (value: number | string | null | undefined) =>
  Number(value ?? 0);
const displayDate = (value: string | null) =>
  value ? dates.format(new Date(`${value}T00:00:00`)) : "Sin fecha";
const today = () => new Date().toISOString().slice(0, 10);

function label(status: string) {
  return (
    (
      {
        draft: "Borrador",
        review: "En aprobación",
        approved: "Aprobada",
        rejected: "Rechazada",
        sent: "Enviada",
        partially_received: "Recepción parcial",
        received: "Recibida",
        processing: "En ejecución",
        paid: "Pagado",
        cancelled: "Anulado",
      } as Record<string, string>
    )[status] ?? status
  );
}
function statusClass(status: string) {
  return `status ${status === "paid" || status === "approved" || status === "received" ? "paid" : status === "cancelled" || status === "rejected" ? "cancelled" : status === "review" || status === "processing" ? "pending" : "neutral"}`;
}
function isOverdue(document: Document) {
  return Boolean(
    document.due_date &&
      document.due_date < today() &&
      !["paid", "cancelled"].includes(document.payment_status ?? ""),
  );
}
function isPayableOverdue(payable: DirectPayable) {
  return Boolean(
    payable.due_date &&
      payable.due_date < today() &&
      !["paid", "cancelled"].includes(payable.status),
  );
}
function paymentBlockLabel(reason: string | null) {
  return (
    (
      {
        missing_purchase_order: "No está vinculada a una orden de compra.",
        purchase_order_not_received: "La OC aún no está recepcionada.",
        supplier_mismatch: "El proveedor no coincide con la OC.",
        amount_mismatch: "El monto no coincide con la OC.",
        already_in_payment_batch:
          "Ya está reservada en otra propuesta de pago.",
        purchase_match_pending:
          "Requiere revisar y vincular la factura con una OC.",
        purchase_match_rejected: "El match con compra fue rechazado.",
        purchase_match_exception_not_approved:
          "La excepción de compra aún no está aprobada.",
        awaiting_approval: "Esperando la decisión de aprobación.",
        not_submitted: "Aún no se ha enviado a aprobación.",
        not_approved: "No fue aprobada para pago.",
        already_paid: "Esta cuenta ya fue pagada.",
        reference_only:
          "Referencia de factoring: se controla desde Cuentas por pagar, sin propuesta ni salida de caja.",
      } as Record<string, string>
    )[reason ?? ""] ?? "No cumple las condiciones para pago."
  );
}
function paymentOrderStatusLabel(status: string) {
  return (
    (
      {
        draft: "Propuesta",
        review: "En aprobación",
        approved: "Orden autorizada",
        processing: "Instrucción emitida",
        paid: "Ejecutada",
        cancelled: "Anulada",
      } as Record<string, string>
    )[status] ?? label(status)
  );
}
function cashFlowLabel(category: PaymentItem["cash_flow_category"]) {
  return (
    {
      operating: "Operación",
      investing: "Inversión",
      financing: "Financiamiento",
    } as const
  )[category];
}

export function ProcureToPayWorkbench({
  organizationId,
  canManage,
  canManagePayments,
}: {
  organizationId: string | null;
  canManage: boolean;
  canManagePayments: boolean;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [showDirectPayableForm, setShowDirectPayableForm] = useState(false);
  const [showFinancingForm, setShowFinancingForm] = useState(false);
  const [showBatchForm, setShowBatchForm] = useState(false);
  const [isPreparingSelectedPayments, setIsPreparingSelectedPayments] =
    useState(false);
  const [tab, setTab] = useState<
    "summary" | "requests" | "orders" | "payables" | "proposals" | "financing"
  >("summary");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [detail, setDetail] = useState<{
    kind: string;
    item: Record<string, any>;
  } | null>(null);
  const [request, setRequest] = useState({
    requestNumber: "",
    supplierId: "",
    supplierName: "",
    costCenterId: "",
    description: "",
    requestedOn: today(),
    neededBy: "",
    estimatedAmount: "",
    notes: "",
  });
  const [orderDraft, setOrderDraft] = useState({
    requestId: "",
    purchaseOrderNumber: "",
    expectedOn: "",
    notes: "",
  });
  const [documentToLink, setDocumentToLink] = useState<Record<string, string>>(
    {},
  );
  const [receiptDraft, setReceiptDraft] = useState<{
    purchaseOrderId: string;
    receivedOn: string;
    notes: string;
    lines: Record<string, string>;
  }>({ purchaseOrderId: "", receivedOn: today(), notes: "", lines: {} });
  const [directPayable, setDirectPayable] = useState({
    costCenterId: "",
    supplierId: "",
    supplierName: "",
    beneficiaryName: "",
    invoiceNumber: "",
    category: "utilities",
    categoryDetail: "",
    description: "",
    issueDate: today(),
    dueDate: "",
    totalAmount: "",
    notes: "",
  });
  const [directPayableFile, setDirectPayableFile] = useState<File | null>(null);
  const [payableBeneficiaryDraft, setPayableBeneficiaryDraft] = useState("");
  const [financing, setFinancing] = useState({
    planKind: "asset_financing",
    planNumber: "",
    supplierId: "",
    supplierName: "",
    costCenterId: "",
    assetName: "",
    currencyCode: "CLP",
    principalAmount: "",
    financingTotalAmount: "",
    assetCostClp: "",
    residualValueClp: "",
    installmentCount: "",
    firstDueDate: today(),
    usefulLifeMonths: "",
    amortizationStartMonth: `${today().slice(0, 7)}-01`,
    disbursementDate: today(),
    disbursementAmount: "",
    contractReference: "",
    notes: "",
  });
  const [batch, setBatch] = useState({
    bankAccountId: "",
    scheduledFor: today(),
    notes: "",
    documentIds: [] as string[],
    directPayableIds: [] as string[],
  });
  const [cashFlowCategories, setCashFlowCategories] = useState<
    Record<string, "operating" | "investing" | "financing">
  >({});
  async function load() {
    if (!organizationId) {
      setData(null);
      return;
    }
    const response = await fetch(
      `/api/procure-to-pay?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) {
      setData(null);
      setMessage("No fue posible cargar compras y pagos.");
      return;
    }
    setData((await response.json()) as Payload);
    setMessage(null);
  }
  useEffect(() => {
    void load();
  }, [organizationId]);
  useEffect(() => {
    setPayableBeneficiaryDraft(
      detail?.kind === "payable"
        ? ((detail.item as DirectPayable).beneficiary_name ?? "")
        : "",
    );
  }, [detail]);
  useEffect(() => {
    function closeModal(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setShowRequestForm(false);
      setShowDirectPayableForm(false);
      setShowFinancingForm(false);
      setShowBatchForm(false);
      setOrderDraft((current) => ({ ...current, requestId: "" }));
      setDetail(null);
      setReceiptDraft((current) => ({ ...current, purchaseOrderId: "" }));
    }
    window.addEventListener("keydown", closeModal);
    return () => window.removeEventListener("keydown", closeModal);
  }, []);

  const dueDocuments = useMemo(
    () =>
      (data?.receivedDocuments ?? []).filter(
        (document) =>
          amount(document.total_amount) > 0 &&
          !["paid", "cancelled"].includes(document.payment_status ?? ""),
      ),
    [data],
  );
  const openDirectPayables = useMemo(
    () =>
      (data?.directPayables ?? []).filter(
        (payable) =>
          !payable.is_reference &&
          !["paid", "cancelled"].includes(payable.status),
      ),
    [data],
  );
  const totalPending = useMemo(
    () =>
      dueDocuments.reduce(
        (sum, document) => sum + amount(document.total_amount),
        0,
      ) +
      openDirectPayables.reduce(
        (sum, payable) => sum + amount(payable.total_amount),
        0,
      ),
    [dueDocuments, openDirectPayables],
  );
  const submittedBatches = useMemo(
    () =>
      (data?.paymentBatches ?? []).filter((item) =>
        ["review", "approved", "processing"].includes(item.status),
      ),
    [data],
  );
  const paymentEligibleDocuments = useMemo(
    () => dueDocuments.filter((document) => document.payment_eligible),
    [dueDocuments],
  );
  const paymentBlockedDocuments = useMemo(
    () => dueDocuments.filter((document) => !document.payment_eligible),
    [dueDocuments],
  );
  const paymentEligibleDirectPayables = useMemo(
    () => openDirectPayables.filter((payable) => payable.payment_eligible),
    [openDirectPayables],
  );
  const paymentProposalDocuments = useMemo(
    () =>
      isPreparingSelectedPayments
        ? paymentEligibleDocuments.filter((document) =>
            batch.documentIds.includes(document.id),
          )
        : paymentEligibleDocuments,
    [batch.documentIds, isPreparingSelectedPayments, paymentEligibleDocuments],
  );
  const paymentProposalDirectPayables = useMemo(
    () =>
      isPreparingSelectedPayments
        ? paymentEligibleDirectPayables.filter((payable) =>
            batch.directPayableIds.includes(payable.id),
          )
        : paymentEligibleDirectPayables,
    [
      batch.directPayableIds,
      isPreparingSelectedPayments,
      paymentEligibleDirectPayables,
    ],
  );
  const selectedTotal = useMemo(
    () =>
      paymentEligibleDocuments
        .filter((document) => batch.documentIds.includes(document.id))
        .reduce((sum, document) => sum + amount(document.total_amount), 0) +
      paymentEligibleDirectPayables
        .filter((payable) => batch.directPayableIds.includes(payable.id))
        .reduce((sum, payable) => sum + amount(payable.total_amount), 0),
    [
      batch.documentIds,
      batch.directPayableIds,
      paymentEligibleDocuments,
      paymentEligibleDirectPayables,
    ],
  );
  const requestsNeedingAction = useMemo(
    () =>
      (data?.purchaseRequests ?? []).filter((item) =>
        ["draft", "approved"].includes(item.status),
      ),
    [data],
  );
  const ordersNeedingAction = useMemo(
    () =>
      (data?.purchaseOrders ?? []).filter((item) =>
        ["draft", "approved", "sent"].includes(item.status),
      ),
    [data],
  );
  const unlinkedDocuments = useMemo(
    () => dueDocuments.filter((item) => !item.vendor_purchase_order_id),
    [dueDocuments],
  );
  const receiptOrder = useMemo(
    () =>
      (data?.purchaseOrders ?? []).find(
        (item) => item.id === receiptDraft.purchaseOrderId,
      ) ?? null,
    [data?.purchaseOrders, receiptDraft.purchaseOrderId],
  );
  const receiptLines = useMemo(
    () =>
      (data?.purchaseOrderLines ?? []).filter(
        (line) => line.purchase_order_id === receiptDraft.purchaseOrderId,
      ),
    [data?.purchaseOrderLines, receiptDraft.purchaseOrderId],
  );
  const overdueDocuments = useMemo(
    () => dueDocuments.filter(isOverdue),
    [dueDocuments],
  );
  const inYear = (value: string | null | undefined) =>
    !value || value.slice(0, 4) === year;
  const matches = (value: string) =>
    !search.trim() ||
    value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleRequests = useMemo(
    () =>
      (data?.purchaseRequests ?? []).filter(
        (item) =>
          inYear(item.requested_on) &&
          matches(
            `${item.request_number} ${item.supplier_name} ${item.description}`,
          ) &&
          (stateFilter === "all" || item.status === stateFilter),
      ),
    [data?.purchaseRequests, year, search, stateFilter],
  );
  const visibleOrders = useMemo(
    () =>
      (data?.purchaseOrders ?? []).filter(
        (item) =>
          inYear(item.ordered_on) &&
          matches(`${item.purchase_order_number} ${item.supplier_name}`) &&
          (stateFilter === "all" || item.status === stateFilter),
      ),
    [data?.purchaseOrders, year, search, stateFilter],
  );
  const visiblePayables = useMemo(
    () =>
      [...dueDocuments, ...openDirectPayables].filter(
        (item) =>
          inYear("issue_date" in item ? item.issue_date : null) &&
          matches(
            `${item.supplier_name} ${"document_number" in item ? (item.document_number ?? "") : item.payable_number}`,
          ) &&
          (stateFilter === "all" ||
            (stateFilter === "overdue" &&
              ("document_number" in item
                ? isOverdue(item)
                : isPayableOverdue(item))) ||
            (stateFilter === "eligible" && item.payment_eligible) ||
            (stateFilter === "blocked" && !item.payment_eligible)),
      ),
    [dueDocuments, openDirectPayables, year, search, stateFilter],
  );
  const visibleBatches = useMemo(
    () =>
      (data?.paymentBatches ?? []).filter(
        (item) =>
          inYear(item.scheduled_for) &&
          matches(`${item.batch_number} ${item.payment_reference ?? ""}`) &&
          (stateFilter === "all" || item.status === stateFilter),
      ),
    [data?.paymentBatches, year, search, stateFilter],
  );
  const visibleFinancing = useMemo(
    () =>
      (data?.financingPlans ?? []).filter(
        (item) =>
          inYear(item.first_due_date) &&
          matches(
            `${item.plan_number} ${item.supplier_name} ${item.asset_name ?? ""}`,
          ) &&
          (stateFilter === "all" || item.status === stateFilter),
      ),
    [data?.financingPlans, year, search, stateFilter],
  );
  const availableYears = useMemo(() => {
    const values = new Set<string>([String(new Date().getFullYear())]);
    for (const item of data?.purchaseRequests ?? [])
      values.add(item.requested_on.slice(0, 4));
    for (const item of data?.purchaseOrders ?? [])
      values.add(item.ordered_on.slice(0, 4));
    for (const item of data?.receivedDocuments ?? [])
      values.add(item.issue_date.slice(0, 4));
    for (const item of data?.directPayables ?? [])
      values.add(item.issue_date.slice(0, 4));
    for (const item of data?.paymentBatches ?? [])
      values.add(item.scheduled_for.slice(0, 4));
    for (const item of data?.financingPlans ?? [])
      values.add(item.first_due_date.slice(0, 4));
    return [...values]
      .filter(Boolean)
      .sort((left, right) => right.localeCompare(left));
  }, [data]);

  function selectSupplier(supplierId: string) {
    const supplier = data?.suppliers.find((item) => item.id === supplierId);
    setRequest((current) => ({
      ...current,
      supplierId,
      supplierName: supplier ? supplier.trade_name || supplier.legal_name : "",
    }));
  }
  function selectDirectPayableSupplier(supplierId: string) {
    const supplier = data?.suppliers.find((item) => item.id === supplierId);
    setDirectPayable((current) => ({
      ...current,
      supplierId,
      supplierName: supplier ? supplier.trade_name || supplier.legal_name : "",
    }));
  }
  function selectFinancingSupplier(supplierId: string) {
    const supplier = data?.suppliers.find((item) => item.id === supplierId);
    setFinancing((current) => ({
      ...current,
      supplierId,
      supplierName: supplier ? supplier.trade_name || supplier.legal_name : "",
    }));
  }
  async function post(body: Record<string, unknown>) {
    setSaving(true);
    const response = await fetch("/api/procure-to-pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, ...body }),
    });
    setSaving(false);
    if (!response.ok) {
      setMessage(
        "No fue posible guardar. Revisa los datos, el estado del flujo y tus permisos.",
      );
      return false;
    }
    await load();
    return true;
  }
  async function transition(id: string, action: string) {
    setSaving(true);
    const response = await fetch("/api/procure-to-pay", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        id,
        action,
        paymentReference:
          action === "mark_payment_batch_paid"
            ? "Orden de pago ejecutada"
            : undefined,
      }),
    });
    setSaving(false);
    setMessage(
      response.ok
        ? "Estado actualizado."
        : "No fue posible avanzar: el flujo exige la aprobación o condición previa correspondiente.",
    );
    if (response.ok) await load();
  }
  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post({ action: "create_purchase_request", ...request })) {
      setRequest({
        requestNumber: "",
        supplierId: "",
        supplierName: "",
        costCenterId: "",
        description: "",
        requestedOn: today(),
        neededBy: "",
        estimatedAmount: "",
        notes: "",
      });
      setShowRequestForm(false);
      setMessage(
        "Solicitud creada como borrador. Envíala desde su expediente para iniciar aprobación.",
      );
    }
  }
  async function createOrderFromRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      await post({
        action: "create_purchase_order_from_request",
        purchaseRequestId: orderDraft.requestId,
        purchaseOrderNumber: orderDraft.purchaseOrderNumber,
        expectedOn: orderDraft.expectedOn || undefined,
        notes: orderDraft.notes || undefined,
      })
    ) {
      setOrderDraft({
        requestId: "",
        purchaseOrderNumber: "",
        expectedOn: "",
        notes: "",
      });
      setMessage(
        "OC creada desde la solicitud aprobada. Ahora envíala a aprobación.",
      );
    }
  }
  async function linkDocumentToOrder(orderId: string) {
    const receivedDocumentId = documentToLink[orderId];
    if (!receivedDocumentId) return;
    if (
      await post({
        action: "link_received_document_to_purchase_order",
        purchaseOrderId: orderId,
        receivedDocumentId,
      })
    ) {
      setDocumentToLink((current) => ({ ...current, [orderId]: "" }));
      setMessage(
        "Factura vinculada a la OC. Quedó disponible para el ciclo de pago.",
      );
    }
  }
  function openReceipt(purchaseOrderId: string) {
    const lines = (data?.purchaseOrderLines ?? []).filter(
      (line) => line.purchase_order_id === purchaseOrderId,
    );
    setReceiptDraft({
      purchaseOrderId,
      receivedOn: today(),
      notes: "",
      lines: Object.fromEntries(
        lines
          .filter(
            (line) => amount(line.quantity) > amount(line.received_quantity),
          )
          .map((line) => [line.id, ""]),
      ),
    });
  }
  async function recordReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const lines = receiptLines
      .map((line) => ({
        purchaseOrderLineId: line.id,
        receivedQuantity: receiptDraft.lines[line.id] ?? "",
      }))
      .filter((line) => Number(line.receivedQuantity) > 0);
    if (!lines.length) {
      setMessage("Indica al menos una cantidad recibida.");
      return;
    }
    if (
      await post({
        action: "record_purchase_receipt",
        purchaseOrderId: receiptDraft.purchaseOrderId,
        receivedOn: receiptDraft.receivedOn,
        notes: receiptDraft.notes,
        lines,
      })
    ) {
      setReceiptDraft({
        purchaseOrderId: "",
        receivedOn: today(),
        notes: "",
        lines: {},
      });
      setMessage(
        "Recepción conforme registrada. La factura sólo podrá avanzar hasta el monto realmente recibido.",
      );
    }
  }
  async function createDirectPayable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true);
    const response = await fetch("/api/procure-to-pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        action: "create_direct_payable",
        ...directPayable,
      }),
    });
    const payload = (await response.json().catch(() => null)) as { id?: string } | null;
    if (!response.ok || !payload?.id) {
      setSaving(false);
      setMessage("No fue posible crear la cuenta por pagar. Revisa los datos y tus permisos.");
      return;
    }
    let attachmentError = false;
    if (directPayableFile) {
      const attachment = new FormData();
      attachment.set("organizationId", organizationId);
      attachment.set("payableId", payload.id);
      attachment.set("file", directPayableFile);
      const attachmentResponse = await fetch("/api/direct-payable-attachments", {
        method: "POST",
        body: attachment,
      });
      attachmentError = !attachmentResponse.ok;
    }
    setSaving(false);
    await load();
    {
      setDirectPayable({
        costCenterId: "",
        supplierId: "",
        supplierName: "",
        beneficiaryName: "",
        invoiceNumber: "",
        category: "utilities",
        categoryDetail: "",
        description: "",
        issueDate: today(),
        dueDate: "",
        totalAmount: "",
        notes: "",
      });
      setDirectPayableFile(null);
      setShowDirectPayableForm(false);
      setMessage(
        attachmentError
          ? "Cuenta por pagar enviada a aprobación, pero no se pudo adjuntar el respaldo. Ábrela desde la bandeja para reintentar."
          : "Cuenta por pagar enviada a aprobación. Quedará disponible para pago al aprobarse.",
      );
    }
  }
  async function uploadPayableAttachment(payableId: string, file: File | null) {
    if (!organizationId || !file) return;
    setSaving(true);
    const attachment = new FormData();
    attachment.set("organizationId", organizationId);
    attachment.set("payableId", payableId);
    attachment.set("file", file);
    const response = await fetch("/api/direct-payable-attachments", {
      method: "POST",
      body: attachment,
    });
    setSaving(false);
    setMessage(
      response.ok
        ? "Respaldo adjuntado al expediente de pago."
        : "No fue posible adjuntar el respaldo. Usa PDF, JPG o PNG de hasta 50 MB y verifica tus permisos.",
    );
  }
  async function savePayableBeneficiary(payableId: string) {
    if (!organizationId || !payableBeneficiaryDraft.trim()) return;
    setSaving(true);
    const response = await fetch("/api/procure-to-pay", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        id: payableId,
        action: "set_direct_payable_beneficiary",
        beneficiaryName: payableBeneficiaryDraft,
      }),
    });
    setSaving(false);
    if (!response.ok) {
      setMessage("No fue posible guardar el beneficiario. Verifica tus permisos y vuelve a intentar.");
      return;
    }
    await load();
    setDetail((current) => current?.kind === "payable"
      ? { ...current, item: { ...current.item, beneficiary_name: payableBeneficiaryDraft.trim() } }
      : current);
    setMessage("Beneficiario/a actualizado/a en el expediente de pago.");
  }
  async function createFinancingPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post({ action: "create_asset_financing_plan", ...financing })) {
      setFinancing({
        planKind: "asset_financing",
        planNumber: "",
        supplierId: "",
        supplierName: "",
        costCenterId: "",
        assetName: "",
        currencyCode: "CLP",
        principalAmount: "",
        financingTotalAmount: "",
        assetCostClp: "",
        residualValueClp: "",
        installmentCount: "",
        firstDueDate: today(),
        usefulLifeMonths: "",
        amortizationStartMonth: `${today().slice(0, 7)}-01`,
        disbursementDate: today(),
        disbursementAmount: "",
        contractReference: "",
        notes: "",
      });
      setShowFinancingForm(false);
      setMessage(
        "Plan creado como borrador. Tras aprobarlo, sus cuotas quedan disponibles para pago; los activos además generan amortización contable.",
      );
    }
  }
  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      await post({
        action: "create_payment_batch",
        bankAccountId: batch.bankAccountId || undefined,
        scheduledFor: batch.scheduledFor,
        notes: batch.notes,
        documentIds: batch.documentIds,
        directPayableIds: batch.directPayableIds,
        cashFlowCategories,
      })
    ) {
      setBatch({
        bankAccountId: "",
        scheduledFor: today(),
        notes: "",
        documentIds: [],
        directPayableIds: [],
      });
      setCashFlowCategories({});
      setShowBatchForm(false);
      setIsPreparingSelectedPayments(false);
      setMessage(
        "Propuesta de pago creada como borrador. Envíala desde su expediente para aprobación.",
      );
    }
  }
  function toggleDocument(id: string) {
    setBatch((current) => ({
      ...current,
      documentIds: current.documentIds.includes(id)
        ? current.documentIds.filter((item) => item !== id)
        : [...current.documentIds, id],
    }));
  }
  function toggleDirectPayable(id: string) {
    setBatch((current) => ({
      ...current,
      directPayableIds: current.directPayableIds.includes(id)
        ? current.directPayableIds.filter((item) => item !== id)
        : [...current.directPayableIds, id],
    }));
  }
  function prepareSelectedPayments() {
    if (!batch.documentIds.length && !batch.directPayableIds.length) {
      setMessage(
        "Selecciona al menos una factura o cuenta aprobada para preparar la propuesta.",
      );
      return;
    }
    setIsPreparingSelectedPayments(true);
    setShowBatchForm(true);
    window.setTimeout(
      () =>
        document
          .getElementById("p2p-payment-batch")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  }
  function beginOrder(requestId: string) {
    setOrderDraft({
      requestId,
      purchaseOrderNumber: "",
      expectedOn: "",
      notes: "",
    });
    document
      .getElementById("p2p-create-order")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <main className="dashboard p2p-workbench" data-tab={tab}>
      <section className="headline p2p-headline">
        <div>
          <span className="eyebrow">GESTIÓN DE COMPRAS Y TESORERÍA</span>
          <h1>Compras, obligaciones y pagos</h1>
          <p>
            Controla el expediente completo: solicitud, orden, recepción,
            factura, propuesta de pago, instrucción bancaria y conciliación.
          </p>
        </div>
        <div className="p2p-header-actions">
          {canManage && (
            <button
              className="primary-button"
              onClick={() => setShowRequestForm(true)}
            >
              Nueva solicitud
            </button>
          )}
          {canManagePayments && (
            <button
              className="secondary-button"
              onClick={() => setShowDirectPayableForm(true)}
            >
              Nueva obligación
            </button>
          )}
          {canManagePayments && (
            <button
              className="secondary-button"
              onClick={() => setShowFinancingForm(true)}
            >
              Nuevo financiamiento
            </button>
          )}
        </div>
      </section>
      <section
        className="p2p-navigation"
        aria-label="Navegación de compras y pagos"
      >
        <div className="p2p-tabs">
          {(
            [
              ["summary", "Resumen"],
              ["requests", "Solicitudes"],
              ["orders", "Órdenes y recepciones"],
              ["payables", "Cuentas por pagar"],
              ["proposals", "Propuestas de pago"],
              ["financing", "Financiamientos"],
            ] as const
          ).map(([value, name]) => (
            <button
              type="button"
              key={value}
              className={tab === value ? "active" : ""}
              onClick={() => {
                setTab(value);
                setSearch("");
                setStateFilter("all");
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="p2p-global-filters">
          <label>
            Año
            <select
              value={year}
              onChange={(event) => setYear(event.target.value)}
            >
              {availableYears.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          {tab !== "summary" && (
            <>
              <label>
                Buscar
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Proveedor, número o detalle"
                />
              </label>
              <label>
                Estado
                <select
                  value={stateFilter}
                  onChange={(event) => setStateFilter(event.target.value)}
                >
                  <option value="all">Todos</option>
                  <option value="draft">Borrador</option>
                  <option value="review">En aprobación</option>
                  <option value="approved">Aprobada</option>
                  <option value="sent">Enviada</option>
                  <option value="partially_received">Parcial</option>
                  <option value="received">Recibida</option>
                  <option value="eligible">Elegible</option>
                  <option value="blocked">Bloqueada</option>
                  <option value="overdue">Vencida</option>
                  <option value="processing">En ejecución</option>
                  <option value="paid">Pagada</option>
                </select>
              </label>
            </>
          )}
        </div>
      </section>
      {message && <p className="operation-message">{message}</p>}

      {tab === "summary" && (
        <>
          <section
            className="p2p-flow"
            aria-label="Ciclo de compras, obligaciones y pagos"
          >
            <div className="p2p-flow-step">
              <strong>1</strong>
              <span>Solicitud</span>
              <small>Necesidad y presupuesto</small>
            </div>
            <div className="p2p-flow-step">
              <strong>2</strong>
              <span>Aprobación</span>
              <small>Decisión trazable</small>
            </div>
            <div className="p2p-flow-step">
              <strong>3</strong>
              <span>Orden de compra</span>
              <small>Compromiso con proveedor</small>
            </div>
            <div className="p2p-flow-step">
              <strong>4</strong>
              <span>Factura recibida</span>
              <small>Validación contra OC</small>
            </div>
            <div className="p2p-flow-step">
              <strong>5</strong>
              <span>Pago</span>
              <small>Orden, banco y conciliación</small>
            </div>
          </section>

          <section className="kpis">
            <article className="kpi-card">
              <span>Por pagar</span>
              <strong>{money.format(totalPending)}</strong>
              <small>
                {dueDocuments.length + openDirectPayables.length} factura(s) o
                cuenta(s) abierta(s)
              </small>
            </article>
            <article className="kpi-card">
              <span>Por resolver</span>
              <strong>
                {requestsNeedingAction.length + ordersNeedingAction.length}
              </strong>
              <small>Solicitudes u OCs esperan acción</small>
            </article>
            <article className="kpi-card">
              <span>Cuentas directas</span>
              <strong>{openDirectPayables.length}</strong>
              <small>Servicios y facturas por programar</small>
            </article>
            <article className="kpi-card accent">
              <span>Pagos en proceso</span>
              <strong>
                {money.format(
                  submittedBatches.reduce(
                    (sum, item) => sum + amount(item.total_amount),
                    0,
                  ),
                )}
              </strong>
              <small>En aprobación o ejecución</small>
            </article>
          </section>

          <section className="p2p-attention">
            <div className="panel-heading">
              <div>
                <span className="panel-label">ATENCIÓN REQUERIDA</span>
                <h2>Lo que puede bloquear caja, operación o control</h2>
              </div>
            </div>
            <div className="p2p-attention-grid">
              <article>
                <strong>{overdueDocuments.length}</strong>
                <span>factura(s) vencida(s)</span>
                <small>
                  {overdueDocuments.length
                    ? "Prioriza su pago o documenta la retención."
                    : "No hay vencimientos pendientes."}
                </small>
              </article>
              <article>
                <strong>{paymentBlockedDocuments.length}</strong>
                <span>factura(s) bloqueada(s)</span>
                <small>
                  {paymentBlockedDocuments.length
                    ? "Revisa el motivo antes de proponer un pago."
                    : "No hay bloqueos de pago."}
                </small>
              </article>
              <article>
                <strong>{requestsNeedingAction.length}</strong>
                <span>solicitud(es) activas</span>
                <small>
                  {requestsNeedingAction.length
                    ? "Envía borradores o crea la OC tras aprobación."
                    : "No hay solicitudes pendientes."}
                </small>
              </article>
            </div>
          </section>
        </>
      )}

      {tab !== "summary" && (
        <section className="panel p2p-dense-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-label">{year} · BANDEJA OPERATIVA</span>
              <h2>
                {
                  {
                    requests: "Solicitudes de compra",
                    orders: "Órdenes y recepciones",
                    payables: "Cuentas por pagar",
                    proposals: "Propuestas de pago",
                    financing: "Financiamientos",
                  }[tab]
                }
              </h2>
              <p>
                Haz clic en una fila para revisar su expediente y ejecutar la
                acción disponible.
              </p>
            </div>
            {tab === "proposals" && canManagePayments && (
              <button
                className="primary-button"
                onClick={() => {
                  setIsPreparingSelectedPayments(false);
                  setShowBatchForm(true);
                }}
              >
                Crear propuesta de pago
              </button>
            )}
          </div>
          {tab === "requests" && (
            <div className="table-scroll">
              <table className="p2p-dense-table">
                <thead>
                  <tr>
                    <th>Solicitud</th>
                    <th>Proveedor</th>
                    <th>Detalle</th>
                    <th>Necesario</th>
                    <th className="money-col">Estimado</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRequests.map((item) => (
                    <tr
                      key={item.id}
                      tabIndex={0}
                      onClick={() => setDetail({ kind: "request", item })}
                    >
                      <td>
                        <strong>{item.request_number}</strong>
                      </td>
                      <td>{item.supplier_name}</td>
                      <td>{item.description}</td>
                      <td>
                        {displayDate(item.needed_by || item.requested_on)}
                      </td>
                      <td className="money-col">
                        {money.format(amount(item.estimated_amount))}
                      </td>
                      <td>
                        <span className={statusClass(item.status)}>
                          {label(item.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!visibleRequests.length && (
                    <tr>
                      <td colSpan={6}>
                        No hay solicitudes para los filtros seleccionados.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {tab === "orders" && (
            <div className="table-scroll">
              <table className="p2p-dense-table">
                <thead>
                  <tr>
                    <th>OC</th>
                    <th>Proveedor</th>
                    <th>Entrega</th>
                    <th>Recepción</th>
                    <th className="money-col">Total</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((item) => {
                    const lines = (data?.purchaseOrderLines ?? []).filter(
                      (line) => line.purchase_order_id === item.id,
                    );
                    return (
                      <tr
                        key={item.id}
                        tabIndex={0}
                        onClick={() => setDetail({ kind: "order", item })}
                      >
                        <td>
                          <strong>{item.purchase_order_number}</strong>
                        </td>
                        <td>{item.supplier_name}</td>
                        <td>
                          {displayDate(item.expected_on || item.ordered_on)}
                        </td>
                        <td>
                          {
                            lines.filter(
                              (line) =>
                                amount(line.received_quantity) >=
                                amount(line.quantity),
                            ).length
                          }
                          /{lines.length} líneas
                        </td>
                        <td className="money-col">
                          {money.format(amount(item.total_amount))}
                        </td>
                        <td>
                          <span className={statusClass(item.status)}>
                            {label(item.status)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {!visibleOrders.length && (
                    <tr>
                      <td colSpan={6}>
                        No hay órdenes para los filtros seleccionados.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {tab === "payables" && (
            <>
              <div className="table-scroll">
                <table className="p2p-dense-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Documento / obligación</th>
                      <th>Proveedor</th>
                      <th>Vencimiento</th>
                      <th className="money-col">Monto</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePayables.map((item) => {
                      const isDocument = "document_number" in item;
                      const eligible = item.payment_eligible;
                      const id = item.id;
                      const overdue = isDocument
                        ? isOverdue(item)
                        : isPayableOverdue(item);
                      const selected = isDocument
                        ? batch.documentIds.includes(id)
                        : batch.directPayableIds.includes(id);
                      return (
                        <tr
                          key={id}
                          tabIndex={0}
                          onClick={() =>
                            setDetail({
                              kind: isDocument ? "document" : "payable",
                              item,
                            })
                          }
                        >
                          <td onClick={(event) => event.stopPropagation()}>
                            {canManagePayments && (
                              <input
                                aria-label="Seleccionar para propuesta"
                                type="checkbox"
                                disabled={!eligible}
                                checked={selected}
                                onChange={() =>
                                  isDocument
                                    ? toggleDocument(id)
                                    : toggleDirectPayable(id)
                                }
                              />
                            )}
                          </td>
                          <td>
                            <strong>
                              {isDocument
                                ? item.document_number || "Sin folio"
                                : item.payable_number}
                            </strong>
                            <small>
                              {isDocument
                                ? "Factura recibida"
                                : item.description}
                            </small>
                          </td>
                          <td>
                            <strong>{item.supplier_name}</strong>
                            {!isDocument && item.beneficiary_name && (
                              <small>Beneficiario/a: {item.beneficiary_name}</small>
                            )}
                          </td>
                          <td>{displayDate(item.due_date)}</td>
                          <td className="money-col">
                            {money.format(amount(item.total_amount))}
                          </td>
                          <td>
                            <span
                              className={
                                eligible
                                  ? statusClass(overdue ? "review" : "approved")
                                  : "status cancelled"
                              }
                            >
                              {eligible
                                ? overdue
                                  ? "Vencida"
                                  : "Elegible"
                                : paymentBlockLabel(item.payment_block_reason)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {!visiblePayables.length && (
                      <tr>
                        <td colSpan={6}>
                          No hay documentos u obligaciones para los filtros
                          seleccionados.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {canManagePayments && (
                <div className="p2p-selection-bar">
                  <span>
                    {batch.documentIds.length + batch.directPayableIds.length}{" "}
                    seleccionado(s) · {money.format(selectedTotal)}
                  </span>
                  <button
                    className="primary-button"
                    disabled={
                      saving ||
                      (!batch.documentIds.length &&
                        !batch.directPayableIds.length)
                    }
                    onClick={prepareSelectedPayments}
                  >
                    Preparar propuesta de pago
                  </button>
                </div>
              )}
            </>
          )}
          {tab === "proposals" && (
            <div className="table-scroll">
              <table className="p2p-dense-table">
                <thead>
                  <tr>
                    <th>Propuesta / orden de pago</th>
                    <th>Programada</th>
                    <th>Documentos</th>
                    <th>Flujo IAS 7</th>
                    <th className="money-col">Monto</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleBatches.map((item) => {
                    const categories = [
                      ...new Set(
                        (data?.paymentBatchItems ?? [])
                          .filter((line) => line.payment_batch_id === item.id)
                          .map((line) => line.cash_flow_category),
                      ),
                    ];
                    return (
                      <tr
                        key={item.id}
                        tabIndex={0}
                        onClick={() => setDetail({ kind: "batch", item })}
                      >
                        <td>
                          <strong>{item.batch_number}</strong>
                          <small>
                            {item.status === "approved"
                              ? "Lista para instrucción bancaria"
                              : item.status === "processing"
                                ? "Instrucción bancaria en ejecución"
                                : item.status === "paid"
                                  ? "Pendiente de conciliación bancaria"
                                  : "Propuesta de pago"}
                          </small>
                        </td>
                        <td>{displayDate(item.scheduled_for)}</td>
                        <td>
                          {
                            (data?.paymentBatchItems ?? []).filter(
                              (line) => line.payment_batch_id === item.id,
                            ).length
                          }
                        </td>
                        <td>
                          {categories.length
                            ? categories.map(cashFlowLabel).join(" · ")
                            : "Sin clasificar"}
                        </td>
                        <td className="money-col">
                          {money.format(amount(item.total_amount))}
                        </td>
                        <td>
                          <span className={statusClass(item.status)}>
                            {paymentOrderStatusLabel(item.status)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {!visibleBatches.length && (
                    <tr>
                      <td colSpan={6}>
                        No hay propuestas de pago para los filtros
                        seleccionados.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {tab === "financing" && (
            <div className="table-scroll">
              <table className="p2p-dense-table">
                <thead>
                  <tr>
                    <th>Compromiso</th>
                    <th>Acreedor / proveedor</th>
                    <th>Primer vencimiento</th>
                    <th>Cuotas</th>
                    <th className="money-col">Total</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFinancing.map((item) => (
                    <tr
                      key={item.id}
                      tabIndex={0}
                      onClick={() => setDetail({ kind: "financing", item })}
                    >
                      <td>
                        <strong>{item.plan_number}</strong>
                        <small>
                          {item.plan_kind === "credit"
                            ? "Crédito / préstamo"
                            : item.plan_kind === "supplier_debt"
                              ? "Deuda con proveedor"
                              : item.asset_name}
                        </small>
                      </td>
                      <td>{item.supplier_name}</td>
                      <td>{displayDate(item.first_due_date)}</td>
                      <td>{item.installment_count}</td>
                      <td className="money-col">
                        {item.currency_code === "UF"
                          ? `${amount(item.financing_total_amount).toLocaleString("es-CL", { maximumFractionDigits: 4 })} UF`
                          : money.format(amount(item.financing_total_amount))}
                      </td>
                      <td>
                        <span className={statusClass(item.status)}>
                          {label(item.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!visibleFinancing.length && (
                    <tr>
                      <td colSpan={6}>
                        No hay compromisos para los filtros seleccionados.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {showRequestForm && canManage && (
        <section
          className="panel p2p-create-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Registrar necesidad de compra"
        >
          <div className="panel-heading">
            <div>
              <span className="panel-label">PASO 1 · NUEVO EXPEDIENTE</span>
              <h2>Registrar necesidad de compra</h2>
              <p>
                La solicitud se convierte luego en OC; proveedor, detalle, monto
                y centro de costo se heredan.
              </p>
            </div>
            <button
              className="modal-close"
              type="button"
              aria-label="Cerrar"
              onClick={() => setShowRequestForm(false)}
            >
              ×
            </button>
          </div>
          <form
            className="admin-form p2p-compact-form"
            onSubmit={createRequest}
          >
            <label>
              N° solicitud *
              <input
                required
                value={request.requestNumber}
                onChange={(event) =>
                  setRequest((current) => ({
                    ...current,
                    requestNumber: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Centro de costo *
              <select
                required
                value={request.costCenterId}
                onChange={(event) =>
                  setRequest((current) => ({
                    ...current,
                    costCenterId: event.target.value,
                  }))
                }
              >
                <option value="">Selecciona un centro</option>
                {data?.costCenters.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Proveedor
              <select
                value={request.supplierId}
                onChange={(event) => selectSupplier(event.target.value)}
              >
                <option value="">Proveedor no registrado</option>
                {data?.suppliers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.trade_name || item.legal_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Nombre proveedor *
              <input
                required
                value={request.supplierName}
                onChange={(event) =>
                  setRequest((current) => ({
                    ...current,
                    supplierName: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Monto estimado *
              <input
                required
                min="1"
                type="number"
                value={request.estimatedAmount}
                onChange={(event) =>
                  setRequest((current) => ({
                    ...current,
                    estimatedAmount: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Necesario para
              <input
                type="date"
                value={request.neededBy}
                onChange={(event) =>
                  setRequest((current) => ({
                    ...current,
                    neededBy: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Detalle *
              <input
                required
                value={request.description}
                onChange={(event) =>
                  setRequest((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </label>
            <label className="p2p-form-wide">
              Justificación / nota
              <input
                value={request.notes}
                onChange={(event) =>
                  setRequest((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
              />
            </label>
            <button className="primary-button" disabled={saving} type="submit">
              Crear solicitud
            </button>
          </form>
        </section>
      )}

      {showDirectPayableForm && canManagePayments && (
        <section
          className="panel p2p-create-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Registrar cuenta por pagar"
        >
          <div className="panel-heading">
            <div>
              <span className="panel-label">
                CUENTA DIRECTA · REQUIERE APROBACIÓN
              </span>
              <h2>Registrar factura o cuenta por pagar</h2>
              <p>
                Úsalo para servicios, arriendos u obligaciones ya autorizadas
                que aún no se han pagado. Tras aprobarse queda disponible para
                una propuesta de pago.
              </p>
            </div>
            <button
              className="modal-close"
              type="button"
              aria-label="Cerrar"
              onClick={() => setShowDirectPayableForm(false)}
            >
              ×
            </button>
          </div>
          <form
            className="admin-form p2p-compact-form"
            onSubmit={createDirectPayable}
          >
            <label>
              Centro de costo *
              <select
                required
                value={directPayable.costCenterId}
                onChange={(event) =>
                  setDirectPayable((current) => ({
                    ...current,
                    costCenterId: event.target.value,
                  }))
                }
              >
                <option value="">Selecciona un centro</option>
                {data?.costCenters.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Proveedor
              <select
                value={directPayable.supplierId}
                onChange={(event) =>
                  selectDirectPayableSupplier(event.target.value)
                }
              >
                <option value="">Proveedor no registrado</option>
                {data?.suppliers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.trade_name || item.legal_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Nombre proveedor *
              <input
                required
                value={directPayable.supplierName}
                onChange={(event) =>
                  setDirectPayable((current) => ({
                    ...current,
                    supplierName: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Folio factura
              <input
                value={directPayable.invoiceNumber}
                onChange={(event) =>
                  setDirectPayable((current) => ({
                    ...current,
                    invoiceNumber: event.target.value,
                  }))
                }
              />
            </label>
            {directPayable.category === "termination" && (
              <label>
                Persona beneficiaria *
                <input
                  required
                  maxLength={300}
                  value={directPayable.beneficiaryName}
                  onChange={(event) =>
                    setDirectPayable((current) => ({
                      ...current,
                      beneficiaryName: event.target.value,
                    }))
                  }
                  placeholder="Nombre de la persona desvinculada"
                />
              </label>
            )}
            <label>
              Tipo
              <select
                value={directPayable.category}
                onChange={(event) =>
                  setDirectPayable((current) => ({
                    ...current,
                    category: event.target.value,
                    categoryDetail:
                      event.target.value === "other"
                        ? current.categoryDetail
                        : "",
                  }))
                }
              >
                <option value="utilities">Servicios básicos</option>
                <option value="rent">Arriendo</option>
                <option value="taxes">Impuestos / contribuciones</option>
                <option value="insurance">Seguros</option>
                <option value="subscriptions">Suscripciones</option>
                <option value="termination">Finiquito</option>
                <option value="other">Otro</option>
              </select>
            </label>
            {directPayable.category === "other" && (
              <label>
                Especifica el tipo *
                <input
                  required
                  maxLength={120}
                  value={directPayable.categoryDetail}
                  onChange={(event) =>
                    setDirectPayable((current) => ({
                      ...current,
                      categoryDetail: event.target.value,
                    }))
                  }
                  placeholder="Ej. Mantención, asesoría o licencia"
                />
              </label>
            )}
            <label>
              Monto total *
              <input
                required
                min="1"
                type="number"
                value={directPayable.totalAmount}
                onChange={(event) =>
                  setDirectPayable((current) => ({
                    ...current,
                    totalAmount: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Fecha documento *
              <input
                required
                type="date"
                value={directPayable.issueDate}
                onChange={(event) =>
                  setDirectPayable((current) => ({
                    ...current,
                    issueDate: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Vencimiento
              <input
                type="date"
                value={directPayable.dueDate}
                onChange={(event) =>
                  setDirectPayable((current) => ({
                    ...current,
                    dueDate: event.target.value,
                  }))
                }
              />
            </label>
            <label className="p2p-form-wide">
              Concepto *
              <input
                required
                value={directPayable.description}
                onChange={(event) =>
                  setDirectPayable((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="Ej. Cuenta de electricidad oficina central"
              />
            </label>
            <label className="p2p-form-wide">
              Nota / respaldo
              <input
                value={directPayable.notes}
                onChange={(event) =>
                  setDirectPayable((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
              />
            </label>
            <label className="p2p-form-wide">
              Documento de respaldo
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                onChange={(event) =>
                  setDirectPayableFile(event.target.files?.[0] ?? null)
                }
              />
              <small>PDF, JPG o PNG · máximo 50 MB. Quedará disponible para quien apruebe el pago.</small>
            </label>
            <button className="primary-button" disabled={saving} type="submit">
              Crear cuenta por pagar
            </button>
          </form>
        </section>
      )}

      {showFinancingForm && canManagePayments && (
        <section
          className="panel p2p-create-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Registrar financiamiento"
        >
          <div className="panel-heading">
            <div>
              <span className="panel-label">
                OPERACIÓN FINANCIERA · UNA APROBACIÓN
              </span>
              <h2>
                {financing.planKind === "asset_financing"
                  ? "Registrar activo financiado"
                  : financing.planKind === "credit"
                    ? "Registrar crédito o préstamo"
                    : "Registrar deuda con proveedor"}
              </h2>
              <p>
                {financing.planKind === "asset_financing"
                  ? "Genera cuotas para caja y un calendario lineal de amortización contable del activo; ambos quedan ligados al mismo expediente."
                  : financing.planKind === "credit"
                    ? "Registra el desembolso que ingresa a caja y las cuotas futuras, sin crear un activo ni amortización."
                    : "Registra una obligación ya pactada con su calendario de cuotas, sin forzar amortización de activo."}
              </p>
            </div>
            <button
              className="modal-close"
              type="button"
              aria-label="Cerrar"
              onClick={() => setShowFinancingForm(false)}
            >
              ×
            </button>
          </div>
          <form
            className="admin-form p2p-compact-form"
            onSubmit={createFinancingPlan}
          >
            <label>
              Tipo de operación *
              <select
                value={financing.planKind}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    planKind: event.target.value,
                  }))
                }
              >
                <option value="asset_financing">Activo financiado</option>
                <option value="credit">Crédito / préstamo</option>
                <option value="supplier_debt">Deuda con proveedor</option>
              </select>
            </label>
            <label>
              N° plan *
              <input
                required
                value={financing.planNumber}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    planNumber: event.target.value,
                  }))
                }
                placeholder="Ej. CRED-2026-01"
              />
            </label>
            <label>
              Centro de costo *
              <select
                required
                value={financing.costCenterId}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    costCenterId: event.target.value,
                  }))
                }
              >
                <option value="">Selecciona un centro</option>
                {data?.costCenters.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {financing.planKind === "credit" ? "Acreedor" : "Proveedor"}
              <select
                value={financing.supplierId}
                onChange={(event) =>
                  selectFinancingSupplier(event.target.value)
                }
              >
                <option value="">No registrado</option>
                {data?.suppliers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.trade_name || item.legal_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Nombre{" "}
              {financing.planKind === "credit" ? "acreedor" : "proveedor"} *
              <input
                required
                value={financing.supplierName}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    supplierName: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Moneda
              <select
                value={financing.currencyCode}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    currencyCode: event.target.value,
                  }))
                }
              >
                <option value="CLP">Pesos chilenos</option>
                <option value="UF">UF</option>
              </select>
            </label>
            <label>
              {financing.planKind === "asset_financing"
                ? "Valor adquisición"
                : "Capital / monto origen"}{" "}
              ({financing.currencyCode}) *
              <input
                required
                min="1"
                type="number"
                step="0.0001"
                value={financing.principalAmount}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    principalAmount: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Total a pagar ({financing.currencyCode}) *
              <input
                required
                min="1"
                type="number"
                step="0.0001"
                value={financing.financingTotalAmount}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    financingTotalAmount: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              N° cuotas *
              <input
                required
                min="1"
                max="240"
                type="number"
                value={financing.installmentCount}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    installmentCount: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Primer vencimiento *
              <input
                required
                type="date"
                value={financing.firstDueDate}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    firstDueDate: event.target.value,
                  }))
                }
              />
            </label>
            {financing.planKind === "credit" && (
              <>
                <label>
                  Fecha desembolso *
                  <input
                    required
                    type="date"
                    value={financing.disbursementDate}
                    onChange={(event) =>
                      setFinancing((current) => ({
                        ...current,
                        disbursementDate: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Monto desembolsado ({financing.currencyCode}) *
                  <input
                    required
                    min="1"
                    type="number"
                    step="0.0001"
                    value={financing.disbursementAmount}
                    onChange={(event) =>
                      setFinancing((current) => ({
                        ...current,
                        disbursementAmount: event.target.value,
                      }))
                    }
                  />
                </label>
              </>
            )}
            {financing.planKind === "asset_financing" && (
              <>
                <label>
                  Activo *
                  <input
                    required
                    value={financing.assetName}
                    onChange={(event) =>
                      setFinancing((current) => ({
                        ...current,
                        assetName: event.target.value,
                      }))
                    }
                    placeholder="Ej. Vehículo operativo"
                  />
                </label>
                <label>
                  Valor contable del activo (CLP) *
                  <input
                    required
                    min="1"
                    type="number"
                    value={financing.assetCostClp}
                    onChange={(event) =>
                      setFinancing((current) => ({
                        ...current,
                        assetCostClp: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Valor residual (CLP)
                  <input
                    min="0"
                    type="number"
                    value={financing.residualValueClp}
                    onChange={(event) =>
                      setFinancing((current) => ({
                        ...current,
                        residualValueClp: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Vida útil (meses) *
                  <input
                    required
                    min="1"
                    max="600"
                    type="number"
                    value={financing.usefulLifeMonths}
                    onChange={(event) =>
                      setFinancing((current) => ({
                        ...current,
                        usefulLifeMonths: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Inicio amortización *
                  <input
                    required
                    type="month"
                    value={financing.amortizationStartMonth.slice(0, 7)}
                    onChange={(event) =>
                      setFinancing((current) => ({
                        ...current,
                        amortizationStartMonth: `${event.target.value}-01`,
                      }))
                    }
                  />
                </label>
              </>
            )}
            <label>
              Contrato / respaldo
              <input
                value={financing.contractReference}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    contractReference: event.target.value,
                  }))
                }
              />
            </label>
            <label className="p2p-form-wide">
              Notas
              <input
                value={financing.notes}
                onChange={(event) =>
                  setFinancing((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
              />
            </label>
            <button className="primary-button" disabled={saving} type="submit">
              Crear plan de financiamiento
            </button>
          </form>
        </section>
      )}

      {orderDraft.requestId && canManage && (
        <section
          className="panel p2p-create-panel"
          id="p2p-create-order"
          role="dialog"
          aria-modal="true"
          aria-label="Emitir orden de compra"
        >
          <div className="panel-heading">
            <div>
              <span className="panel-label">
                PASO 3 · DESDE SOLICITUD APROBADA
              </span>
              <h2>Emitir orden de compra</h2>
              <p>La OC conserva la trazabilidad de la solicitud origen.</p>
            </div>
            <button
              className="modal-close"
              type="button"
              aria-label="Cerrar"
              onClick={() =>
                setOrderDraft((current) => ({ ...current, requestId: "" }))
              }
            >
              ×
            </button>
          </div>
          <form
            className="admin-form p2p-compact-form"
            onSubmit={createOrderFromRequest}
          >
            <label>
              N° OC *
              <input
                required
                value={orderDraft.purchaseOrderNumber}
                onChange={(event) =>
                  setOrderDraft((current) => ({
                    ...current,
                    purchaseOrderNumber: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Entrega estimada
              <input
                type="date"
                value={orderDraft.expectedOn}
                onChange={(event) =>
                  setOrderDraft((current) => ({
                    ...current,
                    expectedOn: event.target.value,
                  }))
                }
              />
            </label>
            <label className="p2p-form-wide">
              Nota para proveedor
              <input
                value={orderDraft.notes}
                onChange={(event) =>
                  setOrderDraft((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
              />
            </label>
            <button className="primary-button" disabled={saving} type="submit">
              Crear OC desde solicitud
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() =>
                setOrderDraft({
                  requestId: "",
                  purchaseOrderNumber: "",
                  expectedOn: "",
                  notes: "",
                })
              }
            >
              Cancelar
            </button>
          </form>
        </section>
      )}

      {showBatchForm && canManagePayments && (
        <section
          className="panel p2p-create-panel p2p-payment-batch-modal"
          id="p2p-payment-batch"
          role="dialog"
          aria-modal="true"
          aria-label="Preparar propuesta de pago"
        >
          <div className="panel-heading">
            <div>
              <span className="panel-label">PASO 5 · PROPUESTA DE PAGO</span>
              <h2>Preparar propuesta de pago</h2>
              <p>
                {isPreparingSelectedPayments
                  ? "Revisa los documentos que seleccionaste. Para cambiar la selección, vuelve a la bandeja de cuentas por pagar."
                  : "Incluye documentos elegibles y cuentas directas que ya fueron aprobadas."} El número de propuesta se asignará automáticamente al crearla.
              </p>
            </div>
            <span className="unit">{money.format(selectedTotal)}</span>
            <button
              className="modal-close"
              type="button"
              aria-label="Cerrar"
              onClick={() => setShowBatchForm(false)}
            >
              ×
            </button>
          </div>
          <form
            className="admin-form p2p-compact-form p2p-payment-batch-form"
            onSubmit={createBatch}
          >
            <label>
              Fecha de pago *
              <input
                required
                type="date"
                value={batch.scheduledFor}
                onChange={(event) =>
                  setBatch((current) => ({
                    ...current,
                    scheduledFor: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Cuenta bancaria
              <select
                value={batch.bankAccountId}
                onChange={(event) =>
                  setBatch((current) => ({
                    ...current,
                    bankAccountId: event.target.value,
                  }))
                }
              >
                <option value="">Sin cuenta asignada</option>
                {data?.bankAccounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.account_number_masked
                      ? ` · ${item.account_number_masked}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Nota
              <input
                value={batch.notes}
                onChange={(event) =>
                  setBatch((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
              />
            </label>
            <div className="table-scroll p2p-form-wide">
              <table>
                <thead>
                  <tr>
                    <th>{isPreparingSelectedPayments ? "Estado" : "Incluir"}</th>
                    <th>Proveedor / documento</th>
                    <th>Vencimiento</th>
                    <th>Clasificación IAS 7</th>
                    <th className="money-col">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentProposalDocuments.map((document) => (
                    <tr key={document.id}>
                      <td>
                        {isPreparingSelectedPayments ? (
                          <span className="p2p-selection-state">Incluida</span>
                        ) : (
                          <input
                            aria-label={`Incluir ${document.supplier_name}`}
                            type="checkbox"
                            checked={batch.documentIds.includes(document.id)}
                            onChange={() => toggleDocument(document.id)}
                          />
                        )}
                      </td>
                      <td>
                        <strong>{document.supplier_name}</strong>
                        <small>{document.document_number || "Sin folio"}</small>
                      </td>
                      <td>{displayDate(document.due_date)}</td>
                      <td>
                        <select
                          aria-label={`Clasificación IAS 7 de ${document.supplier_name}`}
                          value={
                            cashFlowCategories[`received:${document.id}`] ??
                            "operating"
                          }
                          onChange={(event) =>
                            setCashFlowCategories((current) => ({
                              ...current,
                              [`received:${document.id}`]: event.target
                                .value as
                                | "operating"
                                | "investing"
                                | "financing",
                            }))
                          }
                        >
                          <option value="operating">Operación</option>
                          <option value="investing">Inversión</option>
                          <option value="financing">Financiamiento</option>
                        </select>
                      </td>
                      <td className="money-col">
                        {money.format(amount(document.total_amount))}
                      </td>
                    </tr>
                  ))}
                  {paymentProposalDirectPayables.map((payable) => (
                    <tr key={payable.id}>
                      <td>
                        {isPreparingSelectedPayments ? (
                          <span className="p2p-selection-state">Incluida</span>
                        ) : (
                          <input
                            aria-label={`Incluir ${payable.supplier_name}`}
                            type="checkbox"
                            checked={batch.directPayableIds.includes(payable.id)}
                            onChange={() => toggleDirectPayable(payable.id)}
                          />
                        )}
                      </td>
                      <td>
                        <strong>{payable.supplier_name}</strong>
                        <small>
                          {payable.invoice_number || payable.payable_number} ·
                          Cuenta directa
                        </small>
                      </td>
                      <td>{displayDate(payable.due_date)}</td>
                      <td>
                        <select
                          aria-label={`Clasificación IAS 7 de ${payable.supplier_name}`}
                          value={
                            cashFlowCategories[`payable:${payable.id}`] ??
                            "operating"
                          }
                          onChange={(event) =>
                            setCashFlowCategories((current) => ({
                              ...current,
                              [`payable:${payable.id}`]: event.target.value as
                                | "operating"
                                | "investing"
                                | "financing",
                            }))
                          }
                        >
                          <option value="operating">Operación</option>
                          <option value="investing">Inversión</option>
                          <option value="financing">Financiamiento</option>
                        </select>
                      </td>
                      <td className="money-col">
                        {money.format(amount(payable.total_amount))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!isPreparingSelectedPayments && paymentBlockedDocuments.length > 0 && (
              <div className="p2p-payment-blocked p2p-form-wide">
                <strong>Documentos no elegibles para esta propuesta</strong>
                {paymentBlockedDocuments.map((document) => (
                  <p key={document.id}>
                    {document.supplier_name} ·{" "}
                    {document.document_number || "Sin folio"}:{" "}
                    {paymentBlockLabel(document.payment_block_reason)}
                  </p>
                ))}
              </div>
            )}
            <button
              className="primary-button"
              disabled={
                saving ||
                (!batch.documentIds.length && !batch.directPayableIds.length)
              }
              type="submit"
            >
              Crear propuesta de pago
            </button>
          </form>
        </section>
      )}
      {detail && (
        <div
          className="modal-backdrop p2p-glass-backdrop"
          role="presentation"
          onMouseDown={() => setDetail(null)}
        >
          <section
            className="entry-modal p2p-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Detalle del expediente"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">
                  EXPEDIENTE 360 ·{" "}
                  {detail.kind === "batch" ? "PAGO" : detail.kind.toUpperCase()}
                </span>
                <h2>
                  {"request_number" in detail.item
                    ? detail.item.request_number
                    : "purchase_order_number" in detail.item
                      ? detail.item.purchase_order_number
                      : "payable_number" in detail.item
                        ? detail.item.payable_number
                        : "document_number" in detail.item
                          ? detail.item.document_number || "Factura sin folio"
                          : "batch_number" in detail.item
                            ? detail.item.batch_number
                            : detail.item.plan_number}
                </h2>
                <p>
                  {"supplier_name" in detail.item
                    ? detail.item.supplier_name
                    : detail.item.payment_reference || "Propuesta de pago"}
                </p>
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Cerrar"
                onClick={() => setDetail(null)}
              >
                ×
              </button>
            </div>
            <div className="p2p-detail-grid">
              <article>
                <span>Estado</span>
                <strong>
                  <span className={statusClass(detail.item.status)}>
                    {detail.kind === "batch"
                      ? paymentOrderStatusLabel(detail.item.status)
                      : label(detail.item.status)}
                  </span>
                </strong>
              </article>
              <article>
                <span>Monto</span>
                <strong>
                  {"estimated_amount" in detail.item
                    ? money.format(amount(detail.item.estimated_amount))
                    : "total_amount" in detail.item
                      ? money.format(amount(detail.item.total_amount))
                      : "financing_total_amount" in detail.item
                        ? money.format(
                            amount(detail.item.financing_total_amount),
                          )
                        : "total_amount" in detail.item
                          ? money.format(amount(detail.item.total_amount))
                          : "—"}
                </strong>
              </article>
              <article>
                <span>Trazabilidad</span>
                <strong>
                  {detail.kind === "order"
                    ? "Solicitud → OC → recepción → factura"
                    : detail.kind === "batch"
                      ? "Propuesta → aprobación → instrucción bancaria → conciliación"
                      : "Expediente con bitácora y aprobaciones"}
                </strong>
              </article>
            </div>
            {detail.kind === "order" && (
              <div className="p2p-detail-section">
                <h3>Recepción y factura</h3>
                <p>
                  {(data?.purchaseOrderLines ?? [])
                    .filter((line) => line.purchase_order_id === detail.item.id)
                    .map(
                      (line) =>
                        `${line.description}: ${amount(line.received_quantity)}/${amount(line.quantity)}`,
                    )
                    .join(" · ") || "Sin líneas registradas."}
                </p>
                {["received", "partially_received"].includes(
                  detail.item.status,
                ) && (
                  <div className="p2p-inline-action">
                    <select
                      aria-label="Factura recibida para vincular"
                      value={documentToLink[detail.item.id] ?? ""}
                      onChange={(event) =>
                        setDocumentToLink((current) => ({
                          ...current,
                          [detail.item.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Selecciona una factura sin OC</option>
                      {unlinkedDocuments.map((document) => (
                        <option key={document.id} value={document.id}>
                          {document.supplier_name} ·{" "}
                          {document.document_number || "Sin folio"} ·{" "}
                          {money.format(amount(document.total_amount))}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!documentToLink[detail.item.id] || saving}
                      onClick={() => void linkDocumentToOrder(detail.item.id)}
                    >
                      Vincular factura
                    </button>
                  </div>
                )}
              </div>
            )}
            {detail.kind === "batch" && (
              <div className="p2p-detail-section">
                <h3>Clasificación de flujo</h3>
                <p>
                  {[
                    ...new Set(
                      (data?.paymentBatchItems ?? [])
                        .filter(
                          (line) => line.payment_batch_id === detail.item.id,
                        )
                        .map(
                          (line) =>
                            ({
                              operating: "Operación",
                              investing: "Inversión",
                              financing: "Financiamiento",
                            })[line.cash_flow_category ?? ""],
                        )
                        .filter(Boolean),
                    ),
                  ].join(" · ") || "Se clasificará al preparar la propuesta."}
                </p>
                <div className="table-scroll">
                  <table className="p2p-dense-table p2p-detail-items">
                    <thead>
                      <tr>
                        <th>Proveedor / documento</th>
                        <th>Vencimiento</th>
                        <th>IAS 7</th>
                        <th className="money-col">Monto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.paymentBatchItems ?? [])
                        .filter(
                          (line) => line.payment_batch_id === detail.item.id,
                        )
                        .map((line) => (
                          <tr key={line.id}>
                            <td>
                              <strong>{line.supplier_name_snapshot}</strong>
                              <small>
                                {line.document_number_snapshot || "Sin folio"}
                              </small>
                            </td>
                            <td>{displayDate(line.due_date_snapshot)}</td>
                            <td>{cashFlowLabel(line.cash_flow_category)}</td>
                            <td className="money-col">
                              {money.format(amount(line.amount))}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {detail.kind === "payable" && (
              <div className="p2p-detail-section">
                <h3>Control de pago</h3>
                {(detail.item as DirectPayable).beneficiary_name && (
                  <p><strong>Beneficiario/a:</strong> {(detail.item as DirectPayable).beneficiary_name}</p>
                )}
                <p>
                  {paymentBlockLabel(
                    (detail.item as DirectPayable).payment_block_reason,
                  )}
                </p>
                {canManagePayments && (
                  <>
                    <div className="p2p-inline-action">
                      <input
                        aria-label="Persona beneficiaria"
                        value={payableBeneficiaryDraft}
                        onChange={(event) => setPayableBeneficiaryDraft(event.target.value)}
                        placeholder="Persona beneficiaria"
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={saving || !payableBeneficiaryDraft.trim()}
                        onClick={() => void savePayableBeneficiary(detail.item.id)}
                      >
                        Guardar beneficiario
                      </button>
                    </div>
                    <label className="p2p-inline-file">
                      Adjuntar respaldo al expediente
                      <input
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                        disabled={saving}
                        onChange={(event) =>
                          void uploadPayableAttachment(
                            detail.item.id,
                            event.target.files?.[0] ?? null,
                          )
                        }
                      />
                    </label>
                  </>
                )}
              </div>
            )}
            <div className="modal-actions">
              {detail.kind === "request" &&
                canManage &&
                detail.item.status === "draft" && (
                  <button
                    className="primary-button"
                    disabled={saving}
                    onClick={() =>
                      void transition(detail.item.id, "submit_purchase_request")
                    }
                  >
                    Enviar a aprobación
                  </button>
                )}
              {detail.kind === "request" &&
                canManage &&
                detail.item.status === "approved" && (
                  <button
                    className="primary-button"
                    onClick={() => {
                      beginOrder(detail.item.id);
                      setDetail(null);
                    }}
                  >
                    Crear orden de compra
                  </button>
                )}
              {detail.kind === "order" &&
                canManage &&
                detail.item.status === "draft" && (
                  <button
                    className="primary-button"
                    disabled={saving}
                    onClick={() =>
                      void transition(detail.item.id, "submit_purchase_order")
                    }
                  >
                    Enviar a aprobación
                  </button>
                )}
              {detail.kind === "order" &&
                canManage &&
                detail.item.status === "approved" && (
                  <button
                    className="primary-button"
                    disabled={saving}
                    onClick={() =>
                      void transition(detail.item.id, "send_purchase_order")
                    }
                  >
                    Enviar al proveedor
                  </button>
                )}
              {detail.kind === "order" &&
                canManage &&
                ["sent", "partially_received"].includes(detail.item.status) && (
                  <button
                    className="primary-button"
                    onClick={() => {
                      openReceipt(detail.item.id);
                      setDetail(null);
                    }}
                  >
                    Registrar recepción
                  </button>
                )}
              {detail.kind === "batch" &&
                canManagePayments &&
                detail.item.status === "draft" && (
                  <button
                    className="primary-button"
                    disabled={saving}
                    onClick={() =>
                      void transition(detail.item.id, "submit_payment_batch")
                    }
                  >
                    Enviar propuesta a aprobación
                  </button>
                )}
              {detail.kind === "batch" &&
                canManagePayments &&
                detail.item.status === "approved" && (
                  <button
                    className="primary-button"
                    disabled={saving}
                    onClick={() =>
                      void transition(detail.item.id, "start_payment_batch")
                    }
                  >
                    Emitir instrucción bancaria
                  </button>
                )}
              {detail.kind === "batch" &&
                canManagePayments &&
                detail.item.status === "processing" && (
                  <button
                    className="primary-button"
                    disabled={saving}
                    onClick={() =>
                      void transition(detail.item.id, "mark_payment_batch_paid")
                    }
                  >
                    Confirmar orden de pago
                  </button>
                )}
              {detail.kind === "financing" &&
                canManagePayments &&
                detail.item.status === "draft" && (
                  <button
                    className="primary-button"
                    disabled={saving}
                    onClick={() =>
                      void transition(
                        detail.item.id,
                        "submit_asset_financing_plan",
                      )
                    }
                  >
                    Enviar a aprobación
                  </button>
                )}
              <button
                className="secondary-button"
                onClick={() => setDetail(null)}
              >
                Cerrar
              </button>
            </div>
          </section>
        </div>
      )}
      {receiptOrder && canManage && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() =>
            setReceiptDraft({
              purchaseOrderId: "",
              receivedOn: today(),
              notes: "",
              lines: {},
            })
          }
        >
          <section
            className="entry-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Registrar recepción conforme"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">RECEPCIÓN CONFORME · OC</span>
                <h2>
                  {receiptOrder.purchase_order_number} ·{" "}
                  {receiptOrder.supplier_name}
                </h2>
                <p>
                  Registra sólo lo recibido. La factura podrá vincularse y
                  pagarse hasta el monto y las cantidades ya confirmadas.
                </p>
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Cerrar"
                onClick={() =>
                  setReceiptDraft({
                    purchaseOrderId: "",
                    receivedOn: today(),
                    notes: "",
                    lines: {},
                  })
                }
              >
                ×
              </button>
            </div>
            <form className="admin-form" onSubmit={recordReceipt}>
              <label>
                Fecha de recepción *
                <input
                  required
                  type="date"
                  value={receiptDraft.receivedOn}
                  onChange={(event) =>
                    setReceiptDraft((current) => ({
                      ...current,
                      receivedOn: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="p2p-form-wide">
                Observación / respaldo
                <input
                  value={receiptDraft.notes}
                  maxLength={2000}
                  onChange={(event) =>
                    setReceiptDraft((current) => ({
                      ...current,
                      notes: event.target.value,
                    }))
                  }
                  placeholder="Ej. Guía, conformidad del área solicitante o diferencia pendiente"
                />
              </label>
              <div className="table-scroll p2p-form-wide">
                <table>
                  <thead>
                    <tr>
                      <th>Línea</th>
                      <th className="money-col">Pedida</th>
                      <th className="money-col">Ya recibida</th>
                      <th className="money-col">Pendiente</th>
                      <th className="money-col">Recibir ahora</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receiptLines.map((line) => {
                      const pending = Math.max(
                        0,
                        amount(line.quantity) - amount(line.received_quantity),
                      );
                      return (
                        <tr key={line.id}>
                          <td>
                            <strong>{line.description}</strong>
                          </td>
                          <td className="money-col">
                            {amount(line.quantity).toLocaleString("es-CL")}
                          </td>
                          <td className="money-col">
                            {amount(line.received_quantity).toLocaleString(
                              "es-CL",
                            )}
                          </td>
                          <td className="money-col">
                            {pending.toLocaleString("es-CL")}
                          </td>
                          <td className="money-col">
                            <input
                              aria-label={`Cantidad recibida ${line.description}`}
                              disabled={pending === 0}
                              min="0"
                              max={pending}
                              step="0.0001"
                              type="number"
                              value={receiptDraft.lines[line.id] ?? ""}
                              onChange={(event) =>
                                setReceiptDraft((current) => ({
                                  ...current,
                                  lines: {
                                    ...current.lines,
                                    [line.id]: event.target.value,
                                  },
                                }))
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="modal-actions p2p-form-wide">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    setReceiptDraft({
                      purchaseOrderId: "",
                      receivedOn: today(),
                      notes: "",
                      lines: {},
                    })
                  }
                >
                  Cancelar
                </button>
                <button
                  className="primary-button"
                  disabled={saving}
                  type="submit"
                >
                  Confirmar recepción
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
