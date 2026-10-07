import type { ForgeEvent, ForgeInput } from "@/lib/forge/orchestrator";
import { attachRun, getActiveRun, startForgeRun, stopForgeRun } from "@/lib/forge/runner";
import { db } from "@/db";
import { projects, projectFiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { addMessage } from "@/lib/forge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  } as const;
}

/** Open an SSE stream attached to the project's (possibly detached) run. */
function streamRun(projectId: string, after: number): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (obj: ForgeEvent | { kind: string; message?: string }) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const run = getActiveRun(projectId);
      if (!run) {
        push({ kind: "error", message: "Aucune génération en cours sur ce projet (elle a peut-être été interrompue — relancez)." });
        closed = true;
        controller.close();
        return;
      }
      const detach = attachRun(projectId, after, (e) => {
        push(e);
        if (e.kind === "done" || e.kind === "error" || e.kind === "cancelled") {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          cleanup();
        }
      });
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 10_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        detach?.();
      };
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

/** POST { request, mode?, after? } — start a detached generation, then stream it. */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: { request?: string; mode?: "create" | "iterate"; after?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON invalide." }, { status: 400 });
  }
  const request = (body.request ?? "").trim();
  if (request.length < 2 || request.length > 8000) {
    return Response.json({ error: "Demande vide ou trop longue." }, { status: 400 });
  }
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) return Response.json({ error: "Projet introuvable." }, { status: 404 });

  const fileCount = await db.select({ path: projectFiles.path }).from(projectFiles).where(eq(projectFiles.projectId, id)).limit(1);
  const mode: "create" | "iterate" = body.mode ?? (fileCount.length === 0 ? "create" : "iterate");
  const settings = (project.settings ?? {}) as { fixCycles?: number; maxFiles?: number; runBuild?: boolean; runTests?: boolean };

  const input: Omit<ForgeInput, "emit" | "signal"> = {
    projectId: id,
    projectName: project.name,
    seedRequest: project.seedRequest,
    mode,
    request,
    settings: {
      fixCycles: settings.fixCycles ?? 3,
      maxFiles: settings.maxFiles ?? 40,
      runBuild: settings.runBuild !== false,
      runTests: settings.runTests !== false,
    },
  };

  const started = startForgeRun(input);
  if (!started.ok) {
    // A run is already active — attach to it instead of erroring out.
    return streamRun(id, body.after ?? 0);
  }
  await db.update(projects).set({ status: "generating", updatedAt: new Date() }).where(eq(projects.id, id));
  await addMessage(id, "user", request, { mode });
  return streamRun(id, body.after ?? 0);
}

/** GET ?after=N — re-attach/replay (reconnection), ?status=1 — JSON liveness. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  if (url.searchParams.get("status") === "1") {
    const run = getActiveRun(id);
    return Response.json({
      active: !!run && !run.done,
      terminal: run?.terminal ?? null,
      lastSeq: run?.seq ?? 0,
      label: run?.label ?? null,
    });
  }
  const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
  const run = getActiveRun(id);
  if (!run) return Response.json({ active: false }, { status: 404 });
  return streamRun(id, after);
}

/** DELETE — stop the running generation, cleanly. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const stopped = stopForgeRun(id);
  return Response.json({ stopped });
}
