import { VFS, extractSymbols, languageOf } from "./vfs";
import type { ArchitectureMap } from "@/lib/ai/types";

/* ------------------------------------------------------------------ */
/*  Deterministic project intelligence — no AI call required.          */
/*  This is the always-fresh internal representation of the project    */
/*  that keeps the model honest about what exists.                     */
/* ------------------------------------------------------------------ */

const FRAMEWORK_HINTS: [string, string][] = [
  ["next", "Next.js"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"],
  ["@angular/core", "Angular"], ["express", "Express"], ["fastify", "Fastify"],
  ["hono", "Hono"], ["nestjs", "NestJS (via @nestjs)"], ["@nestjs/core", "NestJS"],
  ["flask", "Flask"], ["fastapi", "FastAPI"], ["django", "Django"], ["laravel", "Laravel"],
  ["tailwindcss", "Tailwind"], ["vite", "Vite"], ["electron", "Electron"],
];

function readPkg(vfs: VFS): Record<string, unknown> | null {
  try {
    const raw = vfs.read("package.json");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Detect the stack actually in use — source of truth for imported & iterated projects. */
export function detectStack(vfs: VFS): ArchitectureMap["stack"] {
  const pkg = readPkg(vfs);
  const deps = pkg
    ? Object.keys({ ...((pkg.dependencies as object) ?? {}), ...((pkg.devDependencies as object) ?? {}) })
    : [];
  const paths = vfs.paths();
  const frameworks = FRAMEWORK_HINTS.filter(([k]) => deps.some((d) => d === k || d.startsWith(k + "/"))).map(([, v]) => v);
  if (paths.some((p) => p.endsWith(".vue")) && !frameworks.includes("Vue")) frameworks.push("Vue");
  if (paths.some((p) => p.endsWith(".svelte")) && !frameworks.includes("Svelte")) frameworks.push("Svelte");
  if (vfs.has("next.config.js") || vfs.has("next.config.mjs") || vfs.has("next.config.ts")) {
    if (!frameworks.includes("Next.js")) frameworks.unshift("Next.js");
  }
  if (vfs.has("requirements.txt") || paths.some((p) => p.endsWith(".py"))) {
    if (vfs.read("requirements.txt")?.match(/flask/i)) frameworks.push("Flask");
    else if (vfs.read("requirements.txt")?.match(/fastapi/i)) frameworks.push("FastAPI");
    else if (vfs.read("requirements.txt")?.match(/django/i)) frameworks.push("Django");
  }
  const tsLike = paths.some((p) => /\.tsx?$/.test(p));
  const pyLike = paths.some((p) => p.endsWith(".py"));
  const goLike = vfs.has("go.mod");
  const rustLike = vfs.has("Cargo.toml");
  const phpLike = paths.some((p) => p.endsWith(".php"));
  const language = tsLike ? "TypeScript" : pyLike ? "Python" : goLike ? "Go" : rustLike ? "Rust" : phpLike ? "PHP" : paths.some((p) => /\.[cm]?jsx?$/.test(p)) ? "JavaScript" : vfs.has("index.html") ? "HTML/CSS/JS" : "";
  const packageManager = pkg
    ? vfs.has("pnpm-lock.yaml") ? "pnpm" : vfs.has("yarn.lock") ? "yarn" : "npm"
    : vfs.has("requirements.txt") || pyLike ? "pip"
    : goLike ? "go" : rustLike ? "cargo" : phpLike || vfs.has("composer.json") ? "composer" : "none";
  const buildTool = deps.includes("vite") || vfs.has("vite.config.ts") || vfs.has("vite.config.js") ? "vite"
    : frameworks.includes("Next.js") ? "next" : tsLike && vfs.has("tsconfig.json") ? "tsc" : "";
  const runtime = pkg || paths.some((p) => p.startsWith("api/") || p.includes("/server/")) ? "node" : pyLike ? "python" : vfs.has("index.html") ? "browser" : "";
  return { language, framework: [...new Set(frameworks)].slice(0, 3).join(" + "), runtime, packageManager, buildTool };
}

/* ——— Import graph ——— */
const IMPORT_RE = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".vue", ".svelte"];
const RESOLVE_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.css"];

function resolveLocal(vfs: VFS, fromFile: string, spec: string): string | null {
  const fromDir = fromFile.split("/").slice(0, -1).join("/");
  const base = (fromDir ? fromDir + "/" : "") + spec;
  const parts: string[] = [];
  for (const seg of base.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const p = parts.join("/");
  for (const ext of RESOLVE_EXTS) if (vfs.has(p + ext)) return p + ext;
  for (const idx of RESOLVE_INDEX) if (vfs.has(p + idx)) return p + idx;
  return null;
}

/* ——— Route detection (express-style, next-style, fastapi/flask, HTML pages) ——— */
const ROUTE_PATTERNS: RegExp[] = [
  /(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  /@(app|router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
  /@route\s*\(\s*['"]([^'"]+)['"]/gi,
  /(?:fetch|axios(?:\.\w+)?)\s*\(\s*['"](\/?api\/[^'"`]+)['"`]/gi,
];

function detectRoutes(vfs: VFS): string[] {
  const routes = new Set<string>();
  for (const p of vfs.paths()) {
    // Next.js-style routes
    const next = p.match(/^(?:src\/)?app\/(.+)\/(page|route)\.[tj]sx?$/);
    if (next) routes.add(`/${next[1]}${next[2] === "route" ? " (api)" : ""}`);
    const content = vfs.read(p)!;
    let m: RegExpExecArray | null;
    for (const re of ROUTE_PATTERNS) {
      const rx = new RegExp(re.source, re.flags);
      while ((m = rx.exec(content)) && routes.size < 40) {
        const path = m[3] ?? m[2] ?? m[1];
        if (path && path.startsWith("/")) routes.add(path);
      }
    }
    if (p.endsWith(".html") && !p.includes("/")) routes.add(`page ${p}`);
  }
  return [...routes].sort().slice(0, 40);
}

function detectModels(vfs: VFS): string[] {
  const out = new Set<string>();
  for (const p of vfs.paths()) {
    if (/schema|model|entity|migration|\.sql$/i.test(p)) {
      const content = vfs.read(p)!;
      let m: RegExpExecArray | null;
      const pats = [
        /model\s+(\w+)\s*\{/g, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/gi,
        /(?:interface|type|class)\s+(\w+)(?:\s*extends|\s*\{)/g, /pgTable\s*\(\s*["'](\w+)["']/g,
        /Schema\s*\(\s*\{[\s\S]{0,40}\}\s*\)/g,
      ];
      for (const re of pats) {
        const rx = new RegExp(re.source, re.flags);
        while ((m = rx.exec(content)) && out.size < 24) if (m[1]) out.add(m[1]);
      }
      if (p.endsWith(".sql") || /schema/i.test(p)) out.add(p);
    }
  }
  return [...out].slice(0, 24);
}

const ENV_RE = /(?:process\.env|import\.meta\.env|os\.environ(?:\.get)?|getenv|env\()\s*(?:\.\s*|\[\s*['"]|\(\s*['"])?([A-Z][A-Z0-9_]{2,})/g;

function detectEnvVars(vfs: VFS): string[] {
  const out = new Set<string>();
  const BUILTIN = new Set(["NODE_ENV", "PATH", "HOME", "PWD", "PORT", "HOSTNAME", "PUBLIC_URL", "CI"]);
  for (const p of vfs.paths()) {
    const content = vfs.read(p)!;
    let m: RegExpExecArray | null;
    const rx = new RegExp(ENV_RE.source, "g");
    while ((m = rx.exec(content)) && out.size < 32) {
      if (m[1] && !BUILTIN.has(m[1])) out.add(m[1]);
    }
    if (/^\.env(\.|$)/.test(p) && !p.includes("example")) {
      for (const line of content.split("\n")) {
        const key = line.match(/^([A-Z][A-Z0-9_]{2,})\s*=/)?.[1];
        if (key) out.add(key);
      }
    }
  }
  return [...out].sort();
}

function detectEntryPoints(vfs: VFS): string[] {
  const found: string[] = [];
  const candidates = [
    "index.html", "public/index.html", "src/index.html", "src/main.ts", "src/main.tsx", "src/main.js",
    "src/index.ts", "src/index.tsx", "src/index.js", "src/App.tsx", "src/App.jsx", "app/page.tsx",
    "src/app/page.tsx", "pages/index.tsx", "server.ts", "server.js", "src/server.ts", "index.js",
    "index.ts", "main.py", "app.py", "main.go", "cmd/main.go", "src/main.rs", "src/lib.rs", "index.php",
  ];
  for (const c of candidates) if (vfs.has(c)) found.push(c);
  return found.slice(0, 8);
}

/** Compute the full internal architecture representation. */
export function analyzeArchitecture(vfs: VFS): ArchitectureMap {
  const modules: ArchitectureMap["modules"] = [];
  let edges = 0;
  for (const p of vfs.paths()) {
    const lang = languageOf(p);
    const content = vfs.read(p)!;
    const isCode = ["typescript", "tsx", "javascript", "jsx", "python", "go", "rust", "vue", "svelte", "php"].includes(lang);
    let imports = 0;
    const localDeps: string[] = [];
    if (isCode) {
      let m: RegExpExecArray | null;
      const rx = new RegExp(IMPORT_RE.source, "g");
      while ((m = rx.exec(content))) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (!spec) continue;
        imports++;
        if (spec.startsWith(".")) {
          const resolved = resolveLocal(vfs, p, spec);
          if (resolved) {
            edges++;
            localDeps.push(resolved);
          }
        }
      }
    }
    const symbols = extractSymbols(p, content);
    if (isCode || symbols.length) {
      modules.push({ path: p, symbols: symbols.slice(0, 10), imports });
    }
  }
  return {
    stack: detectStack(vfs),
    entryPoints: detectEntryPoints(vfs),
    routes: detectRoutes(vfs),
    models: detectModels(vfs),
    envVars: detectEnvVars(vfs),
    modules: modules.sort((a, b) => b.imports - a.imports).slice(0, 60),
    files: vfs.paths().length,
    bytes: vfs.totalBytes(),
    edges,
  };
}

/** Compact text rendering of the architecture map for prompts. */
export function describeArchitecture(map: ArchitectureMap, maxChars = 2600): string {
  const lines: string[] = [];
  lines.push(`stack détectée: ${map.stack.language}${map.stack.framework ? " + " + map.stack.framework : ""} (runtime ${map.stack.runtime || "?"}, pm ${map.stack.packageManager}, build ${map.stack.buildTool || "aucun"})`);
  if (map.entryPoints.length) lines.push(`points d'entrée: ${map.entryPoints.join(", ")}`);
  if (map.routes.length) lines.push(`routes/pages: ${map.routes.slice(0, 20).join(" | ")}`);
  if (map.models.length) lines.push(`modèles de données: ${map.models.slice(0, 16).join(", ")}`);
  if (map.envVars.length) lines.push(`variables d'environnement utilisées: ${map.envVars.join(", ")}`);
  lines.push("modules (path: exports):");
  for (const mod of map.modules.slice(0, 40)) {
    lines.push(`- ${mod.path}${mod.symbols.length ? `: ${mod.symbols.join(", ")}` : ""}`);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n…";
  return out;
}

/* ------------------------------------------------------------------ */
/*  Project memory — ARCHITECTURE.md / DECISIONS.md, regenerated from  */
/*  REAL state and consulted by the agent on every iteration.          */
/* ------------------------------------------------------------------ */

export function renderArchitectureDoc(map: ArchitectureMap, opts: { name: string; description?: string; scripts?: Record<string, string>; features?: string[] }): string {
  const L: string[] = [];
  L.push(`# ARCHITECTURE — ${opts.name}`, "");
  if (opts.description) L.push(opts.description, "");
  L.push(`> Mis à jour automatiquement par CodeForge depuis l'état réel du projet (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC).`);
  L.push("", "## Stack détectée", "");
  L.push(`- Langage : ${map.stack.language || "?"}`);
  if (map.stack.framework) L.push(`- Framework : ${map.stack.framework}`);
  if (map.stack.runtime) L.push(`- Runtime : ${map.stack.runtime}`);
  if (map.stack.packageManager && map.stack.packageManager !== "none") L.push(`- Package manager : ${map.stack.packageManager}`);
  if (map.stack.buildTool) L.push(`- Build : ${map.stack.buildTool}`);
  if (opts.scripts && Object.keys(opts.scripts).length) {
    L.push("", "## Commandes", "");
    for (const [k, v] of Object.entries(opts.scripts)) L.push(`- \`npm run ${k}\` → \`${v}\``);
  }
  if (map.entryPoints.length) L.push("", "## Points d'entrée", "", ...map.entryPoints.map((p) => `- \`${p}\``));
  if (map.routes.length) L.push("", "## Routes & pages détectées", "", ...map.routes.map((r) => `- \`${r}\``));
  if (map.models.length) L.push("", "## Modèles de données", "", ...map.models.map((m) => `- ${m}`));
  if (map.envVars.length) L.push("", "## Variables d'environnement", "", ...map.envVars.map((v) => `- \`${v}\` (documentée dans .env.example — jamais de valeur réelle)`));
  if (opts.features?.length) L.push("", "## Fonctionnalités", "", ...opts.features.map((f) => `- ${f}`));
  L.push("", "## Modules (exports principaux)", "");
  for (const m of map.modules.slice(0, 50)) L.push(`- \`${m.path}\`${m.symbols.length ? ` — ${m.symbols.join(", ")}` : ""}`);
  L.push("", `_Graphe d'import : ${map.edges} liaison(s) interne(s) · ${map.files} fichier(s) · ${(map.bytes / 1024).toFixed(1)} Ko_`, "");
  return L.join("\n");
}

export function appendDecisions(existing: string | null, decisions: { topic: string; choice: string; why: string }[], contextLine: string): string {
  const date = new Date().toISOString().slice(0, 10);
  let base = existing ?? `# DÉCISIONS TECHNIQUES\n\n> Journal des choix — CodeForge le consulte avant chaque modification.\n`;
  if (!decisions.length && !contextLine) return base;
  const bullets: string[] = [];
  for (const d of decisions.slice(0, 12)) {
    const line = `- **${d.topic}** → ${d.choice}${d.why ? ` — ${d.why}` : ""}`;
    if (!base.includes(line)) bullets.push(line);
  }
  if (contextLine && !base.includes(contextLine)) bullets.push(`- ${contextLine}`);
  if (!bullets.length) return base;
  const hasSection = base.includes(`## ${date}`);
  if (!hasSection) base += `\n## ${date}\n\n`;
  return base.trimEnd() + "\n" + bullets.join("\n") + "\n";
}

export function excerptMemory(vfs: VFS, maxChars = 1500): string {
  const parts: string[] = [];
  const decisions = vfs.read("DECISIONS.md");
  if (decisions) parts.push(decisions.slice(-maxChars));
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/*  .env.example — always generated deterministically, never with      */
/*  real values. Real secrets are refused.                             */
/* ------------------------------------------------------------------ */

const SECRET_VALUE_RE = /^(sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN)/;

export function buildEnvExample(vfs: VFS, envHints: { name: string; purpose: string; required: boolean }[]): { content: string; leaked: string[] } {
  const used = detectEnvVars(vfs);
  const names = new Map<string, { purpose: string; required: boolean }>();
  for (const n of used) names.set(n, { purpose: "", required: false });
  for (const h of envHints) {
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(h.name)) names.set(h.name, { purpose: h.purpose, required: h.required });
  }
  const leaked: string[] = [];
  // Scan committed .env files for real-looking secrets — refuse to propagate them
  for (const p of vfs.paths()) {
    if (/^\.env(\.|$)/.test(p) && !p.includes("example")) {
      for (const line of vfs.read(p)!.split("\n")) {
        const m = line.match(/^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+)$/);
        if (m && SECRET_VALUE_RE.test(m[2].trim())) leaked.push(m[1]);
        if (m) names.set(m[1], names.get(m[1]) ?? { purpose: "", required: false });
      }
    }
  }
  if (!names.size) return { content: "", leaked };
  const lines = ["# Variables d'environnement — copier vers .env et renseigner.", "# Généré par CodeForge depuis l'usage réel dans le code.", ""];
  for (const [name, meta] of [...names.entries()].sort()) {
    if (meta.purpose) lines.push(`# ${meta.purpose}${meta.required ? " (requis)" : ""}`);
    else if (meta.required) lines.push("# (requis)");
    lines.push(`${name}=`);
    lines.push("");
  }
  return { content: lines.join("\n"), leaked };
}
