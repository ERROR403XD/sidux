#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REPO_DIR="${CODEXAPP_SOURCE_DIR:-$DEFAULT_REPO_DIR}"
RELEASE_ROOT="${CODEXAPP_RELEASE_ROOT:-/home/docker/codexapp-releases}"
STATE_ROOT="${CODEXAPP_SWITCH_STATE_ROOT:-/home/docker/codexapp-switch-state}"
SERVICE_NAME="${CODEXAPP_SERVICE_NAME:-codexapp.service}"
DROPIN_DIR="${CODEXAPP_DROPIN_DIR:-/etc/systemd/system/${SERVICE_NAME}.d}"
DROPIN_FILE="${CODEXAPP_DROPIN_FILE:-$DROPIN_DIR/90-release-switch.conf}"
PRODUCTION_HOME="${CODEXAPP_PRODUCTION_HOME:-/root/.codex}"
PRODUCTION_URL="${CODEXAPP_PRODUCTION_URL:-http://127.0.0.1:5900}"
PRODUCTION_PORT="${CODEXAPP_PRODUCTION_PORT:-5900}"
TEST_CONTAINER="${CODEXAPP_TEST_CONTAINER:-codexapp-multi-account-dev}"
NODE_BIN="${CODEXAPP_NODE_BIN:-$(command -v node || true)}"
CURRENT_TRANSACTION_FILE="$STATE_ROOT/current-transaction"

CURRENT_LOG=""
CUTOVER_TRANSACTION=""
AUTH_SNAPSHOT_READY=0
DROPIN_SNAPSHOT_READY=0
TEST_CONTAINER_WAS_RUNNING=0
SCHEDULER_DRAINED=0
API_PROXY_DRAINED=0
ACTIVATION_DRAINED=0

resume_scheduler_on_exit() {
  if [[ "$ACTIVATION_DRAINED" == "1" ]]; then
    curl --fail --silent --show-error --max-time 10 -X POST -H 'Content-Type: application/json' \
      --data '{"draining":false}' "$PRODUCTION_URL/codex-api/api-proxy/activation/drain" >/dev/null || true
  fi
  if [[ "$API_PROXY_DRAINED" == "1" ]]; then
    curl --silent --show-error --max-time 10 -X POST -H 'Content-Type: application/json' \
      --data '{"draining":false}' "$PRODUCTION_URL/codex-api/api-proxy/drain" >/dev/null || true
  fi
  if [[ "$SCHEDULER_DRAINED" == "1" ]]; then
    curl --silent --show-error --max-time 10 -X POST -H 'Content-Type: application/json' \
      --data '{"draining":false}' "$PRODUCTION_URL/codex-api/automation-runtime/drain" >/dev/null || true
  fi
}
trap resume_scheduler_on_exit EXIT

running_release_has_no_scheduler() {
  # Legacy Express returns the SPA for unknown API paths. Only a verified old
  # running release may omit the scheduler; HTTP 200 alone is insufficient.
  CODEXAPP_INSPECT_SERVICE="$SERVICE_NAME" "$NODE_BIN" --input-type=commonjs <<'NODE'
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const value = execFileSync('systemctl', ['show', process.env.CODEXAPP_INSPECT_SERVICE, '-p', 'ExecStart', '--value'], { encoding: 'utf8' })
const match = value.match(/(\/[^\s;{}]+)\/dist-cli\/index\.js/)
let legacy = false
try {
  const version = JSON.parse(readFileSync(`${match[1]}/package.json`, 'utf8')).version
  const parsed = /^0\.1\.(\d+)$/.exec(version)
  legacy = parsed !== null && Number(parsed[1]) <= 89
} catch {}
process.exit(legacy ? 0 : 1)
NODE
}

running_release_has_no_api_proxy() {
  CODEXAPP_INSPECT_SERVICE="$SERVICE_NAME" "$NODE_BIN" --input-type=commonjs <<'NODE'
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
try {
  const value = execFileSync('systemctl', ['show', process.env.CODEXAPP_INSPECT_SERVICE, '-p', 'ExecStart', '--value'], { encoding: 'utf8' })
  const entry = value.match(/(\/[^\s;{}]+\/dist-cli\/index\.js)/)?.[1]
  if (!entry) process.exit(1)
  process.exit(readFileSync(entry, 'utf8').includes('/codex-api/api-proxy') ? 1 : 0)
} catch { process.exit(1) }
NODE
}

drain_activation_for_cutover() {
  if running_release_has_no_api_proxy; then return 0; fi
  local status
  status="$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' "$PRODUCTION_URL/codex-api/api-proxy/activation/activity")"
  if [[ "$status" == "404" ]]; then return 0; fi
  [[ "$status" == "200" ]] || die "Cannot inspect activation (HTTP $status)."
  # Set before POST so a lost response is also recovered by the exit trap.
  ACTIVATION_DRAINED=1
  curl --fail --silent --show-error --max-time 10 -X POST -H 'Content-Type: application/json' \
    --data '{"draining":true}' "$PRODUCTION_URL/codex-api/api-proxy/activation/drain" >/dev/null
}

drain_api_proxy_for_cutover() {
  if running_release_has_no_api_proxy; then return 0; fi
  API_PROXY_DRAINED=1
  curl --fail --silent --show-error --max-time 310 -X POST -H 'Content-Type: application/json' \
    --data '{"draining":true}' "$PRODUCTION_URL/codex-api/api-proxy/drain" >/dev/null
}

drain_scheduler_for_cutover() {
  if running_release_has_no_scheduler; then return 0; fi
  local status
  status="$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' "$PRODUCTION_URL/codex-api/automation-runtime")"
  [[ "$status" == "200" ]] || die "Cannot inspect scheduler (HTTP $status)."
  SCHEDULER_DRAINED=1
  curl --fail --silent --show-error --max-time 40 -X POST -H 'Content-Type: application/json' \
    --data '{"draining":true}' "$PRODUCTION_URL/codex-api/automation-runtime/drain" >/dev/null
}

usage() {
  cat <<'EOF'
Usage:
  codexapp-release-switch.sh prepare
  codexapp-release-switch.sh check [release-directory|latest]
  codexapp-release-switch.sh activate [release-directory|latest] --confirm-idle
  codexapp-release-switch.sh rollback --confirm-idle
  codexapp-release-switch.sh status

Two-phase workflow:
  1. Run prepare while the current CodexApp remains online.
  2. End the current Codex turn and close every CodexApp browser tab.
  3. From a separate host shell, run activate latest --confirm-idle.

The script never imports credentials from the test container. Production auth
state is snapshotted only after the old service stops and must remain byte-for-
byte unchanged during the code-only cutover.
EOF
}

log() {
  local message="[$(date '+%Y-%m-%d %H:%M:%S%z')] $*"
  printf '%s\n' "$message"
  if [[ -n "$CURRENT_LOG" ]]; then
    printf '%s\n' "$message" >> "$CURRENT_LOG"
  fi
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

require_root() {
  [[ "$(id -u)" == "0" ]] || die "This command must run as root."
}

atomic_write_line() {
  local target="$1"
  local value="$2"
  local target_dir temporary
  target_dir="$(dirname "$target")"
  mkdir -p "$target_dir"
  temporary="$(mktemp "$target_dir/.codexapp-switch.XXXXXX")"
  printf '%s\n' "$value" > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$target"
}

read_first_line() {
  local path="$1"
  [[ -f "$path" ]] || return 1
  IFS= read -r REPLY < "$path" || true
  [[ -n "${REPLY:-}" ]] || return 1
  printf '%s\n' "$REPLY"
}

validate_release() {
  local requested="$1"
  local resolved root_resolved
  if [[ -z "$requested" || "$requested" == "latest" ]]; then
    requested="$(read_first_line "$STATE_ROOT/latest-prepared" || true)"
  fi
  [[ -n "$requested" ]] || die "No prepared release was found. Run prepare first."
  resolved="$(realpath -e "$requested")"
  root_resolved="$(realpath -m "$RELEASE_ROOT")"
  case "$resolved/" in
    "$root_resolved"/*) ;;
    *) die "Release must be inside $root_resolved" ;;
  esac
  [[ "$resolved" != *[[:space:]]* ]] || die "Release path cannot contain whitespace."
  [[ -f "$resolved/.codexapp-release-ready" ]] || die "Release is missing its readiness marker: $resolved"
  [[ -f "$resolved/dist-cli/index.js" ]] || die "Release CLI entry is missing: $resolved/dist-cli/index.js"
  validate_api_proxy_component "$resolved" || return 1
  printf '%s\n' "$resolved"
}

validate_api_proxy_component() {
  "$NODE_BIN" --input-type=commonjs - "$1" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const release = process.argv[2]
if (!fs.readFileSync(path.join(release, 'dist-cli/index.js'), 'utf8').includes('/codex-api/api-proxy')) process.exit(0)
const directory = path.join(release, 'api-proxy-component')
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
const binary = fs.readFileSync(path.join(directory, 'cli-proxy-api'))
fs.accessSync(path.join(directory, 'cli-proxy-api'), fs.constants.X_OK)
fs.accessSync(path.join(directory, 'LICENSE'))
if (crypto.createHash('sha256').update(binary).digest('hex') !== manifest.binarySha256) throw new Error('Prepared API proxy component checksum mismatch')
NODE
}

service_environment_is_expected() {
  local environment
  environment="$(systemctl show "$SERVICE_NAME" -p Environment --value)"
  [[ " $environment " == *" CODEX_HOME=$PRODUCTION_HOME "* ]]
}

check_runtime_boundary() {
  require_command systemctl
  require_command stat
  require_command curl
  require_command realpath
  [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "Node executable is unavailable: $NODE_BIN"
  [[ "$NODE_BIN" != *[[:space:]]* ]] || die "Node path cannot contain whitespace."
  systemctl cat "$SERVICE_NAME" >/dev/null || die "Systemd service is unavailable: $SERVICE_NAME"
  service_environment_is_expected || die "$SERVICE_NAME does not use the expected CODEX_HOME=$PRODUCTION_HOME"
  [[ -d "$PRODUCTION_HOME" ]] || die "Production CODEX_HOME is missing: $PRODUCTION_HOME"
  [[ "$(stat -c '%a' "$PRODUCTION_HOME")" == "700" ]] || die "Production CODEX_HOME must have mode 0700."
}

require_cutover_commands() {
  local command
  for command in cp diff cmp install lsof; do
    require_command "$command"
  done
}

check_idle_runtime() {
  local base_url="$PRODUCTION_URL" legacy_scheduler=0 legacy_api_proxy=0
  if running_release_has_no_scheduler; then legacy_scheduler=1; fi
  if running_release_has_no_api_proxy; then legacy_api_proxy=1; fi
  CODEXAPP_LEGACY_API_PROXY="$legacy_api_proxy" CODEXAPP_LEGACY_SCHEDULER="$legacy_scheduler" CODEXAPP_IDLE_CHECK_URL="$base_url" "$NODE_BIN" "$REPO_DIR/scripts/check-codexapp-idle.cjs"
}

snapshot_auth_state() {
  local transaction="$1"
  local snapshot="$transaction/auth-snapshot"
  local item marker
  mkdir -p "$snapshot"
  chmod 700 "$snapshot"
  for item in auth.json accounts.json accounts; do
    marker="${item//./_}.present"
    if [[ -e "$PRODUCTION_HOME/$item" ]]; then
      cp -a "$PRODUCTION_HOME/$item" "$snapshot/$item"
      : > "$snapshot/$marker"
    fi
  done
  AUTH_SNAPSHOT_READY=1
}

auth_state_matches_snapshot() {
  local transaction="$1"
  local snapshot="$transaction/auth-snapshot"
  local item marker
  for item in auth.json accounts.json accounts; do
    marker="${item//./_}.present"
    if [[ -f "$snapshot/$marker" ]]; then
      [[ -e "$PRODUCTION_HOME/$item" ]] || return 1
    elif [[ -e "$PRODUCTION_HOME/$item" ]]; then
      return 1
    fi
  done
  # Account homes also contain live SQLite databases, caches and temporary files.
  # Keep the full rollback snapshot, but compare only authentication invariants.
  "$NODE_BIN" - "$snapshot" "$PRODUCTION_HOME" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const [snapshot, home] = process.argv.slice(2);
const volatileAccountFields = new Set([
  'authStatus', 'lastVerifiedAtIso', 'quotaSnapshot', 'quotaUpdatedAtIso',
  'quotaStatus', 'quotaError', 'unavailableReason', 'resetCredits',
]);
function metadata(root) {
  const file = path.join(root, 'accounts.json');
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!state || !Array.isArray(state.accounts)) throw new Error('invalid metadata');
  return {
    ...state,
    accounts: state.accounts.map(account => {
      if (!account || typeof account.storageId !== 'string') throw new Error('invalid account');
      return Object.fromEntries(Object.entries(account).filter(([key]) => !volatileAccountFields.has(key)));
    }),
  };
}
function credentials(root) {
  const files = new Map();
  function add(relative) {
    const file = path.join(root, relative);
    if (fs.existsSync(file)) files.set(relative, fs.readFileSync(file));
  }
  add('auth.json');
  // Only the store's profile and pending-login locations contain credentials.
  // Do not traverse sessions, databases, caches or tmp under each account home.
  const accounts = path.join(root, 'accounts');
  if (fs.existsSync(accounts)) {
    for (const entry of fs.readdirSync(accounts, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.pending') {
        for (const login of fs.readdirSync(path.join(accounts, '.pending'), { withFileTypes: true })) {
          if (login.isDirectory()) add(path.join('accounts', '.pending', login.name, 'auth.json'));
        }
      } else {
        add(path.join('accounts', entry.name, 'auth.json'));
      }
    }
  }
  return files;
}
try {
  if (!isDeepStrictEqual(metadata(snapshot), metadata(home)) ||
      !isDeepStrictEqual(credentials(snapshot), credentials(home))) process.exit(1);
} catch {
  // Never print parsed metadata or credential contents, including parse errors.
  process.exit(1);
}
NODE
}

restore_auth_snapshot() {
  local transaction="$1"
  local snapshot="$transaction/auth-snapshot"
  local quarantine="$transaction/quarantined-auth-state"
  local item marker
  [[ "$AUTH_SNAPSHOT_READY" == "1" ]] || return 0
  mkdir -p "$quarantine"
  for item in auth.json accounts.json accounts; do
    marker="${item//./_}.present"
    if [[ -e "$PRODUCTION_HOME/$item" ]]; then
      mv "$PRODUCTION_HOME/$item" "$quarantine/$item"
    fi
    if [[ -f "$snapshot/$marker" ]]; then
      cp -a "$snapshot/$item" "$PRODUCTION_HOME/$item"
    fi
  done
}

snapshot_dropin() {
  local transaction="$1"
  mkdir -p "$transaction"
  if [[ -f "$DROPIN_FILE" ]]; then
    cp -a "$DROPIN_FILE" "$transaction/previous-dropin.conf"
    : > "$transaction/previous-dropin.present"
  fi
  DROPIN_SNAPSHOT_READY=1
}

restore_dropin_snapshot() {
  local transaction="$1"
  [[ "$DROPIN_SNAPSHOT_READY" == "1" ]] || return 0
  mkdir -p "$DROPIN_DIR"
  if [[ -f "$transaction/previous-dropin.present" ]]; then
    install -m 600 "$transaction/previous-dropin.conf" "$DROPIN_FILE"
  elif [[ -f "$DROPIN_FILE" ]]; then
    mv "$DROPIN_FILE" "$transaction/replaced-dropin.conf"
  fi
}

install_release_dropin() {
  local release="$1"
  local temporary
  mkdir -p "$DROPIN_DIR"
  temporary="$(mktemp "$DROPIN_DIR/.codexapp-release.XXXXXX")"
  printf '%s\n' \
    '[Service]' \
    'ExecStart=' \
    "Environment=CODEXAPP_API_PROXY_BINARY=$release/api-proxy-component/cli-proxy-api" \
    "ExecStart=$NODE_BIN $release/dist-cli/index.js --port $PRODUCTION_PORT --strict-port --no-password --no-open" \
    > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$DROPIN_FILE"
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS "$PRODUCTION_URL/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_test_container_after_failure() {
  if [[ "$TEST_CONTAINER_WAS_RUNNING" == "1" ]]; then
    docker start "$TEST_CONTAINER" >/dev/null 2>&1 || true
  fi
}

rollback_failed_cutover() {
  local exit_status="${1:-$?}"
  trap - ERR
  set +e
  log "Cutover failed; restoring the previous service definition and authentication snapshot."
  systemctl stop "$SERVICE_NAME" >/dev/null 2>&1
  restore_dropin_snapshot "$CUTOVER_TRANSACTION"
  systemctl daemon-reload
  restore_auth_snapshot "$CUTOVER_TRANSACTION"
  systemctl start "$SERVICE_NAME"
  wait_for_health
  restart_test_container_after_failure
  log "Automatic rollback finished with original error status $exit_status."
  exit "$exit_status"
}

fail_cutover() {
  log "ERROR: $*" >&2
  rollback_failed_cutover 1
}

prepare_release() {
  require_root
  require_command git
  require_command pnpm
  require_command npm
  require_command tar
  require_command realpath
  [[ -f "$REPO_DIR/package.json" ]] || die "Source package.json is missing: $REPO_DIR/package.json"
  [[ -z "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]] || die "Tracked source changes are not committed. Commit them before preparing a release."

  local version commit timestamp release pack_path help_path
  version="$($NODE_BIN -p "require('${REPO_DIR}/package.json').version")"
  commit="$(git -C "$REPO_DIR" rev-parse --short=12 HEAD)"
  timestamp="$(date '+%Y%m%d-%H%M%S')"
  release="$RELEASE_ROOT/codexapp-${version}-${commit}-${timestamp}"
  pack_path="/tmp/codexapp-${version}.tgz"
  [[ ! -e "$release" ]] || die "Release already exists: $release"

  log "Building committed source at $commit."
  pnpm --dir "$REPO_DIR" run build
  pnpm --dir "$REPO_DIR" pack --pack-destination /tmp
  [[ -f "$pack_path" ]] || die "Expected package tarball was not created: $pack_path"

  mkdir -p "$release"
  tar -xzf "$pack_path" -C "$release" --strip-components=1
  # Record the exact deployment tree; recovery of this release can use npm ci
  # instead of resolving transitive ranges again. Do not upgrade at activation.
  npm --prefix "$release" install --omit=dev --package-lock
  [[ -f "$release/package-lock.json" ]] || die "Prepared dependency lock is missing."

  if [[ -f "$REPO_DIR/resources/api-proxy/manifest.json" ]]; then
    "$NODE_BIN" "$REPO_DIR/scripts/install-api-proxy.cjs" "$REPO_DIR/output/api-proxy-component"
    cp -a "$REPO_DIR/output/api-proxy-component" "$release/api-proxy-component"
    validate_api_proxy_component "$release"
  fi

  help_path="$release/codexapp-help.txt"
  "$NODE_BIN" "$release/dist-cli/index.js" --help > "$help_path"
  grep -q -- '--strict-port' "$help_path" || die "Prepared CLI does not expose --strict-port."
  if grep -Eq -- '--tunnel|--no-tunnel|--login|--no-login|^[[:space:]]+login([[:space:]]|$)' "$help_path"; then
    die "Prepared CLI still exposes removed tunnel/login startup controls."
  fi
  "$NODE_BIN" -e "const p=require(process.argv[1]); if(p.name!=='codexapp'||p.version!==process.argv[2]) process.exit(1)" "$release/package.json" "$version"

  printf 'version=%s\ncommit=%s\nprepared_at=%s\nsource=%s\n' \
    "$version" "$commit" "$(date --iso-8601=seconds)" "$REPO_DIR" \
    > "$release/.codexapp-release-ready"
  chmod 600 "$release/.codexapp-release-ready" "$help_path"
  mkdir -p "$STATE_ROOT"
  chmod 700 "$RELEASE_ROOT" "$STATE_ROOT"
  atomic_write_line "$STATE_ROOT/latest-prepared" "$release"
  log "Prepared release: $release"
  log "No production service, port, or authentication file was changed."
}

check_release() {
  local release
  release="$(validate_release "${1:-latest}")"
  check_runtime_boundary
  systemctl is-active --quiet "$SERVICE_NAME" || die "$SERVICE_NAME is not active."
  curl -fsS "$PRODUCTION_URL/" >/dev/null || die "Production health check failed: $PRODUCTION_URL/"
  check_idle_runtime
  log "Release is ready: $release"
  log "Runtime is idle according to CodexApp. Direct host CLI activity must still be checked by the user."
}

activate_release() {
  require_root
  require_cutover_commands
  local requested="latest"
  local confirmed=0
  local argument release transaction timestamp previous_transaction
  shift
  for argument in "$@"; do
    case "$argument" in
      --confirm-idle) confirmed=1 ;;
      latest) requested="latest" ;;
      --*) die "Unknown activate option: $argument" ;;
      *) requested="$argument" ;;
    esac
  done
  [[ "$confirmed" == "1" ]] || die "Refusing cutover without --confirm-idle. End the Codex turn and close all CodexApp tabs first."
  release="$(validate_release "$requested")"
  check_runtime_boundary
  systemctl is-active --quiet "$SERVICE_NAME" || die "$SERVICE_NAME must be active before cutover."
  drain_activation_for_cutover
  drain_scheduler_for_cutover
  drain_api_proxy_for_cutover
  check_idle_runtime

  timestamp="$(date '+%Y%m%d-%H%M%S')"
  transaction="$STATE_ROOT/transactions/activate-$timestamp"
  mkdir -p "$transaction"
  chmod 700 "$transaction"
  CURRENT_LOG="$transaction/switch.log"
  : > "$CURRENT_LOG"
  CUTOVER_TRANSACTION="$transaction"
  previous_transaction="$(read_first_line "$CURRENT_TRANSACTION_FILE" || true)"
  atomic_write_line "$transaction/target-release" "$release"
  atomic_write_line "$transaction/previous-transaction" "$previous_transaction"
  systemctl show "$SERVICE_NAME" -p FragmentPath -p DropInPaths -p ExecStart -p WorkingDirectory -p Environment > "$transaction/previous-service-state.txt"
  snapshot_dropin "$transaction"

  if docker inspect "$TEST_CONTAINER" >/dev/null 2>&1 && [[ "$(docker inspect -f '{{.State.Running}}' "$TEST_CONTAINER")" == "true" ]]; then
    TEST_CONTAINER_WAS_RUNNING=1
    log "Stopping isolated test container $TEST_CONTAINER."
    docker stop --time 30 "$TEST_CONTAINER" >/dev/null
  fi

  trap rollback_failed_cutover ERR
  log "Stopping $SERVICE_NAME after the idle check."
  systemctl stop "$SERVICE_NAME"
  if lsof -nP -iTCP:"$PRODUCTION_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    fail_cutover "Production port $PRODUCTION_PORT is still occupied after stopping $SERVICE_NAME."
  fi
  snapshot_auth_state "$transaction"
  log "Authentication state snapshot created after service stop."

  install_release_dropin "$release"
  systemctl daemon-reload
  systemctl start "$SERVICE_NAME"
  wait_for_health || fail_cutover "New release did not pass the homepage health check within 60 seconds."
  systemctl is-active --quiet "$SERVICE_NAME" || fail_cutover "New release service is not active."
  systemctl show "$SERVICE_NAME" -p ExecStart --value | grep -Fq "$release/dist-cli/index.js" || fail_cutover "Systemd did not load the target release."
  auth_state_matches_snapshot "$transaction" || fail_cutover "Authentication state changed during code-only cutover."

  printf 'activated_at=%s\nrelease=%s\nauth_state_unchanged=yes\n' \
    "$(date --iso-8601=seconds)" "$release" > "$transaction/result.txt"
  atomic_write_line "$CURRENT_TRANSACTION_FILE" "$transaction"
  trap - ERR
  log "Cutover succeeded: $release"
  log "Authentication state remained byte-for-byte unchanged. Test container $TEST_CONTAINER remains stopped."
}

rollback_release() {
  require_root
  require_cutover_commands
  shift
  [[ "${1:-}" == "--confirm-idle" ]] || die "Refusing rollback without --confirm-idle. End active work and close all CodexApp tabs first."
  local active_transaction previous_transaction timestamp transaction
  active_transaction="$(read_first_line "$CURRENT_TRANSACTION_FILE" || true)"
  [[ -n "$active_transaction" && -d "$active_transaction" ]] || die "No active release-switch transaction is available to roll back."
  previous_transaction="$(read_first_line "$active_transaction/previous-transaction" || true)"
  check_runtime_boundary
  systemctl is-active --quiet "$SERVICE_NAME" || die "$SERVICE_NAME must be active before rollback."
  drain_activation_for_cutover
  drain_scheduler_for_cutover
  drain_api_proxy_for_cutover
  check_idle_runtime

  timestamp="$(date '+%Y%m%d-%H%M%S')"
  transaction="$STATE_ROOT/transactions/rollback-$timestamp"
  mkdir -p "$transaction"
  chmod 700 "$transaction"
  CURRENT_LOG="$transaction/switch.log"
  : > "$CURRENT_LOG"
  CUTOVER_TRANSACTION="$transaction"
  snapshot_dropin "$transaction"

  trap rollback_failed_cutover ERR
  log "Stopping $SERVICE_NAME for rollback."
  systemctl stop "$SERVICE_NAME"
  snapshot_auth_state "$transaction"
  DROPIN_SNAPSHOT_READY=1
  if [[ -f "$active_transaction/previous-dropin.present" ]]; then
    install -m 600 "$active_transaction/previous-dropin.conf" "$DROPIN_FILE"
  elif [[ -f "$DROPIN_FILE" ]]; then
    mv "$DROPIN_FILE" "$transaction/rolled-back-dropin.conf"
  fi
  systemctl daemon-reload
  systemctl start "$SERVICE_NAME"
  wait_for_health || fail_cutover "Rolled-back release did not pass the homepage health check within 60 seconds."
  systemctl is-active --quiet "$SERVICE_NAME" || fail_cutover "Rolled-back service is not active."
  auth_state_matches_snapshot "$transaction" || fail_cutover "Authentication state changed during code rollback."

  if [[ -n "$previous_transaction" && -d "$previous_transaction" ]]; then
    atomic_write_line "$CURRENT_TRANSACTION_FILE" "$previous_transaction"
  elif [[ -f "$CURRENT_TRANSACTION_FILE" ]]; then
    mv "$CURRENT_TRANSACTION_FILE" "$transaction/cleared-current-transaction"
  fi
  printf 'rolled_back_at=%s\nfrom_transaction=%s\nauth_state_unchanged=yes\n' \
    "$(date --iso-8601=seconds)" "$active_transaction" > "$transaction/result.txt"
  trap - ERR
  log "Rollback succeeded. Authentication state remained byte-for-byte unchanged."
}

show_status() {
  local active_state sub_state main_pid current_transaction latest release_line="none" token
  active_state="$(systemctl show "$SERVICE_NAME" -p ActiveState --value 2>/dev/null || true)"
  sub_state="$(systemctl show "$SERVICE_NAME" -p SubState --value 2>/dev/null || true)"
  main_pid="$(systemctl show "$SERVICE_NAME" -p MainPID --value 2>/dev/null || true)"
  current_transaction="$(read_first_line "$CURRENT_TRANSACTION_FILE" || true)"
  latest="$(read_first_line "$STATE_ROOT/latest-prepared" || true)"
  if [[ -f "$DROPIN_FILE" ]]; then
    release_line="custom-dropin"
    while IFS= read -r token; do
      case "$token" in
        "$RELEASE_ROOT"/*/dist-cli/index.js)
          release_line="$token"
          break
          ;;
      esac
    done < <(tr ' ' '\n' < "$DROPIN_FILE")
  else
    release_line="base-unit"
  fi
  printf 'service=%s\nstate=%s/%s\nmain_pid=%s\nactive_release=%s\nlatest_prepared=%s\ncurrent_transaction=%s\n' \
    "$SERVICE_NAME" "${active_state:-unknown}" "${sub_state:-unknown}" "${main_pid:-0}" "$release_line" "${latest:-none}" "${current_transaction:-none}"
  if docker inspect "$TEST_CONTAINER" >/dev/null 2>&1; then
    printf 'test_container=%s\n' "$(docker inspect -f '{{.State.Status}}' "$TEST_CONTAINER")"
  else
    printf 'test_container=absent\n'
  fi
  if [[ -f "$PRODUCTION_HOME/auth.json" ]]; then
    stat -c 'production_auth=present,mode=%a,size=%s,mtime=%Y' "$PRODUCTION_HOME/auth.json"
  else
    printf 'production_auth=absent\n'
  fi
}

main() {
  local command="${1:-}"
  case "$command" in
    prepare) prepare_release ;;
    check) check_release "${2:-latest}" ;;
    activate) activate_release "$@" ;;
    rollback) rollback_release "$@" ;;
    status) show_status ;;
    -h|--help|help|'') usage ;;
    *) usage >&2; die "Unknown command: $command" ;;
  esac
}

main "$@"
