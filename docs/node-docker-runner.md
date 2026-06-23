# Node Docker Runner

Node.js builds are isolated from Jenkins slave host tooling. Jenkins only needs Docker access; Node, npm, pnpm, yarn, native addon build dependencies, and temporary caches live inside the container.

## Image Template

Template path:

```text
docker/node-runner/Dockerfile.tpl
```

The template provides:

- Node runtime from `BASE_IMAGE`.
- bash, git, curl, ca-certificates, tzdata, python3, make, and g++.
- `Asia/Shanghai` timezone and UTF-8 locale.
- Optional custom CA import from `certs/custom-ca.crt`.
- Fixed `/usr/local/bin/ci-entrypoint`.
- `/workspace` as working directory.

It does not preinstall pnpm or yarn versions and does not persist project dependencies or caches.

## Build Image

```bash
scripts/build-node-ci-image.sh \
  --node 20 \
  --base node:20-bookworm-slim \
  --image devops-ci/node20:202606
```

Optional flags:

- `--ca-file /path/to/custom-ca.crt`
- `--push`
- `--no-cache`
- `--keep-context`

Docker login is handled outside the script.

## Runtime Flow

Jenkins generates `.ci-runtime/init.sh`, `install.sh`, and `build.sh`, mounts them read-only to `/ci-scripts`, and runs the image with:

- `CI=true`
- `PM`
- `PMVER`
- `NPM_REGISTRY`
- optional `NPM_TOKEN`
- workspace mounted to `/workspace`

The entrypoint always runs:

```text
/ci-scripts/init.sh
/ci-scripts/install.sh
/ci-scripts/build.sh
```

`init.sh` is sourced by the entrypoint so PATH and package-manager config exported by the init slot are visible to `install.sh` and `build.sh`. The default Jenkins helper installs the declared package manager into `/tmp/devops-ci-pm` and uses `/tmp` for npm cache/user config. These paths are inside the container and disappear when it exits.
