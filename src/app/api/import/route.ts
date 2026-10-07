import { parseZipImport, buildPreview } from "@/lib/forge/packaging";
import { createProject, createRun, finishRun, replaceProjectFiles, updateProject } from "@/lib/forge/store";
import { VFS } from "@/lib/forge/vfs";
import { analyzeArchitecture, describeArchitecture } from "@/lib/forge/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Import an existing ZIP project so the AI can modify it later. */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Envoyez un fichier .zip (champ « file »)." }, { status: 400 });
  }
  if (file.size > 12_000_000) {
    return Response.json({ error: "ZIP trop volumineux (12 Mo max en texte)." }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  let parsed;
  try {
    parsed = await parseZipImport(buffer);
  } catch {
    return Response.json({ error: "Ce fichier n'est pas un ZIP lisible." }, { status: 400 });
  }
  if (!parsed.files.length) {
    return Response.json({ error: "Aucun fichier texte exploitable trouvé dans ce ZIP.", skipped: parsed.skipped.slice(0, 40) }, { status: 400 });
  }

  const base = file.name.replace(/\.zip$/i, "").slice(0, 60) || "projet-importé";
  const project = await createProject({
    name: base,
    request: `Projet importé depuis ${file.name} (${parsed.files.length} fichiers)`,
  });
  await replaceProjectFiles(project.id, parsed.files);
  const vfs = VFS.from(parsed.files);
  const preview = buildPreview(vfs);
  // Real stack detection so later iterations respect the existing project
  const arch = analyzeArchitecture(vfs);
  const detectedPlan = {
    name: base,
    description: `Importé depuis « ${file.name} »`,
    summary: `Projet ${arch.stack.language}${arch.stack.framework ? " " + arch.stack.framework : ""} importé`,
    stack: { ...arch.stack, styling: "" },
    features: [],
    architecture: describeArchitecture(arch, 1200),
    phases: [],
    decisions: [],
    env: arch.envVars.map((n) => ({ name: n, purpose: "", required: false })),
    verify: { install: arch.stack.packageManager === "npm", devCmd: "", buildCmd: "", testCmd: "" },
    files: [],
    dependencies: {},
    devDependencies: {},
    scripts: {},
    previewable: preview.ok,
    imported: true,
  };
  await updateProject(project.id, {
    status: "ready",
    description: `Importé depuis « ${file.name} » — ${parsed.files.length} fichiers conservés, ${parsed.skipped.length} ignorés. Stack détectée : ${arch.stack.language || "?"}${arch.stack.framework ? " + " + arch.stack.framework : ""}.`,
    plan: detectedPlan as object,
    previewable: preview.ok,
    version: 1,
  });
  const run = await createRun(project.id, "import", `Import de ${file.name}`);
  await finishRun(run.id, {
    status: "done",
    plan: detectedPlan as object,
    diff: { added: parsed.files.map((f) => f.path), modified: [], deleted: [], stats: { files: parsed.files.length, bytes: vfs.totalBytes(), linesAdded: 0, linesRemoved: 0 } } as object,
    stats: {
      files: parsed.files.length, bytes: vfs.totalBytes(), durationMs: 0, engine: "import (analyse déterministe, sans moteur)",
      archContext: { routes: arch.routes, models: arch.models, envVars: arch.envVars, entryPoints: arch.entryPoints, stack: arch.stack },
    } as object,
    snapshot: vfs.totalBytes() < 3_500_000 ? (vfs.snapshot() as object) : null,
  });
  return Response.json({ id: project.id, files: parsed.files.length, skipped: parsed.skipped.slice(0, 40) });
}
