#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/install-gradle-tools.sh \
    [--root /data/mise] \
    [--manifest /data/mise/manifests/gradle.json] \
    [--archive /path/to/gradle.tar.gz] \
    [--force] \
    [key-or-version...]

Installs Gradle versions with:
  MISE_DATA_DIR=/data/mise/data
  MISE_CONFIG_DIR=/data/mise/config
  MISE_CACHE_DIR=/data/mise/cache
  MISE_STATE_DIR=/data/mise/state
  MISE_TMP_DIR=/data/mise/tmp
  mise install gradle@<version>

When --archive is provided, the script does not download through mise. It
extracts one local Gradle archive into:
  /data/mise/data/installs/gradle/<manifest-version>

For manual maintenance, source /data/mise/mise-env.sh and use mise directly:
  source /data/mise/mise-env.sh
  mise install gradle@<version>
  mise where gradle@<version>
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
manifest="${manifest:-${MISE_ROOT}/manifests/gradle.json}"

if [[ "${#versions[@]}" -eq 0 ]]; then
  mapfile -t versions < <(manifest_resolved_versions "$manifest" "gradle")
else
  mapfile -t versions < <(manifest_resolved_versions "$manifest" "gradle" "${versions[@]}")
fi

load_mise_env
mkdir -p "$MISE_DATA_DIR" "$MISE_CONFIG_DIR" "$MISE_CACHE_DIR" "$MISE_STATE_DIR" "$MISE_TMP_DIR"

if [[ -n "$archive" && "${#versions[@]}" -ne 1 ]]; then
  die "--archive installs exactly one Gradle version; pass one key such as 8.8"
fi

for version in "${versions[@]}"; do
  min_java="$(manifest_tool_field "$manifest" "gradle" "$version" "minJava")"
  validation_java_home="$(select_probe_java_home "${MISE_ROOT}/manifests/java.json" "$min_java")"
  if [[ -z "$validation_java_home" ]]; then
    die "Gradle ${version} validation requires Java ${min_java:-any}+; install a matching platform JDK first or provide JAVA_HOME"
  fi

  if [[ -n "$archive" ]]; then
    install_archive_into_mise_tool "gradle" "$version" "$archive" "bin/gradle" "$force"
    run_with_java_home "$validation_java_home" "$(mise_tool_install_dir "gradle" "$version")/bin/gradle" -v
  else
    ensure_mise
    log "installing gradle@${version}"
    "$MISE_BIN" install "gradle@${version}"
    run_with_java_home "$validation_java_home" "$MISE_BIN" exec "gradle@${version}" -- gradle -v
  fi
done

set_mise_permissions "$MISE_ROOT"
log "normalized permissions under ${MISE_ROOT}"
