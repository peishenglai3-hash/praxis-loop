import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { repositoryStatePath } from "./paths.js";

const MAX_GIT_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, args: string[], binary = false): string | Buffer {
  const result = execFileSync("git", args, {
    cwd,
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: MAX_GIT_BUFFER,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result;
}

export function repositoryRoot(cwd: string): string {
  return String(git(resolve(cwd), ["rev-parse", "--show-toplevel"])).trim();
}

export function repositoryId(root: string): string {
  const resolved = resolve(root);
  const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 20);
}

export function headCommit(root: string): string {
  return String(git(root, ["rev-parse", "HEAD"])).trim();
}

export function assertCleanRepository(root: string): void {
  const status = String(git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).trim();
  if (status.length > 0) {
    const paths = status.split(/\r?\n/u).slice(0, 12).join("\n");
    throw new Error(`The source worktree has uncommitted changes. Commit or move them, then retry.\n${paths}`);
  }
}

export async function createWorktree(root: string, runId: string, baseCommit: string): Promise<string> {
  const worktreePath = resolve(repositoryStatePath(repositoryId(root)), "worktrees", runId);
  await mkdir(dirname(worktreePath), { recursive: true });
  git(root, ["worktree", "add", "--detach", worktreePath, baseCommit]);
  return worktreePath;
}

export function captureDiff(worktreePath: string, baseCommit: string): { patch: Buffer; hash: string; status: string } {
  const status = String(git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]));
  // Intent-to-add makes new files visible to diff without staging their content.
  if (status.length > 0) {
    try { git(worktreePath, ["add", "--intent-to-add", "--", "."]); }
    catch { /* A conflict or ignored-only tree remains represented in status. */ }
  }
  const patch = git(worktreePath, ["diff", "--binary", "--no-ext-diff", baseCommit, "--", "."], true) as Buffer;
  const hash = createHash("sha256").update(patch).digest("hex");
  const finalStatus = String(git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]));
  return { patch, hash, status: finalStatus };
}

export function verifyWorktreeBase(worktreePath: string, baseCommit: string): boolean {
  return headCommit(worktreePath) === baseCommit;
}

export function removeWorktree(root: string, worktreePath: string): void {
  const expectedParent = resolve(repositoryStatePath(repositoryId(root)), "worktrees");
  const resolved = resolve(worktreePath);
  const actualParent = dirname(resolved);
  const sameParent = process.platform === "win32"
    ? actualParent.toLocaleLowerCase() === expectedParent.toLocaleLowerCase()
    : actualParent === expectedParent;
  if (!sameParent) throw new Error("Refusing to remove a worktree outside Praxis Loop state storage");
  git(root, ["worktree", "remove", "--force", resolved]);
}
