import { getProjectFiles } from "@/lib/forge/store";
import { VFS } from "@/lib/forge/vfs";
import { buildPreview } from "@/lib/forge/packaging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Serves the REAL generated entry page with local assets inlined.
 * Only ever exists if buildPreview could honestly assemble one.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const { db } = await import("@/db");
  const { projects } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) return Response.json({ error: "Projet introuvable." }, { status: 404 });

  // Priority 1: the persisted REAL preview (compiled dist bundle or inlined statics)
  if (project.previewHtml) {
    return new Response(project.previewHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Preview-Source": "built" },
    });
  }

  // Priority 2: assemble statically right now from the real files
  const files = await getProjectFiles(id);
  const vfs = VFS.from(files.map((f) => ({ path: f.path, content: f.content })));
  const preview = buildPreview(vfs);

  if (!preview.ok || !preview.html) {
    return new Response(`<!doctype html><html><body style="background:#0b0b10;color:#888;font:14px system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><p style="max-width:420px;text-align:center;line-height:1.6">${preview.reason ?? "Prévisualisation indisponible pour ce projet."}</p></body></html>`, {
      status: 422,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response(preview.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Preview-Entry": preview.entry ?? "",
    },
  });
}
