#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/generate-toolchain-index.sh \
    [--root /data/mise] \
    [--manifest-dir /data/mise/manifests] \
    [--ci-root /data/devops-ci] \
    [--base config/devops-toolchain/index.base.json] \
    [--output /data/devops-ci/index.json]

Generates the platform toolchain index only after all declared Java, Maven,
and Gradle tools are present and executable.
EOF
}

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
manifest_dir=""
base_file="${REPO_ROOT}/config/devops-toolchain/index.base.json"
output_file=""

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
    --ci-root)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      DEVOPS_CI_ROOT="$2"
      DEVOPS_CI_INDEX="${DEVOPS_CI_ROOT}/index.json"
      shift 2
      ;;
    --base)
      [[ $# -ge 2 ]] || die "--base requires a value"
      base_file="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || die "--output requires a value"
      output_file="$2"
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
output_file="${output_file:-${DEVOPS_CI_INDEX}}"

ensure_command python3
[[ -f "$base_file" ]] || die "base index not found: $base_file"
[[ -d "$manifest_dir" ]] || die "manifest directory not found: $manifest_dir"

mkdir -p "$(dirname "$output_file")"
tmp_file="$(mktemp "${output_file}.tmp.XXXXXX")"

python3 - "$MISE_ROOT" "$manifest_dir" "$base_file" "$tmp_file" <<'PY'
import json
import os
import subprocess
import sys

mise_root, manifest_dir, base_file, output_file = sys.argv[1:5]

def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)

def run_check(command):
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def require_exe(path):
    if not os.path.isfile(path) or not os.access(path, os.X_OK):
        raise SystemExit(f"required executable not found: {path}")

index = load_json(base_file)
index.setdefault("java", {})
index["java"]["jdks"] = {}
index["java"]["maven"] = {}
index["java"]["gradle"] = {}

java_manifest = load_json(os.path.join(manifest_dir, "java.json"))
maven_manifest = load_json(os.path.join(manifest_dir, "maven.json"))
gradle_manifest = load_json(os.path.join(manifest_dir, "gradle.json"))

for item in java_manifest.get("java", []):
    name = item["name"]
    version = item["version"]
    java_home = os.path.join(mise_root, "java", "data", "installs", "java", version)
    java_bin = os.path.join(java_home, "bin", "java")
    require_exe(java_bin)
    run_check([java_bin, "-version"])
    index["java"]["jdks"][name] = {"JAVA_HOME": java_home}

for item in maven_manifest.get("maven", []):
    name = item["name"]
    version = item["version"]
    maven_home = os.path.join(mise_root, "maven", "data", "installs", "maven", version)
    mvn_bin = os.path.join(maven_home, "bin", "mvn")
    require_exe(mvn_bin)
    run_check([mvn_bin, "-v"])
    index["java"]["maven"][name] = {"MAVEN_HOME": maven_home}

for item in gradle_manifest.get("gradle", []):
    name = item["name"]
    version = item["version"]
    gradle_home = os.path.join(mise_root, "gradle", "data", "installs", "gradle", version)
    gradle_bin = os.path.join(gradle_home, "bin", "gradle")
    require_exe(gradle_bin)
    run_check([gradle_bin, "-v"])
    index["java"]["gradle"][name] = {"GRADLE_HOME": gradle_home}

with open(output_file, "w", encoding="utf-8") as fh:
    json.dump(index, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

mv "$tmp_file" "$output_file"
chmod 0644 "$output_file"
log "wrote toolchain index: $output_file"
