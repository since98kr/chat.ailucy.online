#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_REPOSITORY_URL='https://github.com/since98kr/chat.ailucy.online'
VALIDATE_ONLY="${RUNNER_VALIDATE_ONLY:-false}"

: "${GITHUB_REPOSITORY_URL:?Set GITHUB_REPOSITORY_URL to https://github.com/since98kr/chat.ailucy.online}"
: "${RUNNER_VERSION:?Set the approved GitHub Actions runner version, for example 2.335.1}"
: "${RUNNER_SHA256:?Set the official SHA-256 for the selected runner archive}"

RUNNER_USER="${RUNNER_USER:-chat-production-runner}"
RUNNER_HOME="${RUNNER_HOME:-/opt/actions-runner-chat-production}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname)-chat-production}"
PRODUCTION_ROOT="${CHAT_PRODUCTION_ROOT:-/opt/chat-v2/production}"
PRODUCTION_DATA_DIR="${CHAT_PRODUCTION_DATA_DIR:-${PRODUCTION_ROOT}/data}"
PRODUCTION_STATE_DIR="${CHAT_PRODUCTION_STATE_DIR:-${PRODUCTION_ROOT}/state}"
ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
DOWNLOAD_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${ARCHIVE}"

log() {
  printf '[chat-production-runner] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

normalize_repository_url() {
  local value="${1%/}"
  value="${value%.git}"
  printf '%s' "${value}"
}

path_is_within() {
  local child parent
  child="$(realpath -m "$1")"
  parent="$(realpath -m "$2")"
  [[ "${child}" == "${parent}" || "${child}" == "${parent}"/* ]]
}

validate_configuration() {
  local repository_url runner_home production_root production_data production_state
  repository_url="$(normalize_repository_url "${GITHUB_REPOSITORY_URL}")"
  [[ "${repository_url}" == "${EXPECTED_REPOSITORY_URL}" ]] \
    || fail "runner may only be registered to ${EXPECTED_REPOSITORY_URL}"

  [[ "${RUNNER_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail 'RUNNER_VERSION must be an explicit semantic version'
  [[ "${RUNNER_SHA256}" =~ ^[0-9a-fA-F]{64}$ ]] \
    || fail 'RUNNER_SHA256 must be a 64-character hexadecimal digest'
  [[ "${VALIDATE_ONLY}" == 'true' || "${VALIDATE_ONLY}" == 'false' ]] \
    || fail 'RUNNER_VALIDATE_ONLY must be true or false'

  [[ "${RUNNER_USER}" != 'root' && "${RUNNER_USER}" != 'chat-runner' ]] \
    || fail 'production runner must use a dedicated non-staging service account'
  [[ "${RUNNER_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] \
    || fail 'RUNNER_USER contains unsupported characters'
  [[ "${RUNNER_NAME}" != *staging* && "${RUNNER_NAME}" != 'agentlucy-chat-staging' ]] \
    || fail 'production runner name must not reuse a staging identity'
  [[ "${RUNNER_NAME}" == *production* ]] \
    || fail 'production runner name must include production'

  runner_home="$(realpath -m "${RUNNER_HOME}")"
  production_root="$(realpath -m "${PRODUCTION_ROOT}")"
  production_data="$(realpath -m "${PRODUCTION_DATA_DIR}")"
  production_state="$(realpath -m "${PRODUCTION_STATE_DIR}")"

  [[ "${runner_home}" == /opt/actions-runner-chat-production* ]] \
    || fail 'RUNNER_HOME must use the dedicated /opt/actions-runner-chat-production namespace'
  [[ "${runner_home}" != /opt/actions-runner-chat-staging* ]] \
    || fail 'production runner may not reuse the staging runner directory'
  [[ "${production_root}" == /opt/chat-v2/production* ]] \
    || fail 'CHAT_PRODUCTION_ROOT must use the /opt/chat-v2/production namespace'
  [[ "${production_root}" != /opt/chat-v2/staging* ]] \
    || fail 'production root may not reuse the staging root'
  path_is_within "${production_data}" "${production_root}" \
    || fail 'production data directory must be contained within the production root'
  path_is_within "${production_state}" "${production_root}" \
    || fail 'production state directory must be contained within the production root'
  path_is_within "${runner_home}" "${production_root}" \
    && fail 'runner binaries and production application data must use separate roots'

  log 'Configuration validation passed.'
  log "Repository: ${repository_url}"
  log "Runner identity: ${RUNNER_NAME} (${RUNNER_USER})"
  log "Runner home: ${runner_home}"
  log "Production root: ${production_root}"
  log "Production data: ${production_data}"
  log "Production state: ${production_state}"
}

ensure_directory() {
  local path="$1" mode="$2"
  if [[ -L "${path}" ]]; then
    fail "refusing symbolic-link directory: ${path}"
  fi
  if [[ -e "${path}" && ! -d "${path}" ]]; then
    fail "path exists but is not a directory: ${path}"
  fi
  if [[ ! -d "${path}" ]]; then
    install -d -o "${RUNNER_USER}" -g "${RUNNER_USER}" -m "${mode}" "${path}"
  fi
}

validate_configuration

if [[ "${VALIDATE_ONLY}" == 'true' ]]; then
  log 'Validation-only mode complete. No user, directory, runner, service, Docker, or GitHub state was changed.'
  exit 0
fi

: "${GITHUB_RUNNER_TOKEN:?Set a short-lived GitHub Actions runner registration token}"

if [[ "${EUID}" -ne 0 ]]; then
  fail 'run this bootstrap script with sudo'
fi

command -v curl >/dev/null || fail 'curl is not installed'
command -v tar >/dev/null || fail 'tar is not installed'
command -v sha256sum >/dev/null || fail 'sha256sum is not installed'
command -v docker >/dev/null || fail 'docker is not installed'
docker compose version >/dev/null || fail 'docker compose is unavailable'
getent group docker >/dev/null || fail 'docker group does not exist'

if [[ -d "${RUNNER_HOME}" ]] && find "${RUNNER_HOME}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  fail "runner directory is not empty; inspect and remove or rotate it manually: ${RUNNER_HOME}"
fi

if ! id "${RUNNER_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${RUNNER_USER}"
fi
[[ "$(id -u "${RUNNER_USER}")" != '0' ]] || fail 'runner service account must not be root'
usermod -aG docker "${RUNNER_USER}"

ensure_directory "${RUNNER_HOME}" 0750
ensure_directory "${PRODUCTION_ROOT}" 0750
ensure_directory "${PRODUCTION_DATA_DIR}" 0750
ensure_directory "${PRODUCTION_DATA_DIR}/artifacts" 0750
ensure_directory "${PRODUCTION_DATA_DIR}/backups" 0750
ensure_directory "${PRODUCTION_STATE_DIR}" 0750

runuser -u "${RUNNER_USER}" -- test -r "${PRODUCTION_DATA_DIR}"
runuser -u "${RUNNER_USER}" -- test -w "${PRODUCTION_DATA_DIR}"
runuser -u "${RUNNER_USER}" -- test -x "${PRODUCTION_DATA_DIR}"
runuser -u "${RUNNER_USER}" -- test -r "${PRODUCTION_STATE_DIR}"
runuser -u "${RUNNER_USER}" -- test -w "${PRODUCTION_STATE_DIR}"
runuser -u "${RUNNER_USER}" -- test -x "${PRODUCTION_STATE_DIR}"
runuser -u "${RUNNER_USER}" -- docker version >/dev/null

if [[ -e "${RUNNER_HOME}/.runner" || -e "${RUNNER_HOME}/.credentials" ]]; then
  fail 'runner directory already contains registration state; manual inspection is required'
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 "${DOWNLOAD_URL}" -o "${tmp_dir}/${ARCHIVE}"
printf '%s  %s\n' "${RUNNER_SHA256}" "${tmp_dir}/${ARCHIVE}" | sha256sum --check --status

tar -xzf "${tmp_dir}/${ARCHIVE}" -C "${RUNNER_HOME}"
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_HOME}"
"${RUNNER_HOME}/bin/installdependencies.sh"

installed_version="$(runuser -u "${RUNNER_USER}" -- "${RUNNER_HOME}/bin/Runner.Listener" --version | tail -n 1)"
[[ "${installed_version}" == "${RUNNER_VERSION}" ]] \
  || fail "installed runner version mismatch: expected ${RUNNER_VERSION}, found ${installed_version:-missing}"

runuser -u "${RUNNER_USER}" -- "${RUNNER_HOME}/config.sh" \
  --unattended \
  --url "${EXPECTED_REPOSITORY_URL}" \
  --token "${GITHUB_RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels 'chat-production' \
  --work '_work'

cd "${RUNNER_HOME}"
./svc.sh install "${RUNNER_USER}"
./svc.sh start
./svc.sh status

cat <<EOF
Production runner installation complete.

Identity and isolation:
- Repository: ${EXPECTED_REPOSITORY_URL}
- Runner user: ${RUNNER_USER}
- Runner name: ${RUNNER_NAME}
- Required custom label: chat-production
- Runner home: ${RUNNER_HOME}
- Production root: ${PRODUCTION_ROOT}
- Production data UID:GID: $(stat -c '%u:%g' "${PRODUCTION_DATA_DIR}")
- Docker access: verified

Security notes:
- This runner executes trusted repository code with Docker access; keep it repository-scoped.
- Do not add the chat-staging label or reuse the staging runner directory.
- Keep CHAT_PRODUCTION_RELEASE_ENABLED=false until a reviewed release window.
- Keep registration tokens and production secrets out of files, logs, issues, and chat.
- This script did not deploy, restart, or replace the Chat V2 production service.
EOF
