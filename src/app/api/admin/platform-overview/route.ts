import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdministrator } from "@/lib/admin-access";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await requirePlatformAdministrator();
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const yearParam = Number(request.nextUrl.searchParams.get("year"));
  const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= new Date().getFullYear() ? yearParam : new Date().getFullYear();
  const { data, error } = await context.supabase.rpc("platform_super_admin_overview", { p_year: year });
  if (error) return NextResponse.json({ error: "unable_to_read_platform_overview" }, { status: 500 });

  return NextResponse.json({ year, organizations: data ?? [] }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
