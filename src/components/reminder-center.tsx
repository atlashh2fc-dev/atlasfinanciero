"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  reminderAmountLabel,
  reminderCopy,
  reminderDayLabel,
  type DueReminder,
} from "@/lib/reminders";

const POLL_MS = 60_000;
const CELEBRATION_MS = 2_800;

const batchStatusLabels: Record<string, string> = {
  draft: "Borrador",
  review: "En aprobación",
  approved: "Aprobada",
  processing: "En ejecución",
};

// Avisos personales: aparecen sin bloquear la pantalla, uno a la vez, y
// vuelven cada intervalo hasta que se aprueban (o se paga la cuenta).
export function ReminderCenter() {
  const [reminders, setReminders] = useState<DueReminder[]>([]);
  const [busy, setBusy] = useState<"approve" | "snooze" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<{ id: string; text: string } | null>(null);
  const celebrationTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/reminders", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { reminders?: DueReminder[] };
      setReminders(payload.reminders ?? []);
    } catch {
      // Sin red: se reintenta en el próximo ciclo.
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  useEffect(() => () => {
    if (celebrationTimer.current) window.clearTimeout(celebrationTimer.current);
  }, []);

  // Con la pestaña en segundo plano, el título avisa que hay algo pendiente.
  const pendingCount = reminders.length;
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = pendingCount ? `(${pendingCount}) ${base}` : base;
    return () => {
      document.title = document.title.replace(/^\(\d+\) /, "");
    };
  }, [pendingCount]);

  const reminder = reminders[0];
  if (!reminder) return null;

  const copy = reminderCopy(reminder);
  const amount = reminderAmountLabel(reminder.amount);
  const day = reminderDayLabel(reminder.scheduled_for);
  const batchStatus = reminder.batch_status ? batchStatusLabels[reminder.batch_status] ?? null : null;
  const celebrating = celebration?.id === reminder.id;
  const playful = reminder.style === "playful";
  const headlineId = `reminder-${reminder.id}-title`;

  async function approve() {
    if (busy) return;
    setBusy("approve");
    setError(null);
    try {
      const response = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", id: reminder.id }),
      });
      if (!response.ok) throw new Error("approve_failed");
      setCelebration({ id: reminder.id, text: copy.celebration });
      celebrationTimer.current = window.setTimeout(() => {
        setCelebration(null);
        setReminders((current) => current.filter((item) => item.id !== reminder.id));
      }, CELEBRATION_MS);
    } catch {
      setError("No pudimos aprobarlo. Puede que ya esté decidido: revísalo en Aprobaciones.");
      void load();
    } finally {
      setBusy(null);
    }
  }

  async function snooze() {
    if (busy) return;
    setBusy("snooze");
    setError(null);
    // Se oculta al instante; si falla, vuelve con el motivo.
    setReminders((current) => current.filter((item) => item.id !== reminder.id));
    try {
      const response = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "snooze", id: reminder.id }),
      });
      if (!response.ok) throw new Error("snooze_failed");
    } catch {
      setReminders((current) => [reminder, ...current.filter((item) => item.id !== reminder.id)]);
      setError("No pudimos posponerlo. Inténtalo de nuevo.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <aside className="reminder-center" aria-label="Recordatorios" aria-live="polite">
      <section
        className={`reminder-card${playful ? " is-playful" : ""}${celebrating ? " is-celebrating" : ""}`}
        aria-labelledby={headlineId}
      >
        {celebrating ? (
          <div className="reminder-celebration" role="status">
            <span className="reminder-confetti" aria-hidden="true">
              {Array.from({ length: 14 }, (_, index) => <i key={index} />)}
            </span>
            <span className="reminder-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </span>
            <h2 id={headlineId}>{celebration.text}</h2>
            <p>Quedó aprobado para pago.</p>
          </div>
        ) : (
          <>
            <div className="reminder-top">
              <span className="reminder-bell" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
              </span>
              <span className="reminder-eyebrow">{copy.eyebrow}</span>
              <span className="reminder-attempt">Aviso {reminder.snooze_count + 1}</span>
            </div>
            <h2 id={headlineId}>{copy.headline}</h2>
            <p className="reminder-body">{copy.body}</p>
            <dl className="reminder-facts">
              {amount && <div><dt>Monto</dt><dd className="reminder-amount">{amount}</dd></div>}
              {day && <div><dt>Pago</dt><dd>{day}</dd></div>}
              {batchStatus && <div><dt>Estado</dt><dd>{batchStatus}</dd></div>}
            </dl>
            {error && <p className="reminder-error" role="alert">{error}</p>}
            <div className="reminder-actions">
              {reminder.can_approve ? (
                <button type="button" className="reminder-approve" onClick={() => void approve()} disabled={Boolean(busy)}>
                  {busy === "approve" ? "Aprobando…" : copy.approveLabel}
                </button>
              ) : (
                <p className="reminder-note">Esta aprobación la decide otra persona.</p>
              )}
              <button type="button" className="reminder-snooze" onClick={() => void snooze()} disabled={Boolean(busy)}>
                {copy.snoozeLabel}
              </button>
            </div>
            {reminders.length > 1 && <p className="reminder-more">y {reminders.length - 1} recordatorio{reminders.length > 2 ? "s" : ""} más</p>}
          </>
        )}
      </section>
    </aside>
  );
}
