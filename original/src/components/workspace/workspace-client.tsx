"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft, Ban, Braces, CircleAlert, Download, Eye, FileCode2, GitBranch, Hammer, ListTree, Loader2,
  PanelRight, SendHorizonal, Settings2, Square, Trash2, Activity,
} from "lucide-react";
import { EngineBadge } from "../engine-badge";
import { FileTree } from "./file-tree";
import { CodeViewer } from "./code-viewer";
import { Timeline, type FeedItem } from "./timeline";
import { SidePanel, type ChatMsg, type DiffData, type PlanData, type RunInfo } from "./side-panel";

export interface WorkspaceFile { path: string; content: string; language: string; bytes: number }

export interface WorkspaceData {
  project: {
    id: string; name: string; description: string; status: string; previewable: boolean;
    version: number; seedRequest: string;
    settings: { fixCycles: number; maxFiles: number; runBuild: boolean; runTests: boolean };
  };
  files: WorkspaceFile[];
  plan: PlanData | null;
  diff: DiffData | null;
  runs: RunInfo[];
  events: { kind: string; label: string; status: string; detail?: unknown }[];
  messages: ChatMsg[];
  engine: { ok: boolean; active: { label: string; model?: string; kind: string; detail?: string } | null } | null;
}

type Tab = "activity" | "code" | "preview";

let feedSeq = 0;
const fk = () => `f${++feedSeq}`;

export function WorkspaceClient({ initial, autostart }: { initial: WorkspaceData; autostart: boolean }) {
  const router = useRouter();
  const [project, setProject] = useState(initial.project);
  const [files, setFiles] = useState<Record<string, WorkspaceFile>>(
    () => Object.fromEntries(initial.files.map((f) => [f.path, f]))
  );
  const [plan, setPlan] = useState(initial.plan);
  const [diff, setDiff] = useState(initial.diff);
  const [runs, setRuns] = useState(initial.runs);
  const [messages, setMessages] = useState(initial.messages);
  const [feed, setFeed] = useState<FeedItem[]>(() =>
    initial.events.slice(-400).map((e) => ({
      key: fk(),
      kind: (e.kind as FeedItem["kind"]) ?? "log",
      label: e.label,
      status: e.status === "active" ? "done" : (e.status as FeedItem["status"]) ?? "done",
      detail: typeof e.detail === "object" && e.detail && "path" in e.detail ? String((e.detail as { path?: string }).path ?? "") : undefined,
      ms: typeof e.detail === "object" && e.detail && "ms" in e.detail ? Number((e.detail as { ms?: number }).ms ?? 0) : undefined,
    }))
  );
  const [selected, setSelected] = useState<string | null>(initial.files[0]?.path ?? null);
  const [tab, setTab] = useState<Tab>(initial.files.length ? "code" : "activity");
  const [generating, setGenerating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPaths, setNewPaths] = useState<Set<string>>(new Set());
  const [mobilePanel, setMobilePanel] = useState<"files" | "main" | "side">("main");
  const [showSettings, setShowSettings] = useState(false);
  const [nameVal, setNameVal] = useState(initial.project.name);
  const feedEnd = useRef<HTMLDivElement>(null);
  const startedOnce = useRef(false);

  const fileList = useMemo(() => Object.values(files).map((f) => ({ path: f.path, bytes: f.bytes })).sort((a, b) => a.path.localeCompare(b.path)), [files]);

  useEffect(() => { feedEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [feed]);

  /* ——— Data refresh (authoritative, after a run finishes) ——— */
  const refreshWorkspace = useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${project.id}`, { cache: "no-store" });
      if (!r.ok) return;
      const ws = await r.json();
      setProject((p) => ({
        ...p,
        name: ws.project.name, description: ws.project.description, status: ws.project.status,
        previewable: ws.project.previewable, version: ws.project.version,
        settings: ws.project.settings ?? p.settings,
      }));
      setNameVal(ws.project.name);
      setFiles(Object.fromEntries(ws.files.map((f: WorkspaceFile) => [f.path, f])));
      setPlan((ws.lastRun?.plan ?? ws.project.plan ?? null) as PlanData | null);
      setDiff((ws.lastRun?.diff ?? null) as DiffData | null);
      setRuns(ws.runs.map((r: { id: string; kind: string; status: string; startedAt: string; stats: unknown }) => ({
        id: r.id, kind: r.kind, status: r.status, startedAt: r.startedAt, stats: r.stats as RunInfo["stats"],
      })));
      setMessages(ws.messages);
    } catch { /* network hiccup — live state stays */ }
  }, [project.id]);

  /* ——— Stream consumption with automatic reconnection (runs are detached
        server-side, so the forge keeps working even if the HTTP stream drops) ——— */
  const consumeForge = useCallback(async (initialResponse: Response) => {
    const stepRows = new Map<string, string>();
    const fileRows = new Map<string, string>();
    let lastSeq = 0;
    let res = initialResponse;
    let failures = 0;

    const upsert = (map: Map<string, string>, k: string, item: FeedItem) => {
      setFeed((prev) => {
        const key = map.get(k);
        const idx = key ? prev.findIndex((x) => x.key === key) : -1;
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], ...item, key: next[idx].key };
          return next;
        }
        map.set(k, item.key);
        return [...prev, item];
      });
    };

    const handle = (e: {
      kind: string; step?: string; status?: string; label?: string; path?: string; bytes?: number; ms?: number;
      content?: string; message?: string; plan?: PlanData; diff?: DiffData; issues?: { severity: string }[]; seq?: number;
    }): boolean => {
      if (e.kind === "step" && e.step) {
        upsert(stepRows, e.step, { key: fk(), kind: "step", step: e.step, label: e.label ?? "", status: (e.status as FeedItem["status"]) ?? "active" });
      } else if (e.kind === "file" && e.path) {
        upsert(fileRows, e.path, { key: fk(), kind: "file", label: e.path, status: (e.status as FeedItem["status"]) ?? "active", detail: e.label, ms: e.ms });
        if (e.status === "done" && typeof e.content === "string") {
          const lang = e.path.split(".").pop() ?? "text";
          setFiles((prev) => ({ ...prev, [e.path!]: { path: e.path!, content: e.content!, language: lang, bytes: e.bytes ?? e.content!.length } }));
          setNewPaths((s) => new Set(s).add(e.path!));
          setSelected((cur) => cur ?? e.path!);
        }
      } else if (e.kind === "plan") {
        if (e.plan) setPlan(e.plan as PlanData);
      } else if (e.kind === "issues") {
        const errs = e.issues?.filter((i) => i.severity === "error").length ?? 0;
        setFeed((p) => [...p, { key: fk(), kind: "issues", label: e.label ?? "validation", status: errs ? "error" : "done" }]);
      } else if (e.kind === "fix" && e.path) {
        upsert(fileRows, `fix:${e.path}:${e.label ?? ""}`, { key: fk(), kind: "fix", label: `${e.path} — ${e.label ?? "correction"}`, status: (e.status as FeedItem["status"]) ?? "active", ms: e.ms });
      } else if (e.kind === "phase") {
        upsert(stepRows, `phase:${(e.label ?? "").slice(0, 40)}`, { key: fk(), kind: "phase", label: e.label ?? "", status: (e.status as FeedItem["status"]) ?? "active" });
      } else if (e.kind === "verify") {
        upsert(stepRows, "verify", { key: fk(), kind: "step", step: "verify", label: e.label ?? "", status: (e.status as FeedItem["status"]) ?? "active" });
      } else if (e.kind === "log") {
        setFeed((p) => [...p, { key: fk(), kind: "log", label: e.message ?? "", status: "done" }]);
      } else if (e.kind === "diff" && e.diff) {
        setDiff(e.diff);
        setFeed((p) => [...p, { key: fk(), kind: "diff", label: e.label ?? "modifications appliquées", status: "done" }]);
      } else if (e.kind === "done") {
        setFeed((p) => [...p, { key: fk(), kind: "done", label: e.label ?? "Projet prêt", status: "done" }]);
        return true;
      } else if (e.kind === "error") {
        setFeed((p) => [...p, { key: fk(), kind: "error", label: e.message ?? "Erreur", status: "error" }]);
        setError(e.message ?? "Erreur inconnue");
        return true;
      } else if (e.kind === "cancelled") {
        setFeed((p) => [...p, { key: fk(), kind: "cancelled", label: "Génération arrêtée — le projet conserve son état précédent (persistance atomique).", status: "skipped" }]);
        return true;
      }
      return false;
    };

    for (;;) {
      if (!res.ok || !res.body) {
        if (res.status === 404) {
          setFeed((p) => [...p, { key: fk(), kind: "log", label: "La génération n'est plus suivie côté serveur (redémarrage) — état rechargé.", status: "done" }]);
          return;
        }
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Erreur ${res.status}`);
      }
      let terminal = false;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += value;
          let cut: number;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const line = raw.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
              const e = JSON.parse(line.slice(5));
              if (typeof e.seq === "number") lastSeq = Math.max(lastSeq, e.seq);
              if (handle(e)) terminal = true;
            } catch { /* malformed event */ }
          }
        }
      } catch {
        /* connection dropped — the run continues server-side */
      }
      if (terminal) return;
      failures++;
      if (failures > 10) throw new Error("Flux de génération interrompu définitivement.");
      setFeed((p) => [...p, { key: fk(), kind: "log", label: `Flux HTTP interrompu (timeout ~300 s) — reconnexion, la forge continue en arrière-plan…`, status: "active" }]);
      await new Promise((r) => setTimeout(r, Math.min(8000, 1200 * failures)));
      res = await fetch(`/api/projects/${project.id}/stream?after=${lastSeq}`, { cache: "no-store" });
    }
  }, [project.id]);

  /* ——— Start a generation ——— */
  const startForge = useCallback(async (request: string, mode?: "create" | "iterate") => {
    if (generating) return;
    setGenerating(true);
    setError(null);
    setTab("activity");
    setMobilePanel("main");
    try {
      const res = await fetch(`/api/projects/${project.id}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, mode }),
      });
      await consumeForge(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion interrompue");
    } finally {
      setGenerating(false);
      await refreshWorkspace();
    }
  }, [generating, project.id, consumeForge, refreshWorkspace]);

  /* ——— Stop: the run is detached server-side → ask the server to abort it ——— */
  const stopForge = useCallback(async () => {
    await fetch(`/api/projects/${project.id}/stream`, { method: "DELETE" }).catch(() => {});
  }, [project.id]);

  /* ——— Resume an in-flight run after a page refresh ——— */
  useEffect(() => {
    if (startedOnce.current) return;
    startedOnce.current = true;
    (async () => {
      try {
        const st = await fetch(`/api/projects/${project.id}/stream?status=1`, { cache: "no-store" }).then((r) => r.json());
        if (st.active) {
          setGenerating(true);
          setTab("activity");
          setFeed((p) => [...p, { key: fk(), kind: "log", label: "Génération en cours détectée — reconnexion au flux en direct.", status: "active" }]);
          try {
            await consumeForge(await fetch(`/api/projects/${project.id}/stream?after=0`, { cache: "no-store" }));
          } finally {
            setGenerating(false);
            refreshWorkspace();
          }
          return;
        }
      } catch { /* fall through to autostart logic */ }
      if (autostart && initial.files.length === 0) {
        startForge(initial.project.seedRequest, "create");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ask = useCallback(async (question: string) => {
    setAsking(true);
    const tempId = `tmp-${Date.now()}`;
    setMessages((p) => [...p, { id: tempId, role: "user", content: question, meta: { kind: "question" } }]);
    try {
      const r = await fetch(`/api/projects/${project.id}/ask`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Erreur");
      setMessages((p) => [...p, { id: tempId + "-a", role: "assistant", content: d.answer, meta: { kind: "answer", references: d.references } }]);
    } catch (e) {
      setMessages((p) => [...p, { id: tempId + "-a", role: "assistant", content: e instanceof Error ? e.message : "Impossible de répondre.", meta: { kind: "answer", references: [] } }]);
    } finally {
      setAsking(false);
    }
  }, [project.id]);

  const restore = useCallback(async (runId: string) => {
    const r = await fetch(`/api/projects/${project.id}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }),
    });
    if (r.ok) { await refreshWorkspace(); setTab("code"); }
  }, [project.id, refreshWorkspace]);

  const saveName = async () => {
    if (nameVal.trim() && nameVal !== project.name) {
      await fetch(`/api/projects/${project.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nameVal }) });
    }
  };

  const saveSettings = async (fixCycles: number, maxFiles: number, runBuild: boolean, runTests: boolean) => {
    const settings = { fixCycles, maxFiles, runBuild, runTests };
    setProject((p) => ({ ...p, settings }));
    await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    setShowSettings(false);
  };

  const deleteProject = async () => {
    await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    router.push("/");
    router.refresh();
  };

  const [verifying, setVerifying] = useState(false);
  /* Real toolchain check — no AI. Also rebuilds the preview from build output. */
  const runVerify = useCallback(async () => {
    if (verifying || generating) return;
    setVerifying(true);
    setTab("activity");
    setMobilePanel("main");
    setFeed((p) => [...p, { key: fk(), kind: "verify", label: "Vérification manuelle : npm install + build + tests réels…", status: "active" }]);
    try {
      const r = await fetch(`/api/projects/${project.id}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `Erreur ${r.status}`);
      if (!d.ran) {
        setFeed((p) => [...p, { key: fk(), kind: "verify", label: `Vérification non exécutée : ${d.skippedReason}`, status: "skipped" }]);
      } else if (d.ok) {
        setFeed((p) => [...p, { key: fk(), kind: "verify", label: `Outillage validé${d.previewFrom ? ` · preview reconstruite depuis le ${d.previewFrom}` : ""}`, status: "done" }]);
      } else {
        const first = d.issues?.[0];
        setFeed((p) => [...p, { key: fk(), kind: "verify", label: `Outillage en échec : ${first ? `[${first.kind}] ${first.file ?? "?"} — ${first.message}` : "voir journal"}`, status: "error" }]);
      }
      await refreshWorkspace();
    } catch (e) {
      setFeed((p) => [...p, { key: fk(), kind: "verify", label: e instanceof Error ? e.message : "Échec de vérification", status: "error" }]);
    } finally {
      setVerifying(false);
    }
  }, [verifying, generating, project.id, refreshWorkspace]);

  const hasFiles = fileList.length > 0;
  const statusBadge = generating
    ? { cls: "dot-warn", txt: "forge en cours" }
    : project.status === "ready"
      ? { cls: "dot-ok", txt: `prêt · v${project.version}` }
      : project.status === "error"
        ? { cls: "dot-err", txt: "erreur" }
        : { cls: "dot-idle", txt: project.status };

  /* ——————————————————— render ——————————————————— */

  const filesPanel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[color:var(--line)] px-4 py-3">
        <span className="panel-title">Fichiers</span>
        <span className="mono text-[10.5px] text-[color:var(--ink-3)]">{fileList.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-2">
        {hasFiles ? (
          <FileTree files={fileList} selected={selected} onSelect={(p) => { setSelected(p); setTab("code"); setMobilePanel("main"); }} newPaths={newPaths} />
        ) : (
          <p className="p-4 text-[12px] leading-relaxed text-[color:var(--ink-3)]">
            {generating ? "Les fichiers apparaissent ici au fur et à mesure de leur écriture réelle…" : "Aucun fichier. Lancez une génération."}
          </p>
        )}
      </div>
    </div>
  );

  const mainPanel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[color:var(--line)] px-3 py-2">
        <button className={`tab ${tab === "activity" ? "active" : ""}`} onClick={() => setTab("activity")}>
          <Activity size={13} /> Activité
        </button>
        <button className={`tab ${tab === "code" ? "active" : ""}`} onClick={() => setTab("code")} disabled={!hasFiles}>
          <FileCode2 size={13} /> Code
        </button>
        <button className={`tab ${tab === "preview" ? "active" : ""}`} onClick={() => setTab("preview")} disabled={!hasFiles}>
          <Eye size={13} /> Aperçu
        </button>
        {generating && (
          <span className="mono ml-auto flex items-center gap-2 pr-2 text-[11px] text-[color:var(--violet)]">
            <Loader2 size={12} className="animate-spin" /> l'IA travaille…
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {tab === "activity" && (
          <div className="h-full overflow-y-auto">
            <Timeline items={feed} />
            <div ref={feedEnd} />
            {error && !generating && (
              <div className="mx-4 mb-4 flex items-start gap-2 rounded-xl border border-[rgba(251,113,133,0.35)] bg-[rgba(251,113,133,0.07)] p-3.5 text-[12.5px] leading-relaxed text-[color:var(--err)]">
                <CircleAlert size={15} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold">La génération n'a pas abouti</p>
                  <p className="mt-0.5 text-[rgba(251,113,133,0.85)]">{error}</p>
                  <p className="mt-1 text-[color:var(--ink-3)]">Relancez la demande : l'étape échouera proprement si le moteur est de nouveau joignable.</p>
                </div>
              </div>
            )}
          </div>
        )}
        {tab === "code" && (
          selected && files[selected] ? (
            <CodeViewer path={selected} content={files[selected].content} language={files[selected].language} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-[13px] text-[color:var(--ink-3)]">Sélectionnez un fichier dans l'arborescence.</div>
          )
        )}
        {tab === "preview" && (
          <div className="h-full p-3">
            {project.previewable ? (
              <iframe
                key={`${project.id}-${project.version}`}
                className="preview-frame"
                sandbox="allow-scripts"
                src={`/api/projects/${project.id}/preview?v=${project.version}`}
                title="Aperçu réel du projet généré"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[color:var(--line-strong)] p-8 text-center">
                <Eye size={22} className="text-[color:var(--ink-3)]" />
                <p className="max-w-md text-[13px] font-medium text-[color:var(--ink-2)]">Pas de prévisualisation instantanée pour ce projet.</p>
                <p className="max-w-md text-[12px] leading-relaxed text-[color:var(--ink-3)]">
                  CodeForge n'affiche jamais de fausse preview. Ce projet requiert une installation/un build
                  (ou n'a pas de point d'entrée HTML statique). Exportez le ZIP puis lancez-le en suivant son README.
                </p>
                <a className="btn mt-1" href={`/api/projects/${project.id}/export`}><Download size={14} /> Exporter le ZIP</a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const sidePanel = (
    <SidePanel
      plan={plan}
      diff={diff}
      runs={runs}
      messages={messages}
      asking={asking}
      onAsk={ask}
      onRestore={restore}
      onOpenFile={(p) => { if (files[p]) { setSelected(p); setTab("code"); setMobilePanel("main"); } }}
    />
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ————— Header ————— */}
      <header className="flex items-center gap-2 border-b border-[color:var(--line)] bg-[rgba(10,10,16,0.75)] px-3 py-2.5 backdrop-blur-xl sm:gap-3 sm:px-4">
        <Link href="/" className="icon-btn" title="Retour à l'accueil"><ArrowLeft size={16} /></Link>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Hammer size={15} className="shrink-0 text-[color:var(--violet)]" />
          <input
            className="min-w-0 flex-1 bg-transparent font-display text-[15px] font-semibold outline-none"
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="badge hidden sm:inline-flex"><span className={`dot ${statusBadge.cls}`} />{statusBadge.txt}</span>
        </div>
        <div className="hidden md:block"><EngineBadge initial={initial.engine as never} compact /></div>
        <button
          className={`btn !px-3.5 !py-2 ${!hasFiles || generating ? "pointer-events-none opacity-40" : ""}`}
          onClick={runVerify}
          disabled={!hasFiles || verifying || generating}
          title="Exécuter l'outillage réel (npm install, build, tests) sur les fichiers actuels — reconstruit aussi la preview si possible. Aucun appel IA."
        >
          {verifying ? <Loader2 size={14} className="animate-spin" /> : <Hammer size={14} />}
          <span className="hidden sm:inline">{verifying ? "Build…" : "Vérifier"}</span>
        </button>
        <div className="relative">
          <button className="icon-btn" onClick={() => setShowSettings(!showSettings)} title="Réglages de génération"><Settings2 size={15} /></button>
          {showSettings && (
            <SettingsPopover
              fixCycles={project.settings.fixCycles}
              maxFiles={project.settings.maxFiles}
              runBuild={project.settings.runBuild}
              runTests={project.settings.runTests}
              onSave={saveSettings}
              onClose={() => setShowSettings(false)}
            />
          )}
        </div>
        <a
          className={`btn !px-3.5 !py-2 ${!hasFiles ? "pointer-events-none opacity-40" : ""}`}
          href={hasFiles ? `/api/projects/${project.id}/github-pages` : undefined}
          title={hasFiles ? "Export prêt pour GitHub Pages (.nojekyll, guide, et workflow Actions si un build est requis)" : "Rien à exporter pour l'instant"}
        >
          <GitBranch size={14} /> <span className="hidden sm:inline">Pages</span>
        </a>
        <a
          className={`btn !px-3.5 !py-2 ${!hasFiles ? "pointer-events-none opacity-40" : "btn-primary"}`}
          href={hasFiles ? `/api/projects/${project.id}/export` : undefined}
          title={hasFiles ? "Télécharger le ZIP (reconstruit à la demande)" : "Rien à exporter pour l'instant"}
        >
          <Download size={14} /> <span className="hidden sm:inline">ZIP</span>
        </a>
        <button className="icon-btn hover:!text-[color:var(--err)]" onClick={deleteProject} title="Supprimer le projet"><Trash2 size={15} /></button>
      </header>

      {/* ————— Mobile panel switcher ————— */}
      <div className="flex gap-1 border-b border-[color:var(--line)] px-3 py-1.5 lg:hidden">
        <button className={`tab ${mobilePanel === "files" ? "active" : ""}`} onClick={() => setMobilePanel("files")}><ListTree size={13} /> Fichiers</button>
        <button className={`tab ${mobilePanel === "main" ? "active" : ""}`} onClick={() => setMobilePanel("main")}><Braces size={13} /> Atelier</button>
        <button className={`tab ${mobilePanel === "side" ? "active" : ""}`} onClick={() => setMobilePanel("side")}><PanelRight size={13} /> Conception</button>
      </div>

      {/* ————— Body ————— */}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[248px_minmax(0,1fr)_310px]">
        <aside className={`min-h-0 border-r border-[color:var(--line)] bg-[rgba(255,255,255,0.012)] ${mobilePanel === "files" ? "block" : "hidden"} lg:block`}>
          {filesPanel}
        </aside>
        <main className={`min-h-0 bg-[rgba(255,255,255,0.008)] ${mobilePanel === "main" ? "block" : "hidden"} lg:block`}>
          {mainPanel}
        </main>
        <aside className={`min-h-0 border-l border-[color:var(--line)] bg-[rgba(255,255,255,0.012)] ${mobilePanel === "side" ? "block" : "hidden"} lg:block`}>
          {sidePanel}
        </aside>
      </div>

      {/* ————— Prompt bar ————— */}
      <div className="border-t border-[color:var(--line)] bg-[rgba(10,10,16,0.85)] px-3 py-3 backdrop-blur-xl sm:px-4">
        <div className="mx-auto flex max-w-4xl items-end gap-2">
          <div className="relative flex-1">
            <textarea
              className="textarea !rounded-2xl !py-3 pr-4 !text-[13.5px]"
              rows={1}
              placeholder={
                hasFiles
                  ? "Itérez sur ce projet : « ajoute une page de paramètres », « transforme le thème en rétro », « optimise la boucle de rendu »…"
                  : generating
                    ? "L'IA écrit le projet… vous pouvez préparer la suite ici."
                    : "Décrivez le projet à forger…"
              }
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 150) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && prompt.trim() && !generating) {
                  e.preventDefault();
                  const req = prompt.trim();
                  setPrompt("");
                  (e.target as HTMLTextAreaElement).style.height = "auto";
                  startForge(req, hasFiles ? "iterate" : "create");
                }
              }}
            />
          </div>
          {generating ? (
            <button className="btn btn-danger !rounded-2xl !px-4 !py-3" onClick={stopForge} title="Arrêter proprement la génération en cours">
              <Square size={13} /> <span className="hidden sm:inline">Stop</span>
            </button>
          ) : (
            <button
              className="btn btn-primary !rounded-2xl !px-4 !py-3"
              disabled={prompt.trim().length < 3}
              onClick={() => { const req = prompt.trim(); setPrompt(""); startForge(req, hasFiles ? "iterate" : "create"); }}
              title={hasFiles ? "Modifier le projet existant (itération chirurgicale)" : "Générer le projet"}
            >
              <SendHorizonal size={15} /> <span className="hidden sm:inline">{hasFiles ? "Itérer" : "Forger"}</span>
            </button>
          )}
        </div>
        <p className="mono mx-auto mt-2 max-w-4xl text-center text-[10px] text-[color:var(--ink-3)]">
          <Ban size={9} className="mr-1 inline" />
          Chaque itération analyse les fichiers réels et ne modifie que le nécessaire — jamais de réécriture complète sans raison.
        </p>
      </div>
    </div>
  );
}

function SettingsPopover({ fixCycles, maxFiles, runBuild, runTests, onSave, onClose }: {
  fixCycles: number; maxFiles: number; runBuild: boolean; runTests: boolean;
  onSave: (c: number, f: number, b: boolean, t: boolean) => void;
  onClose: () => void;
}) {
  const [cycles, setCycles] = useState(fixCycles);
  const [files, setFiles] = useState(maxFiles);
  const [build, setBuild] = useState(runBuild);
  const [tests, setTests] = useState(runTests);
  return (
    <motion.div
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="glass absolute right-0 top-11 z-50 w-76 p-4 shadow-2xl"
      style={{ width: 300 }}
    >
      <p className="panel-title mb-3">Réglages de génération</p>
      <label className="mb-3 block">
        <span className="mb-1 flex justify-between text-[12px] text-[color:var(--ink-2)]">
          Cycles d'auto-correction <span className="mono text-[color:var(--violet)]">{cycles}</span>
        </span>
        <input type="range" min={0} max={6} value={cycles} onChange={(e) => setCycles(Number(e.target.value))} className="w-full accent-[#8b7cff]" />
      </label>
      <label className="mb-3 block">
        <span className="mb-1 flex justify-between text-[12px] text-[color:var(--ink-2)]">
          Fichiers max par génération <span className="mono text-[color:var(--violet)]">{files}</span>
        </span>
        <input type="range" min={4} max={128} value={files} onChange={(e) => setFiles(Number(e.target.value))} className="w-full accent-[#8b7cff]" />
      </label>
      <label className="mb-2 flex cursor-pointer items-center justify-between gap-3 text-[12.5px] text-[color:var(--ink-2)]">
        <span>Vérifier avec le build réel (npm install + build)</span>
        <input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} className="h-4 w-4 accent-[#8b7cff]" />
      </label>
      <label className="mb-4 flex cursor-pointer items-center justify-between gap-3 text-[12.5px] text-[color:var(--ink-2)]">
        <span>Exécuter les tests réels (npm test)</span>
        <input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} className="h-4 w-4 accent-[#8b7cff]" />
      </label>
      <p className="mb-3 text-[10.5px] leading-relaxed text-[color:var(--ink-3)]">
        Le build/tests tournent dans un bac à sable isolé, sans variables d'environnement. Les erreurs réelles sont réinjectées dans l'auto-correction.
      </p>
      <div className="flex gap-2">
        <button className="btn btn-primary flex-1 !py-2 !text-[12.5px]" onClick={() => onSave(cycles, files, build, tests)}>Enregistrer</button>
        <button className="btn !py-2 !text-[12.5px]" onClick={onClose}>Fermer</button>
      </div>
    </motion.div>
  );
}
