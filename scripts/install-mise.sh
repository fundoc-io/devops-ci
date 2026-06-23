#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/mise-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/install-mise.sh --binary /path/to/mise [--target /usr/local/bin/mise] [--force]

Installs an existing mise linux-x64 glibc binary into the fixed platform path.
This script does not download mise.
EOF
}

binary=""
target="$MISE_BIN"
force=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      [[ $# -ge 2 ]] || die "--binary requires a value"
      binary="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || die "--target requires a value"
      target="$2"
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
      die "unknown argument: $1"
      ;;
  esac
done

require_root

[[ -n "$binary" ]] || {
  usage
  die "--binary is required"
}
[[ -f "$binary" ]] || die "mise binary file not found: $binary"

if [[ -e "$target" && "$force" != "1" ]]; then
  die "target already exists: $target; use --force to replace it"
fi

install -D -m 0755 "$binary" "$target"
log "installed mise to $target"
"$target" --version
