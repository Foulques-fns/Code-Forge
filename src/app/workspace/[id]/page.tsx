import { notFound } from "next/navigation";
import { getProjectWorkspace } from "@/lib/forge/store";
import { checkEngineStatus } from "@/lib/ai/providers";
import { WorkspaceClient, type WorkspaceData } from "@/components/workspace/workspace-client";
import type { DiffData, PlanData } from "@/components/workspace/side-panel";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autostart?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const ws = await getProjectWorkspace(id);
  if (!ws) notFound();
  const engine = await checkEngineStatus().catch(() => null);

  const lastDoneRun = ws.runs.find((r) => r.status === "done") ?? null;
  const data: WorkspaceData = {
    project: {
      id: ws.project.id,
      name: ws.project.name,
      description: ws.project.description,
      status: ws.project.status,
      previewable: ws.project.previewable,
      version: ws.project.version,
      seedRequest: ws.project.seedRequest,
      settings: {
        fixCycles: Number((ws.project.settings as { fixCycles?: number } | null)?.fixCycles ?? 3),
        maxFiles: Number((ws.project.settings as { maxFiles?: number } | null)?.maxFiles ?? 40),
        runBuild: (ws.project.settings as { runBuild?: boolean } | null)?.runBuild !== false,
        runTests: (ws.project.settings as { runTests?: boolean } | null)?.runTests !== false,
      },
    },
    files: ws.files.map((f) => ({ path: f.path, content: f.content, language: f.language, bytes: f.bytes })),
    plan: (lastDoneRun?.plan ?? ws.project.plan ?? null) as PlanData | null,
    diff: (lastDoneRun?.diff ?? null) as DiffData | null,
    runs: ws.runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      stats: r.stats as { files?: number; durationMs?: number; engine?: string } | null,
    })),
    events: ws.events.map((e) => ({ kind: e.kind, label: e.label, status: e.status, detail: e.detail })),
    messages: ws.messages.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      meta: m.meta as WorkspaceData["messages"][number]["meta"],
      createdAt: m.createdAt.toISOString(),
    })),
    engine: engine ? { ok: engine.ok, active: engine.active ? { label: engine.active.label, model: engine.active.model, kind: engine.active.kind, detail: engine.active.detail } : null } : null,
  };

  return <WorkspaceClient initial={data} autostart={sp.autostart === "1"} />;
}
