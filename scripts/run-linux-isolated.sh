#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  printf 'Refusing to run the Linux mechanism suite outside a GitHub-hosted runner VM.\n' >&2
  exit 2
fi
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
  --env PRAXIS_LOOP_DOCKER_ISOLATION_VERIFIED=1 \
  --env PRAXIS_LOOP_SOURCE_COMMIT="$source_commit" \
  "$image" sh -c 'mkdir -p /tmp/evidence && exec node scripts/launch-evaluation.mjs mechanism' >/dev/null
created=1
network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")"
host_mount_types="$(docker inspect --format '{{range .Mounts}}{{if or (eq .Type "bind") (eq .Type "volume")}}{{.Type}}{{end}}{{end}}' "$container")"
container_user="$(docker inspect --format '{{.Config.User}}' "$container")"
read_only_root="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container")"
memory_limit="$(docker inspect --format '{{.HostConfig.Memory}}' "$container")"
cpu_limit="$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$container")"
pids_limit="$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container")"
cap_drop="$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$container")"
tmpfs_tmp="$(docker inspect --format '{{index .HostConfig.Tmpfs "/tmp"}}' "$container")"
tmpfs_home="$(docker inspect --format '{{index .HostConfig.Tmpfs "/home/test"}}' "$container")"
if [[ "$network_mode" != none || -n "$host_mount_types" ||
      "$container_user" != 10001:10001 || "$read_only_root" != true ||
      "$memory_limit" != 4294967296 || "$cpu_limit" != 2000000000 ||
      "$pids_limit" != 64 || "$cap_drop" != '["ALL"]' ||
      "$tmpfs_tmp" != 'rw,nosuid,nodev,size=1g,mode=1777' ||
      "$tmpfs_home" != 'rw,nosuid,nodev,size=256m,uid=10001,gid=10001' ]]; then
  printf 'Isolation check failed: network=%s mounts=%s user=%s read_only=%s memory=%s cpu=%s pids=%s cap_drop=%s tmpfs_tmp=%s tmpfs_home=%s\n' \
    "$network_mode" "$host_mount_types" "$container_user" "$read_only_root" "$memory_limit" "$cpu_limit" "$pids_limit" "$cap_drop" "$tmpfs_tmp" "$tmpfs_home" >&2
  exit 2
fi

printf '{"schemaVersion":1,"runnerEnvironment":"github-hosted","imageId":"%s","sourceCommit":"%s","networkMode":"%s","hostMountTypes":[],"user":"%s","readOnlyRoot":%s,"memoryBytes":%s,"nanoCpus":%s,"pidsLimit":%s,"capDrop":%s,"tmpfsTmp":"%s","tmpfsHome":"%s"}\n' \
  "$image_id" "$source_commit" "$network_mode" "$container_user" "$read_only_root" "$memory_limit" "$cpu_limit" "$pids_limit" "$cap_drop" "$tmpfs_tmp" "$tmpfs_home" > "$out/isolation.json"
docker start "$container" >/dev/null
container_status="$(docker wait "$container")"
docker logs --timestamps "$container" > "$out/console.log" 2>&1 || true
cat "$out/console.log"
printf '{"schemaVersion":1,"containerExitCode":%s,"sourceCommit":"%s","imageId":"%s"}\n' \
  "$container_status" "$source_commit" "$image_id" > "$out/container-result.json"
if ! docker cp "$container:/tmp/evidence/." "$out/"; then
  printf 'Failed to copy sandbox evidence from the completed container.\n' >&2
  exit 3
fi
printf '\nSandbox result: exit=%s evidence=%s\n' "$container_status" "$out"
exit "$container_status"
