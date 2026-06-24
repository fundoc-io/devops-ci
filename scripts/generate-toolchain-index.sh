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
    [--output /data/devops-ci/index.json] \
    [--strict]

Generates the platform toolchain index from installed Java, Maven, and Gradle
tools. By default, manifest entries that are not installed are skipped with a
warning. Use --strict to require every manifest entry to be present.
EOF
}

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
manifest_dir=""
base_file="${REPO_ROOT}/config/devops-toolchain/index.base.json"
output_file=""
ci_root_arg=""
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
    --ci-root)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      ci_root_arg="$2"
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
if [[ -n "$ci_root_arg" ]]; then
  DEVOPS_CI_ROOT="$ci_root_arg"
  DEVOPS_CI_INDEX="${DEVOPS_CI_ROOT}/index.json"
fi
output_file="${output_file:-${DEVOPS_CI_INDEX}}"

ensure_command python3
[[ -f "$base_file" ]] || die "base index not found: $base_file"
[[ -d "$manifest_dir" ]] || die "manifest directory not found: $manifest_dir"

mkdir -p "$(dirname "$output_file")"
tmp_file="$(mktemp "${output_file}.tmp.XXXXXX")"

python3 - "$MISE_DATA_DIR" "$manifest_dir" "$base_file" "$tmp_file" "$strict" <<'PY'
import json
import os
import re
import subprocess
import sys

mise_data_dir, manifest_dir, base_file, output_file, strict_raw = sys.argv[1:6]
strict = strict_raw == "1"

def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)

def warn(message):
    print(f"WARNING: {message}", file=sys.stderr)

def can_use(command, env=None):
    try:
        subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        return True
    except Exception as exc:
        warn(f"validation failed for {' '.join(command)}: {exc}")
        return False

def executable_available(path):
    return os.path.isfile(path) and os.access(path, os.X_OK)

def include_or_skip(kind, name, executable, command, env=None):
    if not executable_available(executable):
        message = f"{kind} {name} is not installed: {executable}"
        if strict:
            raise SystemExit(message)
        warn(f"skipping {message}")
        return False

    if not can_use(command, env):
        message = f"{kind} {name} exists but failed validation"
        if strict:
            raise SystemExit(message)
        warn(f"skipping {message}")
        return False

    return True

def skip_or_die(message):
    if strict:
        raise SystemExit(message)
    warn(f"skipping {message}")
    return False

def with_java_env(java_home):
    if not java_home:
        return None
    env = os.environ.copy()
    env["JAVA_HOME"] = java_home
    env["PATH"] = os.path.join(java_home, "bin") + os.pathsep + env.get("PATH", "")
    return env

def major_from_text(value):
    match = re.search(r"\d+", str(value or ""))
    if not match:
        return None
    return int(match.group(0))

def select_probe_java(min_java, installed_jdks):
    min_major = major_from_text(min_java) or 0
    candidates = []
    for key, item in installed_jdks.items():
        java_home = item.get("JAVA_HOME")
        major = major_from_text(key) or major_from_text(java_home)
        if java_home and major is not None and major >= min_major:
            candidates.append((major, java_home, "mise"))
    if candidates:
        candidates.sort(key=lambda item: item[0])
        return candidates[0]

    env_java_home = os.environ.get("JAVA_HOME")
    env_major = major_from_text(os.path.basename(env_java_home or ""))
    env_java_bin = os.path.join(env_java_home or "", "bin", "java")
    if env_major is None and executable_available(env_java_bin):
        try:
            result = subprocess.run([env_java_bin, "-version"], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            env_major = major_from_text(result.stdout + result.stderr)
        except Exception:
            env_major = None
    if env_java_home and env_major is not None and env_major >= min_major and executable_available(env_java_bin):
        return (env_major, env_java_home, "env")

    return None

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
    java_home = os.path.join(mise_data_dir, "installs", "java", version)
    java_bin = os.path.join(java_home, "bin", "java")
    if include_or_skip("java", name, java_bin, [java_bin, "-version"]):
        index["java"]["jdks"][name] = {"JAVA_HOME": java_home}

for item in maven_manifest.get("maven", []):
    name = item["name"]
    version = item["version"]
    min_java = str(item.get("minJava", ""))
    maven_home = os.path.join(mise_data_dir, "installs", "maven", version)
    mvn_bin = os.path.join(maven_home, "bin", "mvn")
    if not executable_available(mvn_bin):
        include_or_skip("maven", name, mvn_bin, [mvn_bin, "-v"])
        continue
    selected_java = select_probe_java(min_java, index["java"]["jdks"])
    if not selected_java:
        skip_or_die(f"maven {name} validation requires Java {min_java or 'any'}+")
        continue
    _, probe_java_home, probe_source = selected_java
    validation_java_env = with_java_env(probe_java_home)
    if include_or_skip("maven", name, mvn_bin, [mvn_bin, "-v"], validation_java_env):
        index["java"]["maven"][name] = {
            "MAVEN_HOME": maven_home,
            "minJava": min_java,
            "probeJavaHome": probe_java_home,
            "probeJavaSource": probe_source,
        }

for item in gradle_manifest.get("gradle", []):
    name = item["name"]
    version = item["version"]
    min_java = str(item.get("minJava", ""))
    gradle_home = os.path.join(mise_data_dir, "installs", "gradle", version)
    gradle_bin = os.path.join(gradle_home, "bin", "gradle")
    if not executable_available(gradle_bin):
        include_or_skip("gradle", name, gradle_bin, [gradle_bin, "-v"])
        continue
    selected_java = select_probe_java(min_java, index["java"]["jdks"])
    if not selected_java:
        skip_or_die(f"gradle {name} validation requires Java {min_java or 'any'}+")
        continue
    _, probe_java_home, probe_source = selected_java
    validation_java_env = with_java_env(probe_java_home)
    if include_or_skip("gradle", name, gradle_bin, [gradle_bin, "-v"], validation_java_env):
        index["java"]["gradle"][name] = {
            "GRADLE_HOME": gradle_home,
            "minJava": min_java,
            "probeJavaHome": probe_java_home,
            "probeJavaSource": probe_source,
        }

with open(output_file, "w", encoding="utf-8") as fh:
    json.dump(index, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

mv "$tmp_file" "$output_file"
chmod 0644 "$output_file"
log "wrote toolchain index: $output_file"
