#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/package-devops-ci-platform.sh \
    [--version 0.1.0] \
    [--output-dir dist/artifacts] \
    [--cli-tarball tools/devops-toolchain-cli/dist/artifacts/devops-ci-agent-linux-x64-0.1.0.tar.gz] \
    [--mise-binary resources/mise/mise]

Builds a distributable platform package for Jenkins nodes. The package contains
repository scripts, config, Docker templates, copy-paste Jenkins helpers, and
docs. CLI and mise binaries are optional ancillary artifacts.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

resolve_path() {
  local target="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$target"
    return
  fi

  local dir
  dir="$(cd "$(dirname "$target")" && pwd)"
  printf '%s/%s\n' "$dir" "$(basename "$target")"
}

resolve_output_dir() {
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

copy_required_path() {
  local source="$1"
  local destination="$2"

  [[ -e "$source" ]] || die "required package path not found: $source"
  cp -a "$source" "$destination"
}

version="0.1.0"
output_dir="dist/artifacts"
cli_tarball=""
mise_binary=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || die "--version requires a value"
      version="$2"
      shift 2
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || die "--output-dir requires a value"
      output_dir="$2"
      shift 2
      ;;
    --cli-tarball)
      [[ $# -ge 2 ]] || die "--cli-tarball requires a value"
      cli_tarball="$2"
      shift 2
      ;;
    --mise-binary)
      [[ $# -ge 2 ]] || die "--mise-binary requires a value"
      mise_binary="$2"
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

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] || die "invalid --version: $version"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
output_dir="$(resolve_output_dir "$output_dir")"
package_name="devops-ci-platform-${version}"
artifact_file="${output_dir}/${package_name}.tar.gz"

if [[ -n "$cli_tarball" ]]; then
  [[ -f "$cli_tarball" ]] || die "CLI tarball not found: $cli_tarball"
  cli_tarball="$(resolve_path "$cli_tarball")"
fi

if [[ -n "$mise_binary" ]]; then
  [[ -f "$mise_binary" ]] || die "mise binary not found: $mise_binary"
  mise_binary="$(resolve_path "$mise_binary")"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/devops-ci-platform.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

package_root="${tmp_dir}/${package_name}"
mkdir -p "$package_root" "$output_dir"

for item in README.md LICENSE Makefile config docker docs jenkins scripts; do
  copy_required_path "${REPO_ROOT}/${item}" "$package_root/"
done

mkdir -p "${package_root}/artifacts/cli" "${package_root}/artifacts/mise"

cli_artifact_name=""
if [[ -n "$cli_tarball" ]]; then
  cli_artifact_name="$(basename "$cli_tarball")"
  cp "$cli_tarball" "${package_root}/artifacts/cli/${cli_artifact_name}"
fi

mise_artifact_name=""
if [[ -n "$mise_binary" ]]; then
  mise_artifact_name="$(basename "$mise_binary")"
  cp "$mise_binary" "${package_root}/artifacts/mise/${mise_artifact_name}"
  chmod 0755 "${package_root}/artifacts/mise/${mise_artifact_name}"
fi

cat > "${package_root}/VERSION" <<EOF
${version}
EOF

cat > "${package_root}/MANIFEST.json" <<EOF
{
  "name": "devops-ci-platform",
  "version": "${version}",
  "contents": [
    "README.md",
    "LICENSE",
    "Makefile",
    "config/",
    "docker/",
    "docs/",
    "jenkins/",
    "jenkins/snippets/",
    "scripts/"
  ],
  "artifacts": {
    "cli": "${cli_artifact_name}",
    "mise": "${mise_artifact_name}"
  }
}
EOF

find "$package_root/scripts" -type f -name '*.sh' -exec chmod 0755 {} +
find "$package_root/docker" -type f -name '*.sh' -exec chmod 0755 {} + 2>/dev/null || true

tar -czf "$artifact_file" -C "$tmp_dir" "$package_name"
echo "Wrote ${artifact_file}"
