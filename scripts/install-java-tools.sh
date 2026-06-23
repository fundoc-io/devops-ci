#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/install-java-tools.sh \
    [--root /data/mise] \
    [--manifest /data/mise/manifests/java.json] \
    [--archive /path/to/jdk.tar.gz] \
    [--force] \
    [key-or-version...]

Installs Java versions with:
  MISE_DATA_DIR=/data/mise/java/data
  MISE_CACHE_DIR=/data/mise/java/cache
  MISE_TMP_DIR=/data/mise/java/tmp
  mise install java@<version>

When --archive is provided, the script does not download through mise. It
extracts one local JDK archive into:
  /data/mise/java/data/installs/java/<manifest-version>

Example:
  scripts/install-java-tools.sh --archive /data/packages/jdk-11.tar.gz 11
EOF
}

manifest=""
archive=""
force=0
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
    --archive)
      [[ $# -ge 2 ]] || die "--archive requires a value"
      archive="$2"
      shift 2
      ;;
    --force)
      force=1
      shift
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
manifest="${manifest:-${MISE_ROOT}/manifests/java.json}"

if [[ "${#versions[@]}" -eq 0 ]]; then
  mapfile -t versions < <(manifest_resolved_versions "$manifest" "java")
else
  mapfile -t versions < <(manifest_resolved_versions "$manifest" "java" "${versions[@]}")
fi

export_mise_env_for_tool "java"
mkdir -p "$MISE_DATA_DIR" "$MISE_CACHE_DIR" "$MISE_TMP_DIR"

install_java_archive() {
  local version="$1"
  local archive_file="$2"
  local java_bin

  install_archive_into_mise_tool "java" "$version" "$archive_file" "bin/java" "$force"
  java_bin="$(mise_tool_install_dir "java" "$version")/bin/java"
  "$java_bin" -version
}

if [[ -n "$archive" && "${#versions[@]}" -ne 1 ]]; then
  die "--archive installs exactly one Java version; pass one key such as 11"
fi

for version in "${versions[@]}"; do
  if [[ -n "$archive" ]]; then
    install_java_archive "$version" "$archive"
  else
    ensure_mise
    log "installing java@${version}"
    "$MISE_BIN" install "java@${version}"
    "$MISE_BIN" exec "java@${version}" -- java -version
  fi
done

set_mise_permissions "$MISE_ROOT"
log "normalized permissions under ${MISE_ROOT}"
