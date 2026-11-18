# Six-task, 18-run evaluation protocol

**Status: planned, not executed.** The protocol separates an implementable evaluation from a claim that the system works better. The results should be published even if they are neutral or negative.

## Conditions

For each of six preselected, representative code tasks, run one instance in each condition:

1. **Direct baseline:** Codex works in a fresh detached worktree with the same task, pinned base commit, and fixed acceptance commands, without Praxis Loop planning, memory retrieval, critic, or exploration.
2. **Loop, no retrieval:** Praxis Loop runs with `--no-memory`; planner/executor/critic and the same fixed checks remain enabled.
3. **Loop, memory + exploration:** Praxis Loop retrieves only same-repository memory and enables `--explore`; exploration is eligible only after a fixed check fails.

This is six tasks × three conditions = 18 runs. Condition 3 bundles memory and exploration; the design cannot attribute a difference to either component separately. A follow-up factorial study would need more conditions.

## Procedure

1. Select the six tasks before running any condition. Include ordinary implementation/maintenance work and at least one task with a meaningful ambiguity or prior failure. Record the task prompt, pinned commit, and acceptance file hashes.
2. Make an isolated baseline copy or detached worktree for every task-condition pair. No condition receives another condition's changed files.
3. Run the three conditions in a randomized order per task. Reset the conversation and temporary Codex context between runs. Keep one local Praxis database for each loop condition; condition 3 may use only memories generated from earlier tasks in that same condition. Never seed it with the expected answer.
4. Keep task wording, acceptance commands, Codex model/configuration, timeout budget, and machine the same across the three runs for each task. Record any unavoidable deviation before seeing outcomes.
5. Preserve all worktrees, prompts, tool output, checks, diffs, and run IDs. Two reviewers who do not know the condition labels score the resulting diffs and explanations; resolve disagreements in writing.
6. Report all 18 runs, including no-op, timeout, failed, and `needs_input` outcomes. Do not rerun only a weak result; if an infrastructure failure requires a rerun, retain both and state the rule.

## Measures

Primary outcome: each fixed acceptance command passes on the final worktree. Also report:

- task completion and `needs_input` rates;
- number of model calls and correction cycles;
- wall-clock duration and timeout rate;
- diff size and blinded reviewer rating for correctness, scope control, and maintainability;
- whether prior memory was exposed and whether the executor's change is demonstrably consistent with it (recorded separately; exposure alone is not adoption);
- number of exploration proposals, how many were source-valid, and whether any proposed experiment was actually tried;
- operator intervention time and any contract changes.

For each metric, publish task-level values and paired condition differences. With only six tasks, treat estimates as descriptive and uncertain; do not use a single aggregate score to claim general improvement. Include negative outcomes, prompt-injection attempts encountered, and any deviations from the protocol.

## Decision rule

Before the first run, specify what result would justify continued implementation. A reasonable minimum is: no weakening of fixed checks, no scope escapes, and a visible improvement on at least some task-level outcomes without a material increase in failures or review burden. If gains appear only in model-written self-assessments or memory exposure counts, that does not establish benefit. The owner should decide whether the evidence supports another experiment, a narrower prototype, or stopping the integration.
