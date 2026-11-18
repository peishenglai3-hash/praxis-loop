import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { CommandAdapter, CommandResult, CommandSpec, ModelAdapter } from "./types.js";

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_TIMEOUT = 2_147_483_647;

function timeoutBudget(commandMs: number, totalMs: number): number {
  for (const value of [commandMs, totalMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Command budget must be positive and finite");
  }
  return Math.min(Math.ceil(commandMs), Math.ceil(totalMs), MAX_TIMEOUT);
}

/** No shell is created. In particular, Windows script shims are not commands. */
function assertExecutable(executable: string): void {
  if (!executable || executable.includes("\0")) throw new Error("Executable is required");
  if (process.platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(executable)) {
    throw new Error("Windows .cmd/.bat/.ps1 commands are unsupported: use the native executable or node.exe with a JavaScript entry point");
  }
}

interface ProcessOptions {
  signal?: AbortSignal;
  stdin?: string;
}

async function runProcess(command: CommandSpec, cwd: string, totalMs: number, options: ProcessOptions = {}): Promise<CommandResult> {
  assertExecutable(command.executable);
  const timeoutMs = timeoutBudget(command.timeoutMs, totalMs);
  const started = performance.now();
  const absoluteCwd = resolve(cwd);
  const args = [...command.args];
  return await new Promise<CommandResult>((resolveResult) => {
    let child: ChildProcess | undefined;
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    let terminating = false;
    let outputExceeded = false;
    let terminationSignal: string | null = null;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let killer: ChildProcess | undefined;

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (watchdog) clearTimeout(watchdog);
      options.signal?.removeEventListener("abort", aborted);
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", terminated);
      resolveResult({ executable: command.executable, args, cwd: absoluteCwd,
        exitCode: terminationSignal && exitCode === 0 ? 1 : exitCode,
        signal: signal ?? terminationSignal, stdout, stderr, timedOut,
        durationMs: Math.round(performance.now() - started) });
    };
    const killUnixGroup = (signal: NodeJS.Signals): void => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch { /* Already exited. */ } }
    };
    const stop = (reason: string): void => {
      if (settled || terminating) return;
      terminating = true;
      if (timeout) clearTimeout(timeout);
      terminationSignal = reason;
      if (process.platform === "win32" && child?.pid) {
        // Only a numeric PID enters argv. Never compose a cmd.exe command line.
        const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
        try {
          killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
            shell: false, windowsHide: true, stdio: "ignore",
          });
          killer.on("error", (error) => { stderr += `\nProcess-tree termination failed: ${error.message}`; });
          killer.on("close", (code) => {
            if (code !== 0 && !settled) {
              stderr += `\nProcess-tree termination returned ${code}; trying parent termination.`;
              try { child?.kill("SIGKILL"); } catch { /* Already exited. */ }
            }
          });
        } catch (error) { stderr += `\nProcess-tree termination failed: ${String(error)}`; }
      } else {
        killUnixGroup("SIGTERM");
      }
      escalation = setTimeout(() => {
        if (process.platform === "win32") {
          try { child?.kill("SIGKILL"); } catch { /* Already exited. */ }
        } else killUnixGroup("SIGKILL");
      }, 250);
      watchdog = setTimeout(() => {
        stderr += "\nProcess termination did not close all output streams; descendant cleanup is unconfirmed.";
        try { killer?.kill(); } catch { /* Already exited. */ }
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        finish(null, terminationSignal);
      }, 4000);
    };
    const aborted = (): void => stop("ABORT_ERR");
    const interrupted = (): void => stop("SIGINT");
    const terminated = (): void => stop("SIGTERM");
    const collect = (chunk: string, stream: "stdout" | "stderr"): void => {
      if (outputExceeded) return;
      const size = Buffer.byteLength(chunk);
      if (bytes + size > OUTPUT_LIMIT) {
        outputExceeded = true;
        stderr += "\nCombined command output exceeded 16 MiB; command stopped.";
        stop("OUTPUT_LIMIT");
        return;
      }
      bytes += size;
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };

    if (options.signal?.aborted) {
      terminationSignal = "ABORT_ERR";
      finish(null, terminationSignal);
      return;
    }
    try {
      child = spawn(command.executable, args, {
        cwd: absoluteCwd, env: process.env, shell: false,
        windowsHide: true, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => collect(chunk, "stdout"));
      child.stderr?.on("data", (chunk: string) => collect(chunk, "stderr"));
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stderr += `\nstdin: ${error.message}`;
      });
      child.on("error", (error) => { stderr += `\nUnable to execute command: ${error.message}`; });
      child.on("close", (code, signal) => finish(code, signal));
      options.signal?.addEventListener("abort", aborted, { once: true });
      process.once("SIGINT", interrupted);
      process.once("SIGTERM", terminated);
      timeout = setTimeout(() => { timedOut = true; stop("SIGTERM"); }, timeoutMs);
      if (options.signal?.aborted) aborted();
      child.stdin?.end(options.stdin);
    } catch (error) {
      stderr += `\nUnable to execute command: ${String(error)}`;
      finish(null, null);
    }
  });
}

export class ShellCommandAdapter implements CommandAdapter {
  constructor(private readonly signal?: AbortSignal) {}

  async execute(command: CommandSpec, cwd: string, totalBudgetMs: number, signal?: AbortSignal): Promise<CommandResult> {
    const cancellation = signal ?? this.signal;
    return await runProcess(command, cwd, totalBudgetMs, cancellation ? { signal: cancellation } : {});
  }
}

/** Resolve only a native executable or the known npm Codex JavaScript entry. */
function codexInvocation(): { executable: string; prefix: string[] } {
  const configured = process.env.CODEX_EXECUTABLE;
  const requested = configured || "codex";
  if (process.platform !== "win32") return { executable: requested, prefix: [] };
  const fromShim = (shim: string): { executable: string; prefix: string[] } => {
    if (!/^codex\.(?:cmd|ps1)$/i.test(basename(shim))) {
      throw new Error("CODEX_EXECUTABLE script must be a standard npm codex.cmd/codex.ps1 shim, or use codex.exe");
    }
    let directory = dirname(shim);
    for (let depth = 0; depth < 6; depth++) {
      const entry = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(entry)) return { executable: process.execPath, prefix: [entry] };
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error("Cannot resolve npm Codex entry; set CODEX_EXECUTABLE to native codex.exe");
  };
  if (isAbsolute(requested) || /[/\\]/.test(requested)) {
    const path = resolve(requested);
    if (/\.(?:cmd|ps1)$/i.test(path)) return fromShim(path);
    assertExecutable(path);
    return { executable: path, prefix: [] };
  }
  const pathValue = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const directories = pathValue.split(delimiter).filter(Boolean);
  const native = /\.exe$/i.test(requested) ? requested : `${requested}.exe`;
  for (const directory of directories) {
    const candidate = join(directory.replace(/^"|"$/g, ""), native);
    if (existsSync(candidate)) return { executable: candidate, prefix: [] };
  }
  for (const directory of directories) {
    for (const extension of [".cmd", ".ps1"]) {
      const candidate = join(directory.replace(/^"|"$/g, ""), requested.toLowerCase().endsWith(extension) ? requested : `${requested}${extension}`);
      if (existsSync(candidate)) return fromShim(candidate);
    }
  }
  throw new Error("Codex CLI not found; set CODEX_EXECUTABLE to codex.exe or a standard npm Codex shim");
}

const PURPOSE: Record<Parameters<ModelAdapter["generate"]>[0]["purpose"], string> = {
  plan: "Act as the planner. Inspect the task and return the requested plan format. Do not modify files.",
  execute: "Act as the executor. Implement the supplied task within its stated scope and acceptance criteria.",
  critic: "Act as the critic. Diagnose the observed failure against evidence and propose a bounded correction. Do not modify files or weaken acceptance criteria.",
  explore: "Explore the supplied problem and propose testable alternative connections grounded in sources. Do not modify files.",
};

export class CodexAdapter implements ModelAdapter {
  constructor(private readonly signal?: AbortSignal) {}

  async generate(input: Parameters<ModelAdapter["generate"]>[0]): Promise<CommandResult> {
    const invocation = codexInvocation();
    const directory = await mkdtemp(join(tmpdir(), "praxis-loop-codex-"));
    const lastMessage = join(directory, "last-message.txt");
    try {
      const args = [...invocation.prefix, "exec", "--sandbox", input.writable ? "workspace-write" : "read-only",
        "--cd", resolve(input.cwd), "--ephemeral", "--color", "never", "-c", 'approval_policy="never"',
        "--output-last-message", lastMessage, "-"];
      const cancellation = input.signal ?? this.signal;
      const result = await runProcess({ executable: invocation.executable, args, timeoutMs: input.timeoutMs }, input.cwd, input.timeoutMs, {
        ...(cancellation ? { signal: cancellation } : {}),
        stdin: `${PURPOSE[input.purpose]}\n\n${input.prompt}`,
      });
      const debug = result.stdout;
      result.stdout = "";
      if (debug) result.stderr += `\n[Codex command stdout]\n${debug}`;
      try {
        if ((await stat(lastMessage)).size > OUTPUT_LIMIT) throw new Error("Final model message exceeds 16 MiB");
        result.stdout = await readFile(lastMessage, "utf8");
        if (!result.stdout.trim()) throw new Error("Codex returned an empty final message");
      } catch (error) {
        result.stderr += `\nUnable to collect final model message: ${String(error)}`;
        if (result.exitCode === 0) result.exitCode = 1;
      }
      return result;
    } finally {
      const temporaryRoot = resolve(tmpdir());
      const cleanupTarget = resolve(directory);
      if (dirname(cleanupTarget) !== temporaryRoot || !basename(cleanupTarget).startsWith("praxis-loop-codex-")) {
        throw new Error("Refusing to clean up an unexpected Codex temporary directory");
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
}
