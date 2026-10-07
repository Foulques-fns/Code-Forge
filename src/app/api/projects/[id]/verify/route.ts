import { verifyWithTooling } from "@/lib/forge/verify";
import { buildDistPreview, buildPreview } from "@/lib/forge/packaging";
import { getProjectFiles, updateProject } from "@/lib/forge/store";
import { VFS } from "@/lib/forge/vfs";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Re-run the REAL toolchain on the current files — no AI involved.
 * install (if needed) → typecheck → build → test, in a throwaway
 * workspace. On success, captures the real build output and (re)builds
 * the preview from the compiled application. Honest about every outcome.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) return Response.json({ error: "Projet introuvable." }, { status: 404 });
  const files = await getProjectFiles(id);
  if (!files.length) return Response.json({ error: "Le projet ne contient aucun fichier." }, { status: 400 });

  let settings = (project.settings ?? {}) as { runBuild?: boolean; runTests?: boolean };
  try {
    const body = (await req.json()) as { runBuild?: boolean; runTests?: boolean };
    settings = { ...settings, ...body };
  } catch {
    /* empty body is fine */
  }

  const vfs = VFS.from(files.map((f) => ({ path: f.path, content: f.content })));
  const result = await verifyWithTooling(vfs, {
    install: true,
    runTypecheck: true,
    runBuild: settings.runBuild !== false,
    runTests: settings.runTests !== false,
  });

  let previewable = project.previewable;
  let previewFrom: string | null = null;
  if (result.dist) {
    const html = buildDistPreview(result.dist.files, result.dist.entry);
    if (html) {
      await updateProject(id, { previewable: true, previewHtml: html, status: project.status === "generating" ? "generating" : "ready" });
      previewable = true;
      previewFrom = `build réel (${result.dist.entry})`;
    }
  } else if (!project.previewHtml) {
    const staticPrev = buildPreview(vfs);
    if (staticPrev.ok !== project.previewable) {
      await updateProject(id, { previewable: staticPrev.ok });
      previewable = staticPrev.ok;
    }
  }

  return Response.json({
    ran: result.ran,
    ok: result.ok,
    skippedReason: result.skippedReason ?? null,
    commands: result.commands.map((c) => ({ label: c.label, code: c.code, ms: c.ms, tail: c.tail.slice(-600) })),
    issues: result.issues,
    previewable,
    previewFrom,
  });
}
