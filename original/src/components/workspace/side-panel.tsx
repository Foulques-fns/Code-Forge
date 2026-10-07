"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownUp, CircleHelp, ClipboardCheck, Cpu, FileDiff, FileMinus2, FilePlus2, FilePenLine, History,
  Lightbulb, Network, RotateCcw, SendHorizonal,
} from "lucide-react";

export interface DiffData {
  added: string[];
  modified: string[];
  deleted: string[];
  stats: { files: number; bytes: number; linesAdded: number; linesRemoved: number };
}

export interface PlanData {
  description?: string;
  summary?: string;
  architecture?: string;
  features?: string[];
  stack?: { language?: string; framework?: string; runtime?: string; packageManager?: string; buildTool?: string; styling?: string };
}

export interface RunInfo {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  stats?: {
    files?: number;
    durationMs?: number;
    engine?: string;
    verdict?: string;
    report?: string;
    build?: { ran: boolean; ok: boolean | null; rounds?: number; skippedReason?: string; commands?: { label: string; code: number; ms: number }[] };
    archContext?: {
      routes?: string[];
      models?: string[];
      envVars?: string[];
      entryPoints?: string[];
      stack?: { language?: string; framework?: string; buildTool?: string; runtime?: string; packageManager?: string };
    };
  } | null;
}

/** Tiny markdown renderer for the generation report (headings, lists, bold, code). */
function MdLite({ text }: { text: string }) {
  return (
    <div className="space-y-1.5">
      {text.split("\n").map((line, i) => {
        if (line.startsWith("### ")) return <h4 key={i} className="font-display pt-1 text-[12px] font-bold text-[color:var(--ink)]">{line.slice(4)}</h4>;
        if (line.startsWith("## ")) return <h3 key={i} className="font-display text-[13px] font-bold text-[color:var(--ink)]">{line.slice(3)}</h3>;
        if (line.startsWith("- ")) {
          return (
            <p key={i} className="flex gap-2 pl-1 text-[11.5px] leading-relaxed text-[color:var(--ink-2)]">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[color:var(--violet)]" />
              <InlineMd t={line.slice(2)} />
            </p>
          );
        }
        if (!line.trim()) return null;
        return <p key={i} className="text-[11.5px] leading-relaxed text-[color:var(--ink-2)]"><InlineMd t={line} /></p>;
      })}
    </div>
  );
}
function InlineMd({ t }: { t: string }) {
  const parts = t.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") ? <strong key={i} className="text-[color:var(--ink)]">{p.slice(2, -2)}</strong>
        : p.startsWith("`") ? <code key={i} className="mono rounded bg-white/[0.06] px-1 text-[10.5px]">{p.slice(1, -1)}</code>
        : <span key={i}>{p}</span>
      )}
    </>
  );
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta?: { kind?: string; references?: { path: string; role: string }[] } | null;
  createdAt?: string;
}

function Section({ icon: Icon, title, right, children, defaultOpen = true }: {
  icon: React.ElementType; title: string; right?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-[color:var(--line)]">
      <button className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen(!open)}>
        <Icon size={13} className="text-[color:var(--violet)]" />
        <span className="panel-title">{title}</span>
        <span className="ml-auto">{right}</span>
        <span className={`text-[color:var(--ink-3)] transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

export function SidePanel({
  plan, diff, runs, messages, onAsk, asking, onRestore, onOpenFile,
}: {
  plan: PlanData | null;
  diff: DiffData | null;
  runs: RunInfo[];
  messages: ChatMsg[];
  onAsk: (q: string) => void;
  asking: boolean;
  onRestore: (runId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const chatEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, asking]);

  const latest = runs.find((r) => r.status === "done") ?? null;
  const report = latest?.stats?.report ?? null;
  const arch = latest?.stats?.archContext ?? null;
  const build = latest?.stats?.build ?? null;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* ——— Verdict & report ——— */}
      {(report || build) && (
        <Section icon={ClipboardCheck} title="Rapport de génération" defaultOpen={true}>
          <div className="space-y-3">
            {latest?.stats?.verdict && (
              <p className={`rounded-lg border px-3 py-2 text-[12px] font-semibold ${
                latest.stats.verdict === "VALIDÉ"
                  ? "border-[rgba(52,211,153,0.35)] bg-[rgba(52,211,153,0.08)] text-[color:var(--ok)]"
                  : latest.stats.verdict.startsWith("PARTIEL")
                    ? "border-[rgba(251,113,133,0.35)] bg-[rgba(251,113,133,0.08)] text-[color:var(--err)]"
                    : "border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.08)] text-[color:var(--warn)]"
              }`}>
                {latest.stats.verdict}
              </p>
            )}
            {build && (
              <div className="space-y-1.5">
                <div className="mono flex flex-wrap gap-2 text-[10.5px]">
                  <span className={`badge ${build.ok ? "!text-[color:var(--ok)]" : build.ran ? "!text-[color:var(--err)]" : ""}`}>
                    {build.ran ? (build.ok ? `toolchain validée${build.rounds && build.rounds > 1 ? ` (${build.rounds} rounds)` : ""}` : "toolchain en échec") : "non exécutée"}
                  </span>
                </div>
                {!!build.commands?.length && (
                  <div className="space-y-1">
                    {build.commands.slice(-8).map((c, i) => (
                      <div key={i} className="mono flex items-center gap-2 text-[10px] text-[color:var(--ink-3)]">
                        <span className={c.code === 0 ? "text-[color:var(--ok)]" : "text-[color:var(--err)]"}>{c.code === 0 ? "✓" : "✗"}</span>
                        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{c.label}</span>
                        <span>{(c.ms / 1000).toFixed(0)} s</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {report && <MdLite text={report} />}
            {!report && !build?.ran && build?.skippedReason && (
              <p className="text-[11.5px] text-[color:var(--ink-3)]">{build.skippedReason}</p>
            )}
          </div>
        </Section>
      )}

      {/* ——— Detected architecture ——— */}
      {arch && (arch.routes?.length || arch.models?.length || arch.envVars?.length) ? (
        <Section icon={Network} title="Architecture détectée" defaultOpen={false}>
          <div className="space-y-2 text-[11.5px] text-[color:var(--ink-2)]">
            {!!arch.entryPoints?.length && <p><span className="text-[color:var(--ink-3)]">Entrées : </span>{arch.entryPoints.join(" · ")}</p>}
            {!!arch.routes?.length && (
              <div className="flex flex-wrap gap-1">
                {arch.routes.slice(0, 14).map((r) => <span key={r} className="badge !text-[10px]">{r}</span>)}
              </div>
            )}
            {!!arch.models?.length && <p><span className="text-[color:var(--ink-3)]">Modèles : </span>{arch.models.join(", ")}</p>}
            {!!arch.envVars?.length && <p><span className="text-[color:var(--ink-3)]">Env : </span><span className="mono text-[10.5px]">{arch.envVars.join(", ")}</span></p>}
          </div>
        </Section>
      ) : null}

      {/* ——— Plan ——— */}
      <Section icon={Lightbulb} title="Conception" defaultOpen={true}>
        {!plan ? (
          <p className="text-[12px] leading-relaxed text-[color:var(--ink-3)]">
            Le plan architectural apparaîtra ici dès la première génération : stack choisie,
            fonctionnalités, fichier par fichier.
          </p>
        ) : (
          <div className="space-y-3">
            {(plan.description || plan.summary) && (
              <p className="text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">{plan.description || plan.summary}</p>
            )}
            {plan.stack && (
              <div className="flex flex-wrap gap-1.5">
                {[plan.stack.language, plan.stack.framework, plan.stack.runtime, plan.stack.packageManager !== "none" && plan.stack.packageManager, plan.stack.styling !== "none" && plan.stack.styling && `style: ${plan.stack.styling}`]
                  .filter(Boolean)
                  .map((s, i) => (
                    <span key={i} className="badge"><Cpu size={10} />{String(s)}</span>
                  ))}
              </div>
            )}
            {!!plan.features?.length && (
              <ul className="space-y-1">
                {plan.features.slice(0, 10).map((f, i) => (
                  <li key={i} className="flex gap-2 text-[12px] leading-snug text-[color:var(--ink-2)]">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[color:var(--mint)]" />
                    {f}
                  </li>
                ))}
              </ul>
            )}
            {plan.architecture && (
              <p className="rounded-lg border border-[color:var(--line)] bg-white/[0.02] p-3 text-[11.5px] leading-relaxed text-[color:var(--ink-3)]">
                {plan.architecture}
              </p>
            )}
          </div>
        )}
      </Section>

      {/* ——— Diff ——— */}
      <Section icon={FileDiff} title="Dernières modifications" defaultOpen={!!diff}>
        {!diff ? (
          <p className="text-[12px] text-[color:var(--ink-3)]">Fichiers ajoutés, modifiés ou supprimés par la dernière génération.</p>
        ) : (
          <div className="space-y-2">
            <div className="mono flex gap-3 text-[11px] text-[color:var(--ink-3)]">
              <span className="text-[color:var(--ok)]">+{diff.stats.linesAdded}</span>
              <span className="text-[color:var(--err)]">−{diff.stats.linesRemoved}</span>
              <span>{diff.stats.files} fichier(s) touché(s)</span>
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {diff.added.map((p) => (
                <button key={"a" + p} onClick={() => onOpenFile(p)} className="tree-item w-full text-left !text-[11.5px]">
                  <FilePlus2 size={12} className="shrink-0 text-[color:var(--ok)]" />
                  <span className="overflow-hidden text-ellipsis">{p}</span>
                </button>
              ))}
              {diff.modified.map((p) => (
                <button key={"m" + p} onClick={() => onOpenFile(p)} className="tree-item w-full text-left !text-[11.5px]">
                  <FilePenLine size={12} className="shrink-0 text-[color:var(--violet)]" />
                  <span className="overflow-hidden text-ellipsis">{p}</span>
                </button>
              ))}
              {diff.deleted.map((p) => (
                <div key={"d" + p} className="tree-item !text-[11.5px] line-through opacity-60">
                  <FileMinus2 size={12} className="shrink-0 text-[color:var(--err)]" />
                  <span className="overflow-hidden text-ellipsis">{p}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* ——— Q&A ——— */}
      <Section icon={CircleHelp} title="Interroger le projet" defaultOpen={true}>
        <div className="space-y-2.5">
          <div className="max-h-72 space-y-2.5 overflow-y-auto pr-1">
            {messages.filter((m) => m.meta?.kind === "question" || m.meta?.kind === "answer").length === 0 && (
              <p className="text-[12px] leading-relaxed text-[color:var(--ink-3)]">
                Posez une question sur le code réel : « où se trouve la logique de validation ? »,
                « quel fichier gère l'état ? »…
              </p>
            )}
            {messages
              .filter((m) => m.meta?.kind === "question" || m.meta?.kind === "answer")
              .slice(-14)
              .map((m) => (
                <div key={m.id} className={m.role === "user" ? "ml-6" : "mr-2"}>
                  <div
                    className={`rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
                      m.role === "user"
                        ? "bg-[rgba(139,124,255,0.14)] text-[color:var(--ink)]"
                        : "border border-[color:var(--line)] bg-white/[0.02] text-[color:var(--ink-2)]"
                    }`}
                  >
                    {m.content}
                  </div>
                  {!!m.meta?.references?.length && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {m.meta.references.map((r) => (
                        <button key={r.path} className="chip !py-0.5 !text-[10.5px]" onClick={() => onOpenFile(r.path)} title={r.role}>
                          {r.path}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            {asking && (
              <div className="flex items-center gap-2 text-[12px] text-[color:var(--ink-3)]">
                <span className="spinner" /> Analyse des fichiers réels…
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          <div className="flex gap-2">
            <input
              className="input !rounded-xl !py-2 !text-[12.5px]"
              placeholder="Question sur ce projet…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) { onAsk(q.trim()); setQ(""); } }}
              disabled={asking}
            />
            <button className="icon-btn shrink-0 !border-[color:var(--line)]" disabled={asking || !q.trim()} onClick={() => { onAsk(q.trim()); setQ(""); }}>
              <SendHorizonal size={14} />
            </button>
          </div>
        </div>
      </Section>

      {/* ——— Versions ——— */}
      <Section icon={History} title="Versions" defaultOpen={false} right={<span className="mono text-[10px] text-[color:var(--ink-3)]">{runs.length}</span>}>
        {runs.length === 0 ? (
          <p className="text-[12px] text-[color:var(--ink-3)]">Chaque génération réussie crée une version restaurable.</p>
        ) : (
          <div className="space-y-1.5">
            {runs.map((r, i) => (
              <div key={r.id} className="flex items-center gap-2 rounded-lg border border-[color:var(--line)] bg-white/[0.02] px-3 py-2">
                <ArrowDownUp size={12} className="shrink-0 text-[color:var(--ink-3)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-[11.5px] font-medium text-[color:var(--ink-2)]">
                    {r.kind === "import" ? "Import ZIP" : r.kind === "create" ? "Création" : "Itération"} · {r.status === "done" ? "terminée" : r.status}
                  </p>
                  <p className="mono text-[10px] text-[color:var(--ink-3)]">
                    {new Date(r.startedAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    {r.stats?.files ? ` · ${r.stats.files} fichiers` : ""}
                  </p>
                </div>
                {i > 0 && r.status === "done" && (
                  <button className="icon-btn !h-7 !w-7" title="Restaurer cet instantané" onClick={() => onRestore(r.id)}>
                    <RotateCcw size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
