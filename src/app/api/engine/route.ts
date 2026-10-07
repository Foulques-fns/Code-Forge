import { checkEngineStatus } from "@/lib/ai/providers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const status = await checkEngineStatus(force);
  return NextResponse.json(status);
}
