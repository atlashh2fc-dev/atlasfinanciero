// Recordatorios por persona (public.user_reminders). La base decide cuándo
// toca avisar; aquí sólo se arma lo que se muestra en la tarjeta.

export type ReminderStyle = "standard" | "playful";

export type DueReminder = {
  id: string;
  organization_id: string;
  organization_name: string;
  title: string;
  message: string | null;
  style: ReminderStyle;
  interval_minutes: number;
  next_remind_at: string;
  snooze_count: number;
  payable_number: string | null;
  beneficiary_name: string | null;
  amount: number | string | null;
  currency_code: string | null;
  scheduled_for: string | null;
  batch_status: string | null;
  can_approve: boolean;
  approve_only: boolean;
};

export type ReminderCopy = {
  eyebrow: string;
  headline: string;
  body: string;
  approveLabel: string;
  snoozeLabel: string;
  celebration: string;
};

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

/** "3 h", "45 min", "1 h 30 min": el intervalo tal como lo dice la gente. */
export function reminderIntervalLabel(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "un rato";
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "viernes 16-10" a partir de una fecha ISO (YYYY-MM-DD) sin zona horaria. */
export function reminderDayLabel(isoDate: string | null) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [year, month, day] = isoDate.split("-").map(Number);
  const weekday = new Intl.DateTimeFormat("es-CL", {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
  return `${weekday} ${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}`;
}

export function reminderAmountLabel(amount: DueReminder["amount"]) {
  const value = Number(amount);
  return amount === null || !Number.isFinite(value) ? null : money.format(value);
}

// Cada "más tarde" sube un peldaño: el tono se pone más insistente, nunca
// culpabilizador. A partir del último se repite con el número de aviso.
const playfulHeadlines = [
  "Hay un anticipo esperando tu visto bueno",
  "Segundo aviso: el anticipo sigue en la fila",
  "Tercer aviso: el anticipo ya se aprendió tu nombre",
  "Cuarto aviso: este recordatorio es más puntual que el café",
  "Quinto aviso: el botón verde te está mirando",
];

const playfulBodies = [
  "{who} pidió un anticipo de {amount}{when}. Solo falta tu aprobación.",
  "{who} sigue esperando con cara de viernes. Un clic y queda tranquilo.",
  "Dicen que aprobar anticipos a tiempo trae buena suerte toda la semana.",
  "Este aviso vuelve cada {interval}. Aprobar es la única forma de que se jubile.",
  "Prometemos no volver a molestar… apenas apruebes.",
];

const playfulCelebrations = [
  "¡Aprobado! {who} te debe un café.",
  "¡Listo! Este recordatorio se jubila feliz.",
  "¡Aprobado! El viernes se ve mucho mejor.",
];

function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

export function reminderCopy(reminder: DueReminder): ReminderCopy {
  const who = reminder.beneficiary_name?.trim() || "Alguien";
  const amount = reminderAmountLabel(reminder.amount) ?? "un monto";
  const day = reminderDayLabel(reminder.scheduled_for);
  const interval = reminderIntervalLabel(reminder.interval_minutes);
  const values = {
    who,
    amount,
    when: day ? ` para el ${day}` : "",
    interval,
  };
  const attempt = Math.max(0, Math.trunc(reminder.snooze_count));
  const eyebrow = `Recordatorio · ${reminder.organization_name}`;
  const snoozeLabel = `Recuérdamelo en ${interval}`;

  if (reminder.style !== "playful")
    return {
      eyebrow,
      headline: reminder.title,
      body: reminder.message ?? "",
      approveLabel: "Aprobar",
      snoozeLabel,
      celebration: "Aprobado.",
    };

  const last = playfulHeadlines.length - 1;
  return {
    eyebrow,
    headline:
      attempt <= last
        ? playfulHeadlines[attempt]
        : `Aviso n.º ${attempt + 1}: la perseverancia es una virtud`,
    body: fill(playfulBodies[Math.min(attempt, playfulBodies.length - 1)], values),
    approveLabel: "Aprobar anticipo",
    snoozeLabel,
    celebration: fill(playfulCelebrations[attempt % playfulCelebrations.length], values),
  };
}
