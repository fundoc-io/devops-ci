#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/install-node-runtime.sh \
    [--root /data/mise] \
    [--manifest /data/mise/manifests/node.json] \
    [--node-path-file /data/mise/runtime-config/devops-cli-node.path] \
    [key-or-version...]

Installs a host Node.js runtime for platform tools such as devops-cli.
This Node.js runtime is not used for project Node builds; project builds run
inside Docker runner images selected by .ci/toolchain.json.

Default install key:
  lts

The installed executable path is written to:
  /data/mise/runtime-config/devops-cli-node.path
EOF
}

manifest=""
node_path_file=""
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
manifest="${manifest:-${MISE_ROOT}/manifests/node.json}"
node_path_file="${node_path_file:-${MISE_ROOT}/runtime-config/devops-cli-node.path}"

if [[ "${#versions[@]}" -eq 0 ]]; then
  versions=("lts")
fi

mapfile -t resolved_versions < <(manifest_resolved_versions "$manifest" "node" "${versions[@]}")

export_mise_env_for_tool "node"
mkdir -p "$MISE_DATA_DIR" "$MISE_CACHE_DIR" "$MISE_TMP_DIR" "$(dirname "$node_path_file")"

runtime_node_path=""
for version in "${resolved_versions[@]}"; do
  log "installing node@${version}"
  "$MISE_BIN" install "node@${version}"
  node_path="$("$MISE_BIN" exec "node@${version}" -- node -p 'process.execPath')"
  [[ -x "$node_path" ]] || die "node executable not found after install: $node_path"
  "$node_path" --version

  if [[ -z "$runtime_node_path" ]]; then
    runtime_node_path="$node_path"
  fi
done

printf '%s\n' "$runtime_node_path" > "$node_path_file"
chmod 0644 "$node_path_file"
log "wrote devops-cli Node path: ${node_path_file}"

set_mise_permissions "$MISE_ROOT"
log "normalized permissions under ${MISE_ROOT}"
