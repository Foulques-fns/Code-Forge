import { breakerInfo, getActiveProvider, reportProviderFailure, reportProviderSuccess } from "./providers";
import type {
  ChatMessage,
  FileSummary,
  Issue,
  ModificationPlan,
  ProjectPlan,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Shared system prompt — project-agnostic by design.                 */
/*  There is deliberately NO catalog of app types here: the model      */
/*  invents the architecture from the request, every time.             */
/* ------------------------------------------------------------------ */

const SYSTEM = `You are CodeForge, an autonomous senior software engineer that designs and builds complete, real, working software from scratch — to the standard of a paid professional delivery, never a demo.

Absolute rules:
- You INVENT the architecture for each request. Never assume a fixed project type; derive the stack, file tree and features from the request itself.
- Write COMPLETE, runnable code. Never output placeholders such as "TODO", "implement later", "add logic here", "code omitted", or truncated endings.
- REAL, never fake: every button, link, form, search, filter, modal and menu must actually DO something wired to the app's logic. Forbidden in all deliverables: "coming soon", alerts-as-features, dead href="#", decorative-only controls, pretend-auth, pretend-persistence, fake data presented as dynamic, simulated APIs when a real one is expected.
- Real assets: never hotlink placeholder image services (placehold.co, dummyimage, picsum...). When visuals are needed, DESIGN them — inline SVG illustrations/icons you actually draw (interesting, not grey boxes), CSS art, or generated local assets.
- Craft matters: deliberate request-specific art direction (palette, typography pairing, spacing scale — NOT the same violet-blue gradient every time), consistent design tokens, meaningful animations (keyframes/WAAPI/canvas when motion is requested — implemented, not just "transition: all"), responsive mobile/tablet/desktop, loading/empty/error states, basic accessibility (labels, focus, semantic roles), favicon (local SVG icon you design), <title> and meta description on every HTML page.
- Every relative import must target a file that exists in the plan. Keep names, exports and APIs perfectly consistent across files.
- If the user demands a specific technology, use exactly that. Otherwise choose the simplest coherent stack that fits the request (plain HTML/CSS/JS is often best for small browser apps).
- Follow the output contract of each task EXACTLY (raw code only, or raw JSON only). Never add markdown fences, comments about your reasoning, or explanations outside the contract.`;

const FORBIDDEN_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|vendor\/bundle|__pycache__)(\/|$)/;
const FORBIDDEN_PATH = /(\.\.(\/|$))|(^\/)/;

export function sanitizePath(p: string): string | null {
  const clean = p.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+/g, "/");
  if (!clean || clean.length > 200 || clean.includes("\0")) return null;
  if (FORBIDDEN_PATH.test(clean)) return null;
  if (FORBIDDEN_DIRS.test(clean)) return null;
  if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp[34]|avi|mov|zip|exe|dll|so|bin|pdf)$/i.test(clean)) return null;
  return clean;
}

/* ------------------------------------------------------------------ */
/*  Output parsing helpers                                             */
/* ------------------------------------------------------------------ */

function tryParse(t: string): unknown | null {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Balance-aware closer: appends quotes/brackets needed to close an open JSON value. */
function closeJson(fragment: string): string {
  let depthObj = 0, depthArr = 0, inStr = false, esc = false;
  for (const c of fragment) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depthObj++;
    else if (c === "}") depthObj--;
    else if (c === "[") depthArr++;
    else if (c === "]") depthArr--;
  }
  let out = fragment.replace(/,\s*$/, "");
  if (inStr) out += '"';
  out += "]".repeat(Math.max(0, depthArr)) + "}".repeat(Math.max(0, depthObj));
  return out;
}

function extractJson(text: string): unknown {
  const direct = tryParse(text.trim());
  if (direct !== null) return direct;
  const start = text.indexOf("{");
  if (start === -1) throw new Error("La réponse du moteur ne contient pas de JSON.");
  // Bracket scan that respects strings to find the full object
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const candidate = end !== -1 ? text.slice(start, end + 1) : text.slice(start);
  const quick = tryParse(candidate) ?? tryParse(candidate.replace(/,\s*([}\]])/g, "$1"));
  if (quick !== null) return quick;
  // Robust truncation repair: walk back to each '}' / ']' / '"' boundary, close, retry
  const closers: number[] = [];
  for (let i = candidate.length - 1; i >= 0 && closers.length < 260; i--) {
    if (candidate[i] === "}" || candidate[i] === "]") closers.push(i);
  }
  for (const cut of closers) {
    const frag = candidate.slice(0, cut + 1);
    const fixed = closeJson(frag);
    const parsed = tryParse(fixed) ?? tryParse(fixed.replace(/,\s*([}\]])/g, "$1"));
    if (parsed !== null) return parsed;
  }
  // Last resort: cut at last complete key-value boundary ("...",)
  const lastComma = candidate.lastIndexOf('",');
  if (lastComma > 0) {
    const fixed = closeJson(candidate.slice(0, lastComma + 1));
    const parsed = tryParse(fixed);
    if (parsed !== null) return parsed;
  }
  throw new Error("JSON invalide ou tronqué renvoyé par le moteur.");
}

export function stripCodeFences(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/);
  if (fence) t = fence[1];
  // Some models prefix commentary before the fence: keep the largest fenced block
  if (/```[\w-]*\s*\n/.test(t) && !t.startsWith("```")) {
    const all = [...t.matchAll(/```[\w-]*\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
    if (all.length) t = all.sort((a, b) => b.length - a.length)[0];
  }
  return t.replace(/^\s*```[\w-]*\s*/m, "").replace(/```\s*$/m, "");
}

/* ------------------------------------------------------------------ */
/*  Core completion wrapper                                            */
/* ------------------------------------------------------------------ */

/** Transparency hook: the UI must never be left guessing while we retry or
 *  switch engines. The orchestrator subscribes and turns this into events. */
export type EngineNotice = { attempt: number; tries: number; engine: string; error: string; switching: boolean; waitMs: number };
type EngineListener = (n: EngineNotice) => void;
let engineListener: EngineListener | null = null;
export function setEngineListener(fn: EngineListener | null) {
  engineListener = fn;
}

/**
 * One completion, with RUNTIME FAILOVER: each attempt re-resolves the best
 * available engine (skipping any whose circuit breaker is open), so a provider
 * incident mid-run automatically switches to another free engine.
 */
async function complete(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number; tries?: number; signal?: AbortSignal } = {}) {
  const payload: ChatMessage[] = [{ role: "system", content: SYSTEM }, ...messages];
  const tries = opts.tries ?? 6;
  let lastErr: unknown = null;
  let lastEngine = "";

  for (let attempt = 1; attempt <= tries; attempt++) {
    if (opts.signal?.aborted) throw new Error("Annulé par l'utilisateur");

    // Re-detect when every known engine is cooling down (incidents recover).
    const allCooling = attempt > 1;
    const engine = await getActiveProvider(allCooling && attempt % 3 === 1);
    if (!engine) {
      lastErr = new Error("Aucun moteur IA disponible pour le moment.");
      await sleep(6000, opts.signal);
      continue;
    }
    lastEngine = engine.status.label;
    try {
      const res = await engine.provider.complete(payload, opts);
      if (res.reasoningStarved || !res.text.trim()) {
        // The model thought until its budget ran out and returned nothing.
        // Not a provider outage: rotate quickly, don't open the breaker.
        lastErr = new Error(`Le modèle ${res.model} a épuisé son budget de raisonnement sans produire de contenu.`);
        engineListener?.({ attempt, tries, engine: engine.status.label, error: "contenu vide (budget de raisonnement épuisé)", switching: true, waitMs: 1200 });
        if (opts.signal?.aborted) throw new Error("Annulé par l'utilisateur");
        await sleep(1200, opts.signal);
        continue;
      }
      reportProviderSuccess(engine.provider.id);
      return res;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : "erreur inconnue";
      if (opts.signal?.aborted) throw new Error("Annulé par l'utilisateur");
      // User cancellation is not a provider fault
      if (/Annulé par l'utilisateur/i.test(msg)) throw e;
      reportProviderFailure(engine.provider.id, e);
      // A dead engine is set aside: next attempt picks another one quickly.
      const switched = breakerInfo(engine.provider.id).open;
      const waitMs = switched ? 1500 : 4000 * Math.min(4, attempt);
      engineListener?.({
        attempt,
        tries,
        engine: engine.status.label,
        error: msg.slice(0, 160),
        switching: switched,
        waitMs,
      });
      await sleep(waitMs, opts.signal);
    }
  }
  throw new Error(
    `Tous les moteurs IA gratuits ont échoué après ${tries} tentatives (dernier : ${lastEngine || "?"}). ` +
      `Dernière erreur : ${lastErr instanceof Error ? lastErr.message.slice(0, 200) : "inconnue"}. ` +
      `Il s'agit d'un incident côté fournisseur — relancez la génération, CodeForge réessaiera automatiquement.`
  );
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Annulé par l'utilisateur"));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/* ------------------------------------------------------------------ */
/*  1. PLANNING — invent the project from the request                  */
/* ------------------------------------------------------------------ */

export async function planProject(request: string, maxFiles: number, signal?: AbortSignal): Promise<ProjectPlan> {
  const schema = `{
  "name": "kebab-case project name",
  "description": "2-3 sentences describing what the project does",
  "summary": "one short sentence",
  "stack": {
    "language": "TypeScript / JavaScript / Python / Go / Rust / PHP / SQL...",
    "framework": "React / Vue / Svelte / Next.js / Express / FastAPI / Flask / ... or empty",
    "runtime": "browser | node | python | other",
    "packageManager": "npm | pip | cargo | go | composer | none",
    "buildTool": "vite | tsc | next | none | ...",
    "styling": "css | tailwind | scss | none"
  },
  "features": ["concrete feature actually implemented", "..."],
  "architecture": "paragraph: chosen architecture and WHY it fits this exact request (frontend/backend/db/api split)",
  "phases": [
    { "id": "p1", "title": "Configuration & socle", "goal": "what this stage establishes", "files": ["paths generated in this stage"] }
  ],
  "decisions": [{ "topic": "persistance | auth | état | rendu...", "choice": "what was chosen", "why": "reason tied to the request" }],
  "env": [{ "name": "DATABASE_URL", "purpose": "connexion PostgreSQL", "required": true }],
  "verify": { "install": true, "devCmd": "npm run dev", "buildCmd": "npm run build", "testCmd": "npm test" },
  "files": [{ "path": "relative/path.ext", "purpose": "what this file contains and why" }],
  "dependencies": { "pkg": "^1.0.0" },
  "devDependencies": { "pkg": "^1.0.0" },
  "scripts": { "dev": "...", "build": "...", "start": "...", "test": "..." },
  "previewable": true
}`;
  const user = `User request (verbatim):
"""
${request}
"""

Act as a staff engineer. FIRST analyse the request deeply (project type, data, relations, auth needs, storage, pages, APIs, security, tests), THEN design the project, THEN output ONE JSON object matching EXACTLY the shape below (raw JSON, no markdown):
${schema}

Hard constraints:
- Phases: order the build like a real developer (configuration/base → data models & schema → backend/API & business logic → frontend/UI → integration → tests). The number of phases is YOURS: 2-3 for a tiny tool, as many as needed (up to 8) for a complex system. Every planned file belongs to exactly one phase; "files" stays the flat authoritative list.
- Between 3 and ${maxFiles} files. Use them for REAL substance: models, migrations/schema, API routes with validation, business services, UI with loading/empty/error states, auth when requested (hashed passwords, sessions/JWT best practice), tests for critical logic. Do NOT pad with filler files.
- Do NOT include package.json (synthesized automatically from your dependencies/scripts) and do NOT include README.md (written at the end from the real final state).
- Include every other file needed to install and run: entry points, configuration (tsconfig, vite.config, next.config, requirements.txt, Dockerfile when relevant...), source, styles, tests, .gitignore. If the code reads environment variables, they MUST appear in "env" (never include real secret values anywhere).
- Quality bar: TypeScript typed strictly (no lazy "any"), small focused files and functions, explicit names, separation of concerns, input validation, proper error handling, no dead code, no placeholder ("TODO") code anywhere. Every interactive UI element must actually work.
- Security: validate/sanitize inputs server-side, hash credentials, never hardcode secrets, parameterize SQL, protect mutating routes when auth exists.
- FULL-STACK autonomy rule: unless the user demands a hosted service, prefer a stack that runs with NOTHING but "npm install && npm run dev" — e.g. SQLite via better-sqlite3 (or Prisma+sqlite) for persistence, sessions/JWT in-house. External infra (hosted Postgres, Redis, S3...) only when the request truly needs it; then model it and document it in "env". Never fake persistence: data must hit a real database or real files.
- When demo data makes sense, ship a real, runnable seed script (e.g. scripts/seed or prisma seed) instead of hardcoded arrays.
- When the user requests payments/mails/external APIs you cannot fully realise without secrets, implement the REAL integration code behind env vars (declared in "env") and say so honestly in architecture — never fake the integration.
- PWA on request: real manifest + real service worker with a real caching strategy. Mobile on request: a real project for the chosen stack (Expo/React Native, Flutter, Capacitor...), not a resized web page.
- Craft plan: every web project must include its design foundation in "files" — a tokens/design-system file (colors, type, spacing, radius, shadows specific to THIS request's mood), a locally-drawn SVG favicon, and local SVG visual assets when the UI needs imagery. Animations get their own concrete implementation (css/animations file or a canvas/WAAPI module when requested). Name them for the project.
- "dependencies"/"scripts" must be real, minimal and sufficient — plausible recent versions, nothing gratuitous. Provide a "test" script when tests exist; "verify.install" is true for package-managed stacks.
- Set "previewable": true ONLY for a static browser app opened directly via its HTML page (no server, no build).
- This is NOT a template: name files/structures specifically for THIS request. Two different requests must yield two different architectures.`;

  // 9k tokens is plenty for a real plan JSON and halves latency on free gateways.
  const r = await complete([{ role: "user", content: user }], { temperature: 0.3, signal, maxTokens: 9_000, tries: 8 });
  const raw = extractJson(r.text) as Partial<ProjectPlan>;

  const files: ProjectPlan["files"] = [];
  const seen = new Set<string>();
  const isNode = (raw.stack?.packageManager ?? "none") !== "none" && ["npm", "yarn", "pnpm", "bun"].includes(raw.stack?.packageManager ?? "");
  for (const f of Array.isArray(raw.files) ? raw.files : []) {
    const path = sanitizePath(String(f?.path ?? ""));
    if (!path || seen.has(path)) continue;
    if (path === "package.json" || /^readme(\..+)?$/i.test(path)) continue;
    if (isNode && path === "README.md") continue;
    seen.add(path);
    files.push({ path, purpose: String(f?.purpose ?? "").slice(0, 400) });
    if (files.length >= maxFiles) break;
  }
  if (files.length === 0) throw new Error("Le plan généré ne contient aucun fichier exploitable.");

  const strMap = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (v && typeof v === "object") for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === "string") out[k] = val;
    return out;
  };

  // — phases: sanitized; deterministic fallback derived from file kinds —
  const validPaths = new Set(files.map((f) => f.path));
  let phases: ProjectPlan["phases"] = [];
  if (Array.isArray(raw.phases)) {
    for (const [i, ph] of raw.phases.entries()) {
      const phFiles = (Array.isArray(ph?.files) ? ph.files : []).map((x) => sanitizePath(String(x))).filter((x): x is string => !!x && validPaths.has(x));
      if (!phFiles.length) continue;
      phases.push({ id: String(ph?.id ?? `p${i + 1}`), title: String(ph?.title ?? `Phase ${i + 1}`).slice(0, 80), goal: String(ph?.goal ?? "").slice(0, 240), files: phFiles });
    }
  }
  const covered = new Set(phases.flatMap((p) => p.files));
  const leftovers = files.filter((f) => !covered.has(f.path)).map((f) => f.path);
  if (!phases.length) {
    phases = [{ id: "p1", title: "Construction complète", goal: "Génération de tous les fichiers du projet", files: files.map((f) => f.path) }];
  } else if (leftovers.length) {
    phases[phases.length - 1].files.push(...leftovers);
  }

  const decisions: ProjectPlan["decisions"] = (Array.isArray(raw.decisions) ? raw.decisions : [])
    .map((d) => ({ topic: String(d?.topic ?? "").slice(0, 60), choice: String(d?.choice ?? "").slice(0, 140), why: String(d?.why ?? "").slice(0, 200) }))
    .filter((d) => d.topic && d.choice)
    .slice(0, 10);

  const env: ProjectPlan["env"] = (Array.isArray(raw.env) ? raw.env : [])
    .map((e) => ({ name: String(e?.name ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 60), purpose: String(e?.purpose ?? "").slice(0, 140), required: e?.required === true }))
    .filter((e) => /^[A-Z][A-Z0-9_]{2,}$/.test(e.name))
    .slice(0, 24);

  const scripts = strMap(raw.scripts);
  const verify: ProjectPlan["verify"] = {
    install: raw.verify?.install !== false,
    devCmd: String(raw.verify?.devCmd ?? scripts.dev ?? "").slice(0, 120),
    buildCmd: String(raw.verify?.buildCmd ?? scripts.build ?? "").slice(0, 120),
    testCmd: String(raw.verify?.testCmd ?? scripts.test ?? "").slice(0, 120),
  };

  return {
    name: String(raw.name ?? "codeforge-project").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "codeforge-project",
    description: String(raw.description ?? ""),
    summary: String(raw.summary ?? ""),
    stack: {
      language: String(raw.stack?.language ?? ""),
      framework: String(raw.stack?.framework ?? ""),
      runtime: String(raw.stack?.runtime ?? "browser"),
      packageManager: String(raw.stack?.packageManager ?? "none"),
      buildTool: String(raw.stack?.buildTool ?? ""),
      styling: String(raw.stack?.styling ?? ""),
    },
    features: Array.isArray(raw.features) ? raw.features.map((f) => String(f)).slice(0, 24) : [],
    architecture: String(raw.architecture ?? ""),
    phases,
    decisions,
    env,
    verify,
    files,
    dependencies: strMap(raw.dependencies),
    devDependencies: strMap(raw.devDependencies),
    scripts,
    previewable: raw.previewable === true,
  };
}

/* ------------------------------------------------------------------ */
/*  2. FILE GENERATION — one real file at a time, with context         */
/* ------------------------------------------------------------------ */

export async function generateFile(opts: {
  plan: ProjectPlan;
  target: { path: string; purpose: string };
  phase?: { title: string; goal: string };
  archContext?: string;
  index: FileSummary[];
  generated: { path: string; exports: string[] }[];
  modificationContext?: { request: string; currentContent?: string };
  signal?: AbortSignal;
}): Promise<string> {
  const { plan, target, index, generated, signal, phase, archContext } = opts;
  const others = index
    .filter((f) => f.path !== target.path)
    .slice(0, 80)
    .map((f) => {
      const gen = generated.find((g) => g.path === f.path);
      return `- ${f.path} — ${f.purpose}${gen?.exports.length ? ` (exports: ${gen.exports.slice(0, 12).join(", ")})` : f.exports.length ? ` (exports: ${f.exports.slice(0, 10).join(", ")})` : ""}`;
    })
    .join("\n");

  const briefPlan = JSON.stringify({
    name: plan.name,
    description: plan.description,
    stack: plan.stack,
    features: plan.features,
    dependencies: plan.dependencies,
    devDependencies: plan.devDependencies,
    scripts: plan.scripts,
    ...(plan.env.length ? { env: plan.env } : {}),
  });

  const mod = opts.modificationContext;
  const task = mod
    ? `The project ALREADY EXISTS. The user asked: "${mod.request}". Rewrite the file below so the project fulfils that request while keeping everything else consistent and WITHOUT breaking any existing feature.${
        mod.currentContent != null
          ? `\nCurrent content of ${target.path}:\n<<<CURRENT\n${mod.currentContent.slice(0, 90000)}\nCURRENT>>>`
          : `\nThe file ${target.path} must be created from scratch.`
      }`
    : `Write the file "${target.path}".\nIts role: ${target.purpose}${phase ? `\nBuild stage: "${phase.title}" — ${phase.goal}` : ""}`;

  const user = `Project plan (JSON):
${briefPlan}
${archContext ? `\nLive architecture map of the project (deterministic, authoritative):\n${archContext}\n` : ""}
Complete file index ${mod ? "(current project)" : "(files of this project)"}:
${others || "(none yet)"}

${task}

Engineering bar for THIS file: complete implementation; strict typing (no lazy "any"); small helpers instead of one giant block; validate and sanitize inputs at boundaries; handle errors explicitly; when UI: include loading/empty/error states, make EVERY control functional and responsive, wire interactions to real logic, use the project's design tokens, implement animations concretely; when backend: sanitize, authenticate/authorize where the project has auth, parameterized queries only; exact import paths matching the index above (files listed with "exports:" are already written — import only what they export).
If this file is the HTML entry page: include <title>, meta description, a <link rel="icon"> pointing to a local SVG favicon (create/design it in its own file if needed), semantic landmarks, and make sure every <a>/<button> on the page is wired to real behaviour. If the page shows imagery, draw meaningful inline/local SVG art for this project's subject instead of any external image URL.

Output contract: output the COMPLETE FINAL content of ${target.path} and nothing else. No markdown fences, no leading explanation, no trailing notes. The file must be internally coherent with every other file listed above.`;

  const r = await complete([{ role: "user", content: user }], { temperature: 0.25, signal, maxTokens: 16_000 });
  const content = stripCodeFences(r.text);
  if (!content.trim()) throw new Error(`Le moteur a renvoyé un fichier vide pour ${target.path}`);
  return content.endsWith("\n") ? content : content + "\n";
}

/* ------------------------------------------------------------------ */
/*  3. AUTO-FIX — repair a file using real validator diagnostics       */
/* ------------------------------------------------------------------ */

const FIX_GUIDANCE: Partial<Record<Issue["kind"], string>> = {
  syntax: "Syntax error: locate the exact token/line flagged by the parser and repair the grammar without changing behaviour.",
  typescript: "TypeScript type error: fix the types or the value, NOT by casting to any. Align signatures with the exporting file.",
  "missing-file": "An import/reference points to a file that does not exist: either rewrite the import to target the correct existing file in the index, or inline the needed logic. Only reference files in the index.",
  "missing-dependency": "A module is imported but not declared: if a relative file was meant, fix the path; otherwise keep the import identical — the dependency will be declared separately in package.json.",
  placeholder: "Placeholder code detected: implement the missing logic completely. No TODOs allowed.",
  html: "HTML resource missing: correct the src/href to point at a file that actually exists in the index.",
  package: "package.json coherence: fix scripts/deps so install/build can run.",
  config: "Configuration problem: fix the config value; required env vars must be documented via .env.example, never hardcoded.",
  route: "Route/API mismatch: align the backend route and the frontend caller (method, path, payload shape).",
  build: "Error surfaced by the real build tool: read the diagnostic carefully and fix the root cause in this file.",
  test: "A real test failed: fix the implementation or the test so the expectation is genuinely satisfied — never delete the assertion to pass.",
  runtime: "Runtime error: fix the faulty code path (undefined access, wrong assumptions...).",
  quality: "FAKE/mock marker or missing realness requirement: implement the feature FOR REAL (never 'coming soon', no dead link, no decorative-only control, no external placeholder image service — design real local SVG assets instead). A professional client would reject this.",
  consistency: "Cross-file inconsistency: align names, exports, and call signatures with the rest of the project.",
  "generation-failed": "This file failed to generate: write it completely now.",
  json: "Invalid JSON: output strictly valid JSON for this file.",
};

export async function fixFile(opts: {
  plan: ProjectPlan | null;
  path: string;
  content: string;
  issues: Issue[];
  index: FileSummary[];
  archContext?: string;
  buildLogTail?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { plan, path, content, issues, index, signal, archContext, buildLogTail } = opts;
  const diag = issues.map((i) => `- [${i.kind}] ${i.message}`).join("\n");
  const guidance = [...new Set(issues.map((i) => FIX_GUIDANCE[i.kind]).filter(Boolean))].join("\n");
  const others = index
    .filter((f) => f.path !== path)
    .slice(0, 60)
    .map((f) => `- ${f.path}${f.exports.length ? ` (exports: ${f.exports.slice(0, 10).join(", ")})` : ""}`)
    .join("\n");

  const user = `You must repair the file "${path}" of project "${plan?.name ?? "unknown"}".

Validator diagnostics (REAL, produced by parsers/tooling — not guesses):
${diag}

Repair strategy per category:
${guidance}
${archContext ? `\nArchitecture map (authoritative):\n${archContext}\n` : ""}
Other files in the project (their exports are the source of truth for imports):
${others}
${buildLogTail ? `\nTail of the REAL tool output:\n<<<LOG\n${buildLogTail.slice(0, 2400)}\nLOG>>>` : ""}

Current broken content of ${path}:
<<<FILE
${content.slice(0, 90000)}
FILE>>>

Output contract: output the COMPLETE CORRECTED content of ${path} (the entire file, fixed), nothing else. No markdown fences, no commentary. Fix every diagnostic while preserving all working behaviour and every existing feature.`;

  const r = await complete([{ role: "user", content: user }], { temperature: 0.15, signal, maxTokens: 16_000 });
  const fixed = stripCodeFences(r.text);
  if (!fixed.trim()) throw new Error(`Correction vide pour ${path}`);
  return fixed.endsWith("\n") ? fixed : fixed + "\n";
}

/* ------------------------------------------------------------------ */
/*  4. MODIFICATION PLANNING — surgical edits to an existing project   */
/* ------------------------------------------------------------------ */

export async function planModification(
  request: string,
  index: FileSummary[],
  samples: { path: string; content: string }[],
  archContext: string,
  previousIssues: { file: string | null; message: string }[],
  signal?: AbortSignal
): Promise<ModificationPlan> {
  const idx = index.map((f) => `- ${f.path} — ${f.purpose || ""} [${f.lines} lignes]${f.exports.length ? ` exports: ${f.exports.slice(0, 10).join(", ")}` : ""}`).join("\n");
  const smp = samples
    .map((s) => `<<<FILE ${s.path}\n${s.content.slice(0, 9000)}\nFILE>>>`)
    .join("\n\n");

  const user = `An existing project must be MODIFIED surgically (NEVER rewritten from scratch, NEVER lose existing features).

User request (verbatim):
"""
${request}
"""

DETECTED architecture of the current project (deterministic — respect the existing stack; do NOT introduce a different framework than the one detected unless the user explicitly asks):
${archContext}

Project file index:
${idx}

Key file excerpts:
${smp || "(project currently empty — plan a full build instead)"}
${previousIssues.length ? `\nKnown unresolved problems from the previous run (fix them too when touched):\n${previousIssues.slice(0, 8).map((i) => `- ${i.file ?? "?"}: ${i.message}`).join("\n")}` : ""}

Think like the maintainer of THIS codebase: which files must change, which new files are needed (new route? new model? new component? new dependency — declare it by updating package.json via an "update" op), which can be left untouched. Preserve every existing working feature.

Decide the MINIMAL set of operations. Output ONE JSON object, no markdown:
{
  "analysis": "what the request implies and where it touches the project",
  "operations": [
    { "op": "create|update|delete|move", "path": "existing-or-new/path", "newPath": "only for move", "purpose": "why and what changes" }
  ],
  "summary": "one sentence for the user"
}
Rules: prefer "update" over rewriting many files; only touch what the request requires; when adding a capability that needs a library, include an "update" op on package.json; if the project is empty, "create" the files a new build needs.`;

  const r = await complete([{ role: "user", content: user }], { temperature: 0.25, signal, maxTokens: 10_000, tries: 8 });
  const raw = extractJson(r.text) as Partial<ModificationPlan>;
  const ops: ModificationPlan["operations"] = [];
  const seen = new Set<string>();
  for (const o of Array.isArray(raw.operations) ? raw.operations : []) {
    const path = sanitizePath(String(o?.path ?? ""));
    if (!path) continue;
    const op = String(o?.op ?? "update");
    if (!["create", "update", "delete", "move"].includes(op)) continue;
    const key = `${op}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ops.push({ op: op as ModificationPlan["operations"][number]["op"], path, newPath: o?.newPath ? sanitizePath(String(o.newPath)) ?? undefined : undefined, purpose: String(o?.purpose ?? "").slice(0, 400) });
    if (ops.length >= 40) break;
  }
  if (!ops.length) throw new Error("Le moteur n'a proposé aucune modification interprétable.");
  return { analysis: String(raw.analysis ?? ""), operations: ops, summary: String(raw.summary ?? "") };
}

/* ------------------------------------------------------------------ */
/*  5. README — written from the REAL final state of the project       */
/* ------------------------------------------------------------------ */

export async function writeReadme(opts: {
  plan: ProjectPlan | null;
  name: string;
  seedRequest: string;
  index: FileSummary[];
  validation: { checked: boolean; errors: number; warnings: number; cycles: number };
  signal?: AbortSignal;
}): Promise<string> {
  const { plan, name, index, signal } = opts;
  const treeLines = index
    .slice(0, 120)
    .map((f) => `${f.path} — ${f.purpose}`)
    .join("\n");
  const user = `Write the README.md for the project "${name}" described below. It must document THIS REAL project only.

Project:
- name: ${name}
- description: ${plan?.description ?? ""}
- original user request: """${opts.seedRequest.slice(0, 600)}"""
- stack: ${JSON.stringify(plan?.stack ?? {})}
- features: ${(plan?.features ?? []).join("; ")}
- scripts: ${JSON.stringify(plan?.scripts ?? {})}
- dependencies: ${Object.keys(plan?.dependencies ?? {}).join(", ") || "aucune"}
- devDependencies: ${Object.keys(plan?.devDependencies ?? {}).join(", ") || "aucune"}
- packageManager: ${plan?.stack?.packageManager ?? "none"}

Real file tree with purposes:
${treeLines}

Honesty block (must appear, adapted): syntax validation was ${opts.validation.checked ? `run by CodeForge (${opts.validation.errors} remaining error(s), ${opts.validation.warnings} warning(s), ${opts.validation.cycles} auto-fix cycle(s) used)` : "NOT run"}.

The README must include (in French): titre + description, fonctionnalités réelles, prérequis, installation, lancement, build, arborescence commentée, variables d'environnement si nécessaires, déploiement, limites connues honnêtes — généré par CodeForge. Output raw markdown only, no fences around the whole document.`;

  const r = await complete([{ role: "user", content: user }], { temperature: 0.3, signal, maxTokens: 8_000 });
  const md = stripCodeFences(r.text);
  return md.endsWith("\n") ? md : md + "\n";
}

/* ------------------------------------------------------------------ */
/*  6. PROJECT Q&A — answer from the real file index                   */
/* ------------------------------------------------------------------ */

export async function answerQuestion(
  question: string,
  index: FileSummary[],
  samples: { path: string; content: string }[],
  signal?: AbortSignal
): Promise<{ answer: string; references: { path: string; role: string }[] }> {
  const idx = index.map((f) => `- ${f.path} [${f.lines} lignes]${f.exports.length ? ` exports: ${f.exports.slice(0, 12).join(", ")}` : ""} — ${f.purpose}`).join("\n");
  const smp = samples.map((s) => `<<<FILE ${s.path}\n${s.content.slice(0, 6000)}\nFILE>>>`).join("\n\n");
  const user = `You are analysing a real software project. Answer the user's question using ONLY the facts below.

File index:
${idx}

Excerpts:
${smp}

Question: """${question}"""

Output ONE JSON object, no markdown:
{ "answer": "concise answer in French, mention precise file paths and symbol names", "references": [{ "path": "file", "role": "why relevant" }] }`;

  const r = await complete([{ role: "user", content: user }], { temperature: 0.2, signal, maxTokens: 4_000 });
  const raw = extractJson(r.text) as { answer?: string; references?: { path?: unknown; role?: unknown }[] };
  return {
    answer: String(raw.answer ?? "Je n'ai pas pu déterminer la réponse à partir des fichiers."),
    references: (Array.isArray(raw.references) ? raw.references : [])
      .map((x) => ({ path: String(x?.path ?? ""), role: String(x?.role ?? "") }))
      .filter((x) => index.some((f) => f.path === x.path))
      .slice(0, 8),
  };
}
