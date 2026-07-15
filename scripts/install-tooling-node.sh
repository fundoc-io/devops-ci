#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/install-tooling-node.sh \
    [--root /data/mise] \
    [--manifest /data/mise/manifests/tooling-node.json] \
    [--node-path-file /data/mise/devops-toolchain-node.path] \
    [--archive /path/to/node.tar.gz] \
    [--force] \
    [key-or-version...]

Installs a host Node.js runtime for platform tools such as devops-toolchain.
This Node.js runtime is not used for project Node builds; project builds run
inside Docker runner images selected by .ci/toolchain.json.

Default install key:
  lts

The installed executable path is written to:
  /data/mise/devops-toolchain-node.path

When --archive is provided, the script does not download through mise. It
extracts one local Node.js archive into:
  /data/mise/data/installs/node/<manifest-version>

For manual maintenance, source /data/mise/mise-env.sh and use mise directly:
  source /data/mise/mise-env.sh
  mise install node@<version>
  mise where node@<version>
EOF
}

manifest=""
node_path_file=""
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
    --node-path-file)
      [[ $# -ge 2 ]] || die "--node-path-file requires a value"
      node_path_file="$2"
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
manifest="${manifest:-${MISE_ROOT}/manifests/tooling-node.json}"
node_path_file="${node_path_file:-${MISE_ROOT}/devops-toolchain-node.path}"

if [[ "${#versions[@]}" -eq 0 ]]; then
  versions=("lts")
fi

mapfile -t resolved_versions < <(manifest_resolved_versions "$manifest" "node" "${versions[@]}")

if [[ -n "$archive" && "${#resolved_versions[@]}" -ne 1 ]]; then
  die "--archive installs exactly one Node.js version; pass one key such as lts or 20"
fi

load_mise_env
mkdir -p "$MISE_DATA_DIR" "$MISE_CONFIG_DIR" "$MISE_CACHE_DIR" "$MISE_STATE_DIR" "$MISE_TMP_DIR" "$(dirname "$node_path_file")"

runtime_node_path=""
for version in "${resolved_versions[@]}"; do
  if [[ -n "$archive" ]]; then
    install_archive_into_mise_tool "node" "$version" "$archive" "bin/node" "$force"
    node_path="$(mise_tool_install_dir "node" "$version")/bin/node"
  else
    ensure_mise
    log "installing node@${version}"
    "$MISE_BIN" install "node@${version}"
    node_path="$("$MISE_BIN" exec "node@${version}" -- node -p 'process.execPath')"
  fi

  [[ -x "$node_path" ]] || die "node executable not found after install: $node_path"
  "$node_path" --version

  if [[ -z "$runtime_node_path" ]]; then
    runtime_node_path="$node_path"
  fi
done

printf '%s\n' "$runtime_node_path" > "$node_path_file"
chmod 0644 "$node_path_file"
log "wrote devops-toolchain Node path: ${node_path_file}"

set_mise_permissions "$MISE_ROOT"
log "normalized permissions under ${MISE_ROOT}"
