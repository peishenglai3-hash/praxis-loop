#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodexAdapter, ShellCommandAdapter } from "./adapters.js";
import { currentRepositoryId, runTask } from "./runner.js";
import { repositoryRoot, removeWorktree } from "./git.js";
import { repositoryStatePath } from "./paths.js";
import { PraxisStore } from "./store.js";
import type { CommandSpec, MemoryKind } from "./types.js";

const HELP = `praxis-loop — local-first planning, bounded execution, review, and memory

Usage:
  praxis-loop init [--root PATH]
  praxis-loop doctor [--root PATH]
  praxis-loop run --task TEXT --acceptance FILE [--root PATH] [--no-memory] [--explore] [--max-steps 1..4]
  praxis-loop status [--root PATH] [--limit N]
  praxis-loop show RUN_ID [--root PATH]
  praxis-loop memories [--root PATH] [--history]
  praxis-loop recall --query TEXT [--root PATH] [--limit N]
  praxis-loop remember --kind KIND --body TEXT [--root PATH] [--source-event EVENT_ID ...]
  praxis-loop revise MEMORY_ID --kind KIND --body TEXT [--root PATH] [--source-event EVENT_ID ...]
  praxis-loop approve MEMORY_ID [--root PATH]
  praxis-loop reject MEMORY_ID [--root PATH]
  praxis-loop clean RUN_ID [--root PATH]
  praxis-loop where [--root PATH]

Acceptance FILE is a JSON array of fixed argv commands, for example:
  [{"executable":"node","args":["node_modules/typescript/bin/tsc","--noEmit"],"timeoutMs":120000}]

Task prompts are limited to 32 KiB. Each run uses a detached worktree at a pinned commit,
stores local artifacts under the OS user-state directory, runs at most five fixed checks,
and allows one correction. Review changes in the printed worktree before applying them.
The CLI never commits or pushes. Model commands require a working Codex CLI login.
`;

const VALUE_OPTIONS = new Set(["root", "task", "acceptance", "max-steps", "limit", "query", "kind", "body", "source-event"]);
const BOOLEAN_OPTIONS = new Set(["help", "history", "explore", "no-memory"]);

interface ParsedArgs { positionals: string[]; values: Map<string, string[]>; flags: Set<string> }

function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals < 0 ? undefined : equals);
    if (BOOLEAN_OPTIONS.has(name)) {
      if (equals >= 0) throw new Error(`--${name} does not take a value`);
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option --${name}`);
    const value = equals >= 0 ? token.slice(equals + 1) : tokens[++index];
    if (value === undefined || value.length === 0) throw new Error(`--${name} requires a value; use --${name}=VALUE for values starting with a dash`);
    const prior = values.get(name) ?? [];
    if (name !== "source-event" && prior.length > 0) throw new Error(`--${name} may be supplied once`);
    prior.push(value);
    values.set(name, prior);
  }
  return { positionals, values, flags };
}

function one(args: ParsedArgs, name: string, required = false): string | undefined {
  const value = args.values.get(name)?.[0];
  if (required && value === undefined) throw new Error(`Missing required --${name}`);
  return value;
}

function integer(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function memoryKind(value: string | undefined): MemoryKind {
  if (value === "observation" || value === "preference" || value === "decision" || value === "reflection") return value;
  throw new Error("--kind must be observation, preference, decision, or reflection");
}

async function repositoryContext(path: string): Promise<{ root: string; id: string; statePath: string; store: PraxisStore }> {
  const root = repositoryRoot(resolve(path));
  const id = currentRepositoryId(root);
  const statePath = repositoryStatePath(id);
  await mkdir(statePath, { recursive: true });
  return { root, id, statePath, store: new PraxisStore(resolve(statePath, "praxis.sqlite")) };
}

function printJson(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function validateAcceptance(value: unknown): CommandSpec[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new Error("Acceptance file must contain 1..5 command objects");
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`Acceptance command ${index + 1} must be an object`);
    const command = item as Record<string, unknown>;
    if (Object.keys(command).some((key) => !["executable", "args", "timeoutMs"].includes(key))) throw new Error(`Acceptance command ${index + 1} contains an unsupported field`);
    if (typeof command.executable !== "string" || !command.executable.trim() || !Array.isArray(command.args) || !command.args.every((arg) => typeof arg === "string")) {
      throw new Error(`Acceptance command ${index + 1} needs an executable string and string argv array`);
    }
    if (typeof command.timeoutMs !== "number" || !Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 900000) {
      throw new Error(`Acceptance command ${index + 1} timeoutMs must be 1..900000`);
    }
    return { executable: command.executable, args: command.args as string[], timeoutMs: command.timeoutMs };
  });
}

async function runCommand(command: string, args: ParsedArgs): Promise<void> {
  const rootInput = one(args, "root") ?? process.cwd();
  const context = await repositoryContext(rootInput);
  try {
    if (command === "init") {
      process.stdout.write(`Initialized ${resolve(context.statePath, "praxis.sqlite")}\n`);
      return;
    }
    if (command === "where") {
      printJson({ repositoryRoot: context.root, repositoryId: context.id, statePath: context.statePath });
      return;
    }
    if (command === "doctor") {
      const sqliteVersion = (context.store.db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
      printJson({ node: process.version, sqlite: sqliteVersion, fts5: context.store.ftsAvailable, repositoryId: context.id, statePath: context.statePath });
      return;
    }
    if (command === "run") {
      const task = one(args, "task", true)!;
      const acceptancePath = resolve(context.root, one(args, "acceptance", true)!);
      const acceptanceText = await readFile(acceptancePath, "utf8");
      if (Buffer.byteLength(acceptanceText, "utf8") > 64 * 1024) throw new Error("Acceptance file exceeds 64 KiB");
      let acceptance: CommandSpec[];
      try { acceptance = validateAcceptance(JSON.parse(acceptanceText) as unknown); }
      catch (error) { throw new Error(`Invalid acceptance file: ${String(error)}`); }
      const controller = new AbortController();
      const interrupt = (): void => controller.abort(new Error("Interrupted by user"));
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      try {
        const maxSteps = integer(one(args, "max-steps"), 4, "--max-steps");
        if (maxSteps > 4) throw new Error("--max-steps must be from 1 to 4");
        const outcome = await runTask({
          root: context.root, prompt: task, acceptance,
          useMemory: !args.flags.has("no-memory"), explore: args.flags.has("explore"),
          maxSteps, signal: controller.signal,
        }, context.store, new CodexAdapter(controller.signal), new ShellCommandAdapter(controller.signal));
        printJson(outcome);
        if (outcome.status !== "completed") process.exitCode = outcome.status === "failed" ? 1 : 2;
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
      return;
    }
    if (command === "status") {
      const limit = Math.min(100, integer(one(args, "limit"), 20, "--limit"));
      printJson(context.store.listRuns(context.id, limit));
      return;
    }
    if (command === "show") {
      const runId = args.positionals[0];
      if (!runId) throw new Error("Usage: praxis-loop show RUN_ID [--root PATH]");
      const run = context.store.getRun(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      printJson(run);
      return;
    }
    if (command === "memories") {
      printJson(context.store.allMemories(context.id, args.flags.has("history")));
      return;
    }
    if (command === "recall") {
      const query = one(args, "query", true)!;
      const limit = Math.min(50, integer(one(args, "limit"), 10, "--limit"));
      printJson(context.store.searchMemories(query, context.id, [context.id], limit));
      return;
    }
    if (command === "remember" || command === "revise") {
      const priorId = command === "revise" ? args.positionals[0] : undefined;
      if (command === "revise" && !priorId) throw new Error("Usage: praxis-loop revise MEMORY_ID --kind KIND --body TEXT");
      const input = {
        id: randomUUID(), repositoryId: context.id, kind: memoryKind(one(args, "kind")),
        body: one(args, "body", true)!, sourceEventIds: args.values.get("source-event") ?? [],
        applicableRepositoryIds: [context.id], createdAt: new Date().toISOString(),
      };
      if (command === "revise") context.store.reviseMemory(priorId!, input);
      else context.store.recordMemory(input);
      process.stdout.write(`${input.id}\n`);
      return;
    }
    if (command === "approve" || command === "reject") {
      const memoryId = args.positionals[0];
      if (!memoryId) throw new Error(`Usage: praxis-loop ${command} MEMORY_ID [--root PATH]`);
      if (command === "approve") context.store.approveMemory(memoryId);
      else context.store.revokeMemory(memoryId);
      process.stdout.write(`${command === "approve" ? "Approved" : "Rejected"} ${memoryId}\n`);
      return;
    }
    if (command === "clean") {
      const runId = args.positionals[0];
      if (!runId) throw new Error("Usage: praxis-loop clean RUN_ID [--root PATH]");
      const run = context.store.getRun(runId);
      if (!run || typeof run.worktree_path !== "string") throw new Error(`Unknown run ${runId}`);
      removeWorktree(context.root, run.worktree_path);
      process.stdout.write(`Removed worktree for ${runId}\n`);
      return;
    }
    throw new Error(`Unknown command ${command}. Use praxis-loop --help.`);
  } finally {
    context.store.close();
  }
}

async function main(): Promise<void> {
  const [command = "help", ...tokens] = process.argv.slice(2);
  const args = parseArgs(tokens);
  if (args.flags.has("help") || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  await runCommand(command, args);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`praxis-loop: ${message}\n`);
  process.exitCode = 1;
});
