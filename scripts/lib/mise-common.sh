#!/usr/bin/env bash
set -euo pipefail

MISE_BIN="${MISE_BIN:-/usr/local/bin/mise}"
MISE_ROOT="${MISE_ROOT:-/data/mise}"
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

tool_data_dir() {
  local tool="$1"
  printf '%s/%s/data' "$MISE_ROOT" "$tool"
}

tool_cache_dir() {
  local tool="$1"
  printf '%s/%s/cache' "$MISE_ROOT" "$tool"
}

tool_tmp_dir() {
  local tool="$1"
  printf '%s/%s/tmp' "$MISE_ROOT" "$tool"
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

export_mise_env_for_tool() {
  local tool="$1"
  export MISE_DATA_DIR
  export MISE_CACHE_DIR
  export MISE_TMP_DIR
  MISE_DATA_DIR="$(tool_data_dir "$tool")"
  MISE_CACHE_DIR="$(tool_cache_dir "$tool")"
  MISE_TMP_DIR="$(tool_tmp_dir "$tool")"
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

set_mise_permissions() {
  local root="$1"
  require_managed_mise_root "$root"
  chown -R root:root "$root"
  find "$root" -type d -exec chmod 0755 {} +
  find "$root" -type f -perm /111 -exec chmod 0755 {} +
  find "$root" -type f ! -perm /111 -exec chmod 0644 {} +
  find "$root/scripts" -type f -name '*.sh' -exec chmod 0755 {} + 2>/dev/null || true
}
