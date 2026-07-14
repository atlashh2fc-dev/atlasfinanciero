import { NextResponse } from "next/server";
import { getPeopleWorkConfig } from "@/lib/peoplework/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getPeopleWorkConfig();

  return NextResponse.json({
    provider: "peoplework",
    state: config.state,
    configured: config.state === "ready_for_mapping",
  });
}
