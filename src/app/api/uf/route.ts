import { NextRequest, NextResponse } from "next/server";
import { getSiiUfQuote, isIsoDate } from "@/lib/sii-uf";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!isIsoDate(date)) return NextResponse.json({ error: "invalid_uf_date" }, { status: 400 });

  try {
    const quote = await getSiiUfQuote(date);
    return NextResponse.json(quote, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "sii_uf_unavailable";
    return NextResponse.json({ error: code }, { status: code === "sii_uf_date_unavailable" ? 422 : 503 });
  }
}
