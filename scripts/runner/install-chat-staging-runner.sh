#!/usr/bin/env bash
set -Eeuo pipefail

: "${GITHUB_REPOSITORY_URL:?Set GITHUB_REPOSITORY_URL, for example https://github.com/since98kr/chat.ailucy.online}"
: "${GITHUB_RUNNER_TOKEN:?Set a short-lived GitHub Actions runner registration token}"
: "${RUNNER_VERSION:?Set the approved GitHub Actions runner version, for example 2.335.1}"
: "${RUNNER_SHA256:?Set the official SHA-256 for the selected runner archive}"

RUNNER_USER="${RUNNER_USER:-chat-runner}"
RUNNER_HOME="${RUNNER_HOME:-/opt/actions-runner-chat-staging}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname)-chat-staging}"
ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
DOWNLOAD_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${ARCHIVE}"

if [[ "${EUID}" -ne 0 ]]; then
  echo 'Run this bootstrap script with sudo.' >&2
  exit 1
fi

if ! id "${RUNNER_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${RUNNER_USER}"
fi

install -d -o "${RUNNER_USER}" -g "${RUNNER_USER}" -m 0750 "${RUNNER_HOME}"
install -d -o "${RUNNER_USER}" -g "${RUNNER_USER}" -m 0750 /opt/chat-v2/staging/data /opt/chat-v2/staging/state

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 "${DOWNLOAD_URL}" -o "${tmp_dir}/${ARCHIVE}"
printf '%s  %s\n' "${RUNNER_SHA256}" "${tmp_dir}/${ARCHIVE}" | sha256sum --check --status

tar -xzf "${tmp_dir}/${ARCHIVE}" -C "${RUNNER_HOME}"
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_HOME}"

"${RUNNER_HOME}/bin/installdependencies.sh"

runuser -u "${RUNNER_USER}" -- "${RUNNER_HOME}/config.sh" \
  --unattended \
  --url "${GITHUB_REPOSITORY_URL}" \
  --token "${GITHUB_RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "chat-staging" \
  --work "_work" \
  --replace

cd "${RUNNER_HOME}"
./svc.sh install "${RUNNER_USER}"
./svc.sh start
./svc.sh status

cat <<'EOF'
Runner installation complete.

Security notes:
- Keep the repository workflow reviewable; a self-hosted runner can execute repository code.
- Do not add this runner to other repositories.
- Store backend API keys in the GitHub `staging` Environment or a root-readable staging env file.
- The deployment workflow binds the application to localhost only.
EOF
