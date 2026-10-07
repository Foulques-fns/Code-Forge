import { getProjectFiles, getProjectWorkspace } from "@/lib/forge/store";
import { VFS } from "@/lib/forge/vfs";
import { buildGitHubPages, buildZip } from "@/lib/forge/packaging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Export built for GitHub Pages: the real project files, plus .nojekyll,
 * 404.html, a deployment guide, and (when a build step is required) a real
 * GitHub Actions workflow (npm ci → npm run build → deploy-pages).
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ws = await getProjectWorkspace(id);
  if (!ws) return Response.json({ error: "Projet introuvable." }, { status: 404 });
  const files = await getProjectFiles(id);
  if (!files.length) return Response.json({ error: "Le projet ne contient aucun fichier à exporter." }, { status: 400 });

  const vfs = VFS.from(files.map((f) => ({ path: f.path, content: f.content })));
  const pages = buildGitHubPages(vfs, ws.project.name);
  const zipVfs = VFS.from(pages.files);
  const { buffer, bytes } = await buildZip(zipVfs);
  const slug = ws.project.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "codeforge-project";
  const filename = `${slug}-github-pages.zip`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes),
      "X-File-Count": String(pages.files.length),
      "X-Static-Ok": String(pages.staticOk),
      "X-Workflow-Added": String(pages.workflowAdded),
    },
  });
}
