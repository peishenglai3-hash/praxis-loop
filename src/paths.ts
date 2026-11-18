import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Keep databases, prompts, logs, and worktrees out of the user's source repository. */
export function repositoryStatePath(repositoryId: string): string {
  let base: string;
  if (process.platform === "win32") {
    base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  } else if (process.platform === "darwin") {
    base = join(homedir(), "Library", "Application Support");
  } else {
    base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  }
  return join(resolve(base), "PraxisLoop", "repositories", repositoryId);
}
