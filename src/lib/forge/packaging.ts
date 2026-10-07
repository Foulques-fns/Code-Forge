import JSZip from "jszip";
import { VFS, languageOf } from "./vfs";

/* ------------------------------------------------------------------ */
/*  ZIP export — built dynamically from the real generated files.      */
/*  Imports strip junk (node_modules, caches, logs...).                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  GitHub Pages export — a folder you can push and publish.           */
/*  Static projects deploy as-is; build-requiring projects get a real  */
/*  GitHub Actions workflow (npm ci → build → deploy-pages).           */
/* ------------------------------------------------------------------ */

const PAGES_WORKFLOW = (buildOutDir: string) => `name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - name: Install dependencies (reproductible)
        run: npm ci || npm install
      - name: Build
        run: npm run build
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          # Adapter ici si le dossier de sortie réel diffère (dist, build, out...)
          path: ${buildOutDir}
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
`;

function pagesReadme(opts: { name: string; staticOk: boolean; entry: string | null; workflow: boolean; outDir: string | null }): string {
  const { name, staticOk, entry, workflow } = opts;
  const L: string[] = [];
  L.push(`# ${name} — Déploiement GitHub Pages`, "");
  L.push("Ce dossier est prêt à être publié gratuitement via GitHub Pages.", "");
  if (staticOk) {
    L.push("## Mode statique (aucun build requis)", "");
    L.push("1. Créez un dépôt public sur GitHub et poussez ce dossier :", "");
    L.push("   ```bash", "   git init && git add -A && git commit -m \"Initial commit\"", "   git remote add origin https://github.com/<compte>/<repo>.git", "   git push -u origin main", "   ```");
    L.push("2. Sur GitHub : **Settings → Pages → Source : Deploy from a branch** → branche `main`, dossier `/ (root)` → **Save**.");
    L.push(`3. Le site est en ligne en ~1 min à l'adresse \`https://<compte>.github.io/<repo>/\``);
    if (entry) L.push(`   (page d'entrée : \`${entry}\` — chemins relatifs, servis tels quels).`);
    L.push("", "Le fichier \`.nojekyll\` désactive Jekyll (évite toute transformation de vos fichiers).", "");
  } else {
    L.push("## Mode avec build (CI incluse)", "");
    L.push("Ce projet nécessite un build (`npm install && npm run build`). Un workflow GitHub Actions complet est inclus :", "");
    L.push("1. Poussez ce dossier dans un dépôt public.", "2. **Settings → Pages → Source : GitHub Actions**.", "3. À chaque push sur `main`, le workflow \`.github/workflows/deploy-pages.yml` installe, build et déploie automatiquement le site.", "");
  }
  if (workflow) L.push(`> Workflow inclus : build Node 20 → upload de \`${opts.outDir ?? "dist"}\` → déploiement Pages.`);
  if (entry) L.push("", "`404.html` est une copie de la page : utile si l'application gère du routage côté client.");
  L.push("", "_Export préparé par CodeForge depuis les fichiers réels du projet._", "");
  return L.join("\n");
}

export function buildGitHubPages(vfs: VFS, projectName: string): {
  files: { path: string; content: string }[];
  staticOk: boolean;
  entry: string | null;
  workflowAdded: boolean;
  outDir: string | null;
} {
  const files = [...vfs.entries()];
  const entry = findHtmlEntry(vfs);
  const staticOk = buildPreview(vfs).ok;
  let workflowAdded = false;
  let outDir: string | null = null;

  // Real-world conveniences
  if (!files.some((f) => f.path === ".nojekyll")) {
    files.unshift({ path: ".nojekyll", content: "" });
  }
  if (entry && !files.some((f) => f.path === "404.html")) {
    files.push({ path: "404.html", content: vfs.read(entry)! });
  }

  // Build-requiring project → include a REAL CI workflow
  if (!staticOk && vfs.has("package.json")) {
    try {
      const pkg = JSON.parse(vfs.read("package.json")!);
      if (pkg.scripts?.build && !files.some((f) => f.path === ".github/workflows/deploy-pages.yml")) {
        const viteCfg = ["vite.config.ts", "vite.config.js", "vite.config.mjs"].map((p) => vfs.read(p)).find(Boolean) ?? "";
        outDir = /["'](?:dist|build|out)["']/.test(viteCfg) ? (viteCfg.match(/["'](dist|build|out)["']/)?.[1] ?? "dist") : "dist";
        files.push({ path: ".github/workflows/deploy-pages.yml", content: PAGES_WORKFLOW(outDir) });
        workflowAdded = true;
      }
    } catch {
      /* no valid pkg */
    }
  }

  files.push({ path: "GITHUB_PAGES.md", content: pagesReadme({ name: projectName, staticOk, entry, workflow: workflowAdded, outDir }) });
  return { files, staticOk, entry, workflowAdded, outDir };
}

export async function buildZip(vfs: VFS): Promise<{ buffer: Buffer; bytes: number }> {
  const zip = new JSZip();
  for (const { path, content } of vfs.entries()) {
    zip.file(path, content);
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  return { buffer, bytes: buffer.length };
}

const IMPORT_SKIP = /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|target|__pycache__|\.cache|\.idea|\.vscode|venv|\.venv)(\/|$)/i;
const IMPORT_SKIP_FILES = /(\.log$|\.DS_Store$|^Thumbs\.db$|\.lockb$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$)/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|mp[34]|avi|mov|mkv|webm|zip|gz|tar|exe|dll|so|dylib|bin|pdf|psd|class|jar|wasm)$/i;

export async function parseZipImport(data: Buffer): Promise<{
  files: { path: string; content: string }[];
  skipped: string[];
}> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const files: { path: string; content: string }[] = [];
  const skipped: string[] = [];

  // Common single-root folder detection so "my-app-main/src/x" -> "src/x"
  const roots = new Set(entries.map((f) => f.name.split("/")[0]).filter(Boolean));
  let stripPrefix = "";
  if (roots.size === 1) {
    const root = [...roots][0];
    const hasShallow = entries.some((f) => !f.name.includes("/"));
    if (!hasShallow && root) stripPrefix = root + "/";
  }

  let total = 0;
  for (const entry of entries) {
    let path = entry.name;
    if (stripPrefix && path.startsWith(stripPrefix)) path = path.slice(stripPrefix.length);
    if (!path) continue;
    if (IMPORT_SKIP.test(path) || IMPORT_SKIP_FILES.test(path)) {
      skipped.push(path);
      continue;
    }
    if (BINARY_EXT.test(path)) {
      skipped.push(`${path} (binaire non importable en mode texte)`);
      continue;
    }
    if (files.length >= 400 || total > 4_000_000) {
      skipped.push(`${path} (limite d'import atteinte)`);
      continue;
    }
    try {
      const content = await entry.async("string");
      // crude binary sniffing on decoded text
      if (content.includes("\uFFFD\uFFFD\uFFFD")) {
        skipped.push(`${path} (encodage non texte)`);
        continue;
      }
      total += content.length;
      files.push({ path, content });
    } catch {
      skipped.push(path);
    }
  }
  return { files, skipped };
}

/* ------------------------------------------------------------------ */
/*  Preview — assemble a REAL static page from the generated files.    */
/*  Local <script src> and <link href> are inlined so the preview      */
/*  runs the actual code that was generated, never a simulation.       */
/* ------------------------------------------------------------------ */

export interface PreviewResult {
  ok: boolean;
  entry?: string;
  html?: string;
  reason?: string;
  inlined?: string[];
}

export function findHtmlEntry(vfs: VFS): string | null {
  const candidates = [
    "index.html",
    "public/index.html",
    "src/index.html",
    "static/index.html",
    "www/index.html",
    "dist/index.html",
  ];
  for (const c of candidates) if (vfs.has(c)) return c;
  const any = vfs.paths().find((p) => p.endsWith(".html") && !p.includes("/"));
  return any ?? null;
}

function resolveAsset(vfs: VFS, entryDir: string, ref: string): { path: string; content: string } | null {
  const rooted = ref.split(/[?#]/)[0].replace(/^\/+/, "").replace(/^\.\//, "");
  const tries = [
    entryDir && !ref.startsWith("/") ? entryDir + "/" + rooted : rooted,
    rooted,
    "public/" + rooted,
    "src/" + rooted,
  ];
  for (const t of tries) {
    const norm = t.replace(/\/+/g, "/");
    if (vfs.has(norm)) return { path: norm, content: vfs.read(norm)! };
  }
  return null;
}

/** Inline local <img> pointing to project SVGs as data URIs so the preview
 *  doesn't depend on a server for imagery the project actually contains. */
function inlineLocalSvgImages(vfs: VFS, entryDir: string, html: string, inlined: string[]): string {
  return html.replace(/<img\b([^>]*?)src=["'](?!https?:|\/\/|data:)([^"']+\.svg)(?:[?#][^"']*)?["']([^>]*)>/gi, (tag, pre: string, src: string, post: string) => {
    const asset = resolveAsset(vfs, entryDir, src);
    if (!asset) return tag;
    const uri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(asset.content);
    inlined.push(asset.path);
    return `<img${pre}src="${uri}"${post}>`;
  });
}

export function buildPreview(vfs: VFS): PreviewResult {
  const entry = findHtmlEntry(vfs);
  if (!entry) {
    const hasPkg = vfs.has("package.json");
    return {
      ok: false,
      reason: hasPkg
        ? "Ce projet nécessite une étape d'installation/build (npm install && npm run dev). La prévisualisation instantanée n'est honnêtement possible que pour les applications web statiques — exportez le ZIP pour le lancer."
        : "Aucune page HTML utilisable comme point d'entrée n'a été générée dans ce projet.",
    };
  }
  const entryDir = entry.split("/").slice(0, -1).join("/");
  let html = vfs.read(entry)!;
  const inlined: string[] = [];

  // Inline local stylesheets
  html = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href || /^(https?:)?\/\//.test(href)) return tag;
    const asset = resolveAsset(vfs, entryDir, href);
    if (!asset) return tag;
    let css = asset.content;
    // Inline url() assets that are textual (svg) — leave others untouched
    inlined.push(asset.path);
    return `<style data-inlined="${asset.path}">\n${css}\n</style>`;
  });

  // Inline local scripts (classic only — ES modules/TS need a real bundler)
  html = html.replace(/<script\b([^>]*)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, pre: string, src: string, post: string) => {
    if (/^(https?:)?\/\//.test(src)) return tag;
    const asset = resolveAsset(vfs, entryDir, src);
    if (!asset) return tag;
    const attrs = `${pre ?? ""}${post ?? ""}`;
    const lang = languageOf(asset.path);
    if (/type=["']module["']/i.test(attrs) || lang === "typescript" || lang === "tsx") {
      return tag; // cannot honestly inline: needs a bundler
    }
    inlined.push(asset.path);
    return `<script data-inlined="${asset.path}">\n${asset.content}\n</script>`;
  });

  // Honesty gate: any remaining local module script or unresolved asset means
  // the page cannot run as-is — refuse rather than show a broken frame.
  const remainingScripts = [...html.matchAll(/<script\b[^>]*src=["'](?!https?:|\/\/)([^"']+)["'][^>]*>/gi)];
  const isBundled = remainingScripts.some((m) => /type=["']module["']/i.test(m[0])) ||
    remainingScripts.some((m) => /\.tsx?(?:[?#]|$)/.test(m[1]));
  const unresolvedAssets = remainingScripts.map((m) => m[1]).filter((src) => !resolveAsset(vfs, entryDir, src));
  const unresolvedCss = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["'](?!https?:|\/\/)([^"']+)["']/gi)]
    .map((m) => m[1]).filter((href) => !resolveAsset(vfs, entryDir, href));

  if (isBundled || unresolvedAssets.length || unresolvedCss.length) {
    return {
      ok: false,
      entry,
      reason: "Ce projet exige un bundler/serveur (modules ES, TypeScript, Vite...). La preview honnête nécessite un build réel : elle apparaîtra automatiquement après une génération dont l'étape de build a réussi.",
    };
  }

  // Inline local SVG imagery so the preview shows the designed assets
  html = inlineLocalSvgImages(vfs, entryDir, html, inlined);

  // Rewrite <base> so relative anchors don't escape the sandboxed iframe
  if (!/<base\b/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="about:blank">`);
  }
  return { ok: true, entry, html, inlined };
}

/* ------------------------------------------------------------------ */
/*  Dist preview — inline the REAL compiled bundle (dist/index.html    */
/*  with its hashed assets) captured from `npm run build`.             */
/* ------------------------------------------------------------------ */

export function buildDistPreview(files: { path: string; content: string }[], entry: string): string | null {
  const entryRel = entry.split("/").slice(1).join("/"); // "dist/index.html" → "index.html"
  const index = files.find((f) => f.path === entryRel) ?? files.find((f) => f.path.endsWith(".html"));
  if (!index) return null;
  const byPath = new Map(files.map((f) => [f.path.replace(/^\/+/, ""), f.content]));
  const lookup = (ref: string): string | null => {
    const clean = ref.split(/[?#]/)[0].replace(/^\/+/, "");
    if (byPath.has(clean)) return byPath.get(clean)!;
    // hashed assets may be nested ("assets/index-a1b2.js")
    for (const [p, c] of byPath) if (p.endsWith("/" + clean) || p.endsWith(clean)) return c;
    return null;
  };

  let html = index.content;
  html = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href || /^(https?:)?\/\//.test(href)) return tag;
    const css = lookup(href);
    return css != null ? `<style data-inlined-dist="${href}">\n${css}\n</style>` : tag;
  });
  html = html.replace(/<script\b([^>]*)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, pre: string, src: string, post: string) => {
    if (/^(https?:)?\/\//.test(src)) return tag;
    const js = lookup(src);
    if (js == null) return tag;
    const attrs = `${pre ?? ""}${post ?? ""}`.replace(/src=["'][^"']*["']/i, "");
    const isModule = /type=["']module["']/i.test(`${pre}${post}`);
    return `<script${isModule ? ' type="module"' : ""} data-inlined-dist="${src}">\n${js}\n<\/script>`;
  });
  // Inline local SVG imagery from the build output
  html = html.replace(/<img\b([^>]*?)src=["'](?!https?:|\/\/|data:)([^"']+\.svg)(?:[?#][^"']*)?["']([^>]*)>/gi, (tag, pre: string, src: string, post: string) => {
    const svg = lookup(src);
    if (svg == null) return tag;
    const uri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    return `<img${pre}src="${uri}"${post}>`;
  });
  if (!/<base\b/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="about:blank">`);
  }
  return html;
}
