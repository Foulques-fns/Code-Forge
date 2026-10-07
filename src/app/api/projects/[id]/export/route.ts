import { getProjectFiles, getProjectWorkspace } from "@/lib/forge/store";
import { VFS } from "@/lib/forge/vfs";
import { buildZip } from "@/lib/forge/packaging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ws = await getProjectWorkspace(id);
  if (!ws) return Response.json({ error: "Projet introuvable." }, { status: 404 });
  const files = await getProjectFiles(id);
  if (!files.length) return Response.json({ error: "Le projet ne contient aucun fichier à exporter." }, { status: 400 });

  const vfs = VFS.from(files.map((f) => ({ path: f.path, content: f.content })));
  const { buffer, bytes } = await buildZip(vfs);
  const slug = ws.project.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "codeforge-project";
  const filename = `${slug}-v${ws.project.version}.zip`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes),
      "X-File-Count": String(files.length),
    },
  });
}
