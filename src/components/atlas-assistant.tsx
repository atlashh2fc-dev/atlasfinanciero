"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type Message = { id: number; role: "assistant" | "user"; content: string };

const prompts = [
  "¿Cuál es la última factura emitida a Natura?",
  "¿Cuál es el estado de las prefacturas?",
  "¿Cuánto tenemos por cobrar?",
  "¿Cuál es la última orden de compra?",
];

const welcome: Message = {
  id: 0,
  role: "assistant",
  content: "Hola, soy Atlas. Puedo consultar información de la empresa activa: facturas emitidas y recibidas, prefacturas, cartera y órdenes de compra. ¿Qué necesitas revisar?",
};

export function AtlasAssistant({ organizationId }: { organizationId: string | null }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([welcome]);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(1);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([welcome]);
    setQuestion("");
  }, [organizationId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, loading]);

  async function ask(event?: FormEvent<HTMLFormElement>, prompt = question) {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || !organizationId || loading) return;
    setMessages((current) => [...current, { id: sequence.current++, role: "user", content: text }]);
    setQuestion("");
    setLoading(true);
    const response = await fetch("/api/atlas-assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, question: text }) });
    const payload = await response.json().catch(() => null) as { answer?: string; error?: string } | null;
    setMessages((current) => [...current, { id: sequence.current++, role: "assistant", content: response.ok ? payload?.answer || "No pude preparar una respuesta para esa consulta." : response.status === 403 ? "No tienes permiso para consultar esa información." : "No pude consultar la información en este momento. Inténtalo nuevamente." }]);
    setLoading(false);
  }

  return <div className="atlas-assistant">
    {open && <section id="atlas-assistant-panel" className="atlas-assistant-panel" role="dialog" aria-modal="false" aria-label="Asistente Atlas">
      <header className="atlas-assistant-header"><div><span>ASISTENTE FINANCIERO</span><h2>Atlas</h2></div><button type="button" onClick={() => setOpen(false)} aria-label="Minimizar Atlas">−</button></header>
      <div className="atlas-assistant-messages" aria-live="polite">{messages.map((message) => <p className={`atlas-message ${message.role}`} key={message.id}>{message.content}</p>)}{loading && <p className="atlas-message assistant is-thinking">Atlas está revisando la información…</p>}<div ref={messagesEnd} /></div>
      <div className="atlas-assistant-prompts">{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => void ask(undefined, prompt)} disabled={loading}>{prompt}</button>)}</div>
      <form className="atlas-assistant-form" onSubmit={(event) => void ask(event)}><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Escribe tu consulta…" maxLength={600} disabled={loading} aria-label="Consulta para Atlas" /><button type="submit" disabled={loading || !question.trim()}>Enviar</button></form>
      <p className="atlas-assistant-disclaimer">Consulta datos reales de la empresa activa. Atlas no ejecuta acciones ni modifica información.</p>
    </section>}
    <button className="atlas-assistant-fab" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-controls="atlas-assistant-panel"><span aria-hidden="true">✦</span><strong>Atlas</strong></button>
  </div>;
}
