import { db } from "@/db";
import { messages, projectFiles, projects, runEvents, runs } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { languageOf } from "./vfs";

/* ------------------------------------------------------------------ */
/*  Persistence helpers — every byte the AI produces ends up here.     */
/* ------------------------------------------------------------------ */

export type ProjectRow = typeof projects.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;

export async function createProject(input: { name: string; request: string; settings?: unknown }) {
  const [p] = await db
    .insert(projects)
    .values({
      name: input.name,
      seedRequest: input.request,
      status: "idle",
      settings: (input.settings as object) ?? { fixCycles: 2, maxFiles: 32 },
    })
    .returning();
  return p;
}

export async function listProjects() {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      previewable: projects.previewable,
      version: projects.version,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      plan: projects.plan,
      fileCount: sql<number>`(select count(*)::int from ${projectFiles} f where f.project_id = ${projects.id})`,
      totalBytes: sql<number>`coalesce((select sum(f.bytes)::int from ${projectFiles} f where f.project_id = ${projects.id}), 0)`,
    })
    .from(projects)
    .orderBy(desc(projects.updatedAt));
  return rows;
}

/** Loads a project workspace; any run left "running" is an interrupted
 *  generation (server restarted / connection lost) — we say so honestly. */
export async function getProjectWorkspace(id: string) {
  try {
    await db.update(runs).set({ status: "interrupted", finishedAt: new Date() }).where(eq(runs.status, "running"));
  } catch {
    /* best effort sweep */
  }
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) return null;
  if (project.status === "generating") {
    await db.update(projects).set({ status: "interrupted" }).where(eq(projects.id, id));
    project.status = "interrupted";
  }
  const files = await db.select().from(projectFiles).where(eq(projectFiles.projectId, id)).orderBy(projectFiles.path);
  const runRows = await db.select().from(runs).where(eq(runs.projectId, id)).orderBy(desc(runs.startedAt)).limit(12);
  const msgs = await db.select().from(messages).where(eq(messages.projectId, id)).orderBy(messages.createdAt).limit(60);
  const lastRun = runRows[0] ?? null;
  const events = lastRun
    ? await db.select().from(runEvents).where(eq(runEvents.runId, lastRun.id)).orderBy(runEvents.seq).limit(600)
    : [];
  return { project, files, runs: runRows, lastRun, events, messages: msgs };
}

export async function createRun(projectId: string, kind: string, request: string) {
  const [r] = await db.insert(runs).values({ projectId, kind, request, status: "running" }).returning();
  return r;
}

export async function finishRun(id: string, patch: Partial<typeof runs.$inferInsert>) {
  await db.update(runs).set({ ...patch, finishedAt: new Date() }).where(eq(runs.id, id));
}

export async function insertRunEvents(runId: string, evts: { seq: number; kind: string; label: string; status: string; detail?: unknown }[]) {
  if (!evts.length) return;
  for (let i = 0; i < evts.length; i += 100) {
    await db.insert(runEvents).values(
      evts.slice(i, i + 100).map((e) => ({ runId, seq: e.seq, kind: e.kind, label: e.label, status: e.status, detail: e.detail as object }))
    );
  }
}

/** Atomic replacement of the whole file set after a successful run. */
export async function replaceProjectFiles(projectId: string, entries: { path: string; content: string }[]) {
  await db.transaction(async (tx) => {
    await tx.delete(projectFiles).where(eq(projectFiles.projectId, projectId));
    for (let i = 0; i < entries.length; i += 50) {
      await tx.insert(projectFiles).values(
        entries.slice(i, i + 50).map((e) => ({
          projectId,
          path: e.path,
          content: e.content,
          language: languageOf(e.path),
          bytes: e.content.length,
        }))
      );
    }
  });
}

export async function updateProject(id: string, patch: Partial<typeof projects.$inferInsert>) {
  await db.update(projects).set({ ...patch, updatedAt: new Date() }).where(eq(projects.id, id));
}

export async function addMessage(projectId: string, role: "user" | "assistant", content: string, meta?: unknown) {
  const [m] = await db.insert(messages).values({ projectId, role, content, meta: meta as object }).returning();
  return m;
}

export async function deleteProject(id: string) {
  await db.delete(projects).where(eq(projects.id, id));
}

export async function getProjectFiles(id: string) {
  return db.select().from(projectFiles).where(eq(projectFiles.projectId, id)).orderBy(projectFiles.path);
}

export async function getRun(id: string) {
  const [r] = await db.select().from(runs).where(eq(runs.id, id));
  return r ?? null;
}

export async function restoreRunSnapshot(projectId: string, runId: string): Promise<boolean> {
  const run = await getRun(runId);
  const snapshot = run?.snapshot as Record<string, string> | null;
  if (!snapshot || typeof snapshot !== "object") return false;
  const entries = Object.entries(snapshot).map(([path, content]) => ({ path, content: String(content) }));
  await replaceProjectFiles(projectId, entries);
  await updateProject(projectId, { status: "ready" });
  return true;
}
