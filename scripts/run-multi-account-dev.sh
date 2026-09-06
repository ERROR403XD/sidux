#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${CODEXAPP_MULTI_ACCOUNT_IMAGE:-codexapp-multi-account-dev:latest}"
CONTAINER_NAME="${CODEXAPP_MULTI_ACCOUNT_CONTAINER:-codexapp-multi-account-dev}"
CODEX_HOME_VOLUME="${CODEXAPP_MULTI_ACCOUNT_HOME:-codexapp-multi-account-dev-home}"
HOST_PORT="${CODEXAPP_MULTI_ACCOUNT_PORT:-59001}"
TEST_WORKSPACE_VOLUME="${CODEXAPP_TEST_WORKSPACE_VOLUME:-codexapp-0190-test-workspace}"
PACKAGE_VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
PACK_TARGET="${ROOT_DIR}/output/package/codexapp.tgz"
BASE_URL="http://127.0.0.1:${HOST_PORT}"
BACKUP_NAME="${CONTAINER_NAME}-previous-$$"
existing=0
drained=0
api_drained=0
stopped=0
renamed=0
finished=0
pack_dir=""

cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$finished" != 1 && "$stopped" == 1 ]]; then
    if [[ "$renamed" == 1 ]]; then
      docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
      docker rename "$BACKUP_NAME" "$CONTAINER_NAME" || true
    fi
    docker start "$CONTAINER_NAME" >/dev/null || true
    echo "Candidate replacement failed; attempted to restore the previous container." >&2
  fi
  if [[ "$finished" != 1 && "$drained" == 1 ]]; then
    for _ in $(seq 1 10); do
      if curl --fail --silent --max-time 3 -X POST -H 'Content-Type: application/json' --data '{"draining":false}' "$BASE_URL/codex-api/automation-runtime/drain" >/dev/null; then break; fi
      sleep 1
    done
  fi
  if [[ "$finished" != 1 && "$api_drained" == 1 ]]; then
    curl --fail --silent --max-time 10 -X POST -H 'Content-Type: application/json' --data '{"draining":false}' "$BASE_URL/codex-api/api-proxy/drain" >/dev/null || true
  fi
  if [[ -n "$pack_dir" ]]; then rm -rf "$pack_dir"; fi
  exit "$result"
}
trap cleanup EXIT

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  existing=1
  if [[ "${CODEXAPP_REPLACE_DEV:-0}" != 1 ]]; then
    echo "Container ${CONTAINER_NAME} exists. Set CODEXAPP_REPLACE_DEV=1 to replace this candidate." >&2
    exit 1
  fi
elif lsof -nP -iTCP:"$HOST_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${HOST_PORT} is occupied; deployment aborted." >&2
  exit 1
fi

# Complete all build work while the existing candidate remains available.
pack_dir="$(mktemp -d /tmp/codexapp-candidate-pack.XXXXXX)"
pnpm --dir "$ROOT_DIR" run build
pnpm --dir "$ROOT_DIR" pack --pack-destination "$pack_dir"
mkdir -p "$(dirname "$PACK_TARGET")"
cp "$pack_dir/codexapp-${PACKAGE_VERSION}.tgz" "$PACK_TARGET"
node "$ROOT_DIR/scripts/install-api-proxy.cjs" "$ROOT_DIR/output/api-proxy-component"
docker build -t "$IMAGE_NAME" -f "${CODEXAPP_MULTI_ACCOUNT_DOCKERFILE:-$ROOT_DIR/scripts/docker-multi-account-dev.Dockerfile}" "$ROOT_DIR"
docker volume create "$CODEX_HOME_VOLUME" >/dev/null

if [[ "$existing" == 1 ]]; then
  drained=1
  runtime="$(curl --fail --silent --show-error --max-time 40 -X POST -H 'Content-Type: application/json' --data '{"draining":true}' "$BASE_URL/codex-api/automation-runtime/drain")"
  printf '%s' "$runtime" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s).data;if(d?.ready!==true||d.draining!==true||d.activeCount!==0||d.queuedCount!==0)process.exit(1)})'
  if [[ "${CODEXAPP_LEGACY_API_PROXY:-0}" == 1 ]]; then
    docker exec "$CONTAINER_NAME" node -e 'const fs=require("fs");const source=fs.readFileSync("/usr/local/lib/node_modules/codexapp/dist-cli/index.js","utf8");process.exit(source.includes("/codex-api/api-proxy")?1:0)' || { echo "Cannot verify legacy API-proxy exemption." >&2; exit 1; }
  else
    api_drained=1
    curl --fail --silent --show-error --max-time 310 -X POST -H 'Content-Type: application/json' --data '{"draining":true}' "$BASE_URL/codex-api/api-proxy/drain" >/dev/null
  fi
  CODEXAPP_IDLE_CHECK_URL="$BASE_URL" node "$ROOT_DIR/scripts/check-codexapp-idle.cjs"
  docker stop --timeout 10 "$CONTAINER_NAME" >/dev/null
  stopped=1
  docker rename "$CONTAINER_NAME" "$BACKUP_NAME"
  renamed=1
fi

docker run -d \
  --name "$CONTAINER_NAME" --restart unless-stopped \
  -p "0.0.0.0:${HOST_PORT}:59001" -e CODEX_HOME=/codex-home -e TZ=Asia/Shanghai \
  -v "$CODEX_HOME_VOLUME:/codex-home" -v /home/Code:/home/Code \
  -v "$TEST_WORKSPACE_VOLUME:/test-workspace/automation-0190" \
  "$IMAGE_NAME" >/dev/null

for _ in $(seq 1 "${CODEXAPP_DEV_HEALTH_ATTEMPTS:-60}"); do
  if curl --fail --silent --max-time 3 "$BASE_URL/" >/dev/null &&
    curl --fail --silent --max-time 3 "$BASE_URL/codex-api/automation-runtime" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s).data;if(d?.ready!==true||d.error)process.exit(1)}catch{process.exit(1)}})'; then
    finished=1
    if [[ "$renamed" == 1 ]]; then docker rm "$BACKUP_NAME" >/dev/null || echo "Candidate ready; previous container retained: $BACKUP_NAME" >&2; fi
    echo "Multi-account development server: $BASE_URL/"
    echo "Container: $CONTAINER_NAME"
    echo "CODEX_HOME volume: $CODEX_HOME_VOLUME"
    exit 0
  fi
  sleep 1
done
echo "Candidate health check failed." >&2
exit 1
