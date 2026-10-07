"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowRight, Boxes, Braces, CircleCheckBig, FileArchive, FileCode2, FlaskConical, Layers,
  MessagesSquare, PackageOpen, Sparkles, TerminalSquare, Trash2, UploadCloud, Wand2, Zap,
} from "lucide-react";
import { EngineBadge, type EngineStatusLike } from "./engine-badge";

export interface ProjectCardData {
  id: string;
  name: string;
  description: string;
  status: string;
  previewable: boolean;
  version: number;
  updatedAt: string;
  fileCount: number;
  totalBytes: number;
  plan: { stack?: { language?: string; framework?: string } } | null;
}

const INSPIRATIONS = [
  "Une app qui transforme des fichiers CSV en graphiques interactifs directement dans le navigateur",
  "Un tableau blanc collaboratif minimaliste avec export PNG",
  "Un gestionnaire de raccourcis clavier personnalisés avec recherche floue",
  "Un simulateur de système solaire en canvas avec vitesses réglables",
  "Un outil qui génère des palettes de couleurs accessibles à partir d'une image",
  "Un tracker d'habitudes minimaliste avec statistiques hebdomadaires et localStorage",
];

const CAPABILITIES = [
  { icon: Sparkles, title: "Compréhension libre", desc: "Décrivez n'importe quelle idée — aucune catégorie imposée, aucun template." },
  { icon: Layers, title: "Architecture inventée", desc: "Stack, fichiers et dépendances choisis par l'IA pour chaque demande." },
  { icon: FileCode2, title: "Fichiers réels", desc: "Chaque fichier est véritablement écrit, complet, sans code placeholder." },
  { icon: FlaskConical, title: "Validation réelle", desc: "Analyse syntaxique (compilateur TypeScript), imports et dépendances vérifiés." },
  { icon: Wand2, title: "Auto-correction", desc: "Les erreurs détectées sont réparées automatiquement, en boucles configurables." },
  { icon: Boxes, title: "ZIP honnête", desc: "Construit dynamiquement depuis les fichiers réellement générés." },
  { icon: MessagesSquare, title: "Itération & Q&A", desc: "Modifiez le projet en langage naturel, interrogez son code." },
  { icon: PackageOpen, title: "Import de projets", desc: "Fournissez un ZIP existant : l'IA l'analyse et le modifie chirurgicalement." },
];

function relTime(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

function statusDot(status: string): { cls: string; label: string } {
  switch (status) {
    case "ready": return { cls: "dot-ok", label: "prêt" };
    case "generating": return { cls: "dot-warn", label: "en cours" };
    case "error": return { cls: "dot-err", label: "erreur" };
    case "cancelled": return { cls: "dot-idle", label: "annulé" };
    case "interrupted": return { cls: "dot-warn", label: "interrompu" };
    default: return { cls: "dot-idle", label: status };
  }
}

export function HomeClient({ projects, engine }: { projects: ProjectCardData[]; engine: EngineStatusLike | null }) {
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  const launch = useCallback(async () => {
    const req = request.trim();
    if (req.length < 4 || launching) return;
    setLaunching(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: req }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Échec de création du projet");
      router.push(`/workspace/${data.id}?autostart=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur inconnue");
      setLaunching(false);
    }
  }, [request, launching, router]);

  const importZip = async (file: File) => {
    setImporting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import impossible");
      router.push(`/workspace/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur d'import");
      setImporting(false);
    }
  };

  const removeProject = async (id: string, ev: React.MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    router.refresh();
  };

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-5 pb-24">
      {/* ————— Nav ————— */}
      <header className="flex items-center justify-between py-6 anim-fade-in">
        <div className="flex items-center gap-3">
          <div className="forge-orb" style={{ width: 38, height: 38 }}>
            <div className="ring" />
            <div className="core" style={{ inset: 8 }} />
          </div>
          <div>
            <span className="font-display text-lg font-bold tracking-tight">CodeForge</span>
            <span className="ml-2 hidden text-xs text-[color:var(--ink-3)] sm:inline">IA autonome de développement logiciel</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <EngineBadge initial={engine} />
          <button className="btn hidden sm:inline-flex" onClick={() => fileInput.current?.click()} disabled={importing}>
            {importing ? <span className="spinner" /> : <UploadCloud size={15} />}
            Importer un ZIP
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importZip(f);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {/* ————— Hero ————— */}
      <section className="mt-12 text-center sm:mt-20">
        <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 0.8, 0.3, 1] }}>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[color:var(--line)] bg-white/[0.03] px-4 py-1.5 text-xs text-[color:var(--ink-2)]">
            <Zap size={12} className="text-[color:var(--mint)]" />
            Aucun template. Aucune clé API. Que de la génération réelle.
          </div>
          <h1 className="font-display mx-auto max-w-3xl text-4xl font-bold leading-[1.06] tracking-tight sm:text-6xl">
            Décrivez un logiciel.
            <br />
            <span className="text-grad">L'IA le construit.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-[color:var(--ink-2)]">
            CodeForge conçoit l'architecture, écrit chaque fichier, valide la syntaxe, corrige ses erreurs
            et vous livre un projet complet en ZIP. Aucune limite de catégories.
          </p>
        </motion.div>

        <motion.div
          className="mx-auto mt-10 max-w-2xl"
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.65, delay: 0.12, ease: [0.22, 0.8, 0.3, 1] }}
        >
          <div className="hero-textarea-wrap">
            <textarea
              ref={ta}
              className="hero-textarea"
              rows={4}
              placeholder="Que voulez-vous construire ? Décrivez votre projet librement, aussi inhabituel soit-il…"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) launch();
              }}
              disabled={launching}
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-[color:var(--ink-3)]">
              <kbd className="kbd">⌘</kbd> + <kbd className="kbd">Entrée</kbd> pour lancer la forge
            </span>
            <button className="btn btn-primary" onClick={launch} disabled={request.trim().length < 4 || launching}>
              {launching ? <span className="spinner" /> : <ArrowRight size={16} />}
              {launching ? "Ouverture de l'atelier…" : "Forger le projet"}
            </button>
          </div>
          {error && (
            <div className="mt-4 rounded-xl border border-[rgba(251,113,133,0.35)] bg-[rgba(251,113,133,0.08)] px-4 py-3 text-left text-sm text-[color:var(--err)]">
              {error}
            </div>
          )}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {INSPIRATIONS.map((s) => (
              <button
                key={s}
                className="chip"
                onClick={() => {
                  setRequest(s);
                  ta.current?.focus();
                }}
              >
                <Sparkles size={11} className="text-[color:var(--violet)]" />
                {s.length > 58 ? s.slice(0, 58) + "…" : s}
              </button>
            ))}
          </div>
        </motion.div>
      </section>

      {/* ————— Pipeline ————— */}
      <section className="mt-20">
        <div className="mono mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[11px] text-[color:var(--ink-3)]">
          {["DEMANDE", "COMPRÉHENSION", "CONCEPTION", "ARCHITECTURE", "GÉNÉRATION", "VALIDATION", "CORRECTION", "PROJET + ZIP"].map((s, i, arr) => (
            <span key={s} className="flex items-center gap-3">
              <span className={i === 0 || i === arr.length - 1 ? "text-[color:var(--ink-2)]" : ""}>{s}</span>
              {i < arr.length - 1 && <span className="text-[color:var(--violet)]">→</span>}
            </span>
          ))}
        </div>
      </section>

      {/* ————— Capabilities ————— */}
      <section className="mt-14 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {CAPABILITIES.map((c, i) => (
          <motion.div
            key={c.title}
            className="glass glass-hover p-5"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ duration: 0.45, delay: (i % 4) * 0.06 }}
          >
            <c.icon size={18} className="text-[color:var(--violet)]" />
            <h3 className="font-display mt-3 text-[14px] font-semibold">{c.title}</h3>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">{c.desc}</p>
          </motion.div>
        ))}
      </section>

      {/* ————— Projects ————— */}
      <section className="mt-20">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <p className="panel-title mb-1">Atelier</p>
            <h2 className="font-display text-2xl font-bold tracking-tight">Vos projets</h2>
          </div>
          <span className="mono text-xs text-[color:var(--ink-3)]">{projects.length} projet{projects.length > 1 ? "s" : ""}</span>
        </div>

        {projects.length === 0 ? (
          <div className="glass flex flex-col items-center gap-3 px-6 py-16 text-center">
            <TerminalSquare size={26} className="text-[color:var(--ink-3)]" />
            <p className="text-sm text-[color:var(--ink-2)]">Aucun projet pour l'instant.</p>
            <p className="max-w-sm text-xs leading-relaxed text-[color:var(--ink-3)]">
              Écrivez une demande ci-dessus ou importez un ZIP existant : le workspace apparaîtra ici,
              avec ses fichiers, ses versions et son historique.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p, i) => {
              const st = statusDot(p.status);
              return (
                <motion.a
                  key={p.id}
                  href={`/workspace/${p.id}`}
                  className="glass glass-hover group relative block p-5"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: Math.min(i * 0.05, 0.4) }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-display truncate text-[15px] font-semibold">{p.name}</h3>
                      <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
                        {p.description || "Projet forgé par CodeForge"}
                      </p>
                    </div>
                    <button
                      className="icon-btn -mr-1 -mt-1 shrink-0 opacity-0 transition group-hover:opacity-100"
                      onClick={(e) => removeProject(p.id, e)}
                      title="Supprimer le projet"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-[color:var(--ink-3)]">
                    <span className="badge">
                      <span className={`dot ${st.cls}`} />
                      {st.label}
                    </span>
                    {p.plan?.stack?.language && (
                      <span className="badge"><Braces size={11} />{p.plan.stack.language}{p.plan.stack.framework ? ` · ${p.plan.stack.framework}` : ""}</span>
                    )}
                    <span className="mono">{p.fileCount} fichiers</span>
                    {p.version > 0 && <span className="mono">v{p.version}</span>}
                    {p.previewable && (
                      <span className="badge"><CircleCheckBig size={11} className="text-[color:var(--mint)]" />preview</span>
                    )}
                  </div>
                  <div className="mono mt-3 text-[10.5px] text-[color:var(--ink-3)]">{relTime(p.updatedAt)}</div>
                </motion.a>
              );
            })}
          </div>
        )}
      </section>

      <footer className="mt-24 flex flex-col items-center gap-2 border-t border-[color:var(--line)] pt-8 text-center">
        <p className="mono text-[11px] text-[color:var(--ink-3)]">
          CodeForge ne prétend jamais : chaque étape affichée correspond à un travail réellement exécuté.
        </p>
        <p className="mono text-[11px] text-[color:var(--ink-3)]">
          <FileArchive size={11} className="mr-1 inline" />
          Les ZIP sont reconstruits depuis vos fichiers à chaque téléchargement.
        </p>
      </footer>
    </div>
  );
}
