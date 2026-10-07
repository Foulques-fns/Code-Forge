import type {
  AIProvider,
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  EngineStatus,
  ProviderStatus,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function withTimeout(ms: number, outer?: AbortSignal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`timeout after ${ms}ms`)), ms);
  const onAbort = () => ctrl.abort(outer?.reason ?? new Error("aborted"));
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(t);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Slot-based concurrency limiter (NOT a serializer): up to `parallel`
 * requests in flight, with a minimum gap between starts. The gateway's free
 * pool has per-MODEL quotas, so bounded parallelism is safe — and turns a
 * 10-file project from ~10 sequential waits into ~3. Single-threaded JS makes
 * the slot accounting race-free.
 */
function makeGated<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { parallel: number; minGapMs: number }
) {
  let active = 0;
  let lastStart = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const waiters: (() => void)[] = [];

  const pump = () => {
    timer = null;
    while (waiters.length > 0 && active < opts.parallel) {
      const since = Date.now() - lastStart;
      if (since < opts.minGapMs) {
        if (!timer) timer = setTimeout(pump, opts.minGapMs - since);
        return;
      }
      active++;
      lastStart = Date.now();
      waiters.shift()!();
    }
  };
  const acquire = () =>
    new Promise<void>((res) => {
      waiters.push(res);
      pump();
    });
  const release = () => {
    active--;
    if (!timer) timer = setTimeout(pump, Math.max(0, opts.minGapMs - (Date.now() - lastStart)));
  };
  return async (...args: A): Promise<R> => {
    await acquire();
    try {
      return await fn(...args);
    } finally {
      release();
    }
  };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal) {
  const { signal, clear } = withTimeout(timeoutMs, outer);
  try {
    const res = await fetch(url, { ...init, signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(res.status, `${res.status} ${res.statusText} — ${body.slice(0, 240)}`);
    }
    return await res.json();
  } finally {
    clear();
  }
}

/** POST to an OpenAI-compatible /chat/completions endpoint. We only ever read
 *  `choices[0].message.content` — provider "reasoning" fields are discarded. */
async function openAICompatible(
  baseUrl: string,
  apiKey: string | null,
  model: string,
  messages: ChatMessage[],
  opts: CompletionOptions,
  extraHeaders: Record<string, string> = {},
  extraBody: Record<string, unknown> = {},
  timeoutMs = 150_000
): Promise<CompletionResult> {
  const started = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const json = await fetchJson(
    `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.4,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...extraBody,
      }),
    },
    timeoutMs,
    opts.signal
  );
  const choice = json?.choices?.[0];
  const text: string | undefined = choice?.message?.content;
  const reasoning: string = typeof choice?.message?.reasoning === "string" ? choice.message.reasoning : "";
  const finishReason: string | undefined = choice?.finish_reason;
  if (typeof text !== "string" || !text.trim()) {
    // Reasoning-starved model: it burned the whole budget thinking and returned
    // nothing usable. Callers rotate MODEL (fast) instead of blaming the provider.
    if (reasoning.length > 200 || finishReason === "length") {
      return { text: "", model: json?.model ?? model, latencyMs: Date.now() - started, finishReason, reasoningStarved: true };
    }
    throw new Error("Réponse du moteur vide ou malformée.");
  }
  return { text, model: json?.model ?? model, latencyMs: Date.now() - started, finishReason };
}

/* ------------------------------------------------------------------ */
/*  Provider : explicit environment configuration (invisible for UX)   */
/* ------------------------------------------------------------------ */

interface EnvSpec {
  keyEnv: string;
  baseUrl: string;
  models: string[];
  label: string;
  headers?: Record<string, string>;
}

const ENV_SPECS: EnvSpec[] = [
  {
    keyEnv: "CODEFORGE_AI_KEY",
    baseUrl: process.env.CODEFORGE_AI_BASE_URL ?? "https://api.openai.com/v1",
    models: [process.env.CODEFORGE_AI_MODEL ?? "gpt-4o-mini"],
    label: "Moteur configuré (serveur)",
  },
  { keyEnv: "OPENAI_API_KEY", baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", models: ["gpt-4o-mini", "gpt-4o"], label: "OpenAI (clé serveur)" },
  { keyEnv: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", models: ["meta-llama/llama-3.3-70b-instruct", "meta-llama/llama-3.1-8b-instruct"], label: "OpenRouter (clé serveur)" },
  { keyEnv: "GROQ_API_KEY", baseUrl: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], label: "Groq (clé serveur)" },
  { keyEnv: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-coder"], label: "DeepSeek (clé serveur)" },
  { keyEnv: "MISTRAL_API_KEY", baseUrl: "https://api.mistral.ai/v1", models: ["mistral-small-latest", "mistral-medium-latest"], label: "Mistral (clé serveur)" },
  { keyEnv: "TOGETHER_API_KEY", baseUrl: "https://api.together.xyz/v1", models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"], label: "Together (clé serveur)" },
];

function makeEnvProvider(spec: EnvSpec, priority: number): AIProvider {
  const key = () => process.env[spec.keyEnv] ?? null;
  return {
    id: `env:${spec.keyEnv}`,
    label: spec.label,
    kind: "env",
    priority,
    async detect(): Promise<ProviderStatus> {
      const base = { id: this.id, label: this.label, kind: this.kind } as const;
      if (!key()) return { ...base, available: false, detail: "aucune clé d'environnement" };
      // Honest probe: 1-token completion. Falls through to next provider if broken.
      const started = Date.now();
      for (const model of spec.models) {
        try {
          await openAICompatible(spec.baseUrl, key(), model, [{ role: "user", content: "ping" }], { maxTokens: 1 });
          return { ...base, available: true, model, latencyMs: Date.now() - started, detail: "clé détectée dans l'environnement serveur" };
        } catch {
          /* try next model */
        }
      }
      return { ...base, available: false, detail: "clé présente mais le moteur ne répond pas" };
    },
    async complete(messages, opts = {}) {
      let lastErr: unknown = null;
      for (const model of spec.models) {
        try {
          return await openAICompatible(spec.baseUrl, key(), model, messages, opts, spec.headers ?? {});
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("Moteur indisponible");
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Provider : Ollama-style local engine (auto-detected, zero config)  */
/* ------------------------------------------------------------------ */

const LOCAL_MODEL_PREFS = [
  "qwen2.5-coder",
  "deepseek-coder",
  "codellama",
  "codegemma",
  "starcoder2",
  "llama3.3",
  "llama3.2",
  "llama3.1",
  "llama3",
  "mistral",
  "phi",
];

function pickLocalModel(names: string[]): string | null {
  for (const pref of LOCAL_MODEL_PREFS) {
    const hit = names.find((n) => n.toLowerCase().includes(pref));
    if (hit) return hit;
  }
  return names[0] ?? null;
}

function makeOllamaProvider(): AIProvider {
  const base = () => process.env.CODEFORGE_LOCAL_AI_URL ?? "http://127.0.0.1:11434";
  let model: string | null = null;
  return {
    id: "local:ollama",
    label: "Moteur IA local",
    kind: "local",
    priority: 20,
    async detect() {
      const started = Date.now();
      try {
        const json = await fetchJson(`${base()}/api/tags`, { method: "GET" }, 1500);
        const names: string[] = (json?.models ?? []).map((m: { name?: string }) => m?.name ?? "").filter(Boolean);
        model = pickLocalModel(names);
        if (!model) return { id: this.id, label: this.label, kind: this.kind, available: false, detail: "moteur local détecté mais aucun modèle installé" };
        return { id: this.id, label: this.label, kind: this.kind, available: true, model, latencyMs: Date.now() - started, detail: "exécution 100% locale — auto-détecté" };
      } catch {
        return { id: this.id, label: this.label, kind: this.kind, available: false, detail: "aucun moteur local détecté" };
      }
    },
    async complete(messages, opts = {}) {
      const started = Date.now();
      if (!model) {
        const st = await this.detect();
        if (!st.available) throw new Error(st.detail ?? "moteur local indisponible");
      }
      const json = await fetchJson(
        `${base()}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            options: { temperature: opts.temperature ?? 0.4, ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}) },
          }),
        },
        300_000,
        opts.signal
      );
      const text: string | undefined = json?.message?.content;
      if (typeof text !== "string") throw new Error("Réponse du moteur local malformée.");
      return { text, model: model ?? "local", latencyMs: Date.now() - started };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Provider : LM-Studio-style local server (OpenAI-compatible)        */
/* ------------------------------------------------------------------ */

function makeLocalServerProvider(): AIProvider {
  const base = () => process.env.CODEFORGE_LOCAL_OPENAI_URL ?? "http://127.0.0.1:1234/v1";
  let model: string | null = null;
  return {
    id: "local:openai-server",
    label: "Serveur IA local (OpenAI-compatible)",
    kind: "local",
    priority: 30,
    async detect() {
      const started = Date.now();
      try {
        const json = await fetchJson(`${base()}/models`, { method: "GET" }, 1500);
        const names: string[] = (json?.data ?? []).map((m: { id?: string }) => m?.id ?? "").filter(Boolean);
        model = pickLocalModel(names);
        if (!model) return { id: this.id, label: this.label, kind: this.kind, available: false, detail: "serveur local sans modèle chargé" };
        return { id: this.id, label: this.label, kind: this.kind, available: true, model, latencyMs: Date.now() - started, detail: "exécution 100% locale — auto-détecté" };
      } catch {
        return { id: this.id, label: this.label, kind: this.kind, available: false, detail: "non détecté" };
      }
    },
    async complete(messages, opts = {}) {
      if (!model) {
        const st = await this.detect();
        if (!st.available) throw new Error(st.detail ?? "serveur local indisponible");
      }
      return openAICompatible(base(), null, model!, messages, opts);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Provider : free anonymous gateway (no key, no signup, no install)  */
/*  Auto-routes across a pool of free models. Primary zero-config engine. */
/* ------------------------------------------------------------------ */

function makeFreeGatewayProvider(): AIProvider {
  const base = () => process.env.CODEFORGE_GATEWAY_URL ?? "https://api.kilo.ai/api/gateway";
  // PINNED to a verified non-reasoning, code-specialised free route.
  // The auto-router can land on reasoning models that burn their whole token
  // budget thinking and return EMPTY content (measured: 37 KB reasoning, 0 content,
  // finish_reason "length") — unusable for code generation. `reasoning_effort`
  // is ignored by those models, so pinning is the only reliable fix.
  const primary = () => process.env.CODEFORGE_GATEWAY_MODEL ?? "poolside/laguna-s-2.1:free";
  // Wide pool: every free route has its OWN quota, so rotation is the cheapest
  // way to stay alive. `kilo-auto/free` is last — it can route to reasoning
  // models that return empty content.
  const fallbacks = (process.env.CODEFORGE_GATEWAY_FALLBACK_MODELS ??
    [
      "poolside/laguna-xs-2.1:free",
      "qwen/qwen3.8-27b:free",
      "stepfun/step-3.7-flash:free",
      "nvidia/nemotron-3.5-lightning:free",
      "inclusionai/ling-3.0-flash-sante:free",
      "liquid/lfm-2.5-2.6b:free",
      "dots-studio/dots-3-note-preview:free",
      "thinkingmachines/inkling-small:free",
      "kilo-auto/free",
    ].join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  const pool = Array.from(new Set([primary(), ...fallbacks]));

  const call = (model: string, messages: ChatMessage[], opts: CompletionOptions) =>
    openAICompatible(
      base(),
      null,
      model,
      messages,
      { temperature: opts.temperature ?? 0.4, maxTokens: opts.maxTokens, signal: opts.signal },
      {},
      {},
      Number(process.env.CODEFORGE_GATEWAY_TIMEOUT_MS ?? 240_000)
    );

  /**
   * Try models in order, rotating on the two failure modes that are
   * MODEL-specific rather than gateway-specific:
   *  - reasoning-starvation (empty content, budget burned on thinking)
   *  - per-model quota (429) — each free route has its own rate limit
   */
  const gated = makeGated(
    async (messages: ChatMessage[], opts: CompletionOptions = {}) => {
      const notes: string[] = [];
      for (const model of pool) {
        if (opts.signal?.aborted) throw new Error("Annulé par l'utilisateur");
        try {
          const res = await call(model, messages, opts);
          if (!res.reasoningStarved) return res;
          notes.push(`${model} : budget de raisonnement épuisé, aucun contenu`);
          continue; // this model only thinks — next one, no long wait
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 0;
          const quota = status === 404 || status === 429 || /rate.?limit|quota|429|unavailable_model/i.test(e instanceof Error ? e.message : "");
          if (quota) {
            notes.push(`${model} : ${status === 404 ? "indisponible" : "quota atteint"} (${status})`);
            continue; // per-model cap/routing gap — the next free route may be open
          }
          throw e; // real gateway/network failure: let the outer retry handle it
        }
      }
      throw new Error(`Tous les modèles gratuits de la passerelle sont indisponibles — ${notes.join(" · ") || "aucun ne répond"}`);
    },
    { parallel: Number(process.env.CODEFORGE_GATEWAY_PARALLEL ?? 3), minGapMs: Number(process.env.CODEFORGE_GATEWAY_GAP_MS ?? 350) }
  );

  return {
    id: "cloud-free:gateway",
    label: "CodeForge Cloud (gratuit, anonyme)",
    kind: "cloud-free",
    priority: 70,
    async detect() {
      const started = Date.now();
      try {
        // Real probe: must produce actual content, not just an HTTP 200.
        const probe = await call(primary(), [{ role: "user", content: 'Reply with exactly: {"ready":true}' }], { temperature: 0, maxTokens: 600 });
        if (probe.reasoningStarved || !probe.text.trim()) {
          return { id: this.id, label: this.label, kind: this.kind, available: false, detail: "le modèle gratuit ne produit pas de contenu exploitable" };
        }
        return {
          id: this.id, label: this.label, kind: this.kind, available: true,
          model: probe.model ?? primary(), latencyMs: Date.now() - started,
          detail: "Passerelle gratuite anonyme — aucune clé, aucune inscription, aucune installation",
        };
      } catch (e) {
        return { id: this.id, label: this.label, kind: this.kind, available: false, detail: `indisponible (${e instanceof Error ? e.message.slice(0, 90) : "réseau"})` };
      }
    },
    async complete(messages, opts = {}) {
      return gated(messages, opts);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Provider : free community API — secondary zero-config fallback     */
/* ------------------------------------------------------------------ */

function makeFreeCommunityProvider(): AIProvider {
  const base = () => process.env.CODEFORGE_FREE_AI_URL ?? "https://text.pollinations.ai";
  const primary = () => process.env.CODEFORGE_FREE_AI_MODEL ?? "openai";
  // Aliases route differently on the community gateway — alternating them
  // per attempt dodges transiently sick backends (ENOSPC bursts).
  const aliases = Array.from(new Set([primary(), "openai-fast", "openai"]));
  let cursor = 0;
  const nextModel = () => aliases[cursor++ % aliases.length];
  // gpt-oss is a reasoning model: without a low reasoning effort it can burn
  // its entire output budget on internal reasoning and return empty content.
  const freeBody = { reasoning_effort: process.env.CODEFORGE_FREE_AI_REASONING ?? "low" };
  const rawComplete = (messages: ChatMessage[], opts: CompletionOptions = {}) =>
    openAICompatible(
      `${base()}/openai`,
      null,
      nextModel(),
      messages,
      { temperature: opts.temperature ?? 0.4, maxTokens: opts.maxTokens, signal: opts.signal },
      {},
      freeBody
    );
  const pacedComplete = makeGated(rawComplete, { parallel: 1, minGapMs: Number(process.env.CODEFORGE_FREE_AI_GAP_MS ?? 5000) });
  return {
    id: "cloud-free:community",
    label: "CodeForge Cloud (gratuit)",
    kind: "cloud-free",
    priority: 90,
    async detect() {
      const started = Date.now();
      try {
        // Honest probe: a REAL completion that must produce actual output.
        // A trivial 1-token ping can succeed while the backend is disk-full
        // (ENOSPC) and fails every real generation — so probe with real work.
        const probe = await openAICompatible(
          `${base()}/openai`,
          null,
          nextModel(),
          [{ role: "user", content: 'Reply with exactly this JSON and nothing else: {"ready":true}' }],
          { maxTokens: 400, temperature: 0 },
          {},
          freeBody,
          60_000
        );
        if (!/\{/.test(probe.text)) throw new Error("sonde sans contenu exploitable");
        return {
          id: this.id,
          label: this.label,
          kind: this.kind,
          available: true,
          model: probe.model ?? primary(),
          latencyMs: Date.now() - started,
          detail: "API communautaire gratuite — aucune clé, aucune installation",
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "réseau";
        return {
          id: this.id, label: this.label, kind: this.kind, available: false,
          detail: `incident fournisseur détecté (${msg.slice(0, 90)}) — réessais automatiques en cours ; un moteur local serait utilisé s'il était présent`,
        };
      }
    },
    async complete(messages, opts = {}) {
      return pacedComplete(messages, opts);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Registry + active-engine resolution                                */
/* ------------------------------------------------------------------ */

const REGISTRY: AIProvider[] = [
  ...ENV_SPECS.map((s, i) => makeEnvProvider(s, i)),
  makeOllamaProvider(),
  makeLocalServerProvider(),
  makeFreeGatewayProvider(),
  makeFreeCommunityProvider(),
].sort((a, b) => a.priority - b.priority);

/* ------------------------------------------------------------------ */
/*  Circuit breaker: a provider that keeps failing is set aside for a   */
/*  cooldown so the NEXT attempt uses a different engine. This is what  */
/*  makes a run survive a provider incident instead of dying on it.    */
/* ------------------------------------------------------------------ */

interface BreakerState {
  failures: number;
  openUntil: number;
  lastError?: string;
}
const breakers = new Map<string, BreakerState>();
const OPEN_AFTER = 2; // consecutive failures before opening
const COOLDOWN_MS = 90_000;

export function reportProviderFailure(id: string, err: unknown) {
  const b = breakers.get(id) ?? { failures: 0, openUntil: 0 };
  b.failures++;
  b.lastError = err instanceof Error ? err.message.slice(0, 160) : "erreur inconnue";
  if (b.failures >= OPEN_AFTER) b.openUntil = Math.max(b.openUntil, Date.now() + COOLDOWN_MS * Math.min(4, b.failures - OPEN_AFTER + 1));
  breakers.set(id, b);
}

export function reportProviderSuccess(id: string) {
  breakers.set(id, { failures: 0, openUntil: 0 });
  const p = REGISTRY.find((x) => x.id === id);
  if (p) usedEngines.add(p.label);
}

/** Engines that actually served completions since process start (honest reporting). */
const usedEngines = new Set<string>();
export function enginesUsed(): string[] {
  return [...usedEngines];
}

export function breakerInfo(id: string): { open: boolean; retryInMs: number; lastError?: string } {
  const b = breakers.get(id);
  if (!b) return { open: false, retryInMs: 0 };
  const left = b.openUntil - Date.now();
  return { open: left > 0, retryInMs: Math.max(0, left), lastError: b.lastError };
}

let cached: { status: EngineStatus; at: number } | null = null;

export async function checkEngineStatus(force = false): Promise<EngineStatus> {
  if (!force && cached && Date.now() - cached.at < 45_000) return cached.status;
  const providers = await Promise.all(
    REGISTRY.map(async (p) => {
      try {
        return await p.detect();
      } catch {
        return { id: p.id, label: p.label, kind: p.kind, available: false, detail: "échec de détection" } as ProviderStatus;
      }
    })
  );
  const active = providers.find((p) => p.available) ?? null;
  const status: EngineStatus = { ok: !!active, active, providers, checkedAt: new Date().toISOString() };
  cached = { status, at: Date.now() };
  return status;
}

/**
 * Resolve the engine to use RIGHT NOW. Providers whose circuit breaker is
 * open are skipped, so a mid-run incident automatically fails over to the
 * next working free engine instead of hammering a dead one.
 */
export async function getActiveProvider(force = false): Promise<{ provider: AIProvider; status: ProviderStatus } | null> {
  const status = await checkEngineStatus(force);
  const available = status.providers.filter((p) => p.available);
  if (!available.length) return null;
  const healthy = available.filter((p) => !breakerInfo(p.id).open);
  const pick = (healthy.length ? healthy : available).sort((a, b) => {
    // among equally-available providers, prefer the one cooling down soonest
    const ra = breakerInfo(a.id).retryInMs;
    const rb = breakerInfo(b.id).retryInMs;
    return ra - rb;
  })[0];
  const provider = REGISTRY.find((p) => p.id === pick.id);
  return provider ? { provider, status: pick } : null;
}

/** Retry with exponential backoff on transient failures (network, 429, 5xx). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseDelayMs?: number; signal?: AbortSignal; onRetry?: (attempt: number, err: unknown) => void } = {}
): Promise<T> {
  const tries = opts.tries ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (opts.signal?.aborted) throw new Error("Annulé par l'utilisateur");
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e instanceof HttpError ? e.status : 0;
      // Only an explicit user cancellation is non-retryable; network timeouts
      // (our own AbortController) ARE retryable.
      const aborted = opts.signal?.aborted === true;
      // 402 is returned by free tiers when the anonymous rate window trips — wait and retry.
      const retryable = !aborted && (status === 0 || status === 402 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500);
      if (attempt >= tries || !retryable) break;
      opts.onRetry?.(attempt, e);
      // Quota windows AND provider incidents (5xx, e.g. ENOSPC bursts) recover
      // on a longer horizon than transient blips.
      const longWait = status === 402 || status === 429 || status >= 500;
      const delay = longWait ? 20_000 * attempt : (opts.baseDelayMs ?? 3000) * attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Échec inconnu");
}
