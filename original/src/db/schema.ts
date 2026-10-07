import { pgTable, text, integer, boolean, timestamp, jsonb, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";

/** A software project forged by the AI. Files are the single source of truth. */
export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** The very first natural-language request that created this project. */
  seedRequest: text("seed_request").notNull().default(""),
  /** Current status of the project. */
  status: text("status").notNull().default("idle"), // idle | generating | ready | error | cancelled | interrupted
  /** Latest validated plan (stack, features, file list...) */
  plan: jsonb("plan"),
  /** Whether a static in-browser preview could be built from real files. */
  previewable: boolean("previewable").notNull().default(false),
  /** Real assembled preview HTML (from build output or static inlining). */
  previewHtml: text("preview_html"),
  /** Monotonic version, incremented each successful forge run. */
  version: integer("version").notNull().default(0),
  /** Per-project generation settings. */
  settings: jsonb("settings").notNull().default({ fixCycles: 3, maxFiles: 40, runBuild: true, runTests: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Real files of a project. Content is the actual generated source. */
export const projectFiles = pgTable(
  "project_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull().default(""),
    language: text("language").notNull().default("text"),
    bytes: integer("bytes").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_files_project_path").on(t.projectId, t.path), index("project_files_project").on(t.projectId)]
);

/** One autonomous generation / iteration / import run. */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("create"), // create | iterate | import
    request: text("request").notNull().default(""),
    status: text("status").notNull().default("running"), // running | done | error | cancelled
    plan: jsonb("plan"),
    diff: jsonb("diff"), // {added:[], modified:[], deleted:[], stats}
    issues: jsonb("issues").notNull().default([]), // validation issues found & their fate
    stats: jsonb("stats"), // {files, bytes, cyclesUsed, durationMs, engineLabel}
    /** Full snapshot path->content at end of run (used for restore & diffs). */
    snapshot: jsonb("snapshot"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_project").on(t.projectId)]
);

/** Real timeline events emitted during a run (persisted so history is inspectable). */
export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(), // step | file | validate | fix | error | done | info
    label: text("label").notNull(),
    status: text("status").notNull().default("done"), // active | done | error | skipped
    detail: jsonb("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("run_events_run").on(t.runId)]
);

/** Conversation attached to a project: user requests + AI answers (project Q&A). */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull(),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_project").on(t.projectId)]
);
