import { deleteProject, getProjectWorkspace, updateProject } from "@/lib/forge/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ws = await getProjectWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Projet introuvable." }, { status: 404 });
  return NextResponse.json(ws);
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: { name?: string; settings?: { fixCycles?: number; maxFiles?: number; runBuild?: boolean; runTests?: boolean } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide." }, { status: 400 });
  }
  const ws = await getProjectWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Projet introuvable." }, { status: 404 });
  if (body.name?.trim()) await updateProject(id, { name: body.name.trim().slice(0, 80) });
  if (body.settings) {
    const prev = (ws.project.settings ?? {}) as { fixCycles?: number; maxFiles?: number; runBuild?: boolean; runTests?: boolean };
    await updateProject(id, {
      settings: {
        fixCycles: Math.min(6, Math.max(0, Number(body.settings.fixCycles ?? prev.fixCycles ?? 3))),
        maxFiles: Math.min(128, Math.max(3, Number(body.settings.maxFiles ?? prev.maxFiles ?? 40))),
        runBuild: body.settings.runBuild ?? prev.runBuild ?? true,
        runTests: body.settings.runTests ?? prev.runTests ?? true,
      },
    });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  await deleteProject(id);
  return NextResponse.json({ ok: true });
}
