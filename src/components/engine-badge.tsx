"use client";

import { useEffect, useState } from "react";
import { Cpu, RefreshCw } from "lucide-react";

export interface EngineStatusLike {
  ok: boolean;
  active: { id: string; label: string; kind: string; model?: string; detail?: string; latencyMs?: number } | null;
  providers: { id: string; label: string; kind: string; available: boolean; detail?: string }[];
}

/** Live engine badge — always shows the REAL detected engine state. */
export function EngineBadge({ initial, compact = false }: { initial: EngineStatusLike | null; compact?: boolean }) {
  const [status, setStatus] = useState<EngineStatusLike | null>(initial);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (status) return;
    fetch("/api/engine").then((r) => r.json()).then(setStatus).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheck = async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/engine?force=1");
      setStatus(await r.json());
    } finally {
      setChecking(false);
    }
  };

  const active = status?.active;
  const dot = !status ? "dot-idle" : status.ok ? "dot-ok" : "dot-err";
  const label = !status
    ? "Détection du moteur…"
    : active
      ? compact
        ? active.model ?? active.label
        : `${active.label}${active.model ? ` · ${active.model}` : ""}`
      : "Aucun moteur IA";

  return (
    <div className="badge" title={active?.detail ?? (status && !status.ok ? "Aucun moteur local détecté et service communautaire injoignable. Vérifiez la connexion." : undefined)}>
      <span className={`dot ${dot}`} />
      <Cpu size={12} strokeWidth={2.2} />
      <span className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      <button
        onClick={recheck}
        className="ml-1 inline-flex items-center justify-center rounded-full p-0.5 text-[color:var(--ink-3)] transition hover:text-[color:var(--ink)]"
        title="Re-détecter les moteurs"
        aria-label="Re-détecter"
      >
        <RefreshCw size={11} className={checking ? "animate-spin" : ""} />
      </button>
    </div>
  );
}
