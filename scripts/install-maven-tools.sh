#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/install-maven-tools.sh [--root /data/mise] [--manifest /data/mise/manifests/maven.json] [key-or-version...]

Installs Maven versions with:
  MISE_DATA_DIR=/data/mise/maven/data
  MISE_CACHE_DIR=/data/mise/maven/cache
  MISE_TMP_DIR=/data/mise/maven/tmp
  mise install maven@<version>
EOF
}

manifest=""
versions=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || die "--root requires a value"
      MISE_ROOT="$2"
      shift 2
      ;;
    --manifest)
      [[ $# -ge 2 ]] || die "--manifest requires a value"
      manifest="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      versions+=("$1")
      shift
      ;;
  esac
done

require_root
ensure_mise
manifest="${manifest:-${MISE_ROOT}/manifests/maven.json}"

if [[ "${#versions[@]}" -eq 0 ]]; then
  mapfile -t versions < <(manifest_resolved_versions "$manifest" "maven")
else
  mapfile -t versions < <(manifest_resolved_versions "$manifest" "maven" "${versions[@]}")
fi

export_mise_env_for_tool "maven"
mkdir -p "$MISE_DATA_DIR" "$MISE_CACHE_DIR" "$MISE_TMP_DIR"

for version in "${versions[@]}"; do
  log "installing maven@${version}"
  "$MISE_BIN" install "maven@${version}"
  "$MISE_BIN" exec "maven@${version}" -- mvn -v
done

set_mise_permissions "$MISE_ROOT"
log "normalized permissions under ${MISE_ROOT}"
