#!/bin/sh

evidence_dir=${PRAXIS_LOOP_EVIDENCE_DIR:-/tmp/evidence}
if ! mkdir -p "$evidence_dir"; then
  printf 'Unable to create the sandbox evidence directory.\n' >&2
  exit 2
fi

node scripts/launch-evaluation.mjs mechanism
evaluation_status=$?
printf '%s\n' "$evaluation_status" > "$evidence_dir/.evaluation-exit-code"
: > "$evidence_dir/.evaluation-complete"

# The host copies evidence from the tmpfs after evaluation, then releases the
# wrapper so the container can exit with the evaluator's original status.
while [ ! -e "$evidence_dir/.release" ]; do
  sleep 1
done

exit "$evaluation_status"
