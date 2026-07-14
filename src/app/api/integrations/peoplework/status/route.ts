import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";
import { getPeopleWorkConfig } from "@/lib/peoplework/config";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error) return NextResponse.json({ error: context.error }, { status: context.status });
  const config = getPeopleWorkConfig();

  return NextResponse.json({
    provider: "peoplework",
    state: config.state,
    configured: config.state === "ready",
  });
}
