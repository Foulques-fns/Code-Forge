"use client";

import {
  AlertTriangle, CheckCircle2, Compass, FileCode2, GitCompareArrows, Info, Package, ShieldCheck,
  Sparkles, StopCircle, Terminal, Wrench, XCircle, CircleCheckBig, BookOpenText, Workflow, Hammer,
} from "lucide-react";

export interface FeedItem {
  key: string;
  kind: "step" | "phase" | "verify" | "file" | "plan" | "issues" | "fix" | "diff" | "done" | "error" | "cancelled" | "log";
  step?: string;
  label: string;
  status: "active" | "done" | "error" | "skipped";
  detail?: string;
  ms?: number;
  at?: string;
}

const STEP_META: Record<string, { icon: React.ElementType; title: string }> = {
  plan: { icon: Compass, title: "Compréhension & conception" },
  generate: { icon: FileCode2, title: "Génération des fichiers" },
  validate: { icon: ShieldCheck, title: "Validation réelle" },
  fix: { icon: Wrench, title: "Auto-correction" },
  verify: { icon: Hammer, title: "Build & tests réels" },
  readme: { icon: BookOpenText, title: "Documentation" },
  package: { icon: Package, title: "Packaging ZIP" },
};

function icon(it: FeedItem) {
  if (it.kind === "step" && it.step && STEP_META[it.step]) return STEP_META[it.step].icon;
  switch (it.kind) {
    case "plan": return Sparkles;
    case "phase": return Workflow;
    case "verify": return Hammer;
    case "file": return FileCode2;
    case "issues": return it.status === "error" ? AlertTriangle : CircleCheckBig;
    case "fix": return Wrench;
    case "diff": return GitCompareArrows;
    case "done": return CircleCheckBig;
    case "error": return XCircle;
    case "cancelled": return StopCircle;
    case "log": return Terminal;
    default: return Info;
  }
}

function statusCls(s: FeedItem["status"]) {
  return s === "active" ? "active" : s === "error" ? "error" : s === "done" ? "done" : "";
}

function timeOf(at?: string) {
  if (!at) return "";
  try {
    return new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return ""; }
}

export function Timeline({ items }: { items: FeedItem[] }) {
  if (!items.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <Terminal size={22} className="text-[color:var(--ink-3)]" />
        <p className="max-w-xs text-[13px] leading-relaxed text-[color:var(--ink-2)]">
          Aucune génération pour l'instant. Décrivez une demande dans la barre ci-dessous :
          chaque étape réelle apparaîtra ici, au fil du travail de l'IA.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1 p-4">
      {items.map((it) => {
        const Icon = icon(it);
        const isStep = it.kind === "step";
        return (
          <div key={it.key} className={`tl-row ${isStep ? "pt-2" : ""}`}>
            <span className={`tl-ico ${statusCls(it.status)}`}>
              {it.status === "active" ? <span className="spinner" style={{ width: 10, height: 10 }} /> : <Icon size={11} />}
            </span>
            <div className={`flex items-baseline gap-2 ${isStep ? "pb-1.5 pt-1" : "py-[3px]"}`}>
              <span
                className={
                  isStep
                    ? "font-display text-[13px] font-semibold text-[color:var(--ink)]"
                    : it.status === "error"
                      ? "text-[12.5px] text-[color:var(--err)]"
                      : it.status === "skipped"
                        ? "text-[12.5px] text-[color:var(--ink-3)] line-through"
                        : "text-[12.5px] text-[color:var(--ink-2)]"
                }
              >
                {it.kind === "step" && it.step && STEP_META[it.step] ? STEP_META[it.step].title : it.label}
              </span>
              {it.ms != null && <span className="mono text-[10px] text-[color:var(--ink-3)]">{(it.ms / 1000).toFixed(1)} s</span>}
              {it.at && <span className="mono ml-auto text-[10px] text-[color:var(--ink-3)]">{timeOf(it.at)}</span>}
            </div>
            {isStep && it.label && it.label !== (STEP_META[it.step ?? ""]?.title ?? "") && (
              <p className="-mt-0.5 pb-1 text-[11.5px] leading-relaxed text-[color:var(--ink-3)]">{it.label}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
