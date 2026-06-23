#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/validate-mise-tools.sh [--root /data/mise] [--manifest-dir /data/mise/manifests]

Validates installed Java, Maven, and Gradle versions declared in manifests.
EOF
}

manifest_dir=""

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

validate_java() {
  local version="$1"
  local java_home="${MISE_ROOT}/java/data/installs/java/${version}"
  [[ -x "${java_home}/bin/java" ]] || die "java binary not found: ${java_home}/bin/java"
  log "validating java ${version}"
  "${java_home}/bin/java" -version
}

validate_maven() {
  local version="$1"
  local maven_home="${MISE_ROOT}/maven/data/installs/maven/${version}"
  [[ -x "${maven_home}/bin/mvn" ]] || die "mvn binary not found: ${maven_home}/bin/mvn"
  log "validating maven ${version}"
  "${maven_home}/bin/mvn" -v
}

validate_gradle() {
  local version="$1"
  local gradle_home="${MISE_ROOT}/gradle/data/installs/gradle/${version}"
  [[ -x "${gradle_home}/bin/gradle" ]] || die "gradle binary not found: ${gradle_home}/bin/gradle"
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

log "all mise-managed tools validated"
