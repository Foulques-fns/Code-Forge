import { fixFile, generateFile, planModification, planProject, setEngineListener, writeReadme } from "@/lib/ai/engine";
import { enginesUsed, getActiveProvider } from "@/lib/ai/providers";
import type { BuildRunReport, DiffInfo, Issue, ModificationPlan, ProjectPlan } from "@/lib/ai/types";
import { db } from "@/db";
import { projects, runs } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { VFS, buildIndex, diffSnapshots, extractSymbols, languageOf } from "./vfs";
import { harmonizeHtmlRefs, patchPackageDeps, pruneInvalidDeps, validateProject } from "./validate";
import { buildDistPreview, buildPreview, buildZip } from "./packaging";
import { analyzeArchitecture, appendDecisions, buildEnvExample, describeArchitecture, excerptMemory, renderArchitectureDoc } from "./context";
import { ProjectWorkspace, runToolchain } from "./verify";
import {
  createRun, finishRun, getProjectFiles, insertRunEvents, replaceProjectFiles, updateProject, addMessage,
} from "./store";

/* ------------------------------------------------------------------ */
/*  The autonomous development loop. Multi-stage, tool-verified,       */
/*  honest. Every event corresponds to real work being done.           */
/* ------------------------------------------------------------------ */

export type ForgeEvent = {
  seq?: number;
  kind: "step" | "phase" | "file" | "plan" | "issues" | "fix" | "diff" | "done" | "error" | "cancelled" | "log" | "verify";
  step?: string;
  status?: "active" | "done" | "error" | "skipped";
  label?: string;
  path?: string;
  bytes?: number;
  content?: string;
  ms?: number;
  plan?: ProjectPlan;
  issues?: Issue[];
  cycle?: number;
  diff?: DiffInfo;
  stats?: Record<string, unknown>;
  message?: string;
  at?: string;
};

export interface ForgeInput {
  projectId: string;
  projectName: string;
  seedRequest: string;
  mode: "create" | "iterate";
  request: string;
  settings: { fixCycles: number; maxFiles: number; runBuild?: boolean; runTests?: boolean };
  emit: (e: ForgeEvent) => void;
  signal?: AbortSignal;
}

class Cancelled extends Error {
  constructor() {
    super("Annulé par l'utilisateur");
    this.name = "Cancelled";
  }
}

const MAX_FILE_CHARS = 300_000;
const MAX_TOTAL_CHARS = 4_000_000;
const MAX_FIX_PER_FILE = 3;

function guard(signal?: AbortSignal) {
  if (signal?.aborted) throw new Cancelled();
}

/**
 * Bounded parallel worker pool. Files within one build phase are generated
 * CONCURRENTLY (their coherence is enforced afterwards by the validator/fix
 * loop, which is exactly what it exists for). Sequential only at meaningful
 * boundaries: phase → phase, generation → validation.
 */
async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let idx = 0;
  let cancelled: unknown = null;
  const running = new Set<Promise<void>>();
  const spawn = () => {
    while (idx < items.length && running.size < limit && !cancelled) {
      if (signal?.aborted) return;
      const item = items[idx++];
      const p = worker(item)
        .catch((e) => {
          if (e instanceof Cancelled || (e instanceof Error && /aborted|Annulé/i.test(e.message))) cancelled = e;
        })
        .finally(() => running.delete(p));
      running.add(p);
    }
  };
  // Critical: the FIRST spawn must happen before waiting on an empty pool —
  // otherwise the loop never starts and work is silently skipped.
  spawn();
  while (running.size) {
    await Promise.race(running).catch(() => {});
    spawn();
  }
  if (cancelled) throw cancelled;
}

/** Deterministic package.json — guaranteed valid, coherent with the plan. */
function synthesizePackageJson(plan: ProjectPlan): string {
  const pkg = {
    name: plan.name,
    version: "0.1.0",
    private: true,
    description: plan.summary || plan.description,
    type: "module" as const,
    scripts: plan.scripts && Object.keys(plan.scripts).length ? plan.scripts : { start: "node index.js" },
    ...(Object.keys(plan.dependencies).length ? { dependencies: plan.dependencies } : {}),
    ...(Object.keys(plan.devDependencies).length ? { devDependencies: plan.devDependencies } : {}),
    engines: { node: ">=18" },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function synthesizeRequirements(plan: ProjectPlan): string {
  return Object.entries(plan.dependencies).map(([k, v]) => (v && v !== "*" ? `${k}${/^[<>=!~]/.test(v) ? "" : "=="}${v.replace(/^[\^~]/, "")}` : k)).join("\n") + "\n";
}

function pickSamples(vfs: VFS, request: string, limit = 6): { path: string; content: string }[] {
  const words = new Set(request.toLowerCase().split(/[^a-zà-öø-ÿ0-9_]+/i).filter((w) => w.length > 3));
  const scored = vfs.paths().map((p) => {
    const c = vfs.read(p)!;
    const hay = (p + "\n" + c.slice(0, 4000)).toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s += 1;
    if (["typescript", "javascript", "tsx", "jsx", "python"].includes(p.split(".").pop() ?? "")) s += 0.5;
    return { p, c, s };
  });
  return scored
    .filter((x) => x.s >= (words.size ? 0.5 : 0))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => ({ path: x.p, content: x.c.slice(0, 9000) }));
}

/** Counts of syntax-checked code files, for the honest final report. */
function validationCoverage(vfs: VFS): { parsedFiles: number } {
  let parsedFiles = 0;
  for (const p of vfs.paths()) {
    if (["typescript", "tsx", "javascript", "jsx", "json"].includes(languageOf(p))) parsedFiles++;
  }
  return { parsedFiles };
}

export async function runForge(input: ForgeInput): Promise<void> {
  const { emit, signal } = input;
  const started = Date.now();
  let seq = 0;
  const log: { seq: number; kind: string; label: string; status: string; detail?: unknown }[] = [];
  const say = (e: ForgeEvent, persistLabel: string | null, persistStatus = "done", persistDetail?: unknown) => {
    guard(signal);
    emit({ ...e, seq: ++seq, at: new Date().toISOString() });
    if (persistLabel != null) log.push({ seq, kind: e.kind, label: persistLabel, status: persistStatus, detail: persistDetail });
  };

  // Memory of previous unresolved problems — the fixer must not re-trip on them.
  const [prevRun] = await db
    .select({ issues: runs.issues })
    .from(runs)
    .where(eq(runs.projectId, input.projectId))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  const previousIssues: { file: string | null; message: string }[] = (Array.isArray(prevRun?.issues) ? (prevRun.issues as Issue[]) : [])
    .filter((i) => i.severity === "error")
    .slice(0, 8)
    .map((i) => ({ file: i.file, message: i.message }));

  const run = await createRun(input.projectId, input.mode, input.request);

  // Patient engine resolution: providers have incidents that recover on their
  // own. We wait and re-detect rather than failing the user's run instantly.
  let engine = await getActiveProvider(true);
  for (let i = 0; !engine && i < 6; i++) {
    guard(signal);
    say({ kind: "log", message: `Aucun moteur IA ne répond pour l'instant — nouvelle détection dans 10 s (tentative ${i + 1}/6)…` }, `Attente d'un moteur IA (${i + 1}/6)`, "active");
    await new Promise((r) => setTimeout(r, 10_000));
    engine = await getActiveProvider(true);
  }
  const engineLabel = engine ? `${engine.status.label} · ${engine.status.model ?? ""}` : "aucun moteur";
  if (!engine) {
    say(
      { kind: "error", message: "Aucun moteur IA gratuit n'a répondu après 6 détections espacées (moteur local absent, passerelles injoignables). Ce n'est pas un échec du projet : relancez la génération quand le réseau/fournisseur est rétabli." },
      "Échec : aucun moteur IA disponible après 6 tentatives", "error"
    );
    await finishRun(run.id, { status: "error", issues: [] });
    await insertRunEvents(run.id, log);
    await updateProject(input.projectId, { status: "error" });
    return;
  }
  say({ kind: "log", message: `Moteur actif : ${engineLabel}` }, `Moteur actif : ${engineLabel}`);

  // Surface engine retries / failovers in the timeline — never fail silently.
  setEngineListener((n) => {
    const label = n.switching
      ? `Moteur « ${n.engine} » mis de côté (incident) — bascule automatique vers un autre moteur gratuit. Nouvelle tentative ${n.attempt}/${n.tries}…`
      : `Moteur « ${n.engine} » en échec (${n.error}) — nouvelle tentative ${n.attempt}/${n.tries} dans ${Math.round(n.waitMs / 1000)} s…`;
    try {
      say({ kind: "log", message: label }, label, "active");
    } catch {
      /* run cancelled — nothing to report */
    }
  });

  const settings = input.settings;
  let plan: ProjectPlan | null = null;
  let issues: Issue[] = [];
  let diff: DiffInfo | null = null;
  let cyclesUsed = 0;
  let harmonizedCount = 0;
  let buildReport: BuildRunReport = { ran: false, ok: null, rounds: 0, commands: [], skippedReason: "non exécuté" };
  let generationIssues: Issue[] = [];
  const generatedSoFar: { path: string; exports: string[] }[] = [];
  const fixAttempts = new Map<string, number>();

  const purposeOf = (vfs: VFS) => (path: string) => plan?.files.find((f) => f.path === path)?.purpose ?? "";

  try {
    /* -------------------------------------------------------------- */
    /*  Step 1 — analysis + multi-stage planning (real model call)     */
    /* -------------------------------------------------------------- */
    say({ kind: "step", step: "plan", status: "active", label: input.mode === "create" ? "Analyse profonde de la demande et conception multi-phases" : "Analyse du projet existant (carte d'architecture réelle) et planification chirurgicale" }, "Planification", "active");

    const existingFiles = await getProjectFiles(input.projectId);
    const vfs = VFS.from(existingFiles);
    const beforeSnapshot = vfs.snapshot();
    let modPlan: ModificationPlan | null = null;
    let archText = "";

    if (input.mode === "create") {
      plan = await planProject(input.request, settings.maxFiles, signal);
      const phaseSummary = plan.phases.map((p) => p.title).join(" → ");
      say({ kind: "plan", plan }, `Plan conçu : ${plan.name} — ${plan.files.length} fichier(s), ${plan.phases.length} phase(s), stack ${plan.stack.language}${plan.stack.framework ? " + " + plan.stack.framework : ""}`, "done", { plan });
      say({ kind: "log", message: `Phases : ${phaseSummary}` }, `Phases : ${phaseSummary}`);
      if (plan.decisions.length) {
        say({ kind: "log", message: `Décisions : ${plan.decisions.map((d) => `${d.topic} ⇒ ${d.choice}`).join(" · ")}` }, `Décisions techniques enregistrées (${plan.decisions.length})`, "done", { decisions: plan.decisions });
      }
    } else {
      const arch = analyzeArchitecture(vfs);
      archText = describeArchitecture(arch);
      const memory = excerptMemory(vfs);
      if (memory) archText += `\n\nJournal des décisions antérieures (DECISIONS.md — à respecter sauf demande contraire) :\n${memory}`;
      say({ kind: "log", message: `Architecture réelle détectée : ${arch.stack.language}${arch.stack.framework ? " + " + arch.stack.framework : ""}, ${arch.files} fichiers, ${arch.routes.length} route(s), ${arch.models.length} modèle(s)` }, `Carte d'architecture établie (${arch.files} fichiers, ${arch.edges} liens d'import)`);
      const index = buildIndex(vfs);
      modPlan = await planModification(input.request, index, pickSamples(vfs, `${input.request} ${input.seedRequest}`), archText, previousIssues, signal);
      say({ kind: "plan", plan: undefined, message: modPlan.summary }, `Plan de modification : ${modPlan.operations.length} opération(s) — ${modPlan.summary}`, "done", { modPlan });
    }
    say({ kind: "step", step: "plan", status: "done" }, "Planification terminée");

    /* -------------------------------------------------------------- */
    /*  Step 2 — real file generation, phase by phase                  */
    /* -------------------------------------------------------------- */
    say({ kind: "step", step: "generate", status: "active", label: "Génération des fichiers" }, "Génération des fichiers", "active");

    interface WriteOp { path: string; purpose: string; current?: string | null; phase?: { title: string; goal: string } }
    const writeOps: WriteOp[] = [];

    if (input.mode === "create" && plan) {
      if (["npm", "yarn", "pnpm", "bun"].includes(plan.stack.packageManager)) {
        vfs.write("package.json", synthesizePackageJson(plan));
        say({ kind: "file", path: "package.json", status: "done", bytes: vfs.read("package.json")!.length, content: vfs.read("package.json")! }, "package.json synthétisé (cohérent avec le plan)");
      }
      if (plan.stack.packageManager === "pip" && !plan.files.some((f) => f.path === "requirements.txt")) {
        vfs.write("requirements.txt", synthesizeRequirements(plan));
        say({ kind: "file", path: "requirements.txt", status: "done", bytes: vfs.read("requirements.txt")!.length }, "requirements.txt synthétisé");
      }
      // — dynamic, phase-ordered build —
      const byPath = new Map(plan.files.map((f) => [f.path, f.purpose]));
      for (let pi = 0; pi < plan.phases.length; pi++) {
        const phase = plan.phases[pi];
        const known = phase.files.filter((p) => byPath.has(p));
        if (!known.length) continue;
        say({ kind: "phase", label: `Phase ${pi + 1}/${plan.phases.length} — ${phase.title} (${known.length} fichier(s))`, status: "active" }, `Phase ${pi + 1}/${plan.phases.length} : ${phase.title}`, "active", { goal: phase.goal });
        for (const p of known) writeOps.push({ path: p, purpose: byPath.get(p)!, current: null, phase: { title: phase.title, goal: phase.goal } });
      }
    } else if (modPlan) {
      for (const op of modPlan.operations) {
        guard(signal);
        if (op.op === "delete") {
          if (vfs.delete(op.path)) say({ kind: "file", path: op.path, status: "skipped", label: "supprimé" }, `${op.path} supprimé`);
          continue;
        }
        if (op.op === "move") {
          if (op.newPath && vfs.move(op.path, op.newPath)) {
            say({ kind: "file", path: op.newPath, status: "done", label: `déplacé depuis ${op.path}` }, `${op.path} → ${op.newPath}`);
          }
          continue;
        }
        writeOps.push({ path: op.path, purpose: op.purpose ?? "", current: vfs.read(op.path) });
      }
    }

    let totalChars = vfs.totalBytes();
    const failsafePlan = (): ProjectPlan => ({
      name: input.projectName, description: "", summary: "",
      stack: { language: "", framework: "", runtime: "", packageManager: vfs.has("package.json") ? "npm" : "none", buildTool: "", styling: "" },
      features: [], architecture: "", phases: [], decisions: [], env: [], verify: { install: false, devCmd: "", buildCmd: "", testCmd: "" },
      files: [], dependencies: {}, devDependencies: {}, scripts: {}, previewable: vfs.has("index.html"),
    });

    const writeOne = async (op: WriteOp): Promise<boolean> => {
      guard(signal);
      const t0 = Date.now();
      say({ kind: "file", path: op.path, status: "active" }, `${op.path} — génération…`, "active");
      try {
        if (!plan) plan = failsafePlan();
        if (!archText && input.mode === "iterate") archText = describeArchitecture(analyzeArchitecture(vfs));
        let content = await generateFile({
          plan,
          target: { path: op.path, purpose: op.purpose },
          phase: op.phase,
          archContext: archText || undefined,
          index: buildIndex(vfs, purposeOf(vfs)),
          generated: generatedSoFar,
          modificationContext: input.mode === "iterate" ? { request: input.request, currentContent: op.current ?? undefined } : undefined,
          signal,
        });
        if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS) + "\n";
        if (totalChars + content.length > MAX_TOTAL_CHARS) {
          say({ kind: "file", path: op.path, status: "skipped", label: "ignoré (limite de taille du projet)" }, `${op.path} ignoré — limite de taille`);
          return false;
        }
        vfs.write(op.path, content);
        totalChars += content.length;
        const exportsFound = extractSymbols(op.path, content);
        generatedSoFar.push({ path: op.path, exports: exportsFound });
        generationIssues = generationIssues.filter((g) => g.file !== op.path);
        say({ kind: "file", path: op.path, status: "done", bytes: content.length, ms: Date.now() - t0, content }, `${op.path} — ${(content.length / 1024).toFixed(1)} Ko en ${((Date.now() - t0) / 1000).toFixed(1)} s`, "done", { ms: Date.now() - t0, bytes: content.length });
        return true;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        const msg = e instanceof Error ? e.message : "échec de génération";
        say({ kind: "file", path: op.path, status: "error", label: msg }, `${op.path} — échec : ${msg}`, "error");
        if (!generationIssues.some((g) => g.file === op.path)) {
          generationIssues.push({ id: `gen-${op.path}`, file: op.path, kind: "generation-failed", severity: "error", message: `Génération échouée : ${msg}` });
        }
        return false;
      }
    };

    // — Parallel generation within each phase, sequential across phases —
    const MAX_PARALLEL_FILES = 3;
    const grouped = input.mode === "create" && plan
      ? plan.phases.map((ph) => ({
          title: ph.title,
          ops: writeOps.filter((o) => o.phase?.title === ph.title),
        })).filter((g) => g.ops.length > 0)
      : [{ title: "", ops: writeOps }];

    for (const group of grouped) {
      guard(signal);
      if (group.ops.length > 1) {
        say({ kind: "log", message: `Génération parallèle : ${group.ops.length} fichier(s) en cours simultanément${MAX_PARALLEL_FILES > 0 && group.ops.length > MAX_PARALLEL_FILES ? ` (vagues de ${MAX_PARALLEL_FILES})` : ""}…` }, `Parallélisation : ${group.ops.length} fichiers`);
      }
      await runPool(group.ops, MAX_PARALLEL_FILES, (op) => writeOne(op).then(() => undefined), signal);
      guard(signal);
    }
    say({ kind: "phase", label: "Toutes les phases de génération sont terminées", status: "done" }, "Phases de génération terminées");
    say({ kind: "step", step: "generate", status: "done" }, "Génération terminée");

    /* -------------------------------------------------------------- */
    /*  Step 3+4 — validation + targeted autonomous fix loop           */
    /* -------------------------------------------------------------- */
    say({ kind: "step", step: "validate", status: "active", label: "Validation multi-niveaux (syntaxe, imports, dépendances, cohérence)" }, "Validation", "active");
    say({ kind: "step", step: "fix", status: "active", label: "Auto-correction ciblée" }, "Auto-correction", "active");

    harmonizedCount += harmonizeHtmlRefs(vfs);
    if (harmonizedCount) say({ kind: "log", message: `${harmonizedCount} référence(s) HTML réalignée(s) sur les fichiers réels` }, `${harmonizedCount} référence(s) HTML réalignée(s)`);

    /** One targeted-fix pass over current errors; returns remaining errors. */
    const fixPass = async (errorsIn: Issue[], buildLogTail?: string): Promise<Issue[]> => {
      // Deterministic surgery first: uninstallable names never need an AI call.
      const pruned = pruneInvalidDeps(vfs);
      if (pruned.length) say({ kind: "fix", path: "package.json", label: `entrée(s) invalide(s) retirée(s) : ${pruned.join(", ")}` }, `package.json — ${pruned.length} entrée(s) invalide(s) retirée(s)`);
      const missingDeps = [...new Set(
        errorsIn.filter((i) => i.kind === "missing-dependency" && vfs.has("package.json"))
          .map((i) => i.message.match(/«\s*([^»]+?)\s*»/)?.[1]).filter(Boolean) as string[]
      )];
      if (missingDeps.length) {
        const n = await patchPackageDeps(vfs, missingDeps);
        if (n) say({ kind: "fix", path: "package.json", label: `${n} dépendance(s) déclarée(s) avec versions réelles : ${missingDeps.join(", ")}` }, `package.json — +${n} dépendance(s) déclarée(s)`);
      }
      const byFile = new Map<string, Issue[]>();
      for (const issue of errorsIn) {
        if (issue.kind === "missing-dependency" && vfs.has("package.json") && !issue.file) continue;
        const key =
          issue.file ??
          ((issue.kind === "config" || issue.kind === "package" || issue.kind === "missing-dependency") && vfs.has("package.json") ? "package.json" : "(projet)");
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key)!.push(issue);
      }
      const fixable = [...byFile.entries()].filter(([file]) => file !== "(projet)");
      await runPool(
        fixable,
        2,
        async ([file, list]) => {
          const attempts = (fixAttempts.get(file) ?? 0) + 1;
          fixAttempts.set(file, attempts);
          if (attempts > MAX_FIX_PER_FILE) {
            say({ kind: "fix", path: file, status: "skipped", label: `maximum de tentatives atteint (${MAX_FIX_PER_FILE}) — signalé honnêtement` }, `${file} — max de corrections atteint`, "skipped");
            return;
          }
          const t0 = Date.now();
          say({ kind: "fix", path: file, status: "active", label: `correction ciblée de ${list.length} problème(s) (${list.map((l) => l.kind).join(", ")})` }, `${file} — correction…`, "active");
          try {
            const current = vfs.read(file);
            if (current == null) {
              const content = await generateFile({
                plan: plan!,
                target: { path: file, purpose: "Fichier requis par d'autres modules du projet" },
                archContext: describeArchitecture(analyzeArchitecture(vfs), 1800),
                index: buildIndex(vfs, purposeOf(vfs)),
                generated: generatedSoFar,
                signal,
              });
              vfs.write(file, content.slice(0, MAX_FILE_CHARS));
            } else {
              const corrected = await fixFile({
                plan, path: file, content: current, issues: list,
                index: buildIndex(vfs, purposeOf(vfs)),
                archContext: describeArchitecture(analyzeArchitecture(vfs), 1800),
                buildLogTail,
                signal,
              });
              vfs.write(file, corrected.slice(0, MAX_FILE_CHARS));
            }
            generationIssues = generationIssues.filter((g) => g.file !== file);
            say({ kind: "fix", path: file, status: "done", ms: Date.now() - t0 }, `${file} — corrigé en ${((Date.now() - t0) / 1000).toFixed(1)} s`, "done", { ms: Date.now() - t0 });
          } catch (e) {
            if (e instanceof Cancelled) throw e;
            say({ kind: "fix", path: file, status: "error", label: e instanceof Error ? e.message : "échec" }, `${file} — correction échouée`, "error");
          }
        },
        signal
      );

      return [...generationIssues, ...validateProject(vfs)].filter((i) => i.severity === "error");
    };

    let errors: Issue[] = [];
    for (let cycle = 0; cycle <= settings.fixCycles; cycle++) {
      guard(signal);
      generationIssues = generationIssues.filter((g) => !vfs.has(g.file ?? ""));
      const all = [...generationIssues, ...validateProject(vfs)];
      errors = all.filter((i) => i.severity === "error");
      say({ kind: "issues", issues: all, cycle }, `Validation — ${errors.length} erreur(s), ${all.length - errors.length} avertissement(s)`, errors.length ? "error" : "done", { cycle, count: all.length });
      if (input.mode === "iterate" || cycle > 0) issues = all;
      if (!errors.length) break;
      if (cycle >= settings.fixCycles) break;
      cyclesUsed++;
      errors = await fixPass(errors);
    }

    /* -------------------------------------------------------------- */
    /*  Step 5 — AGENT DEBUG LOOP: real workspace, real commands.      */
    /*  install (once) → typecheck → build → test → classify → fix     */
    /*  → re-sync → re-run. Bounded, every command reported honestly.  */
    /* -------------------------------------------------------------- */
    say({ kind: "step", step: "verify", status: "active", label: "Workspace réel : installation, typecheck, build, tests — puis débogage itératif" }, "Vérification outillage (agent)", "active");
    const runBuild = settings.runBuild !== false;
    const runTests = settings.runTests !== false;
    let distAssets: { entry: string; files: { path: string; content: string }[] } | null = null;
    const allCommands: { label: string; code: number; ms: number }[] = [];
    let verifyRounds = 0;

    if (!vfs.has("package.json")) {
      buildReport = { ran: false, ok: null, rounds: 0, commands: [], skippedReason: "Projet hors écosystème npm — validations statiques uniquement (rien d'inventé)." };
      say({ kind: "verify", status: "skipped", label: buildReport.skippedReason }, `Outillage ignoré : ${buildReport.skippedReason}`, "skipped");
    } else {
      const ws = await ProjectWorkspace.materialize(vfs);
      let installedHash: string | null = null;
      try {
        const MAX_TOOL_ROUNDS = 1 + Math.min(3, settings.fixCycles); // first run + bounded debug rounds
        let done = false;
        while (!done) {
          guard(signal);
          verifyRounds++;
          const drift = installedHash !== null && installedHash !== ws.pkgHashOf(vfs);
          const tc = await runToolchain(ws, vfs, {
            runTypecheck: true,
            runLint: false,
            runBuild,
            runTests,
            forceInstall: drift,
            onCommand: (c, phase) => {
              allCommands.push({ label: c.label, code: c.code, ms: c.ms });
              say(
                { kind: "verify", status: c.code === 0 ? "done" : "error", label: `${c.label} → ${c.code === 0 ? "OK" : `échec (code ${c.code})`} · ${(c.ms / 1000).toFixed(0)} s`, ms: c.ms },
                `${c.label} → ${c.code === 0 ? "OK" : `échec (${c.code})`} [${(c.ms / 1000).toFixed(0)} s]`,
                c.code === 0 ? "done" : "error",
                { phase, tail: c.tail.slice(-800) }
              );
            },
          });
          installedHash = tc.pkgHash ?? installedHash;
          if (tc.dist) distAssets = tc.dist;
          if (!tc.ran) {
            buildReport = { ran: false, ok: null, rounds: verifyRounds - 1, commands: allCommands, skippedReason: tc.skippedReason };
            say({ kind: "verify", status: "skipped", label: tc.skippedReason }, `Outillage ignoré : ${tc.skippedReason}`, "skipped");
            break;
          }
          const hardErrors = tc.issues.filter((i) => i.severity === "error");
          if (!hardErrors.length) {
            buildReport = { ran: true, ok: true, rounds: verifyRounds, commands: allCommands, skippedReason: undefined };
            say({ kind: "verify", status: "done", label: verifyRounds > 1 ? `Toolchain validée après ${verifyRounds - 1} round(s) de débogage` : "Toolchain validée du premier coup" }, `toolchain validée (${verifyRounds} round(s))`);
            break;
          }
          issues = [...issues, ...tc.issues];
          if (verifyRounds >= MAX_TOOL_ROUNDS) {
            buildReport = { ran: true, ok: false, rounds: verifyRounds, commands: allCommands, skippedReason: undefined };
            say({ kind: "verify", status: "error", label: `${hardErrors.length} erreur(s) d'outillage persistent après ${verifyRounds - 1} correction(s) — consignées dans le rapport, honnêtement` }, `outillage : ${hardErrors.length} erreur(s) persistante(s)`, "error");
            break;
          }
          say({ kind: "verify", status: "error", label: `Round ${verifyRounds} : ${hardErrors.length} erreur(s) réelle(s) détectée(s) — analyse, localisation, correction ciblée` }, `round ${verifyRounds} : ${hardErrors.length} erreur(s) → correction`, "error");
          cyclesUsed++;
          const combinedTail = tc.commands.filter((c) => c.code !== 0).map((c) => `[${c.label}]\n${c.tail}`).join("\n---\n").slice(-2400);
          await fixPass(hardErrors, combinedTail);
          harmonizedCount += harmonizeHtmlRefs(vfs);
          await ws.sync(vfs); // agent re-enters the workspace with fixes applied
        }
      } finally {
        await ws.dispose();
      }
    }
    say({ kind: "step", step: "verify", status: buildReport.ok ? "done" : buildReport.ran ? "error" : "skipped" }, "Vérification outillage terminée");

    issues = [...generationIssues.filter((g) => !vfs.has(g.file ?? "")), ...validateProject(vfs), ...issues.filter((i) => i.kind === "build" || i.kind === "test" || i.kind === "config" || i.kind === "typescript")];
    const finalErrors = issues.filter((i) => i.severity === "error").length;
    say({ kind: "step", step: "validate", status: "done" }, finalErrors ? `Validation finale — ${finalErrors} problème(s) résiduel(s) (signalés honnêtement)` : "Validation finale — aucune erreur détectée");
    say({ kind: "step", step: "fix", status: finalErrors ? "skipped" : "done", label: `${cyclesUsed} cycle(s) de correction utilisé(s)` }, `Auto-correction — ${cyclesUsed} cycle(s)`);

    /* -------------------------------------------------------------- */
    /*  Step 6 — env sync (deterministic), README, packaging           */
    /* -------------------------------------------------------------- */
    say({ kind: "step", step: "readme", status: "active", label: "Documentation et configuration d'environnement" }, "Documentation", "active");
    const envSync = buildEnvExample(vfs, plan?.env ?? []);
    if (envSync.content) {
      vfs.write(".env.example", envSync.content);
      say({ kind: "file", path: ".env.example", status: "done", bytes: envSync.content.length, content: envSync.content }, ".env.example généré depuis l'usage réel du code");
      if (envSync.leaked.length) {
        say({ kind: "log", message: `ALERTE SÉCURITÉ : valeur(s) semblant être des secrets détectée(s) pour ${envSync.leaked.join(", ")} — jamais recopiée(s) dans .env.example` }, `Alerte secrets : ${envSync.leaked.join(", ")}`, "error");
        issues.push({ id: `secret-${Date.now()}`, file: null, kind: "config", severity: "warning", message: `Des valeurs ressemblant à des secrets ont été neutralisées (${envSync.leaked.join(", ")})` });
      }
    }
    // — Agent memory: regenerated from REAL state, consulted next iteration —
    try {
      const archNow = analyzeArchitecture(vfs);
      const archDoc = renderArchitectureDoc(archNow, {
        name: plan?.name ?? input.projectName,
        description: plan?.description,
        scripts: plan?.scripts,
        features: plan?.features,
      });
      vfs.write("ARCHITECTURE.md", archDoc);
      say({ kind: "file", path: "ARCHITECTURE.md", status: "done", bytes: archDoc.length, content: archDoc }, "ARCHITECTURE.md régénéré depuis l'état réel (mémoire de l'agent)");
      const decisionsDoc = appendDecisions(
        vfs.read("DECISIONS.md"),
        plan?.decisions ?? [],
        modPlan ? `Modification « ${input.request.slice(0, 100)} » : ${modPlan.summary.slice(0, 140)}` : ""
      );
      if (decisionsDoc !== (vfs.read("DECISIONS.md") ?? "")) {
        vfs.write("DECISIONS.md", decisionsDoc.endsWith("\n") ? decisionsDoc : decisionsDoc + "\n");
        say({ kind: "file", path: "DECISIONS.md", status: "done", bytes: decisionsDoc.length, content: decisionsDoc }, "DECISIONS.md mis à jour (journal des choix)");
      }
    } catch {
      /* memory files are best-effort, never blocking */
    }
    try {
      const index = buildIndex(vfs, purposeOf(vfs));
      const readme = await writeReadme({
        plan,
        name: plan?.name ?? input.projectName,
        seedRequest: input.seedRequest || input.request,
        index,
        validation: { checked: true, errors: finalErrors, warnings: issues.length - finalErrors, cycles: cyclesUsed },
        signal,
      });
      vfs.write("README.md", readme);
      say({ kind: "file", path: "README.md", status: "done", bytes: readme.length, content: readme }, "README.md rédigé depuis l'état réel du projet");
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      say({ kind: "step", step: "readme", status: "error", label: "README non généré (moteur indisponible à cette étape)" }, "README — échec", "error");
    }
    if (!vfs.has(".gitignore")) {
      vfs.write(".gitignore", ["node_modules/", "dist/", "build/", "out/", ".env", ".env.*", "!.env.example", "*.log", "__pycache__/", ".DS_Store", "target/", "coverage/", ".next/", ""].join("\n"));
      say({ kind: "file", path: ".gitignore", status: "done", bytes: vfs.read(".gitignore")!.length }, ".gitignore ajouté");
    }
    say({ kind: "step", step: "readme", status: "done" }, "Documentation terminée");

    say({ kind: "step", step: "package", status: "active", label: "Assemblage du ZIP et test de la prévisualisation" }, "Packaging", "active");
    const zipInfo = await buildZip(vfs);
    // Preview priority #1: the REAL compiled output (dist) — persisted, since
    // rebuilding requires node_modules the client doesn't have.
    let previewHtml: string | null = null;
    let staticPreviewOk = false;
    let previewSource = "";
    if (distAssets) {
      previewHtml = buildDistPreview(distAssets.files, distAssets.entry);
      if (previewHtml) previewSource = `build réel (${distAssets.entry} inliné — application compilée authentique)`;
    }
    // Static preview: assembled LIVE on each request from the real files —
    // never persisted, so it can never go stale after edits/iterations.
    const preview = previewHtml ? null : buildPreview(vfs);
    if (!previewHtml && preview?.ok) {
      staticPreviewOk = true;
      previewSource = `fichiers statiques inlinés à la volée (${preview.entry})`;
    }
    const previewable = previewHtml != null || staticPreviewOk;
    const previewNote = previewable
      ? `preview disponible — ${previewSource}`
      : `pas de preview : ${preview?.reason ?? "aucune sortie exploitable"}`;
    say({ kind: "step", step: "package", status: "done", label: `ZIP prêt (${(zipInfo.bytes / 1024).toFixed(1)} Ko) · ${previewNote}` }, `ZIP ${(zipInfo.bytes / 1024).toFixed(1)} Ko — ${previewNote}`);

    /* -------------------------------------------------------------- */
    /*  Persist + honest final report                                  */
    /* -------------------------------------------------------------- */
    diff = diffSnapshots(beforeSnapshot, vfs);
    const snapshotObj = vfs.snapshot();
    const snapshotJson = JSON.stringify(snapshotObj);
    const genFailedLeft = generationIssues.filter((g) => !vfs.has(g.file ?? "")).length;
    const coverage = validationCoverage(vfs);
    const arch = analyzeArchitecture(vfs);
    const depsAdded = diff.added.includes("package.json") || diff.modified.includes("package.json");

    const verdict =
      genFailedLeft > 0 ? "PARTIEL — fichiers non écrits" :
      buildReport.ran && buildReport.ok === false ? "LIVRÉ AVEC RÉSERVE — l'outillage signale des erreurs (voir rapport)" :
      finalErrors > 0 ? `LIVRÉ AVEC ${finalErrors} AVERTISSEMENT(S)` :
      "VALIDÉ";

    const report = [
      `## Rapport de génération — ${plan?.name ?? input.projectName}`,
      ``,
      `**Verdict : ${verdict}**`,
      ``,
      `### Réalisé`,
      `- Fichiers : ${vfs.paths().length} (${(vfs.totalBytes() / 1024).toFixed(1)} Ko) — ZIP ${(zipInfo.bytes / 1024).toFixed(1)} Ko`,
      `- Stack : ${arch.stack.language || "?"}${arch.stack.framework ? " + " + arch.stack.framework : ""}${arch.stack.buildTool ? ` · build ${arch.stack.buildTool}` : ""}`,
      `- Fonctionnalités livrées : ${(plan?.features ?? []).slice(0, 12).join(" ; ") || "—"}`,
      plan?.phases.length ? `- Phases exécutées : ${plan.phases.map((p) => p.title).join(" → ")}` : null,
      arch.routes.length ? `- Routes détectées : ${arch.routes.slice(0, 10).join(" | ")}` : null,
      arch.models.length ? `- Modèles : ${arch.models.slice(0, 8).join(", ")}` : null,
      arch.envVars.length ? `- Variables d'env documentées (.env.example) : ${arch.envVars.join(", ")}` : null,
      ``,
      `### Vérifications réellement effectuées`,
      `- Analyse syntaxique (compilateur TypeScript) : ${coverage.parsedFiles} fichier(s) parsé(s)`,
      `- Résolution des imports inter-fichiers + complétude des dépendances : oui`,
      `- Harmonisation des références HTML : ${harmonizedCount} réécriture(s)`,
      `- Cycles d'auto-correction utilisés : ${cyclesUsed}`,
      buildReport.ran
        ? `- Outillage réel (${buildReport.rounds} round(s) dans un workspace isolé, npm install partagé) : ${buildReport.ok ? "VALIDÉ" : "EN ÉCHEC — voir commandes"}`
        : `- Outillage réel : non exécuté — ${buildReport.skippedReason ?? "non applicable"} (rien n'est prétendu)`,
      ...buildReport.commands.map((c) => `  - \`${c.label}\` → ${c.code === 0 ? "OK" : `échec (code ${c.code})`} (${(c.ms / 1000).toFixed(0)} s)`),
      `- Aperçu : ${previewable ? `disponible (${previewSource})` : "indisponible pour ce type de projet"}`,
      ``,
      `### Reste à connaître`,
      finalErrors === 0 && genFailedLeft === 0 && buildReport.ok !== false
        ? "- Aucune erreur de validation restante détectée à ce stade."
        : `- ${finalErrors} problème(s) de validation restant(s) : ${issues.filter((i) => i.severity === "error").slice(0, 6).map((i) => `[${i.kind}] ${i.file ?? "?"} — ${i.message}`).join(" ; ")}`,
      genFailedLeft > 0 ? `- ${genFailedLeft} fichier(s) planifié(s) non écrit(s) — relancer pour compléter.` : `- Aucun fichier planifié manquant.`,
      `- Moteur(s) ayant réellement servi : ${enginesUsed().join(" + ") || engineLabel} · Durée totale : ${((Date.now() - started) / 1000).toFixed(0)} s`,
    ].filter((l): l is string => l !== null).join("\n");

    const stats = {
      files: vfs.paths().length,
      bytes: vfs.totalBytes(),
      zipBytes: zipInfo.bytes,
      cyclesUsed,
      durationMs: Date.now() - started,
      engine: enginesUsed().join(" + ") || engineLabel,
      enginesUsed: enginesUsed(),
      remainingErrors: finalErrors,
      build: buildReport,
      archContext: { routes: arch.routes, models: arch.models, envVars: arch.envVars, entryPoints: arch.entryPoints, stack: arch.stack, edges: arch.edges },
      report,
      verdict,
    };

    const projectStatus = genFailedLeft > 0 ? "error" : "ready";
    await replaceProjectFiles(input.projectId, vfs.entries());
    await updateProject(input.projectId, {
      name: input.mode === "create" && plan ? plan.name : input.projectName,
      description: plan?.description ?? "",
      plan: (plan ?? { modification: modPlan }) as object,
      previewable,
      previewHtml,
      status: projectStatus,
    });
    await db.update(projects).set({ version: sql`${projects.version} + 1`, updatedAt: new Date() }).where(eq(projects.id, input.projectId));

    await finishRun(run.id, {
      status: genFailedLeft > 0 ? "error" : buildReport.ran && buildReport.ok === false ? "done" : "done",
      plan: (plan ?? { modification: modPlan }) as object,
      diff: diff as object,
      issues: issues.slice(0, 80) as object[],
      stats: stats as object,
      snapshot: snapshotJson.length < 6_000_000 ? (snapshotObj as object) : null,
    });
    await insertRunEvents(run.id, log);

    const summaryMsg =
      genFailedLeft > 0
        ? `Génération PARTIELLE : ${genFailedLeft} fichier(s) n'ont pas pu être écrits (moteur saturé). Les autres fichiers sont conservés — relancez pour compléter.`
        : `${verdict} — ${vfs.paths().length} fichiers, ${(vfs.totalBytes() / 1024).toFixed(1)} Ko. ${buildReport.ran ? (buildReport.ok ? "Build/test réels validés." : "L'outillage réel signale des erreurs (voir rapport).") : "Validations statiques passées."} Moteur ${engineLabel}.`;
    await addMessage(input.projectId, "assistant", summaryMsg, { diff, stats: { ...stats, report: undefined }, report });

    say({ kind: "diff", diff }, `Diff — +${diff.added.length} ajouté(s), ~${diff.modified.length} modifié(s), -${diff.deleted.length} supprimé(s)${depsAdded ? " · package.json mis à jour" : ""}`);
    say(
      genFailedLeft > 0 ? { kind: "error", message: summaryMsg } : { kind: "done", stats: stats as Record<string, unknown> },
      genFailedLeft > 0 ? "Génération partielle" : `Projet terminé — ${verdict}`
    );
    setEngineListener(null);
  } catch (e) {
    setEngineListener(null);
    const cancelled = e instanceof Cancelled || (e instanceof Error && /aborted/i.test(e.message));
    if (cancelled) {
      say({ kind: "cancelled" }, "Génération annulée par l'utilisateur", "skipped");
      await finishRun(run.id, { status: "cancelled", issues: issues as object[] });
      await insertRunEvents(run.id, log).catch(() => {});
      const files = await getProjectFiles(input.projectId);
      await updateProject(input.projectId, { status: files.length ? "ready" : "cancelled" });
      return;
    }
    const msg = e instanceof Error ? e.message : "Erreur inconnue";
    say({ kind: "error", message: msg }, `Échec : ${msg}`, "error");
    await finishRun(run.id, { status: "error", issues: issues as object[] }).catch(() => {});
    await insertRunEvents(run.id, log).catch(() => {});
    const files = await getProjectFiles(input.projectId).catch(() => []);
    await updateProject(input.projectId, { status: files.length ? "ready" : "error" }).catch(() => {});
  }
}
