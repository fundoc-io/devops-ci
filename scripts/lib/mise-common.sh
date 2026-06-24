#!/usr/bin/env bash
set -euo pipefail

MISE_BIN="${MISE_BIN:-/usr/local/bin/mise}"
MISE_ROOT="${MISE_ROOT:-/data/mise}"
DEVOPS_MISE_BIN="${DEVOPS_MISE_BIN:-/usr/local/bin/devops-mise}"
DEVOPS_CI_ROOT="${DEVOPS_CI_ROOT:-/data/devops-ci}"
DEVOPS_CI_INDEX="${DEVOPS_CI_INDEX:-${DEVOPS_CI_ROOT}/index.json}"
DEVOPS_MISE_MARKER=".devops-mise-root"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

log() {
  echo "==> $*"
}

require_root() {
  if [[ "$(id -u)" != "0" ]]; then
    die "this script must be run as root"
  fi
}

ensure_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || die "required command not found: $command_name"
}

ensure_mise() {
  [[ -x "$MISE_BIN" ]] || die "mise binary not found or not executable: $MISE_BIN"
}

ensure_devops_mise() {
  [[ -x "$DEVOPS_MISE_BIN" ]] || die "devops-mise wrapper not found or not executable: $DEVOPS_MISE_BIN"
}

mise_env_file() {
  printf '%s/mise-env.sh' "$MISE_ROOT"
}

load_mise_env() {
  local env_file
  env_file="$(mise_env_file)"
  [[ -f "$env_file" ]] || die "mise env file not found: $env_file; run init-mise-layout.sh first"
  # shellcheck disable=SC1090
  source "$env_file"
}

resolve_path_maybe_missing() {
  local target="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$target"
    return
  fi

  case "$target" in
    /*)
      printf '%s\n' "$target"
      ;;
    *)
      printf '%s/%s\n' "$(pwd)" "$target"
      ;;
  esac
}

assert_safe_mise_root_path() {
  local root
  root="$(resolve_path_maybe_missing "$1")"

  case "$root" in
    ""|"/"|"/data"|"/usr"|"/usr/local"|"/opt"|"/home"|"/var"|"/tmp")
      die "refusing unsafe mise root: $root"
      ;;
  esac

  if [[ "$root" != /* ]]; then
    die "mise root must resolve to an absolute path: $root"
  fi
}

mark_mise_root() {
  local root="$1"
  assert_safe_mise_root_path "$root"
  mkdir -p "$root"
  touch "${root}/${DEVOPS_MISE_MARKER}"
}

require_managed_mise_root() {
  local root="$1"
  assert_safe_mise_root_path "$root"
  [[ -f "${root}/${DEVOPS_MISE_MARKER}" ]] || die "mise root is not initialized by devops-ci: ${root}; run init-mise-layout.sh first"
}

repo_root_from_script() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  cd "${script_dir}/../.." && pwd
}

mise_tool_install_dir() {
  local tool="$1"
  local version="$2"
  printf '%s/installs/%s/%s' "$MISE_DATA_DIR" "$tool" "$version"
}

install_archive_into_mise_tool() {
  local tool="$1"
  local version="$2"
  local archive_file="$3"
  local executable_rel="$4"
  local force="$5"
  local target
  local executable
  local tmp_dir
  local found_executable
  local candidate
  local source_home

  target="$(mise_tool_install_dir "$tool" "$version")"
  executable="${target}/${executable_rel}"

  [[ -f "$archive_file" ]] || die "archive not found: $archive_file"
  ensure_command tar

  if [[ -x "$executable" && "$force" != "1" ]]; then
    log "${tool}@${version} already exists at ${target}"
    return
  fi

  if [[ -e "$target" && "$force" != "1" ]]; then
    die "target already exists but is not a valid ${tool} home: ${target}; use --force to replace it"
  fi

  log "extracting ${archive_file} to ${tool}@${version}"
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/devops-${tool}-archive.XXXXXX")"
  if ! tar -xf "$archive_file" -C "$tmp_dir"; then
    rm -rf "$tmp_dir"
    die "failed to extract archive: $archive_file"
  fi

  found_executable=""
  while IFS= read -r candidate; do
    if [[ -x "$candidate" ]]; then
      found_executable="$candidate"
      break
    fi
  done < <(find "$tmp_dir" -mindepth 1 -maxdepth 5 -path "*/${executable_rel}" \( -type f -o -type l \) -print)

  if [[ -z "$found_executable" ]]; then
    rm -rf "$tmp_dir"
    die "archive does not contain an executable ${executable_rel}: $archive_file"
  fi

  source_home="$(cd "$(dirname "$found_executable")/.." && pwd)"
  rm -rf "$target"
  mkdir -p "$target"
  cp -a "${source_home}/." "$target/"
  chmod 0755 "$executable" 2>/dev/null || true
  rm -rf "$tmp_dir"
}

manifest_versions() {
  local manifest="$1"
  local key="$2"

  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  ensure_command python3

  python3 - "$manifest" "$key" <<'PY'
import json
import sys

manifest_path, key = sys.argv[1], sys.argv[2]
with open(manifest_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

for item in data.get(key, []):
    version = item.get("version")
    if not version:
        raise SystemExit(f"manifest item in {key} is missing version")
    print(version)
PY
}

manifest_resolved_versions() {
  local manifest="$1"
  local key="$2"
  shift 2

  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  ensure_command python3

  python3 - "$manifest" "$key" "$@" <<'PY'
import json
import sys

manifest_path, key, *requested = sys.argv[1:]
with open(manifest_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

items = data.get(key, [])
if not requested:
    requested = [str(item.get("name", "")) for item in items]

for value in requested:
    for item in items:
        name = str(item.get("name", ""))
        version = str(item.get("version", ""))
        if value == name or value == version:
            if not version:
                raise SystemExit(f"manifest item in {key} is missing version")
            print(version)
            break
    else:
        raise SystemExit(f"{key} key/version not found in manifest: {value}")
PY
}

manifest_tool_field() {
  local manifest="$1"
  local key="$2"
  local version="$3"
  local field="$4"

  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  ensure_command python3

  python3 - "$manifest" "$key" "$version" "$field" <<'PY'
import json
import sys

manifest_path, key, requested_version, field = sys.argv[1:]
with open(manifest_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

for item in data.get(key, []):
    version = str(item.get("version", ""))
    name = str(item.get("name", ""))
    if requested_version in (version, name):
        value = item.get(field)
        if value is not None:
            print(value)
        break
PY
}

select_probe_java_home() {
  local java_manifest="$1"
  local min_java="${2:-}"

  [[ -f "$java_manifest" ]] || die "manifest not found: $java_manifest"
  ensure_command python3

  python3 - "$java_manifest" "$MISE_DATA_DIR" "$min_java" "${JAVA_HOME:-}" <<'PY'
import json
import os
import re
import subprocess
import sys

manifest_path, mise_data_dir, min_java_raw, env_java_home = sys.argv[1:]

def major_from_text(value):
    text = str(value or "")
    match = re.search(r"\d+", text)
    if not match:
        return None
    return int(match.group(0))

min_java = major_from_text(min_java_raw) or 0

with open(manifest_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

managed_candidates = []
for item in data.get("java", []):
    version = str(item.get("version", ""))
    if not version:
        continue
    name = str(item.get("name", ""))
    major = major_from_text(name) or major_from_text(version)
    if major is None or major < min_java:
        continue
    java_home = os.path.join(mise_data_dir, "installs", "java", version)
    java_bin = os.path.join(java_home, "bin", "java")
    if os.path.isfile(java_bin) and os.access(java_bin, os.X_OK):
        managed_candidates.append((major, java_home))

if managed_candidates:
    managed_candidates.sort(key=lambda item: item[0])
    print(managed_candidates[0][1])
    raise SystemExit(0)

if env_java_home:
    java_bin = os.path.join(env_java_home, "bin", "java")
    env_major = major_from_text(os.path.basename(env_java_home))
    if env_major is None and os.path.isfile(java_bin) and os.access(java_bin, os.X_OK):
        try:
            result = subprocess.run([java_bin, "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
            env_major = major_from_text(result.stdout + result.stderr)
        except Exception:
            env_major = None
    if env_major is not None and env_major >= min_java and os.path.isfile(java_bin) and os.access(java_bin, os.X_OK):
        print(env_java_home)
PY
}

run_with_java_home() {
  local java_home="$1"
  shift

  if [[ -n "$java_home" ]]; then
    JAVA_HOME="$java_home" PATH="${java_home}/bin:${PATH}" "$@"
    return
  fi

  "$@"
}

set_mise_permissions() {
  local root="$1"
  require_managed_mise_root "$root"
  chown -R root:root "$root"
  find "$root" -type d -exec chmod 0755 {} +
  find "$root" -type f -perm /111 -exec chmod 0755 {} +
  find "$root" -type f ! -perm /111 -exec chmod 0644 {} +
  find "$root/scripts" -type f -name '*.sh' -exec chmod 0755 {} + 2>/dev/null || true
}
