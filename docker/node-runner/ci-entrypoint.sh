#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="${CI_SCRIPT_DIR:-/ci-scripts}"

run_step() {
  local name="$1"
  local file="${SCRIPT_DIR}/${name}.sh"

  if [[ ! -f "$file" ]]; then
    echo "CI step script not found: $file" >&2
    exit 1
  fi

  echo "========== CI STEP: ${name} =========="
  if [[ "$name" == "init" ]]; then
    # init is sourced so PATH/config exports for runtime-installed pm tools
    # are visible to install.sh and build.sh.
    # shellcheck source=/dev/null
    source "$file"
    return
  fi

  bash "$file"
}

run_step init
run_step install
run_step build
