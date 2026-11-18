export type MemoryKind = "observation" | "preference" | "decision" | "reflection";
export type MemoryStatus = "candidate" | "active" | "superseded" | "revoked";

export interface CommandSpec {
  executable: string;
  args: string[];
  timeoutMs: number;
}

export interface TaskSpec {
  id: string;
  repositoryId: string;
  baseCommit: string;
  prompt: string;
  acceptance: CommandSpec[];
  createdAt: string;
  maxSteps: number;
  correctionCycles: number;
  deadlineMs: number;
}

export interface Plan {
  summary: string;
  steps: string[];
  assumptions: string[];
}

export interface CommandResult {
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface VerificationResult {
  status: "pass" | "fail" | "unknown";
  checks: Array<{ command: CommandSpec; result: CommandResult; status: "pass" | "fail" | "unknown" }>;
  diffHash: string;
}

export interface MemoryRecord {
  id: string;
  repositoryId: string;
  kind: MemoryKind;
  body: string;
  sourceEventIds: string[];
  applicableRepositoryIds: string[];
  status: MemoryStatus;
  createdAt: string;
  revisedFrom?: string;
}

export interface MemoryCandidate {
  memory: MemoryRecord;
  rank: number;
  matchedTerms: string[];
  snippet: string;
}

export interface ModelAdapter {
  generate(input: {
    purpose: "plan" | "execute" | "critic" | "explore";
    prompt: string;
    cwd: string;
    writable: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
}

export interface CommandAdapter {
  execute(command: CommandSpec, cwd: string, totalBudgetMs: number, signal?: AbortSignal): Promise<CommandResult>;
}

export interface DecisionInput {
  id: string;
  repositoryId: string;
  body: string;
  sourceEventIds: string[];
  applicableRepositoryIds: string[];
  createdAt: string;
  revisedFrom?: string;
}

export interface MemoryInput extends DecisionInput {
  kind: MemoryKind;
  /** Model-created reflections stay out of retrieval until a person approves them. */
  status?: "candidate" | "active";
}
