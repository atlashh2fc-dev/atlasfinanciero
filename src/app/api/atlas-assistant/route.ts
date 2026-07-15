import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationProcurementAccess } from "@/lib/admin-access";

type AskRequest = { organizationId?: unknown; question?: unknown };
type IssuedDocument = { document_number: string | null; issue_date: string | null; document_type: string | null; client_name: string | null; recipient_name: string | null; total_amount: number | string | null; payment_status: string | null };
type Preinvoice = { counterparty_id: string; period_month: string; status: string; total_amount: number | string | null };
type Counterparty = { id: string; legal_name: string; trade_name: string | null };

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const stopWords = new Set(["atlas", "cual", "que", "como", "dime", "dame", "ultima", "ultimo", "ultimas", "ultimos", "factura", "facturas", "emitida", "emitidas", "emitido", "emitidos", "recibida", "recibidas", "prefactura", "prefacturas", "estado", "monto", "total", "fecha", "folio", "cliente", "clientes", "proveedor", "proveedores", "orden", "compra", "por", "para", "con", "del", "las", "los", "una", "uno", "a", "de", "en", "es", "hay", "tiene", "tenemos", "cuanto", "cuanta", "cobrar", "cartera", "vencida", "vencido"]);

function normalize(value: string | null | undefined) {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();
}

function terms(question: string) {
  return normalize(question).split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !stopWords.has(term));
}

function date(value: string | null) {
  if (!value) return "sin fecha";
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function amount(value: number | string | null) {
  return money.format(Number(value ?? 0));
}

function score(questionTerms: string[], values: Array<string | null | undefined>) {
  const haystack = normalize(values.filter(Boolean).join(" "));
  return questionTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
}

function bestByName<T>(items: T[], questionTerms: string[], names: (item: T) => Array<string | null | undefined>) {
  if (!questionTerms.length) return items[0] ?? null;
  const ranked = items.map((item) => ({ item, score: score(questionTerms, names(item)) })).filter((item) => item.score > 0);
  return ranked.sort((left, right) => right.score - left.score)[0]?.item ?? null;
}

function isInvoice(document: IssuedDocument) {
  const type = normalize(document.document_type);
  return type.includes("factura") && !type.includes("nota de credito");
}

function hasExpenseAccess(role: string) {
  return ["administrator", "finance", "auditor"].includes(role);
}

function isPaid(status: string | null) {
  return normalize(status).includes("pagada");
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as AskRequest | null;
  const organizationId = body?.organizationId;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!isUuid(organizationId) || !question || question.length > 600) return NextResponse.json({ error: "invalid_question" }, { status: 400 });

  const context = await requireOrganizationProcurementAccess(organizationId);
  if (context.error || !context.supabase || !context.membership) return NextResponse.json({ error: context.error }, { status: context.status });

  const normalizedQuestion = normalize(question);
  const questionTerms = terms(question);
  const expenseQuestion = /factura.*recibid|recibid.*factura|proveedor|gasto/.test(normalizedQuestion);
  const purchaseOrderQuestion = /orden de compra|\boc\b/.test(normalizedQuestion);
  const preinvoiceQuestion = normalizedQuestion.includes("prefactura");
  const receivableQuestion = /por cobrar|cartera|vencid/.test(normalizedQuestion);

  if (expenseQuestion) {
    if (!hasExpenseAccess(context.membership.role)) return NextResponse.json({ answer: "Tu rol no tiene acceso a facturas recibidas ni gastos." });
    const { data, error } = await context.supabase.from("received_documents").select("document_number, issue_date, document_type, supplier_name, total_amount, payment_status").eq("organization_id", organizationId).order("issue_date", { ascending: false }).limit(500);
    if (error) return NextResponse.json({ error: "unable_to_read_received_documents" }, { status: 500 });
    const document = bestByName(data ?? [], questionTerms, (item) => [item.supplier_name]);
    if (!document) return NextResponse.json({ answer: questionTerms.length ? "No encontré una factura recibida para ese proveedor en la empresa activa." : "No hay facturas recibidas disponibles para consultar." });
    return NextResponse.json({ answer: `La última factura recibida${document.supplier_name ? ` de ${document.supplier_name}` : ""} es ${document.document_type || "Documento"} folio ${document.document_number || "sin folio"}. Fecha: ${date(document.issue_date)}. Total: ${amount(document.total_amount)}. Estado: ${document.payment_status || "sin estado"}.` });
  }

  if (purchaseOrderQuestion) {
    const { data, error } = await context.supabase.from("customer_purchase_orders").select("purchase_order_number, customer_name, received_date, valid_until, net_amount, currency_code, status").eq("organization_id", organizationId).order("received_date", { ascending: false }).limit(500);
    if (error) return NextResponse.json({ error: "unable_to_read_purchase_orders" }, { status: 500 });
    const order = bestByName(data ?? [], questionTerms, (item) => [item.customer_name]);
    if (!order) return NextResponse.json({ answer: questionTerms.length ? "No encontré una orden de compra para ese cliente." : "No hay órdenes de compra disponibles para consultar." });
    return NextResponse.json({ answer: `La última OC${order.customer_name ? ` de ${order.customer_name}` : ""} es ${order.purchase_order_number}. Recibida el ${date(order.received_date)}. Monto neto: ${order.currency_code || "CLP"} ${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(Number(order.net_amount ?? 0))}. Estado: ${order.status}.` });
  }

  if (preinvoiceQuestion) {
    const [{ data: preinvoices, error: preinvoiceError }, { data: customers, error: customersError }] = await Promise.all([
      context.supabase.from("preinvoices").select("counterparty_id, period_month, status, total_amount").eq("organization_id", organizationId).order("period_month", { ascending: false }).limit(500),
      context.supabase.from("counterparties").select("id, legal_name, trade_name").eq("organization_id", organizationId).in("kind", ["customer", "both"]),
    ]);
    if (preinvoiceError || customersError) return NextResponse.json({ error: "unable_to_read_preinvoices" }, { status: 500 });
    const customersById = new Map((customers as Counterparty[] ?? []).map((customer) => [customer.id, customer]));
    const item = bestByName(preinvoices as Preinvoice[] ?? [], questionTerms, (preinvoice) => {
      const customer = customersById.get(preinvoice.counterparty_id);
      return [customer?.legal_name, customer?.trade_name];
    });
    if (item) {
      const customer = customersById.get(item.counterparty_id);
      return NextResponse.json({ answer: `La última prefactura${customer ? ` de ${customer.trade_name || customer.legal_name}` : ""} corresponde a ${date(item.period_month)}. Total: ${amount(item.total_amount)}. Estado: ${item.status === "review" ? "En revisión" : item.status === "approved" ? "Aprobada" : item.status === "issued" ? "Emitida" : item.status === "cancelled" ? "Anulada" : "Borrador"}.` });
    }
    const summary = (preinvoices ?? []).reduce<Record<string, number>>((result, preinvoice) => ({ ...result, [preinvoice.status]: (result[preinvoice.status] ?? 0) + 1 }), {});
    return NextResponse.json({ answer: `Hay ${summary.draft ?? 0} prefactura(s) en borrador, ${summary.review ?? 0} en revisión, ${summary.approved ?? 0} aprobada(s) y ${summary.issued ?? 0} emitida(s). Puedes preguntarme por un cliente específico.` });
  }

  const { data, error } = await context.supabase.from("issued_documents").select("document_number, issue_date, document_type, client_name, recipient_name, total_amount, payment_status").eq("organization_id", organizationId).order("issue_date", { ascending: false }).limit(1000);
  if (error) return NextResponse.json({ error: "unable_to_read_issued_documents" }, { status: 500 });
  const invoices = (data as IssuedDocument[] ?? []).filter(isInvoice);

  if (receivableQuestion) {
    const pending = invoices.filter((document) => !isPaid(document.payment_status));
    const total = pending.reduce((sum, document) => sum + Number(document.total_amount ?? 0), 0);
    return NextResponse.json({ answer: `La cartera abierta registra ${pending.length} factura(s) no pagada(s), por un total de ${amount(total)}. Esta lectura usa el estado de pago registrado en Facturas.` });
  }

  const folio = normalizedQuestion.match(/(?:folio|factura|n)[°ºo.\s]*(\d{1,12})/)?.[1];
  const document = folio ? invoices.find((item) => normalize(item.document_number).includes(folio)) ?? null : bestByName(invoices, questionTerms, (item) => [item.client_name, item.recipient_name]);
  if (!document) return NextResponse.json({ answer: questionTerms.length ? "No encontré una factura emitida para ese cliente o folio en la empresa activa." : "No hay facturas emitidas disponibles para consultar." });
  const customer = document.client_name || document.recipient_name || "cliente no informado";
  return NextResponse.json({ answer: `La última factura emitida a ${customer} es ${document.document_type || "Factura"} folio ${document.document_number || "sin folio"}. Fecha de emisión: ${date(document.issue_date)}. Total: ${amount(document.total_amount)}. Estado: ${document.payment_status || "sin estado"}.` });
}
