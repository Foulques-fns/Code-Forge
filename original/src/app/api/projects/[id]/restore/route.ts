import { restoreRunSnapshot } from "@/lib/forge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Restore a project to the real snapshot captured at the end of a run. */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: { runId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON invalide." }, { status: 400 });
  }
  if (!body.runId) return Response.json({ error: "runId manquant." }, { status: 400 });
  const ok = await restoreRunSnapshot(id, body.runId);
  if (!ok) return Response.json({ error: "Instantané indisponible pour cette version (trop volumineux ou import)." }, { status: 400 });
  return Response.json({ ok: true });
}
