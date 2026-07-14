// Agregado literal de las líneas del libro `Facturas Emitidas.xlsx`.
// Cada línea normalizada conserva hoja, fila y columna de origen en Supabase.
export const forecastMonthly2026 = [
  { period: "2026-01-01", projectedRevenue: 10440052, actualRevenue: 11154807, projectedExpense: 5146000 },
  { period: "2026-02-01", projectedRevenue: 8996968, actualRevenue: 6845856, projectedExpense: 5146000 },
  { period: "2026-03-01", projectedRevenue: 19511168, actualRevenue: 12457129, projectedExpense: 5146000 },
  { period: "2026-04-01", projectedRevenue: 23264385, actualRevenue: 23918768, projectedExpense: 5146000 },
  { period: "2026-05-01", projectedRevenue: 23764385, actualRevenue: 31889967, projectedExpense: 30667831 },
  { period: "2026-06-01", projectedRevenue: 23964385, actualRevenue: 48271886, projectedExpense: 6656000 },
  { period: "2026-07-01", projectedRevenue: 23764385, actualRevenue: 5915566, projectedExpense: 6656000 },
  { period: "2026-08-01", projectedRevenue: 27423585, actualRevenue: 5807100, projectedExpense: 6656000 },
  { period: "2026-09-01", projectedRevenue: 27623585, actualRevenue: 5807100, projectedExpense: 6656000 },
  { period: "2026-10-01", projectedRevenue: 27423585, actualRevenue: 5807100, projectedExpense: 6656000 },
  { period: "2026-11-01", projectedRevenue: 27423585, actualRevenue: 5807100, projectedExpense: 6656000 },
  { period: "2026-12-01", projectedRevenue: 27623585, actualRevenue: 5807100, projectedExpense: 6656000 },
] as const;

export type ForecastMonthlyRecord = (typeof forecastMonthly2026)[number];
