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
    [--index /data/devops-ci/index.json] \
    [--mise-bin /usr/local/bin/mise] \
    [--devops-mise /usr/local/bin/devops-mise]

Initializes the fixed mise directory layout for host Node.js, Java, Maven,
and Gradle. It writes /data/mise/mise-env.sh and a devops-mise wrapper, but
does not create /etc/profile.d files.
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
    --mise-bin)
      [[ $# -ge 2 ]] || die "--mise-bin requires a value"
      MISE_BIN="$2"
      shift 2
      ;;
    --devops-mise)
      [[ $# -ge 2 ]] || die "--devops-mise requires a value"
      DEVOPS_MISE_BIN="$2"
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
  "${MISE_ROOT}/data" \
  "${MISE_ROOT}/config" \
  "${MISE_ROOT}/cache" \
  "${MISE_ROOT}/state" \
  "${MISE_ROOT}/tmp" \
  "${MISE_ROOT}/manifests" \
  "${MISE_ROOT}/scripts"

cat > "${MISE_ROOT}/config/config.toml" <<'EOF'
[settings]
yes = true
EOF

mkdir -p "$(dirname "$DEVOPS_CI_INDEX")"
if [[ ! -e "$DEVOPS_CI_INDEX" ]]; then
  cp "${REPO_ROOT}/config/devops-toolchain/index.base.json" "$DEVOPS_CI_INDEX"
  chmod 0644 "$DEVOPS_CI_INDEX"
fi

cat > "${MISE_ROOT}/mise-env.sh" <<EOF
# Platform-controlled mise environment for DevOps toolchain management.
export DEVOPS_MISE_ROOT="${MISE_ROOT}"
export DEVOPS_CI_ROOT="${DEVOPS_CI_ROOT}"
export DEVOPS_CI_INDEX="${DEVOPS_CI_INDEX}"
export MISE_BIN="${MISE_BIN}"
export DEVOPS_MISE_BIN="${DEVOPS_MISE_BIN}"
export MISE_DATA_DIR="${MISE_ROOT}/data"
export MISE_CONFIG_DIR="${MISE_ROOT}/config"
export MISE_CACHE_DIR="${MISE_ROOT}/cache"
export MISE_STATE_DIR="${MISE_ROOT}/state"
export MISE_TMP_DIR="${MISE_ROOT}/tmp"
export MISE_GLOBAL_CONFIG_FILE="${MISE_ROOT}/config/config.toml"
export PATH="${MISE_ROOT}/data/shims:/usr/local/bin:\$PATH"
EOF

mkdir -p "$(dirname "$DEVOPS_MISE_BIN")"
cat > "$DEVOPS_MISE_BIN" <<EOF
#!/usr/bin/env bash
set -euo pipefail

source "${MISE_ROOT}/mise-env.sh"

exec "${MISE_BIN}" "\$@"
EOF
chmod 0755 "$DEVOPS_MISE_BIN"

for manifest in tooling-node.json java.json maven.json gradle.json; do
  cp "${REPO_ROOT}/config/mise/manifests/${manifest}" "${MISE_ROOT}/manifests/${manifest}"
done

mkdir -p "${MISE_ROOT}/scripts/lib"
for script in \
  install-tooling-node.sh \
  install-java-tools.sh \
  install-maven-tools.sh \
  install-gradle-tools.sh \
  validate-mise-tools.sh \
  generate-toolchain-index.sh; do
  cp "${REPO_ROOT}/scripts/${script}" "${MISE_ROOT}/scripts/${script}"
done
cp "${REPO_ROOT}/scripts/lib/mise-common.sh" "${MISE_ROOT}/scripts/lib/mise-common.sh"

set_mise_permissions "$MISE_ROOT"
chown root:root "$DEVOPS_MISE_BIN"
chmod 0755 "$DEVOPS_MISE_BIN"
log "mise layout initialized"
