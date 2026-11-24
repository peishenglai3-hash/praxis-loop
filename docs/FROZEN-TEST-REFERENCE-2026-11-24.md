# Praxis Loop Windows test reference freeze — 2026-11-24

## Frozen scope

This reference records the current Windows AppContainer mechanism subset, bounded stability run, and exploratory state-only soak. The source snapshot is SHA-256 `eef9fa2af5e1a569463e06e22e9e9638e4881772aa8b8811d5d2eea0ff785d00` (package `0.1.0`, Node `24.15.0`, pnpm `11.19.0`). No model task or live provider was used. The sandbox was Windows AppContainer with no network capabilities and a kill-on-close Job Object; a host sentinel and loopback denial were checked, and the separate descendant cleanup probe passed. External egress blocking was not independently tested because the host baseline had no external-egress access.

## Results

| Run | Observed result | Coverage boundary |
|---|---|---|
| `windows-mechanism-472a6e8aa73f4e7fbc0aedf9b2b76988` | 16/16 tests passed across `search-exploration.test.mjs` and `store.test.mjs`; source snapshot was unchanged after execution. | `adapters.test.mjs` and `runner.test.mjs` were excluded after redirected child-process spawn stalled in the AppContainer. This does not establish a product defect. |
| `windows-stability-f2843e37178d4d70b617e15986866cf1` | 1,000 memory cycles, 10 store reopens, 11 SQLite checks; total 228.674 s. Reopen mean 0.579 s (range 0.467–0.691 s), search mean 25.15 ms (p95 28.25 ms), process RSS peak 190,132,224 B, Job memory peak 245,215,232 B, 183 peak handles, one active process. Final database 17,633,280 B; WAL 0 B. | Command lifecycle omitted; profile remains partial. Metrics are one local Windows profile, not a general performance guarantee. |
| `windows-soak-6d7e85aa02c84360b78137fc187c6c26` | 3,570 cycles in a 3,600.608 s cycle phase, 3 reopens, 23,570 events, 10,000 memories; three `quick_check` and one `integrity_check` passed. Process RSS peak 166,764,544 B; Job memory peak 241,115,136 B; 184 peak handles; final database 18,083,840 B and WAL 4,128,272 B. | Exploratory, state-only and partial; no command lifecycle. The recorded wall span includes a host sleep interval (see correction below), so elapsed time and the seeding write outlier are not application latency evidence. |

## Correction: host sleep contaminated the soak timing

The earlier ledger described one 2,999.6 s fixture write as an unexplained SQLite stall. That attribution is withdrawn. The host telemetry stream has a 2,998.4185 s gap from `2026-11-24T09:35:36.4227409Z` to `2026-11-24T10:25:34.8412518Z`; the Windows System sleep/wake record spans `2026-11-24T09:35:34.2529801Z` to `2026-11-24T10:25:36.6085659Z`. The test measures intervals using `performance.now()`. Node's Windows libuv high-resolution clock uses `QueryPerformanceCounter`, and Microsoft's documentation states QPC includes time spent in sleep. The near-exact overlap therefore explains the recorded ~2,999.6 s interval as host suspend time included in the timer. It is not evidence of a synchronous SQLite write taking 50 minutes. The test did not execute during sleep; no application-level write latency can be recovered for that interval.

References: [libuv Windows high-resolution clock](https://github.com/libuv/libuv/blob/v1.x/src/win/util.c); [Microsoft QPC sleep semantics](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps).

The run remains partial because command lifecycle coverage is absent. It does not establish long-term application endurance. Future endurance runs must record host sleep/wake events or use an awake-time clock for operation latency while retaining a separate wall-clock schedule measurement.

## Evidence and retention

The public JSON summary and checksums in `test-evidence/reference-2026-11-24/` contain only run IDs, bounded metrics, source/test hashes, and this timing correction. Raw harness logs, host identifiers, sandbox SIDs, process IDs, and local paths are excluded from Git. A private 196-file raw archive plus SHA-256 index was made before local generated evidence was cleaned; those files remain outside the repository.

All results are implementation/mechanism evidence. They do not measure generalization, task quality, model capability, user benefit, or learning across tasks. Linux isolated scenario testing and cross-project integration remain open.