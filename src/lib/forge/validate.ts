import ts from "typescript";
import { VFS, languageOf } from "./vfs";
import type { Issue } from "@/lib/ai/types";

/* ------------------------------------------------------------------ */
/*  Real, parser-based validation of the generated project.            */
/*  Nothing here is simulated: every issue comes from an actual check. */
/* ------------------------------------------------------------------ */

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "dns",
  "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path",
  "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder",
  "sys", "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".vue", ".svelte", ".py"];
const RESOLVE_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.css", "/__init__.py", "/mod.rs"];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function checkTsSyntax(path: string, content: string): Issue[] {
  const lang = languageOf(path);
  const isTsx = lang === "tsx" || lang === "jsx";
  const result = ts.transpileModule(content, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      jsx: isTsx ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
    },
  });
  const issues: Issue[] = [];
  for (const d of result.diagnostics ?? []) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    // 1xxx = syntactic diagnostics (the ones a single-file parse can prove)
    if (d.code < 1000 || d.code >= 2000) continue;
    const pos = d.file && typeof d.start === "number" ? d.file.getLineAndCharacterOfPosition(d.start) : null;
    const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
    issues.push({
      id: uid(),
      file: path,
      kind: "syntax",
      severity: "error",
      message: `${msg}${pos ? ` (ligne ${pos.line + 1})` : ""}`,
    });
    if (issues.length >= 6) break;
  }
  return issues;
}

const IMPORT_RE = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+(\.?[\w./-]+)\s+import|import\s+(\.?[\w./-]+)/g;

function extractImports(content: string, lang: string): string[] {
  const out = new Set<string>();
  if (["typescript", "tsx", "javascript", "jsx", "vue", "svelte", "python"].includes(lang)) {
    let m: RegExpExecArray | null;
    const re = new RegExp(IMPORT_RE.source, "g");
    while ((m = re.exec(content))) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
      if (spec) out.add(spec);
    }
  }
  return [...out];
}

function resolveRelative(vfs: VFS, fromFile: string, spec: string): boolean {
  const fromDir = fromFile.split("/").slice(0, -1).join("/");
  const base = (fromDir ? fromDir + "/" : "") + spec;
  const parts: string[] = [];
  for (const seg of base.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const p = parts.join("/");
  for (const ext of RESOLVE_EXTS) if (vfs.has(p + ext)) return true;
  for (const idx of RESOLVE_INDEX) if (vfs.has(p + idx)) return true;
  return false;
}

const PLACEHOLDER_RE = /(\bTODO\b|\bFIXME\b|implement\s+(this|me|later)|your\s+code\s+here|add\s+(your\s+)?logic\s+here|code\s+omitted|\.\.\.\s*rest\s+of\s+(the\s+)?(code|file)|<!--\s*content\s+-->|placeholder\s+implementation)/i;

/* ------------------------------------------------------------------ */
/*  Anti-mock scanner — a generated project must be REAL, not a demo.  */
/*  These markers block validation until the fixer removes them,       */
/*  exactly like a professional client would reject them.              */
/* ------------------------------------------------------------------ */

const FAKE_MARKERS: { re: RegExp; msg: string; severity: Issue["severity"] }[] = [
  { re: /\bcoming soon\b|feature coming soon|bient[ôo]t disponible|la fonctionnalité arrive/i, msg: "« coming soon » détecté — la fonctionnalité doit être implémentée pour de vrai, jamais annoncée", severity: "error" },
  { re: /not implemented yet|this is (just )?a (demo|mockup|mock|simulation)\b|\bfake(data|users?|response|api)\b|données fictives/i, msg: "marqueur de démo/simulation détecté — remplacer par la vraie implémentation", severity: "error" },
  { re: /placehold\.co|via\.placeholder\.com|dummyimage\.com|lorempixel\.com|fakeimg\.pl|placekitten|loremflickr/i, msg: "service d'images placeholder externe — dessiner un vrai asset local (SVG inclus dans le projet) à la place", severity: "error" },
  { re: /picsum\.photos|source\.unsplash\.com/i, msg: "image externe volatile (service tiers instable) — préférer un asset local (SVG généré, inclus dans le projet)", severity: "warning" },
  { re: /\balert\s*\(\s*['"`]/i, msg: "alert() utilisé comme retour d'interface — implémenter un vrai état UI (notification/toast/modale)", severity: "warning" },
];

function scanAntiMock(path: string, content: string): Issue[] {
  const out: Issue[] = [];
  for (const f of FAKE_MARKERS) {
    const m = content.match(f.re);
    if (m) out.push({ id: uid(), file: path, kind: "quality", severity: f.severity, message: `${f.msg} (« ${m[0].slice(0, 60)} »)` });
  }
  return out;
}

function scanHtmlQuality(vfs: VFS, path: string, content: string): Issue[] {
  const out: Issue[] = [];
  if (!/<title[^>]*>\s*[^<]+\s*<\/title>/i.test(content)) {
    out.push({ id: uid(), file: path, kind: "quality", severity: "error", message: "Balise <title> absente ou vide (onglet navigateur / SEO)" });
  }
  if (!/name=["']description["']/i.test(content)) {
    out.push({ id: uid(), file: path, kind: "quality", severity: "warning", message: "Meta description absente (SEO, aperçu de partage)" });
  }
  const deadLinks = (content.match(/<a\b[^>]*\bhref=["']#["']/gi) ?? []).length;
  if (deadLinks) {
    out.push({ id: uid(), file: path, kind: "quality", severity: "error", message: `${deadLinks} lien(s) mort(s) href="#" — chaque lien doit mener quelque part (navigation réelle ou ancre réelle)` });
  }
  const buttons = (content.match(/<button\b/gi) ?? []).length;
  const hasAnyJs = /<script[\s>]|<a\b[^>]*onclick=|\son\w+=/i.test(content);
  if (buttons > 0 && !hasAnyJs) {
    out.push({ id: uid(), file: path, kind: "quality", severity: "error", message: `${buttons} bouton(s) sans aucun comportement (page sans JavaScript) — les câbler ou les retirer : un bouton décoratif est une maquette` });
  }
  // Favicon: required for a publishable site (checked once, on the entry page)
  const isRootEntry = !path.includes("/");
  if (isRootEntry) {
    const declaresIcon = /rel=["'](?:shortcut )?icon["']/i.test(content);
    const projectHasIcon = vfs.paths().some((p) => /(^|\/)favicon\.(svg|ico|png)$/i.test(p));
    if (!declaresIcon && !projectHasIcon) {
      out.push({ id: uid(), file: path, kind: "quality", severity: "warning", message: "Aucun favicon (ni <link rel=\"icon\"> ni favicon.svg à la racine) — ajouter une icône SVG locale auto-dessinée" });
    }
  }
  return out;
}

function collectDeps(vfs: VFS): { deps: Record<string, string>; all: Set<string>; hasPkg: boolean } {
  const raw = vfs.read("package.json");
  if (raw == null) return { deps: {}, all: new Set(), hasPkg: false };
  try {
    const pkg = JSON.parse(raw);
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
    return { deps, all: new Set(Object.keys(deps)), hasPkg: true };
  } catch {
    return { deps: {}, all: new Set(), hasPkg: true };
  }
}

export function validateProject(vfs: VFS): Issue[] {
  const issues: Issue[] = [];
  const { all: declared, hasPkg } = collectDeps(vfs);

  for (const path of vfs.paths()) {
    const content = vfs.read(path)!;
    const lang = languageOf(path);

    // — Syntactic validation through the real TypeScript parser —
    if (["typescript", "tsx", "javascript", "jsx"].includes(lang) && path !== "package.json") {
      issues.push(...checkTsSyntax(path, content));
    }

    // — Real JSON parsing —
    if (lang === "json") {
      try {
        JSON.parse(content);
      } catch (e) {
        issues.push({ id: uid(), file: path, kind: "json", severity: "error", message: `JSON invalide : ${e instanceof Error ? e.message : "erreur de parsing"}` });
      }
    }

    // — Honesty rule: no placeholder code allowed —
    if (["typescript", "tsx", "javascript", "jsx", "python", "go", "rust", "java", "c", "cpp", "html", "css", "php"].includes(lang)) {
      const m = content.match(PLACEHOLDER_RE);
      if (m && content.length > 40) {
        // Ignore the word TODO inside README-like docs; this only runs on code files.
        issues.push({ id: uid(), file: path, kind: "placeholder", severity: "error", message: `Code placeholder détecté (« ${m[1]} ») — le fichier doit être réellement implémenté` });
      }
    }

    // — Anti-mock / fake markers (blocking like a client acceptance review) —
    if (["typescript", "tsx", "javascript", "jsx", "html", "css", "vue", "svelte", "python", "php"].includes(lang)) {
      issues.push(...scanAntiMock(path, content));
    }
    // — HTML realness rules (SEO, dead links, inert buttons, favicon) —
    if (lang === "html") {
      issues.push(...scanHtmlQuality(vfs, path, content));
    }

    // — Cross-file import resolution —
    for (const spec of extractImports(content, lang)) {
      if (spec.startsWith(".")) {
        if (!resolveRelative(vfs, path, spec)) {
          issues.push({ id: uid(), file: path, kind: "missing-file", severity: "error", message: `Import introuvable : « ${spec} » ne correspond à aucun fichier du projet` });
        }
      } else if (lang !== "python") {
        // Path aliases (@/x, ~/x, src/x) resolve against the project, not the registry
        const aliasBody = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith("~/") ? spec.slice(2) : spec.startsWith("src/") ? spec : null;
        if (aliasBody !== null) {
          const candidates = [`src/${aliasBody}`, aliasBody, `app/${aliasBody}`];
          const hit = candidates.some((c) => RESOLVE_EXTS.some((ext) => vfs.has(c + ext)) || RESOLVE_INDEX.some((i) => vfs.has(c + i)));
          if (!hit && !vfs.has("tsconfig.json")) {
            issues.push({ id: uid(), file: path, kind: "missing-file", severity: "error", message: `Import alias introuvable : « ${spec} » ne correspond à aucun fichier du projet` });
          }
          continue;
        }
        const root = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        const base = root.replace(/^node:/, "");
        const isBuiltin = spec.startsWith("node:") || NODE_BUILTINS.has(base);
        const declaredOrSelf = declared.has(root) || root === path.split("/")[0];
        if (!isBuiltin && !declaredOrSelf && !isGenericModule(root)) {
          issues.push({ id: uid(), file: path, kind: "missing-dependency", severity: "error", message: `Dépendance « ${root} » utilisée mais absente de package.json` });
        }
      }
    }

    // — HTML referenced assets —
    if (lang === "html") {
      for (const { ref, critical } of htmlRefsDetailed(content)) {
        if (/^(https?:)?\/\//.test(ref) || ref.startsWith("data:") || ref.startsWith("#") || ref.startsWith("mailto:") || ref.startsWith("tel:") || ref.startsWith("sms:") || ref.startsWith("javascript:")) continue;
        const clean = ref.split(/[?#]/)[0];
        if (!clean) continue;
        const dir = path.split("/").slice(0, -1).join("/");
        const rooted = rootNorm(clean);
        const p = (dir && !clean.startsWith("/") ? dir + "/" : "") + rooted;
        if (!vfs.has(p) && !vfs.has(rooted) && !vfs.has("public/" + rooted) && !vfs.has("src/" + rooted)) {
          issues.push({
            id: uid(), file: path, kind: "missing-file", severity: critical ? "error" : "warning",
            message: `Ressource référencée introuvable : « ${clean} »`,
          });
        }
      }
    }
  }

  // — package.json coherence —
  if (hasPkg) {
    const raw = vfs.read("package.json")!;
    try {
      const pkg = JSON.parse(raw);
      if (!pkg.dependencies) pkg.dependencies = {};
      const nodeFiles = vfs.paths().filter((p) => ["javascript", "typescript", "jsx", "tsx"].includes(languageOf(p)));
      if (nodeFiles.length > 0 && !pkg.scripts && !vfs.has("index.html")) {
        issues.push({ id: uid(), file: "package.json", kind: "package", severity: "warning", message: "Aucun script npm défini alors que le projet contient du JavaScript" });
      }
      for (const field of ["dependencies", "devDependencies"]) {
        const deps = pkg[field] as Record<string, string> | undefined;
        if (!deps) continue;
        for (const name of Object.keys(deps)) {
          if (!VALID_DEP.test(name) || name.includes("..")) {
            issues.push({ id: uid(), file: "package.json", kind: "package", severity: "error", message: `Nom de dépendance invalide « ${name} » (npm install échouerait) — à supprimer ou remplacer` });
          }
        }
      }
    } catch {
      /* json issue already recorded */
    }
  }

  // — Orphaned files: generated code that NOTHING references (the classic
  //   "inline version + unused external version" duplication). Dead code is
  //   a mock smell — either wire it in or remove it.
  issues.push(...checkOrphans(vfs));

  // — Frontend ↔ backend route coherence (real cross-layer check) —
  issues.push(...checkRouteCoherence(vfs));

  // Deduplicate identical messages per file
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.file}|${i.kind}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 60);
}

function isGenericModule(root: string): boolean {
  // Non-npm ecosystems / relative-ish identifiers
  return /^[a-z]:/i.test(root) || root.includes("..") || /^[A-Z]/.test(root);
}

/** Verify that every /api/* route the frontend calls is actually defined
 *  somewhere in the backend — the classic full-stack coherence bug. */
const ORPHAN_SKIP = /(^|\/)(index\.html|main\.|app\.|server\.|index\.|mod\.rs|vite\.config|next\.config|tsconfig|jsconfig|package\.json|composer\.json|requirements\.txt|dockerfile|makefile|readme|architecture\.md|decisions\.md|\.env\.example|favicon\.|manifest\.|sw\.|service-worker|seed\.|migrate|migration|schema\.|__tests__|\.test\.|\.spec\.|test\/|tests\/)/i;

/** Detect code files that no other file references (never imported, never
 *  linked from HTML, never named in config/scripts). */
function checkOrphans(vfs: VFS): Issue[] {
  const out: Issue[] = [];
  const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|css|scss|vue|svelte)$/i;
  const others = vfs.paths();
  // Everything some file mentions by name counts as referenced
  const corpus = new Map<string, string>(others.map((p) => [p, vfs.read(p)!.toString()]));
  const htmls = others.filter((p) => p.endsWith(".html"));

  for (const p of others) {
    if (!CODE_EXT.test(p) || ORPHAN_SKIP.test(p)) continue;
    const base = (p.split("/").pop() ?? p).replace(CODE_EXT, "");
    if (base.length < 3) continue;
    let referenced = false;
    for (const [other, text] of corpus) {
      if (other === p) continue;
      if (text.includes(p) || text.includes(base)) {
        referenced = true;
        break;
      }
    }
    if (referenced) continue;
    // A JS/CSS asset that no HTML page pulls in (nor any module imports) is dead
    const pulledByHtml = htmls.some((h) => {
      const c = corpus.get(h)!;
      return c.includes(p) || c.includes(p.split("/").pop()!);
    });
    if (pulledByHtml) continue;
    out.push({
      id: `orphan-${p}`,
      file: p,
      kind: "quality",
      severity: "warning",
      message: `Fichier orphelin « ${p} » : généré mais jamais référencé nulle part (code mort) — le câbler réellement ou le supprimer`,
    });
    if (out.length >= 8) break;
  }
  return out;
}

function checkRouteCoherence(vfs: VFS): Issue[] {
  const out: Issue[] = [];
  const defined = new Set<string>();
  const called: { route: string; file: string }[] = [];

  const DEF_PATTERNS = [
    /(?:app|router|server)\s*\.\s*(?:get|post|put|patch|delete|use|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    /@(?:app|router)\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
  ];
  const CALL_PATTERNS = [
    /(?:fetch|axios(?:\.\w+)?)\s*\(\s*['"`]([^'"`]*\/api\/[^'"`\s)]+)['"`]/gi,
  ];

  for (const p of vfs.paths()) {
    const content = vfs.read(p)!;
    // Next.js route files are definitions by construction
    const nextApi = p.match(/^(?:src\/)?app\/api\/(.+)\/route\.[tj]sx?$/);
    if (nextApi) defined.add(`/api/${nextApi[1]}`);
    const pagesApi = p.match(/^(?:src\/)?pages\/api\/(.+)\.[tj]sx?$/);
    if (pagesApi) defined.add(`/api/${pagesApi[1]}`.replace(/\/index$/, "") || "/api");

    for (const re of DEF_PATTERNS) {
      const rx = new RegExp(re.source, re.flags);
      let m: RegExpExecArray | null;
      while ((m = rx.exec(content))) {
        if (m[1]?.startsWith("/")) defined.add(m[1]);
      }
    }
    for (const re of CALL_PATTERNS) {
      const rx = new RegExp(re.source, re.flags);
      let m: RegExpExecArray | null;
      while ((m = rx.exec(content))) {
        if (m[1]) called.push({ route: m[1], file: p });
      }
    }
  }
  if (!defined.size || !called.length) return out;

  const matchers = [...defined].map((d) => {
    const rx = "^" + d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\[id\\\]|\\\[[^\]]+\\\]|:([\w]+)/g, "[^/]+") + "$";
    try {
      return new RegExp(rx);
    } catch {
      return null;
    }
  }).filter((r): r is RegExp => r !== null);

  const seen = new Set<string>();
  for (const c of called) {
    if (seen.has(c.route)) continue;
    seen.add(c.route);
    const clean = c.route.split("?")[0];
    if (!matchers.some((rx) => rx.test(clean))) {
      out.push({
        id: `route-${seen.size}`,
        file: c.file,
        kind: "route",
        severity: "error",
        message: `Appel frontend vers « ${clean} » mais AUCUNE route backend ne la définit — créer la route ou corriger l'appel`,
      });
      if (out.length >= 10) break;
    }
  }
  return out;
}

/** Normalize a reference as the project root: "/js/x.js" means "js/x.js". */
function rootNorm(p: string): string {
  return p.replace(/^\/+/, "").replace(/^\.\//, "");
}

/** Deterministic pre-validation pass: absolute "/x" refs are root-relative
 *  by intent; when the file under root exists, rewrite the ref relatively.
 *  Also: if a local script/stylesheet doesn't exist but exactly ONE file with
 *  the same extension exists in the project, rewrite to the real file. */
export function harmonizeHtmlRefs(vfs: VFS): number {
  const refRe = /(<(?:script|link)\b[^>]*(?:src|href)=["'])(?!https?:|\/\/|data:|#)([^"']+)(["'][^>]*>)/gi;
  let rewritten = 0;
  for (const htmlPath of vfs.paths().filter((p) => p.endsWith(".html"))) {
    const html = vfs.read(htmlPath)!;
    const dir = htmlPath.split("/").slice(0, -1).join("/");
    const next = html.replace(refRe, (whole, pre: string, ref: string, post: string) => {
      const raw = ref.split(/[?#]/)[0];
      const rooted = rootNorm(raw);
      const candidates = [(dir && !raw.startsWith("/") ? dir + "/" : "") + rooted, rooted, "public/" + rooted, "src/" + rooted];
      if (candidates.some((c) => vfs.has(rootNorm(c)))) {
        // Exists — but if written root-absolute, make it project-relative so
        // the same file works from the ZIP, preview and a dev server alike.
        if (raw.startsWith("/") && vfs.has(rooted)) {
          let rel = rooted;
          if (dir && rooted.startsWith(dir + "/")) rel = rooted.slice(dir.length + 1);
          rewritten++;
          return pre + rel + post;
        }
        return whole;
      }
      const wantExt = rooted.split(".").pop()?.toLowerCase();
      if (!wantExt || !["js", "mjs", "css"].includes(wantExt)) return whole;
      const pool = vfs.paths().filter((p) => p.toLowerCase().endsWith("." + (wantExt === "mjs" ? "js" : wantExt)));
      if (pool.length !== 1) return whole;
      const target = pool[0];
      let rel = target;
      if (dir && target.startsWith(dir + "/")) rel = target.slice(dir.length + 1);
      rewritten++;
      return pre + rel + post;
    });
    if (next !== html) vfs.write(htmlPath, next);
  }
  return rewritten;
}

function htmlRefsDetailed(html: string): { ref: string; critical: boolean }[] {
  const out = new Map<string, boolean>();
  const patterns: [RegExp, boolean][] = [
    [/<script[^>]+src=["']([^"']+)["']/gi, true],
    [/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi, true],
    [/<link[^>]+href=["']([^"']+)["']/gi, false],
    [/<img[^>]+src=["']([^"']+)["']/gi, false],
    [/<a[^>]+href=["']([^"']+)["']/gi, false],
    [/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi, false],
  ];
  for (const [re, critical] of patterns) {
    let m: RegExpExecArray | null;
    const rx = new RegExp(re.source, re.flags);
    while ((m = rx.exec(html))) if (m[1] && !out.has(m[1])) out.set(m[1], critical);
  }
  return [...out].map(([ref, c]) => ({ ref, critical: c }));
}

/* ------------------------------------------------------------------ */
/*  Deterministic, honest fixes the runtime can apply itself            */
/* ------------------------------------------------------------------ */

const versionCache = new Map<string, string>();

/** Resolve a REAL published version from the npm registry (never "*" when avoidable). */
async function resolveVersion(dep: string): Promise<string> {
  if (versionCache.has(dep)) return versionCache.get(dep)!;
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(dep)}/latest`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const json = (await res.json()) as { version?: string };
      if (json.version) {
        const v = `^${json.version}`;
        versionCache.set(dep, v);
        return v;
      }
    }
  } catch {
    /* registry unreachable — fall back below */
  }
  const fallback = "latest";
  versionCache.set(dep, fallback);
  return fallback;
}

/** Strict npm package-name validity (rejects path aliases like "@/utils"). */
export const VALID_DEP = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Deterministically remove entries that can never install (aliases, junk). */
export function pruneInvalidDeps(vfs: VFS): string[] {
  const raw = vfs.read("package.json");
  if (raw == null) return [];
  try {
    const pkg = JSON.parse(raw);
    const removed: string[] = [];
    for (const field of ["dependencies", "devDependencies"] as const) {
      if (!pkg[field]) continue;
      for (const name of Object.keys(pkg[field])) {
        if (!VALID_DEP.test(name) || name.includes("..")) {
          removed.push(name);
          delete pkg[field][name];
        }
      }
    }
    if (removed.length) vfs.write("package.json", JSON.stringify(pkg, null, 2) + "\n");
    return removed;
  } catch {
    return [];
  }
}

/** Declare missing dependencies with real semver ranges when resolvable. */
export async function patchPackageDeps(vfs: VFS, missing: string[]): Promise<number> {
  const raw = vfs.read("package.json");
  if (raw == null || !missing.length) return 0;
  try {
    const pkg = JSON.parse(raw);
    pkg.dependencies = pkg.dependencies ?? {};
    let n = 0;
    for (const dep of missing) {
      if (!VALID_DEP.test(dep) || dep.includes("..") || dep.length > 120) continue;
      if (!pkg.dependencies[dep] && !pkg.devDependencies?.[dep]) {
        pkg.dependencies[dep] = await resolveVersion(dep);
        n++;
      }
    }
    if (n) vfs.write("package.json", JSON.stringify(pkg, null, 2) + "\n");
    return n;
  } catch {
    return 0;
  }
}
