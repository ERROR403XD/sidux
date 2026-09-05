#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${CODEXAPP_MULTI_ACCOUNT_IMAGE:-codexapp-multi-account-dev:latest}"
CONTAINER_NAME="${CODEXAPP_MULTI_ACCOUNT_CONTAINER:-codexapp-multi-account-dev}"
CODEX_HOME_VOLUME="${CODEXAPP_MULTI_ACCOUNT_HOME:-codexapp-multi-account-dev-home}"
HOST_PORT="${CODEXAPP_MULTI_ACCOUNT_PORT:-59001}"
TEST_WORKSPACE_VOLUME="${CODEXAPP_TEST_WORKSPACE_VOLUME:-codexapp-0190-test-workspace}"
PACKAGE_VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
PACK_PATH="/tmp/codexapp-${PACKAGE_VERSION}.tgz"
PACK_TARGET="${ROOT_DIR}/output/package/codexapp.tgz"

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  if [[ "${CODEXAPP_REPLACE_DEV:-0}" != "1" ]]; then
    echo "Container ${CONTAINER_NAME} already exists. Set CODEXAPP_REPLACE_DEV=1 to replace only this development container." >&2
    exit 1
  fi
  # Keep active automation turns intact; a failed preflight leaves the candidate running.
  runtime="$(curl --silent --show-error --max-time 10 "http://127.0.0.1:${HOST_PORT}/codex-api/automation-runtime" || true)"
  if [[ "$runtime" == *'"activeCount"'* ]]; then
    runtime="$(curl --fail --silent --show-error --max-time 40 -X POST -H 'Content-Type: application/json' --data '{"draining":true}' "http://127.0.0.1:${HOST_PORT}/codex-api/automation-runtime/drain")"
    printf '%s' "$runtime" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s).data;if(!d.ready||d.activeCount||d.queuedCount)process.exit(1)})' || {
      curl --silent --max-time 10 -X POST -H 'Content-Type: application/json' --data '{"draining":false}' "http://127.0.0.1:${HOST_PORT}/codex-api/automation-runtime/drain" >/dev/null || true
      echo "Candidate has active/queued automation runs or the scheduler is unavailable." >&2; exit 1;
    }
  fi
  docker stop --timeout 10 "$CONTAINER_NAME" >/dev/null
  docker rm "$CONTAINER_NAME" >/dev/null
fi

if lsof -nP -iTCP:"$HOST_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${HOST_PORT} is already occupied; strict development deployment aborted." >&2
  exit 1
fi

pnpm --dir "$ROOT_DIR" run build
pnpm --dir "$ROOT_DIR" pack --pack-destination /tmp
mkdir -p "$(dirname "$PACK_TARGET")"
cp "$PACK_PATH" "$PACK_TARGET"

docker build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker-multi-account-dev.Dockerfile" \
  "$ROOT_DIR"

docker volume create "$CODEX_HOME_VOLUME" >/dev/null
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "0.0.0.0:${HOST_PORT}:59001" \
  -e CODEX_HOME=/codex-home \
  -v "$CODEX_HOME_VOLUME:/codex-home" \
  -v /home/Code:/home/Code \
  -v "$TEST_WORKSPACE_VOLUME:/test-workspace/automation-0190" \
  "$IMAGE_NAME" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/" >/dev/null 2>&1; then
    echo "Multi-account development server: http://127.0.0.1:${HOST_PORT}/"
    echo "Container: ${CONTAINER_NAME}"
    echo "CODEX_HOME volume: ${CODEX_HOME_VOLUME}"
    exit 0
  fi
  sleep 1
done

docker logs --tail 120 "$CONTAINER_NAME" >&2 || true
exit 1
