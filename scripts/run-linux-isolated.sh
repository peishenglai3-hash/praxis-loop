#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "$(git -C "$root" status --porcelain --untracked-files=all)" ]]; then
  printf 'Refusing to build from a dirty checkout; commit intended files and keep private files out of the test image.\n' >&2
  exit 2
fi
source_commit="$(git -C "$root" rev-parse HEAD)"
run_id="${GITHUB_RUN_ID:-manual}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
image="praxis-loop-isolated:${run_id//[^a-zA-Z0-9_.-]/-}"
container="praxis-loop-isolated-${run_id//[^a-zA-Z0-9_.-]/-}"
out="$root/.test-artifacts/linux-isolated/$run_id"
mkdir -p "$out"
created=0
cleanup() {
  if [[ "$created" == 1 ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull --file "$root/tests/linux-sandbox.Dockerfile" --tag "$image" "$root"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
docker create \
  --name "$container" \
  --network none \
  --user 10001:10001 \
  --cpus 2 \
  --memory 4g \
  --pids-limit 64 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=1777 \
  --tmpfs /home/test:rw,nosuid,nodev,size=256m,uid=10001,gid=10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --env HOME=/home/test \
  --env PRAXIS_LOOP_EVIDENCE_DIR=/tmp/evidence \
  --env PRAXIS_LOOP_SOURCE_COMMIT="$source_commit" \
  "$image" >/dev/null
created=1
network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")"
host_mount_types="$(docker inspect --format '{{range .Mounts}}{{if or (eq .Type "bind") (eq .Type "volume")}}{{.Type}}{{end}}{{end}}' "$container")"
if [[ "$network_mode" != none || -n "$host_mount_types" ]]; then
  printf 'Isolation check failed: network=%s host_mount_types=%s\n' "$network_mode" "$host_mount_types" >&2
  exit 2
fi

printf '{"schemaVersion":1,"imageId":"%s","sourceCommit":"%s","networkMode":"%s","hostMountTypes":[],"user":"10001:10001","readOnlyRoot":true,"memoryLimit":"4g","cpuLimit":2,"pidsLimit":64}\n' \
  "$image_id" "$source_commit" "$network_mode" > "$out/isolation.json"
docker start "$container" >/dev/null
container_status="$(docker wait "$container")"
docker logs --timestamps "$container" > "$out/console.log" 2>&1 || true
if ! docker cp "$container:/tmp/evidence/." "$out/"; then
  printf 'Failed to copy sandbox evidence from the completed container.\n' >&2
  exit 3
fi
cat "$out/console.log"
printf '\nSandbox result: exit=%s evidence=%s\n' "$container_status" "$out"
exit "$container_status"