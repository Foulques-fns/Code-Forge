import type { DiffInfo, FileSummary } from "@/lib/ai/types";

/* ------------------------------------------------------------------ */
/*  VirtualFileSystem — the real working representation of a project.  */
/*  Everything the AI does (create / update / delete / move / read)    */
/*  goes through this structure, never through a blob of text.         */
/* ------------------------------------------------------------------ */

export class VFS {
  private files = new Map<string, string>();

  static from(entries: { path: string; content: string }[]): VFS {
    const v = new VFS();
    for (const e of entries) v.write(e.path, e.content);
    return v;
  }

  has(path: string) {
    return this.files.has(path);
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, content: string) {
    this.files.set(path, content);
  }

  delete(path: string): boolean {
    return this.files.delete(path);
  }

  move(from: string, to: string): boolean {
    const c = this.files.get(from);
    if (c == null) return false;
    this.files.delete(from);
    this.files.set(to, c);
    return true;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  entries(): { path: string; content: string }[] {
    return this.paths().map((p) => ({ path: p, content: this.files.get(p)! }));
  }

  totalBytes(): number {
    let n = 0;
    for (const c of this.files.values()) n += c.length;
    return n;
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.files) out[k] = v;
    return out;
  }
}

/* ------------------------------------------------------------------ */
/*  Language detection + symbol extraction for the project index        */
/* ------------------------------------------------------------------ */

export function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    json: "json", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
    py: "python", go: "go", rs: "rust", php: "php", rb: "ruby", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", swift: "swift", sh: "bash", bash: "bash",
    yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml", svg: "xml", sql: "sql", md: "markdown",
    vue: "vue", svelte: "svelte", env: "dotenv", gitignore: "dotenv", lock: "text", txt: "text",
  };
  const base = path.split("/").pop() ?? "";
  if (base === "Dockerfile") return "docker";
  if (base === "Makefile") return "make";
  return map[ext] ?? "text";
}

const SYMBOL_PATTERNS: [RegExp, number][] = [
  [/export\s+default\s+(?:async\s+)?(?:function|class)?\s*([A-Za-z_$][\w$]*)/g, 1],
  [/export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, 1],
  [/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, 1],
  [/(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g, 1],
  [/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function)/g, 1],
  [/^(?:export\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, 1],
  [/^(?:export\s+)?class\s+([A-Za-z_]\w*)/gm, 1],
  [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, 1],
  [/^(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/gm, 1],
  [/\$route|app\.(?:get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g, 1],
];

export function extractSymbols(path: string, content: string): string[] {
  const lang = languageOf(path);
  const out = new Set<string>();
  if (["typescript", "tsx", "javascript", "jsx", "python", "go", "rust", "vue", "svelte", "php", "java", "c", "cpp"].includes(lang)) {
    for (const [re] of SYMBOL_PATTERNS) {
      const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      let m: RegExpExecArray | null;
      while ((m = rx.exec(content)) && out.size < 24) {
        if (m[1]) out.add(m[1]);
      }
    }
  }
  if (lang === "html") {
    const title = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (title) out.add(`«${title[1].trim()}»`);
    out.add(`${(content.match(/<[a-z][\w-]*[\s>]/gi) ?? []).length} balises`);
  }
  return [...out].slice(0, 24);
}

export function buildIndex(vfs: VFS, purposeOf?: (path: string) => string): FileSummary[] {
  return vfs.paths().map((p) => {
    const c = vfs.read(p)!;
    return {
      path: p,
      purpose: purposeOf?.(p) ?? "",
      exports: extractSymbols(p, c),
      lines: c.split("\n").length,
      bytes: c.length,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Real diff between two snapshots + line-level statistics            */
/* ------------------------------------------------------------------ */

function lineDiffCounts(before: string, after: string): { added: number; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  // Bounded LCS on trimmed lines — accurate enough for stats, fast for real files.
  const N = Math.min(a.length, 800);
  const M = Math.min(b.length, 800);
  const dp: Uint32Array[] = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { added: M - common + Math.max(0, b.length - M), removed: N - common + Math.max(0, a.length - N) };
}

export function diffSnapshots(before: Record<string, string>, after: VFS): DiffInfo {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const p of after.paths()) {
    const next = after.read(p)!;
    if (!(p in before)) {
      added.push(p);
      linesAdded += next.split("\n").length;
    } else if (before[p] !== next) {
      modified.push(p);
      const d = lineDiffCounts(before[p], next);
      linesAdded += d.added;
      linesRemoved += d.removed;
    }
  }
  for (const p of Object.keys(before)) {
    if (!after.has(p)) {
      deleted.push(p);
      linesRemoved += before[p].split("\n").length;
    }
  }
  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    stats: { files: added.length + modified.length + deleted.length, bytes: after.totalBytes(), linesAdded, linesRemoved },
  };
}
