import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { VFS } from "./vfs";
import type { Issue } from "@/lib/ai/types";

/* ------------------------------------------------------------------ */
/*  Terminal-grade workspace: the project is materialized on disk and  */
/*  the agent works there like a developer — install once, then run    */
/*  typecheck / lint / build / test repeatedly across fix iterations.  */
/*  Environment scrubbed (no secrets), shared npm cache for speed.     */
/* ------------------------------------------------------------------ */

export interface ToolRun {
  label: string;
  cmd: string;
  code: number; // 0 = success, 124 = timeout
  ms: number;
  tail: string;
}

export interface ToolchainResult {
  ran: boolean;
  ok: boolean | null;
  skippedReason?: string;
  commands: ToolRun[];
  issues: Issue[];
  dist?: { entry: string; files: { path: string; content: string }[] } | null;
  /** Persisted after a successful (re)install so callers can detect drift. */
  pkgHash?: string;
}

const SHARED_CACHE = path.join(os.tmpdir(), "codeforge-npm-cache");
let benchBusy = false;

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ToolRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: os.tmpdir(),
          CI: "true",
          NODE_ENV: "development",
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_progress: "false",
          npm_config_yes: "true",
          npm_config_cache: SHARED_CACHE,
        } as NodeJS.ProcessEnv,
      },
      (err, stdout, stderr) => {
        const raw = (String(stdout ?? "") + "\n" + String(stderr ?? ""));
        // strip ANSI for readable tails
        const out = raw.replace(/\[[0-9;]*m/g, "");
        const lines = out.trim().split("\n").filter((l) => l.trim());
        resolve({
          label: `${cmd} ${args.join(" ")}`,
          cmd,
          code: err ? (typeof err.code === "number" ? err.code : 124) : 0,
          ms: Date.now() - started,
          tail: lines.slice(-30).join("\n").slice(-1600),
        });
      }
    );
    child.unref?.();
  });
}

/** A real on-disk workspace the agent operates in. */
export class ProjectWorkspace {
  private constructor(public dir: string, public fileCount: number) {}

  static async materialize(vfs: VFS): Promise<ProjectWorkspace> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codeforge-ws-"));
    const ws = new ProjectWorkspace(dir, 0);
    await ws.sync(vfs);
    return ws;
  }

  /** Write all VFS files to disk (never touches node_modules). */
  async sync(vfs: VFS): Promise<number> {
    let n = 0;
    for (const { path: p, content } of vfs.entries()) {
      const full = path.join(this.dir, p);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      n++;
    }
    this.fileCount = n;
    return n;
  }

  async hasNodeModules(): Promise<boolean> {
    try {
      await stat(path.join(this.dir, "node_modules"));
      return true;
    } catch {
      return false;
    }
  }

  pkgHashOf(vfs: VFS): string {
    return createHash("sha1").update(vfs.read("package.json") ?? "").digest("hex").slice(0, 12);
  }

  run(cmd: string, args: string[], timeoutMs: number): Promise<ToolRun> {
    return run(cmd, args, this.dir, timeoutMs);
  }

  async dispose() {
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ——— Error classification: real tool output → typed Issues ——— */
let uidn = 0;
const uid = () => `v${++uidn}-${Date.now().toString(36)}`;

export function classifyToolOutput(source: string, out: string): Issue[] {
  const issues: Issue[] = [];
  const push = (file: string | null, kind: Issue["kind"], message: string, severity: Issue["severity"] = "error") => {
    if (issues.length < 24 && !issues.some((i) => i.file === file && i.message === message)) {
      issues.push({ id: uid(), file, kind, message: message.slice(0, 400), severity });
    }
  };

  // TypeScript compiler: src/x.ts(12,5): error TS2322: ...
  for (const m of out.matchAll(/([^\s()]+\.[tj]sx?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/g)) {
    push(m[1], "typescript", `${m[4]} (ligne ${m[2]}) : ${m[5].trim()}`);
  }
  for (const m of out.matchAll(/([^\s()]+\.[tj]sx?)\s*[-–]\s*error\s+(TS\d+):\s*(.+)/g)) {
    push(m[1], "typescript", `${m[2]} : ${m[3].trim()}`);
  }
  // Bundler resolution
  for (const m of out.matchAll(/Failed to resolve import\s+"([^"]+)"\s+from\s+"([^"]+)"/g)) {
    push(m[2], m[1].startsWith(".") ? "missing-file" : "missing-dependency", `Import non résolu (build) : « ${m[1]} »`);
  }
  for (const m of out.matchAll(/Cannot find module\s+'([^']+)'(?:\s+from\s+'([^']+)')?/g)) {
    push(m[2] ?? null, "missing-dependency", `Module introuvable : « ${m[1]} »`);
  }
  for (const m of out.matchAll(/Rollup failed to resolve import "([^"]+)" from "([^"]+)"/g)) {
    push(m[2], m[1].startsWith(".") ? "missing-file" : "missing-dependency", `Import non résolu : « ${m[1]} »`);
  }
  // Could not resolve entry module (vite)
  for (const m of out.matchAll(/Could not resolve entry module\s+"([^"]+)"/g)) {
    push(null, "config", `Point d'entrée introuvable pour le bundler : « ${m[1]} » (le placer à la racine attendue ou ajuster la config)`);
  }
  // Syntax errors
  for (const m of out.matchAll(/([^\s:]+\.[tj]sx?):\d+:\d*:?\s*(?:ERROR|error)?[:\s]*((?:Unexpected|Expected|Parsing error|.*unexpected token).{0,160})/gi)) {
    push(m[1], "syntax", m[2].trim());
  }
  // ESLint: /path/file.tsx\n  12:5  error  msg  rule
  for (const m of out.matchAll(/([^\s]+\.[tj]sx?)\n\s+\d+:\d+\s+error\s+(.{5,120})/g)) {
    push(m[1].replace(/^.*codeforge-ws-[^/]+\//, ""), "syntax", `ESLint : ${m[2].trim()}`, "warning");
  }
  // Tests
  for (const m of out.matchAll(/FAIL\s+([^\s]+)/g)) push(m[1], "test", "Suite de tests en échec");
  for (const m of out.matchAll(/✕\s+(.{5,120})/g)) push(null, "test", `Test en échec : ${m[1].trim()}`);
  // Env / config
  for (const m of out.matchAll(/(?:Missing|missing|required)\s+(?:environment variable|env(?:ironment)?\s*var(?:iable)?)\s*[:\s]*([A-Z][A-Z0-9_]+)/g)) {
    push(null, "config", `Variable d'environnement manquante : ${m[1]} (voir .env.example)`);
  }
  // Python
  for (const m of out.matchAll(/File\s+"([^"]+\.py)",\s+line\s+(\d+)[\s\S]{0,200}?(SyntaxError|ImportError|ModuleNotFoundError|NameError|TypeError):\s*(.{0,140})/g)) {
    push(m[1], m[3] === "SyntaxError" ? "syntax" : m[3] === "ImportError" || m[3] === "ModuleNotFoundError" ? "missing-dependency" : "runtime", `${m[3]} (ligne ${m[2]}): ${m[4].trim()}`);
  }
  // npm dependency-tree conflicts → responsible file IS package.json
  if (source === "install") {
    const found = out.match(/Found:\s*([^\s]+)\s*/);
    for (const m of out.matchAll(/Could not resolve dependency:[\s\S]{0,200}?(?:peer|devPeer)?\s*(?:Optional\s+)?([a-zA-Z0-9@_/.-]+)@["']?([^"'\s]+)["']?\s*from\s*([^\s]+)/g)) {
      push("package.json", "package", `Conflit de versions npm${found ? ` (installé : ${found[1]})` : ""} : « ${m[3]} » exige ${m[1]}@${m[2]}`);
    }
    if (/code E404|404 Not Found\s*-\s*GET/.test(out)) {
      const m = out.match(/'([^']+)' is not in this registry|404 Not Found\s*-\s*GET\s*https?:\/\/\S+\/(\S+)/);
      push("package.json", "missing-dependency", `Paquet inexistant sur le registre npm : « ${m?.[1] ?? m?.[2] ?? "?"} » — le renommer ou le remplacer`);
    }
    if (/code ERESOLVE/.test(out) && !issues.length) {
      push("package.json", "package", `Arbre de dépendances irrésolvable (ERESOLVE)${found ? ` (installé : ${found[1]})` : ""} — aligner les versions antagonistes`);
    }
    if (/EINVALIDPACKAGENAME/.test(out)) {
      push("package.json", "package", "Nom de paquet invalide dans package.json (EINVALIDPACKAGENAME)");
    }
  }
  return issues;
}

/* ——— dist capture (real compiled output, for honest previews) ——— */
const DIST_DIRS = ["dist", "build", "out", ".output/public", "public/build"];
const DIST_TEXT_EXT = /\.(html|js|mjs|css|svg|json|txt)$/i;

async function captureDist(root: string): Promise<ToolchainResult["dist"]> {
  for (const d of DIST_DIRS) {
    const base = path.join(root, d);
    try {
      const files: { path: string; content: string }[] = [];
      let total = 0;
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          const rel = path.relative(base, full).split(path.sep).join("/");
          if (e.isDirectory()) {
            if (rel.split("/").length > 4) continue;
            await walk(full);
          } else if (DIST_TEXT_EXT.test(e.name) && !e.name.endsWith(".map") && !/manifest\.json$/i.test(e.name) && total < 3_500_000) {
            const content = await readFile(full, "utf8");
            total += content.length;
            files.push({ path: rel, content });
          }
        }
      };
      await walk(base);
      const entry = files.find((f) => f.path === "index.html") ?? files.find((f) => f.path.endsWith(".html"));
      if (entry) return { entry: `${d}/${entry.path}`, files };
    } catch {
      /* no such dir */
    }
  }
  return null;
}

export interface ToolchainOpts {
  install?: boolean;
  /** Run npm install even when node_modules exists (deps drifted). */
  forceInstall?: boolean;
  runTypecheck?: boolean;
  runLint?: boolean;
  runBuild?: boolean;
  runTests?: boolean;
  onCommand?: (c: ToolRun, phase: string) => void;
}

/**
 * Run the REAL toolchain inside a workspace, like a developer would.
 * Deterministic order: install → typecheck → lint → build → test.
 * Everything measured and honest; callers decide what to do with results.
 */
export async function runToolchain(ws: ProjectWorkspace, vfs: VFS, opts: ToolchainOpts): Promise<ToolchainResult> {
  const pkgRaw = vfs.read("package.json");
  if (!pkgRaw) {
    return { ran: false, ok: null, skippedReason: "Aucun package.json — projet hors écosystème npm.", commands: [], issues: [] };
  }
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return { ran: false, ok: false, skippedReason: "package.json invalide.", commands: [], issues: [{ id: uid(), file: "package.json", kind: "json", message: "package.json invalide", severity: "error" }] };
  }
  if (benchBusy) {
    return { ran: false, ok: null, skippedReason: "Un autre build occupe déjà le workspace de cette instance.", commands: [], issues: [] };
  }
  benchBusy = true;
  const commands: ToolRun[] = [];
  const issues: Issue[] = [];
  const push = (r: ToolRun, phase: string) => {
    commands.push(r);
    opts.onCommand?.(r, phase);
  };
  try {
    // — install (only when needed: node_modules missing or package.json drifted) —
    if (opts.install !== false) {
      const needInstall = opts.forceInstall === true || !(await ws.hasNodeModules());
      if (needInstall) {
        const r = await ws.run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], 300_000);
        push(r, "install");
        if (r.code !== 0) {
          const fallback: Issue[] = [{ id: uid(), file: "package.json", kind: "package", message: `npm install a échoué (code ${r.code})`, severity: "error" }];
          issues.push(...(classifyToolOutput("install", r.tail).length ? classifyToolOutput("install", r.tail) : fallback));
          return { ran: true, ok: false, commands, issues, pkgHash: ws.pkgHashOf(vfs) };
        }
      }
    }

    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const hasTs = vfs.has("tsconfig.json") && ("typescript" in deps || vfs.paths().some((p) => p.endsWith(".ts") || p.endsWith(".tsx")));

    // — typecheck (fast, high-signal) —
    if (opts.runTypecheck !== false && hasTs) {
      const r = await ws.run("npx", ["tsc", "--noEmit"], 240_000);
      push(r, "typecheck");
      if (r.code !== 0) {
        const found = classifyToolOutput("typecheck", r.tail);
        const fallback: Issue[] = [{ id: uid(), file: null, kind: "typescript", message: `tsc --noEmit a échoué (code ${r.code})`, severity: "error" }];
        issues.push(...(found.length ? found : fallback));
        return { ran: true, ok: false, commands, issues, pkgHash: ws.pkgHashOf(vfs) };
      }
    }

    // — lint (never blocks: findings are warnings) —
    if (opts.runLint && scripts.lint) {
      const r = await ws.run("npm", ["run", "lint"], 240_000);
      push(r, "lint");
      if (r.code !== 0) {
        const found = classifyToolOutput("lint", r.tail).map((i) => ({ ...i, severity: "warning" as const }));
        issues.push(...found);
      }
    }

    // — build —
    let dist: ToolchainResult["dist"] = null;
    if (opts.runBuild !== false && scripts.build) {
      const r = await ws.run("npm", ["run", "build"], 300_000);
      push(r, "build");
      if (r.code !== 0) {
        const found = classifyToolOutput("build", r.tail);
        const fallback: Issue[] = [{ id: uid(), file: null, kind: "build", message: `npm run build a échoué (code ${r.code}) — voir journal`, severity: "error" }];
        issues.push(...(found.length ? found : fallback));
        return { ran: true, ok: false, commands, issues, pkgHash: ws.pkgHashOf(vfs) };
      }
      dist = await captureDist(ws.dir).catch(() => null);
    }

    // — test —
    if (opts.runTests !== false && scripts.test && !/no test specified/.test(scripts.test)) {
      const args = "vitest" in deps ? ["test", "--", "--run"] : "jest" in deps ? ["test", "--", "--ci", "--watchAll=false"] : ["test"];
      const r = await ws.run("npm", args, 300_000);
      push(r, "test");
      if (r.code !== 0) {
        const found = classifyToolOutput("test", r.tail);
        const fallback: Issue[] = [{ id: uid(), file: null, kind: "test", message: `npm test a échoué (code ${r.code})`, severity: "error" }];
        issues.push(...(found.length ? found : fallback));
        return { ran: true, ok: false, commands, issues, dist, pkgHash: ws.pkgHashOf(vfs) };
      }
    }

    const hardErrors = issues.filter((i) => i.severity === "error").length;
    return { ran: true, ok: hardErrors === 0, commands, issues, dist, pkgHash: ws.pkgHashOf(vfs) };
  } finally {
    benchBusy = false;
  }
}

/** One-shot convenience (used by the no-AI verify endpoint). */
export async function verifyWithTooling(vfs: VFS, opts: ToolchainOpts): Promise<ToolchainResult & { installMs?: number; buildMs?: number; testMs?: number }> {
  const ws = await ProjectWorkspace.materialize(vfs);
  try {
    const r = await runToolchain(ws, vfs, opts);
    const find = (phase: string) => r.commands.find((c) => c.cmd === "npm" && c.label.includes(phase))?.ms;
    return { ...r, installMs: find("install"), buildMs: find("build"), testMs: find("test") };
  } finally {
    await ws.dispose();
  }
}
