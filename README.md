# Praxis Loop

Praxis Loop is a small local runtime for one bounded code task at a time. It connects a planner, a Codex executor, fixed acceptance commands, a critic, and same-repository decision memory. It is an engineering prototype motivated by reflexive practice; it does not model society or prove that an agent has become reflective.

## Current scope

- Pin the clean source repository to one Git commit and create an isolated detached worktree.
- Ask Codex to produce a short plan, then make one bounded implementation attempt.
- Run up to five acceptance commands supplied as fixed executable/argv pairs.
- If checks fail, ask a critic to stop, request a decision, or propose one repair. Only one repair is allowed.
- Optionally retrieve same-repository memory and ask for one cited, falsifiable alternative when checks fail.
- Persist run events, decisions, evidence links, and unverified reflection candidates in SQLite.
- Keep all runtime files and worktrees in the operating system's user-state directory, outside the source repository.

The program never commits, pushes, changes acceptance commands, or applies a worktree diff back to the source checkout. Review the printed diff and worktree yourself. The current runtime is sequential: planner, executor, critic, and explorer are separate calls through one configured Codex CLI, not concurrent independent agents.

## Requirements

- Node.js `24.15.x` (the built-in `node:sqlite` API is still marked Release Candidate in the [Node 24.15 documentation](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html)).
- pnpm `11.19.0` for development.
- A Git repository with a clean working tree for `run`.
- A working Codex CLI login for model-backed planning and implementation.

The SQLite API's current release status and the single-user local database are material limitations. Keep backups of any decisions you need to preserve.

## Install and build

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
node dist/cli.js --help
```

## Run a task

Create a small JSON file containing the exact acceptance commands. Each command must have an executable, an argv array, and a timeout in milliseconds. The command runs with no shell and inherits the current environment; environment overrides are not stored or shown to the model.

```json
[
  {
    "executable": "node",
    "args": ["node_modules/typescript/bin/tsc", "--noEmit"],
    "timeoutMs": 120000
  }
]
```

On Windows, use a native executable or `node.exe` plus a JavaScript entry point; `.cmd`, `.bat`, and `.ps1` executables are rejected. Acceptance commands run as your current OS user with the inherited environment, outside Codex's sandbox; only supply commands you trust. The repository must be clean, so commit the acceptance file or store it outside the repository before starting a run.

```powershell
node dist/cli.js init --root C:\work\my-project
node dist/cli.js run --root C:\work\my-project --acceptance C:\work\checks.json --task "Fix the parser error path"
```

Useful commands:

```text
praxis-loop status [--root PATH]
praxis-loop show RUN_ID [--root PATH]
praxis-loop memories [--root PATH] [--history]
praxis-loop recall --query TEXT [--root PATH]
praxis-loop remember --kind reflection --body TEXT [--source-event EVENT_ID]
praxis-loop approve MEMORY_ID
praxis-loop reject MEMORY_ID
praxis-loop clean RUN_ID
```

Model-generated reflection is stored as a candidate and cannot influence retrieval until a person approves it. Run outcomes are stored as decision memories; exposure is recorded separately and does not mean that a memory was adopted. Memory is lexical and repository-scoped, not a learned model or a general knowledge graph.

## Local files

The database, prompts, logs, diffs, and retained worktrees are stored at:

- Windows: `%LOCALAPPDATA%\PraxisLoop\repositories\<repository-id>`
- macOS: `~/Library/Application Support/PraxisLoop/repositories/<repository-id>`
- Linux: `$XDG_STATE_HOME/PraxisLoop/repositories/<repository-id>`, or `~/.local/state/PraxisLoop/repositories/<repository-id>`

Task prompts, model output, event payloads, and diffs remain on that machine by default. `where` prints the selected paths. `clean RUN_ID` removes only the matching retained worktree; the database and artifacts remain for review.

Model calls use the configured Codex CLI account/provider and send the task, relevant repository context, selected memory excerpts, and—after failures—check output to that provider. The local runtime does not publish them to GitHub.

## Architecture and boundaries

See [the architecture and theory boundaries](docs/ARCHITECTURE.md) and [the 18-run evaluation protocol](docs/EXPERIMENT-PROTOCOL.md). The planned study has not been run; this repository contains no real-task effectiveness claim.

## Development checks

```powershell
corepack pnpm typecheck
corepack pnpm build
```

The CI workflow runs only those static checks and a production TypeScript build. It does not run an automated test suite.

## License

MIT. See [LICENSE](LICENSE).
