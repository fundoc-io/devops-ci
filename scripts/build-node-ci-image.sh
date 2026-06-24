#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/build-node-ci-image.sh \
    --node 20 \
    --base node:20-bookworm-slim \
    --image devops-ci/node20:202606 \
    [--apt-mirror https://mirrors.aliyun.com/debian] \
    [--apt-security-mirror https://mirrors.aliyun.com/debian-security] \
    [--apt-enable-backports] \
    [--ca-file /path/to/custom-ca.crt] \
    [--push] [--no-cache] [--keep-context]

Builds a Node CI Runner image from docker/node-runner/Dockerfile.tpl.
Docker credentials are not handled here; run docker login externally.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

node_major=""
base_image=""
image_tag=""
ca_file=""
apt_mirror=""
apt_security_mirror=""
apt_enable_backports=0
push=0
no_cache=0
keep_context=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node)
      [[ $# -ge 2 ]] || die "--node requires a value"
      node_major="$2"
      shift 2
      ;;
    --base)
      [[ $# -ge 2 ]] || die "--base requires a value"
      base_image="$2"
      shift 2
      ;;
    --image)
      [[ $# -ge 2 ]] || die "--image requires a value"
      image_tag="$2"
      shift 2
      ;;
    --ca-file)
      [[ $# -ge 2 ]] || die "--ca-file requires a value"
      ca_file="$2"
      shift 2
      ;;
    --apt-mirror)
      [[ $# -ge 2 ]] || die "--apt-mirror requires a value"
      apt_mirror="$2"
      shift 2
      ;;
    --apt-security-mirror)
      [[ $# -ge 2 ]] || die "--apt-security-mirror requires a value"
      apt_security_mirror="$2"
      shift 2
      ;;
    --apt-enable-backports)
      apt_enable_backports=1
      shift
      ;;
    --push)
      push=1
      shift
      ;;
    --no-cache)
      no_cache=1
      shift
      ;;
    --keep-context)
      keep_context=1
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

[[ -n "$node_major" ]] || {
  usage
  die "--node is required"
}
[[ "$node_major" =~ ^(12|14|16|18|20|22|24)$ ]] || die "unsupported Node major: $node_major"
[[ -n "$base_image" ]] || die "--base is required"
[[ -n "$image_tag" ]] || die "--image is required"
command -v docker >/dev/null 2>&1 || die "docker command not found"

if [[ -n "$ca_file" && ! -f "$ca_file" ]]; then
  die "CA file not found: $ca_file"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
context_dir="$(mktemp -d "${TMPDIR:-/tmp}/node-ci-runner.${node_major}.XXXXXX")"

cleanup() {
  if [[ "$keep_context" == "1" ]]; then
    echo "Build context kept at: $context_dir"
  else
    rm -rf "$context_dir"
  fi
}
trap cleanup EXIT

cp "${REPO_ROOT}/docker/node-runner/Dockerfile.tpl" "${context_dir}/Dockerfile"
cp "${REPO_ROOT}/docker/node-runner/ci-entrypoint.sh" "${context_dir}/ci-entrypoint.sh"
mkdir -p "${context_dir}/certs"
: > "${context_dir}/certs/.keep"

if [[ -n "$ca_file" ]]; then
  cp "$ca_file" "${context_dir}/certs/custom-ca.crt"
fi

build_args=(--build-arg "BASE_IMAGE=${base_image}" -t "$image_tag")
if [[ -n "$apt_mirror" ]]; then
  build_args+=(--build-arg "APT_MIRROR=${apt_mirror}")
fi
if [[ -n "$apt_security_mirror" ]]; then
  build_args+=(--build-arg "APT_SECURITY_MIRROR=${apt_security_mirror}")
fi
if [[ "$apt_enable_backports" == "1" ]]; then
  build_args+=(--build-arg "APT_ENABLE_BACKPORTS=1")
fi
if [[ "$no_cache" == "1" ]]; then
  build_args+=(--no-cache)
fi

echo "Building Node ${node_major} CI Runner image: ${image_tag}"
docker build "${build_args[@]}" "$context_dir"

if [[ "$push" == "1" ]]; then
  echo "Pushing image: ${image_tag}"
  docker push "$image_tag"
fi
