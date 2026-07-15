#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/install-devops-toolchain-cli.sh \
    --tarball /path/to/devops-ci-agent-linux-x64-0.1.0.tar.gz \
    [--node /path/to/node] \
    [--prefix /data/tools/devops-toolchain] \
    [--index /data/devops-ci/index.json] \
    [--bin-name devops-toolchain] \
    [--link /usr/local/bin/devops-toolchain] \
    [--no-link] \
    [--force]

Installs a prebuilt DevOps toolchain CLI tarball. This script does not install
npm dependencies and does not build from source.
The resolved node path is written into the generated wrapper.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

normalize_install_permissions() {
  local root="$1"

  find "$root" -type d -exec chmod 0755 {} +
  find "$root" -type f -exec chmod 0644 {} +
  find "$root" -type f -path '*/bin/*' -exec chmod 0755 {} +
  find "$root" -type f -path '*/cli/*.cjs' -exec chmod 0755 {} +
}

shell_quote() {
  printf "'%s'" "${1//\'/\'\"\'\"\'}"
}

json_escape() {
  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
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

resolve_destination_path() {
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

validate_tarball_paths() {
  local archive="$1"
  local entry

  while IFS= read -r entry; do
    case "$entry" in
      ""|/*|../*|*/../*|*/..)
        die "unsafe path in tarball: $entry"
        ;;
    esac
  done < <(tar -tzf "$archive")
}

tarball=""
node_bin=""
prefix="/data/tools/devops-toolchain"
index_path="/data/devops-ci/index.json"
bin_name="devops-toolchain"
link_path="/usr/local/bin/devops-toolchain"
link_explicit=0
force=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tarball)
      [[ $# -ge 2 ]] || die "--tarball requires a value"
      tarball="$2"
      shift 2
      ;;
    --node)
      [[ $# -ge 2 ]] || die "--node requires a value"
      node_bin="$2"
      shift 2
      ;;
    --prefix)
      [[ $# -ge 2 ]] || die "--prefix requires a value"
      prefix="$2"
      shift 2
      ;;
    --index)
      [[ $# -ge 2 ]] || die "--index requires a value"
      index_path="$2"
      shift 2
      ;;
    --bin-name)
      [[ $# -ge 2 ]] || die "--bin-name requires a value"
      bin_name="$2"
      if [[ "$link_explicit" != "1" ]]; then
        link_path="/usr/local/bin/${bin_name}"
      fi
      shift 2
      ;;
    --link)
      [[ $# -ge 2 ]] || die "--link requires a value"
      link_path="$2"
      link_explicit=1
      shift 2
      ;;
    --no-link)
      link_path=""
      link_explicit=1
      shift
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

[[ -n "$tarball" ]] || {
  usage
  die "--tarball is required"
}
[[ -f "$tarball" ]] || die "tarball not found: $tarball"
validate_tarball_paths "$tarball"

if [[ -z "$node_bin" ]]; then
  node_bin="$(command -v node || true)"
fi
[[ -n "$node_bin" ]] || die "--node is required when node is not on PATH"
[[ -x "$node_bin" ]] || die "node binary is not executable: $node_bin"
node_bin="$(resolve_path "$node_bin")"
[[ "$bin_name" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid --bin-name: $bin_name"
prefix="$(resolve_destination_path "$prefix")"
index_path="$(resolve_destination_path "$index_path")"
if [[ -n "$link_path" ]]; then
  link_path="$(resolve_destination_path "$link_path")"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/devops-toolchain-cli.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

tar --no-same-owner -xzf "$tarball" -C "$tmp_dir"
mapfile -t extracted_roots < <(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | sort)
[[ "${#extracted_roots[@]}" -eq 1 ]] || die "tarball must contain exactly one top-level directory"

extracted_root="${extracted_roots[0]}"
[[ -f "${extracted_root}/VERSION" ]] || die "VERSION file missing in tarball"
version="$(tr -d '[:space:]' < "${extracted_root}/VERSION")"
[[ -n "$version" ]] || die "VERSION is empty"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] || die "invalid VERSION in tarball: $version"

release_dir="${prefix}/releases/${version}"
if [[ -e "$release_dir" ]]; then
  if [[ "$force" != "1" ]]; then
    die "release already exists: $release_dir; use --force to replace it"
  fi
  rm -rf -- "$release_dir"
fi

mkdir -p "$release_dir" "${prefix}/bin"
cp -a "${extracted_root}/." "$release_dir/"
mkdir -p "${release_dir}/bin" "${release_dir}/config"

cat > "${release_dir}/config/devops-toolchain.json" <<EOF
{
  "index": "$(json_escape "$index_path")"
}
EOF

node_literal="$(shell_quote "$node_bin")"
cli_entry_literal="$(shell_quote "${release_dir}/cli/devops-toolchain.cjs")"
config_literal="$(shell_quote "${release_dir}/config/devops-toolchain.json")"

cat > "${release_dir}/bin/${bin_name}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

NODE_BIN=${node_literal}
CLI_ENTRY=${cli_entry_literal}
DEVOPS_TOOLCHAIN_CONFIG=${config_literal}
export DEVOPS_TOOLCHAIN_CONFIG

if [[ ! -x "\$NODE_BIN" ]]; then
  echo "ERROR: node binary not found or not executable: \$NODE_BIN" >&2
  exit 127
fi

if [[ ! -f "\$CLI_ENTRY" ]]; then
  echo "ERROR: devops-toolchain entry not found: \$CLI_ENTRY" >&2
  exit 1
fi

exec "\$NODE_BIN" "\$CLI_ENTRY" "\$@"
EOF
normalize_install_permissions "$release_dir"

ln -sfn "$release_dir" "${prefix}/current.next"
mv -Tf "${prefix}/current.next" "${prefix}/current"
ln -sfn "${prefix}/current/bin/${bin_name}" "${prefix}/bin/${bin_name}"
chmod 0755 "${prefix}/bin"

if [[ -n "$link_path" ]]; then
  mkdir -p "$(dirname "$link_path")"
  ln -sfn "${prefix}/bin/${bin_name}" "$link_path"
fi

"${prefix}/bin/${bin_name}" --version
echo "Installed ${bin_name} ${version} to ${prefix}"
