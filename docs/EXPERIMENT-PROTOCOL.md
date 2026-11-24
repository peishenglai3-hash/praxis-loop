# Praxis Loop staged evaluation protocol

**Status: protocol and guarded harness are implemented. A Windows AppContainer pilot has run for the in-process mechanism subset and bounded stability profile; the full mechanism suite and model-backed stages remain incomplete.** This protocol puts mechanism correctness and isolation before model-backed task trials, long-horizon use, and any cross-project integration. A later stage does not start while its predecessor has an unresolved safety, integrity, or data-loss issue.

## Evaluation questions

The study asks whether the current loop can:

1. preserve its fixed task, repository, and acceptance-check boundaries;
2. recover from ordinary failures without losing the evidence needed to inspect a run;
3. plan and execute useful work across distinct, naturally occurring task contexts;
4. retain, retrieve, revise, and invalidate repository-scoped memories safely over a sequence of tasks; and
5. remain stable as run count, event history, memory volume, and elapsed time grow.

This is an evaluation of observable behavior. Passing tests cannot establish that a model has an inner reflective capacity or that memory caused general improvement.

## Stage gates

### 0. Freeze and prepare the sandbox

Before collecting results:

- Pin the Praxis Loop source snapshot, target-repository commits, Node 24.15.x, package lockfiles, Codex CLI/provider configuration, fixed acceptance commands, and sandbox image/profile.
- For model-backed stages, use a dedicated disposable Linux VM snapshot. Do not mount host folders, user profiles, sockets, credentials, or production data. Restrict guest networking to the model endpoint and explicitly required package sources.
- For offline Windows mechanism and state-stability work only, the repository wrapper may use a unique Windows AppContainer with zero declared network capabilities, a temporary copied workspace, an inaccessible host sentinel, and a kill-on-close Job Object. This shares the host kernel and is not a VM. It cannot establish a VM boundary, and AppContainer tests do not authorize model calls.
- Run as an unprivileged guest user. Use separate sandbox credentials and sanitized/public repositories. Keep the raw evidence directory inside the VM until its manifest is complete.
- In a Linux VM, write /etc/praxis-loop-test-sandbox.json as a root-owned, non-group/world-writable provisioning record with schema version 1 and dedicatedVm, noHostMounts, and networkRestricted set to true. tests/sandbox-guard.mjs checks this record and virtualization/mount hints as a fail-fast guard; it is **not** a VM security boundary. The host hypervisor and network policy provide that boundary.
- Establish a fresh per-study PRAXIS_LOOP_STATE_DIR and PRAXIS_LOOP_EVIDENCE_DIR. Record available CPU/RAM/disk and VM snapshot identity. Do not reuse a personal Praxis Loop database.

The Linux marker record can be a small JSON object such as {"schemaVersion":1,"studyId":"example-study","dedicatedVm":true,"noHostMounts":true,"networkRestricted":true}. Install it from the guest administrator account with root ownership and mode 0644, then run the evaluator only as the unprivileged study user. The marker records the VM operator's setup; it does not verify or enforce that setup. The Windows wrapper verifies its AppContainer token and Job Object before resume, checks a host-only file and loopback denial, and keeps the workspace/evidence inside a fresh temporary root.

For deterministic mechanism checks, `.github/workflows/isolated-mechanism.yml` uses a standard GitHub-hosted `ubuntu-24.04` job, which is a fresh VM per job. It checks out without persisted credentials, prepares dependencies and the build image before starting tests, then runs the test process as UID 10001 in a read-only Docker image with `--network none`, no runtime bind mounts, no capabilities, and bounded CPU, memory, processes, and temporary storage. The host wrapper refuses non-GitHub-hosted runners and verifies Docker's reported network, mounts, user, read-only root, resource limits, capability drop, and temporary storage before starting tests. It copies generated test evidence and console output after the container exits. The container-side guard accepts this explicit host-wrapper attestation because containers do not expose the outer VM's virtualization flags; the host settings remain the actual isolation boundary. This profile covers the no-model mechanism suite. It is not a task-quality or model-generalization study, and it does not authorize exposing provider credentials to the test container.

This CI mechanism profile caps the container at 2 vCPU, 4 GiB memory, 64 processes, 1 GiB temporary storage, and 256 MiB home storage; it is not used for the stability/soak stage. The hosted runner remains outside the container only to provision the image, verify isolation settings, collect artifacts after process exit, and report the workflow result.

If neither sandbox profile can be established, stop before runtime or model-backed work. On Windows, do not invoke the ordinary pnpm runtime-test commands on the host; use the explicit AppContainer wrapper for its documented offline subset. WSL without a dedicated VM and a host marker do not satisfy the model-stage gate.

### 1. Deterministic mechanism checks

Run pnpm build, then run the complete pnpm test suite inside the VM. These checks do not call a model and use throwaway repositories/databases. Cover:

- adapter argv handling, output bounds, timeout, cancellation, and descendant-process cleanup;
- worktree creation/removal boundaries, pinned base, unmodified source checkout, and detection of checks that alter the worktree;
- planner/executor/critic malformed output and failure persistence, one-repair limit, and final diff-to-verification hash agreement;
- unique verification-round artifacts and event replay after close/reopen;
- memory approval, revision, revocation, source-scope validation, projection rebuild, FTS consistency, and idempotence;
- state-directory isolation between repositories and between study runs; and
- exploration citation, applicability, and bounded-selection contracts.

Fix one root cause at a time. Each discovered issue receives an issue record and a focused regression case before the suite is rerun in the VM. A local typecheck is not a substitute for these checks.

On Windows, `scripts/run-windows-appcontainer.ps1 -Mode mechanism` currently runs only `search-exploration.test.mjs` and `store.test.mjs` through the AppContainer loader. These 16 tests cover retrieval, evidence selection, projection rebuild/replay, approval, revision, and revocation. The first `ShellCommandAdapter` test stalled at a redirected child-process spawn: the evaluator remained the sole active Job Object process beyond its 5-second command budget. Therefore `adapters.test.mjs` and `runner.test.mjs` are recorded as excluded and unverified; a passing Windows report is marked `partial`. The host separately verified child/grandchild creation and kill-on-job-close, but that does not verify adapter pipe capture, timeout, cancellation, Git/worktree, or end-to-end runner behavior. Keep those checks gated for a VM or another isolated runtime that supports the same process semantics.

### 2. Six-task paired pilot

Prefer the three original projects—praxis-runtime, TFRK, and codex-habit—as separate target repositories, with two real maintenance tasks per repository if each can be safely prepared. Otherwise use at least two sanitized repository contexts and record any missing domain. Keep worktrees and stores separate; this tests task-context transfer and does not integrate the projects. Include ordinary implementation/maintenance, at least one ambiguous but resolvable request, and at least one task whose acceptance depends on more than one file or subsystem. Do not manufacture a task category or inject an expected solution, correct label, reference diff, answer memory, or synthetic prior state into the model context. If only one sanitized repository is available, record that as a generalization limit.

For each task, prepare the normal user prompt and fixed acceptance commands before any run. Hash them and the base commit. Acceptance commands express the task's practical contract; expected answers and reviewer labels remain outside the VM/model context. Praxis Loop may expose its normal task/check information and actual check results.

Run these three conditions once per task (18 total runs):

1. **Direct baseline:** the same model and task in a clean worktree, without Praxis Loop planning, retrieval, exploration, or critic.
2. **Loop, no retrieval:** normal loop with --no-memory.
3. **Loop, accumulated memory and exploration:** normal loop with memory enabled and --explore; its database begins empty and can contain only events generated by earlier runs in this same condition and repository.

Randomize the condition order per task. Give every task-condition pair a fresh worktree and clean model context. Do not show condition names or internal ratings to the model or blinded reviewers. Do not retry a weak run; if a documented infrastructure failure requires rerunning, keep both records.

Two reviewers who do not know the condition score the final diff for task completion, correctness, scope control, maintainability, and unsupported claims. Resolve disagreement in writing. Report all runs, including no-op, timeout, failed, and needs_input. Six tasks are a descriptive pilot, not a significance test. Since condition 3 bundles memory and exploration, this pilot cannot attribute an effect to either one independently.

### 3. Long-horizon memory and context study

Start only after Stage 2 has no unresolved P0/P1 issue and the task protocol is frozen. Use one repository domain and a sequence of 12 new, naturally occurring tasks. Pair each task with a direct baseline and run the loop arm sequentially with one persistent, initially empty study database. The loop arm sees only memories created by its own earlier task outcomes; do not seed it with labels, expected answers, or hand-written helpful memory.

Restart the CLI process for every task while retaining the study database. After tasks 4 and 8, close the process cleanly, snapshot/hash the database and artifact manifest, then continue from that same study state. Record model/provider and prompt changes; a material change starts a new sequence rather than silently continuing this one.

Inspect outcomes by sequence position (early/middle/late), not only as one average. Specifically track relevant and harmful retrieval, stale or contradictory memory, failed invalidation, repeated errors, corrections, task/check completion, reviewer scores, context size, operator time, and evidence growth. A later task that is worsened by memory is a regression even if the overall completion rate rises.

### 4. Resource and endurance checks

Run pnpm test:stability for the bounded local cycle/resource profile. Run a full pnpm test:soak only after Stage 1 passes and the selected sandbox has enough disk headroom; Linux uses a 24-hour low-load, model-free endurance run. If Stage 1 is only partially available, the Windows wrapper may run its one-hour state-only soak as an exploratory subsystem probe; it does not satisfy Stage 1 or close the full Stage 4 gate. On Windows, command lifecycle cycles are omitted because redirected child-process creation stalled; the host Job Object samples evaluator handles, active processes, and peak Job memory at roughly one-second intervals plus monitor overhead, and enforces 512 handles, 16 active processes, 1 GiB per-process memory, and 2 GiB Job memory. Record RSS, child-process coverage, event/database size, artifact size, task-cycle duration, SQLite integrity, and error counts at fixed intervals. A Windows soak is partial until command lifecycle and complete mechanism coverage are run in a compatible isolated environment.

For the first standard VM profile, pre-register these operational ceilings before the run: 4 vCPU, 8 GiB RAM, 20 GiB scratch disk, 1 GiB process RSS, 128 open file descriptors, zero live child processes at idle sample points, 512 MiB for the stability database plus WAL/SHM, and 32 MiB captured output per invocation. For the Windows AppContainer pilot, the host enforces its stated Job Object limits; in-process RSS and database ceilings remain 1 GiB and 512 MiB, while the host records peak Job memory and handle/process counts. The Windows host CPU and scratch-disk capacity were not independently capped, so no VM-level CPU or disk-limit claim is made. If a profile differs, adjust ceilings before the run and record the reason. A breached ceiling fails the stage; latency percentiles remain descriptive until a stable baseline has been collected.

Report growth per cycle and the slope over time, plus peak values and any restart/recovery behavior. No soak result proves model quality or long-term user benefit.

The first completed Windows bounded profile reached 1000 cycles with 10 store reopens and 11 successful SQLite checks at the 10,000-memory scale. The pre-fix reopen mean was 24.96 s; the optimized implementation reduced it to 0.579 s. The optimized run took 228.7 s, peaked at 190.1 MiB process RSS and 245.2 MiB Job memory, ended with a 16.8 MiB main database and zero-byte WAL, and recorded no sampled handle/process/memory limit violation. It omitted all command lifecycle cycles and is marked `partial` in its manifest.

The exploratory Windows state-only soak completed 3,570 cycles over a 3,600.6 s cycle phase. Three `quick_check` and one final `integrity_check` passed. A reported 2,999.6 s fixture-write interval overlaps a 2,998.4 s host telemetry gap and a Windows sleep/wake interval. The test uses `performance.now()`; libuv uses QueryPerformanceCounter on Windows, and QPC includes sleep time. Reclassify this measurement as host-sleep contamination, not SQLite write latency. This run remains partial because command lifecycle coverage is zero; see [the frozen reference](FROZEN-TEST-REFERENCE-2026-11-24.md).

### 5. Cross-task and cross-project integration

Begin only after Stages 1–4 have no unresolved P0/P1 issues and Stage 3 has no unexplained late-sequence regression. First test the loop's own module contracts in one process and one repository. Only then consider adapters to Praxis Runtime, TFRK, or codex-habit. Keep each project checkout, database, and evidence stream separate until an explicit, reviewed adapter contract exists. Do not turn this stage into a monolithic shared store or an uncontrolled multi-agent run.

## Measurements and stop rules

For every run record: study/run ID, task and condition pseudonyms, task/base/check hashes, repository and model versions, randomized order, timestamps, model-call count, completion status, check statuses, correction count, diff hash/size, resource measurements, reviewer scores, interventions, and deviations.

Report task-level outcomes and paired differences. Keep these separate:

- **mechanism correctness:** fixed checks and invariants behaved as designed;
- **task quality:** independent reviewers assess the diff and explanation;
- **memory behavior:** exposure, applicability, retrieval, revision, and harm are observed separately;
- **resource stability:** bounded processes, storage, and time under stated load; and
- **user benefit:** not measured by this plan.

Stop the active stage on any scope escape, altered fixed checks, false pass, lost or corrupted event history, cross-repository memory leak, surviving child after cancellation, or breached resource limit. Preserve the failing evidence, reduce it to one reproduction, diagnose the root cause, implement the smallest fix, add a focused regression case, then resume at the failed gate. Classify unresolved safety/integrity/data-loss issues as P0/P1 and do not proceed.

## Issue records and evidence retention

Maintain one issue ledger per study; do not make a new version of the ledger for each rerun. For each distinct root cause record:

- stable issue ID and first/last seen run IDs;
- OBSERVED, REPRODUCED, DIAGNOSED, FIXED_PENDING_SANDBOX, VERIFIED_IN_SANDBOX, DEFERRED, or NOT_REPRODUCED status;
- impact/severity, exact trigger, smallest reproduction, and affected invariant;
- source evidence paths and SHA-256 hashes from the run manifest;
- diagnosis separated from observation, fix commit, regression case, and verification result; and
- whether the issue blocks the next gate.

Deduplicate repeated symptoms under one root cause while retaining each occurrence's run ID. Keep raw prompts, model output, check logs, and diffs in the sandbox evidence directory, not in source control. Keep the minimal reproduction and issue summary needed for future work. Do not delete original evidence until its manifest and any issue-specific excerpts have been checked; do not retain duplicate copies or old run directories after the study's declared retention window.

The evaluator writes one bounded log and hash-bearing manifest per invocation. Test databases, worktrees, and caches must be study-scoped and disposable. Production event history is the source of record; only derived indexes/caches may be rebuilt or cleared automatically. Any later archival or deletion step must verify the destination manifest before removing its source.

## Current status

- Windows AppContainer mechanism evidence: the search/retrieval and store subset passed 16/16 tests. Adapter and runner suites remain unverified after a redirected-child-process stall in the isolated container.
- Windows bounded stability: 1,000 memory cycles, 10 reopens, and 11 SQLite checks passed after an optimization to 10k-memory projection validation. This single local profile remains partial.
- Windows state-only soak: the one-hour cycle phase completed and SQLite integrity checks passed. Its longest recorded write interval spans host sleep and is excluded from application latency evidence. The run remains partial.
- The GitHub-hosted Linux mechanism workflow is configured; its first run is pending. Six-task/model evaluation, cross-project integration, and long-horizon task-quality evidence remain pending. No model calls were made in the completed Windows probes.
- The exact sanitized results, limits, and timing correction are frozen in [FROZEN-TEST-REFERENCE-2026-11-24.md](FROZEN-TEST-REFERENCE-2026-11-24.md); private raw logs are not stored in Git.
