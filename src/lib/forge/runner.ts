import { runForge, type ForgeEvent, type ForgeInput } from "./orchestrator";

/* ------------------------------------------------------------------ */
/*  Background run manager. Generations run DETACHED from any HTTP     */
/*  request (immune to the ~300s request timeout, survivable across    */
/*  page refreshes). SSE streams attach/detach/replay at will.         */
/* ------------------------------------------------------------------ */

interface ActiveRun {
  projectId: string;
  controller: AbortController;
  buffer: ForgeEvent[];
  seq: number;
  done: boolean;
  terminal?: "done" | "error" | "cancelled";
  startedAt: number;
  label: string;
  listeners: Set<(e: ForgeEvent) => void>;
}

const g = globalThis as typeof globalThis & { __codeforgeRuns?: Map<string, ActiveRun> };
const RUNS = (g.__codeforgeRuns ??= new Map<string, ActiveRun>());

// Runs older than 6h are purged defensively.
function sweep() {
  const now = Date.now();
  for (const [k, r] of RUNS) {
    if (now - r.startedAt > 6 * 3600_000) RUNS.delete(k);
  }
}

export function getActiveRun(projectId: string): ActiveRun | null {
  sweep();
  return RUNS.get(projectId) ?? null;
}

export function isRunning(projectId: string): boolean {
  const r = getActiveRun(projectId);
  return !!r && !r.done;
}

export function startForgeRun(input: Omit<ForgeInput, "emit" | "signal">): { ok: boolean; reason?: string } {
  sweep();
  const existing = RUNS.get(input.projectId);
  if (existing && !existing.done) return { ok: false, reason: "Une génération est déjà en cours sur ce projet." };
  const controller = new AbortController();
  const run: ActiveRun = {
    projectId: input.projectId,
    controller,
    buffer: [],
    seq: 0,
    done: false,
    startedAt: Date.now(),
    label: input.request.slice(0, 80),
    listeners: new Set(),
  };
  RUNS.set(input.projectId, run);

  const emit = (e: ForgeEvent) => {
    run.seq = e.seq ?? run.seq + 1;
    const stamped = { ...e, seq: run.seq };
    run.buffer.push(stamped);
    if (run.buffer.length > 5000) run.buffer.splice(0, run.buffer.length - 5000);
    for (const l of run.listeners) {
      try {
        l(stamped);
      } catch {
        /* listener gone */
      }
    }
    if (e.kind === "done") { run.done = true; run.terminal = "done"; }
    if (e.kind === "error") { run.done = true; run.terminal = "error"; }
    if (e.kind === "cancelled") { run.done = true; run.terminal = "cancelled"; }
  };

  // Fire and forget — orchestrates fully in background, persists itself.
  void runForge({ ...input, emit, signal: controller.signal })
    .catch(() => {
      if (!run.done) {
        run.done = true;
        run.terminal = "error";
        emit({ kind: "error", message: "Interruption inattendue du moteur de génération." });
      }
    })
    .finally(() => {
      run.done = true;
      run.terminal ??= "done";
    });

  return { ok: true };
}

export function stopForgeRun(projectId: string): boolean {
  const run = getActiveRun(projectId);
  if (!run || run.done) return false;
  run.controller.abort();
  return true;
}

/**
 * Subscribe to a run's event stream. Replays buffered events with seq > after,
 * then streams live. Returns an unsubscribe function.
 */
export function attachRun(projectId: string, after: number, listener: (e: ForgeEvent) => void): (() => void) | null {
  const run = getActiveRun(projectId);
  if (!run) return null;
  for (const e of run.buffer) {
    if ((e.seq ?? 0) > after) {
      try {
        listener(e);
      } catch {
        /* ignore */
      }
    }
  }
  if (run.done) return () => {};
  run.listeners.add(listener);
  return () => {
    run.listeners.delete(listener);
  };
}
