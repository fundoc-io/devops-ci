#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/init-mise-layout.sh \
    [--root /data/mise] \
    [--ci-root /data/devops-ci] \
    [--index /data/devops-ci/index.json]

Initializes the fixed mise directory layout for Java, Maven, and Gradle.
It writes a manual profile snippet under /data/mise/runtime-config/profile.sh
but does not create /etc/profile.d files.
EOF
}

index_explicit=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || die "--root requires a value"
      MISE_ROOT="$2"
      shift 2
      ;;
    --ci-root)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      DEVOPS_CI_ROOT="$2"
      if [[ "$index_explicit" != "1" ]]; then
        DEVOPS_CI_INDEX="${DEVOPS_CI_ROOT}/index.json"
      fi
      shift 2
      ;;
    --index)
      [[ $# -ge 2 ]] || die "--index requires a value"
      DEVOPS_CI_INDEX="$2"
      index_explicit=1
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

require_root

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

log "initializing mise layout at ${MISE_ROOT}"
mark_mise_root "$MISE_ROOT"
mkdir -p \
  "${MISE_ROOT}/system-config" \
  "${MISE_ROOT}/runtime-config" \
  "${MISE_ROOT}/java/data" "${MISE_ROOT}/java/cache" "${MISE_ROOT}/java/tmp" \
  "${MISE_ROOT}/maven/data" "${MISE_ROOT}/maven/cache" "${MISE_ROOT}/maven/tmp" \
  "${MISE_ROOT}/gradle/data" "${MISE_ROOT}/gradle/cache" "${MISE_ROOT}/gradle/tmp" \
  "${MISE_ROOT}/manifests" \
  "${MISE_ROOT}/profiles" \
  "${MISE_ROOT}/scripts"

cat > "${MISE_ROOT}/system-config/config.toml" <<'EOF'
[settings]
yes = true
disable_tools = ["node"]
EOF

cat > "${MISE_ROOT}/runtime-config/config.toml" <<EOF
[env]
DEVOPS_MISE_ROOT = "${MISE_ROOT}"
DEVOPS_CI_INDEX = "${DEVOPS_CI_INDEX}"
EOF

cat > "${MISE_ROOT}/runtime-config/profile.sh" <<EOF
# Source this file explicitly when maintaining the CI toolchain host.
# Jenkins builds should use ${DEVOPS_CI_INDEX} and withEnv
# instead of loading this profile globally.
export DEVOPS_MISE_ROOT="${MISE_ROOT}"
export DEVOPS_CI_ROOT="${DEVOPS_CI_ROOT}"
export DEVOPS_CI_INDEX="${DEVOPS_CI_INDEX}"
export MISE_BIN="${MISE_BIN}"
export PATH="/usr/local/bin:\$PATH"
EOF

for manifest in java.json maven.json gradle.json; do
  cp "${REPO_ROOT}/config/mise/manifests/${manifest}" "${MISE_ROOT}/manifests/${manifest}"
done

mkdir -p "${MISE_ROOT}/scripts/lib"
for script in \
  install-java-tools.sh \
  install-maven-tools.sh \
  install-gradle-tools.sh \
  validate-mise-tools.sh \
  generate-toolchain-index.sh; do
  cp "${REPO_ROOT}/scripts/${script}" "${MISE_ROOT}/scripts/${script}"
done
cp "${REPO_ROOT}/scripts/lib/mise-common.sh" "${MISE_ROOT}/scripts/lib/mise-common.sh"

set_mise_permissions "$MISE_ROOT"
log "mise layout initialized"
