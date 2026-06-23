#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/validate-mise-tools.sh [--root /data/mise] [--manifest-dir /data/mise/manifests] [--strict]

Validates installed Java, Maven, and Gradle versions declared in manifests.
By default, missing manifest entries are skipped with a warning. Use --strict
to require every manifest entry to be present.
EOF
}

manifest_dir=""
strict=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || die "--root requires a value"
      MISE_ROOT="$2"
      shift 2
      ;;
    --manifest-dir)
      [[ $# -ge 2 ]] || die "--manifest-dir requires a value"
      manifest_dir="$2"
      shift 2
      ;;
    --strict)
      strict=1
      shift
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

manifest_dir="${manifest_dir:-${MISE_ROOT}/manifests}"
load_mise_env

validate_java() {
  local version="$1"
  local java_home="${MISE_DATA_DIR}/installs/java/${version}"
  if [[ ! -x "${java_home}/bin/java" ]]; then
    if [[ "$strict" == "1" ]]; then
      die "java binary not found: ${java_home}/bin/java"
    fi
    log "skipping missing java ${version}: ${java_home}/bin/java"
    return
  fi
  log "validating java ${version}"
  "${java_home}/bin/java" -version
}

validate_maven() {
  local version="$1"
  local maven_home="${MISE_DATA_DIR}/installs/maven/${version}"
  if [[ ! -x "${maven_home}/bin/mvn" ]]; then
    if [[ "$strict" == "1" ]]; then
      die "mvn binary not found: ${maven_home}/bin/mvn"
    fi
    log "skipping missing maven ${version}: ${maven_home}/bin/mvn"
    return
  fi
  log "validating maven ${version}"
  "${maven_home}/bin/mvn" -v
}

validate_gradle() {
  local version="$1"
  local gradle_home="${MISE_DATA_DIR}/installs/gradle/${version}"
  if [[ ! -x "${gradle_home}/bin/gradle" ]]; then
    if [[ "$strict" == "1" ]]; then
      die "gradle binary not found: ${gradle_home}/bin/gradle"
    fi
    log "skipping missing gradle ${version}: ${gradle_home}/bin/gradle"
    return
  fi
  log "validating gradle ${version}"
  "${gradle_home}/bin/gradle" -v
}

mapfile -t java_versions < <(manifest_versions "${manifest_dir}/java.json" "java")
mapfile -t maven_versions < <(manifest_versions "${manifest_dir}/maven.json" "maven")
mapfile -t gradle_versions < <(manifest_versions "${manifest_dir}/gradle.json" "gradle")

for version in "${java_versions[@]}"; do
  validate_java "$version"
done

for version in "${maven_versions[@]}"; do
  validate_maven "$version"
done

for version in "${gradle_versions[@]}"; do
  validate_gradle "$version"
done

log "mise-managed tool validation complete"
