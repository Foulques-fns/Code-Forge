export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  model: string;
  latencyMs: number;
  finishReason?: string;
  /** True when the model spent its whole budget on internal reasoning and
   *  returned no usable content — a MODEL problem, not a provider outage. */
  reasoningStarved?: boolean;
}

export type ProviderKind = "local" | "cloud-free" | "env";

export interface ProviderStatus {
  id: string;
  label: string;
  kind: ProviderKind;
  available: boolean;
  model?: string;
  detail?: string;
  latencyMs?: number;
}

export interface AIProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  priority: number;
  detect(): Promise<ProviderStatus>;
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<CompletionResult>;
}

export interface EngineStatus {
  ok: boolean;
  active: ProviderStatus | null;
  providers: ProviderStatus[];
  checkedAt: string;
}

/* ———— Generative domain types ———— */

export interface PlannedFile {
  path: string;
  purpose: string;
}

/** One dynamic stage of the build. Small projects get 2-3 phases,
 *  complex systems get many — never a fixed pipeline. */
export interface PlanPhase {
  id: string;
  title: string;
  goal: string;
  files: string[];
}

export interface PlanDecision {
  topic: string;
  choice: string;
  why: string;
}

export interface PlanEnvVar {
  name: string;
  purpose: string;
  required: boolean;
}

export interface PlanVerify {
  install: boolean;
  devCmd: string;
  buildCmd: string;
  testCmd: string;
}

export interface ProjectPlan {
  name: string;
  description: string;
  summary: string;
  stack: {
    language: string;
    framework: string;
    runtime: string;
    packageManager: string;
    buildTool: string;
    styling: string;
  };
  features: string[];
  architecture: string;
  /** Dynamic multi-stage build order. */
  phases: PlanPhase[];
  decisions: PlanDecision[];
  env: PlanEnvVar[];
  verify: PlanVerify;
  files: PlannedFile[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  previewable: boolean;
}

/** Deterministic, always-fresh internal representation of the project. */
export interface ArchitectureMap {
  stack: { language: string; framework: string; runtime: string; packageManager: string; buildTool: string };
  entryPoints: string[];
  routes: string[];
  models: string[];
  envVars: string[];
  modules: { path: string; symbols: string[]; imports: number }[];
  files: number;
  bytes: number;
  edges: number;
}

export interface BuildRunReport {
  ran: boolean;
  ok: boolean | null;
  /** Rounds of the debug loop (build → fix → rebuild) actually executed. */
  rounds: number;
  skippedReason?: string;
  /** Every real command executed, with real outcome. */
  commands: { label: string; code: number; ms: number }[];
}

export type ModOp = "create" | "update" | "delete" | "move";

export interface Modification {
  op: ModOp;
  path: string;
  newPath?: string;
  purpose?: string;
}

export interface ModificationPlan {
  analysis: string;
  operations: Modification[];
  summary: string;
}

export type IssueKind =
  | "syntax"
  | "typescript"
  | "json"
  | "missing-file"
  | "missing-dependency"
  | "placeholder"
  | "generation-failed"
  | "html"
  | "package"
  | "config"
  | "route"
  | "build"
  | "test"
  | "runtime"
  | "consistency"
  | "quality";

export interface Issue {
  id: string;
  file: string | null;
  kind: IssueKind;
  message: string;
  severity: "error" | "warning";
  fixed?: boolean;
}

export interface FileSummary {
  path: string;
  purpose: string;
  exports: string[];
  lines: number;
  bytes: number;
}

export interface DiffInfo {
  added: string[];
  modified: string[];
  deleted: string[];
  stats: { files: number; bytes: number; linesAdded: number; linesRemoved: number };
}
