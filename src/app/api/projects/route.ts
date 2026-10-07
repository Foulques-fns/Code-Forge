import { createProject, listProjects } from "@/lib/forge/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await listProjects();
  return NextResponse.json({ projects: rows });
}

export async function POST(req: Request) {
  let body: { request?: string; settings?: { fixCycles?: number; maxFiles?: number; runBuild?: boolean; runTests?: boolean } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }
  const request = (body.request ?? "").trim();
  if (request.length < 4) {
    return NextResponse.json({ error: "Décrivez le projet à construire (au moins quelques mots)." }, { status: 400 });
  }
  if (request.length > 8000) {
    return NextResponse.json({ error: "Demande trop longue (8000 caractères max)." }, { status: 400 });
  }
  const fixCycles = Math.min(6, Math.max(0, Number(body.settings?.fixCycles ?? 3)));
  const maxFiles = Math.min(128, Math.max(3, Number(body.settings?.maxFiles ?? 40)));
  const provisional = request.replace(/\s+/g, " ").slice(0, 42);
  const project = await createProject({ name: provisional, request, settings: { fixCycles, maxFiles, runBuild: true, runTests: true } });
  return NextResponse.json({ id: project.id });
}
