import { NextResponse } from "next/server";

export const revalidate = 3600;

type PublicIndicator = {
  codigo: string;
  nombre: string;
  unidad_medida: string;
  fecha: string;
  valor: number;
};

const indicatorCodes = ["uf", "utm", "dolar", "euro", "ipc", "tpm"] as const;

export async function GET() {
  try {
    const response = await fetch("https://mindicador.cl/api", {
      next: { revalidate },
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Public indicator service returned ${response.status}`);

    const payload = await response.json() as Record<string, PublicIndicator | string>;
    const indicators = indicatorCodes.flatMap((code) => {
      const value = payload[code];
      return value && typeof value !== "string" ? [{
        code: value.codigo,
        name: value.nombre,
        unit: value.unidad_medida,
        date: value.fecha,
        value: value.valor,
      }] : [];
    });

    return NextResponse.json({
      updatedAt: typeof payload.fecha === "string" ? payload.fecha : null,
      indicators,
      source: { name: "Indicadores públicos de Chile", url: "https://mindicador.cl/api" },
      references: [
        { name: "SII · Valores y fechas", url: "https://www.sii.cl/valores_y_fechas/" },
        { name: "Banco Central · Indicadores diarios", url: "https://si3.bcentral.cl/Bdemovil/BDE/IndicadoresDiarios" },
      ],
    }, { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } });
  } catch {
    return NextResponse.json({ error: "No fue posible actualizar los indicadores públicos." }, { status: 503 });
  }
}
