# DevOps CI Toolchain Design

## Purpose

This repository prepares the CI toolchain used by Jenkins nodes and project builds. It contains platform scripts, `mise` layout configuration, Node Docker Runner templates, a Jenkins copy-paste helper, and a CLI submodule for `.ci/toolchain.json`.

The CLI is only one module. The root project also packages scripts, Docker templates, config, docs, and optional binary resources for Jenkins node distribution.

## Module Boundaries

- `tools/devops-toolchain-cli/`: TypeScript CLI subproject. The user npm package exposes `devops-cli init`, `validate`, `print`, and `resolve`. The Jenkins agent tarball exposes the same root command names without an extra namespace.
- `scripts/`: host preparation, `mise` setup, index generation, CLI tarball installation, Docker image build, and platform package creation.
- `config/devops-toolchain/`: base platform index, primarily Node major to Docker image mapping.
- `config/mise/manifests/`: host Node.js, Java, Maven, and Gradle install manifests. Manifest `name` is the public key; manifest `version` is the actual `mise` install identifier.
- `docker/node-runner/`: Node Runner Dockerfile template and fixed entrypoint.
- `jenkins/snippets/`: a copy-paste Groovy helper for ordinary `Pipeline script from SCM` files.
- `resources/`: optional local binary resources such as a pre-supplied `mise` binary. Large binaries are not committed.

Jenkins jobs should copy `jenkins/snippets/devops-ci-toolchain.groovy` to the end of the business pipeline file.

## Toolchain Contract

Project configuration lives at `.ci/toolchain.json`. It declares toolchain versions only and must not contain `commands`, `scripts`, or `args`.

Node example:

```json
{
  "type": "node",
  "node": "20",
  "pm": "pnpm",
  "pmver": "9.15.9"
}
```

Java Maven example:

```json
{
  "type": "java",
  "jdk": "21",
  "buildTool": "maven",
  "maven": "3",
  "skipTests": true
}
```

User-facing Java keys are plain version keys such as `8`, `11`, `17`, and `21`. Distribution details such as Temurin stay in platform manifests and generated indexes.

## CLI Behavior

The CLI uses `cac` for command parsing, `prompts` for interactive setup, and `semver` for version/range handling.

`devops-cli init` chooses defaults in this order:

1. Existing `.ci/toolchain.json`.
2. Current project `package.json`.
3. Built-in common values.

When `package.json` exists and no toolchain file exists, `type` defaults to `node`. `engines.node` or `volta.node` provides the Node major default; ranges such as `>=20.18.xx` resolve to major `20`. `packageManager` provides `pm` and exact `pmver`. Users can still change all values during the interactive flow and can go back to the previous question.

`devops-cli resolve` returns stable JSON for Jenkins and requires a platform index from `--index`, `DEVOPS_CI_INDEX`, or the installed CLI config. If `.ci/toolchain.json` is absent, resolve can infer a Node toolchain from `package.json`.

## Node Runner

Node builds run in Docker. Jenkins mounts only the workspace and generated runtime scripts:

```text
$WORKSPACE -> /workspace
$WORKSPACE/.ci-runtime -> /ci-scripts:ro
```

The runner entrypoint executes:

```text
source /ci-scripts/init.sh
bash /ci-scripts/install.sh
bash /ci-scripts/build.sh
```

`init.sh` is sourced so PATH and package-manager config exported by the init slot are visible to later steps. The default helper init installs the declared package manager with npm into `/tmp/devops-ci-pm`, sets npm cache/user config under `/tmp`, and configures the default registry. No host npm/pnpm/yarn cache, HOME directory, or global prefix is mounted.

Pipeline-specific acceleration sources belong in the business pipeline's `initScript` slot. Prefer npm-compatible config only for npm and pnpm; unsupported yarn-specific mirror keys should be omitted or handled explicitly by that pipeline.

## Jenkins Helper

The copy-paste helper exposes one class:

```groovy
def devopsCi = new DevopsCiToolchain(this)
devopsCi.buildByToolchain('.ci/toolchain.json')
```

The helper:

- runs `devops-cli resolve`;
- checks only the stable JSON `status`;
- writes `.ci-runtime/init.sh`, `install.sh`, and `build.sh` with Jenkins `writeFile`;
- runs Node projects in Docker;
- injects Java environment variables from the resolve result;
- accepts closures for `initScript`, `installScript`, `buildScript`, `beforeDocker`, `afterDocker`, `beforeJava`, and `afterJava`.

Groovy does not read `/data/devops-ci/index.json` or maintain version allowlists. Platform availability and fallback behavior are owned by `devops-cli resolve`.

## Mise Layout

`mise` is used for host preparation. The host Node.js runtime installed by `scripts/install-node-runtime.sh` is only for platform tools such as `devops-cli`; project Node.js builds still run in Docker.

Default paths:

```text
/usr/local/bin/mise
/data/mise
/data/mise/runtime-config/devops-cli-node.path
/data/devops-ci/index.json
/data/tools/devops-cli
/usr/local/bin/devops-cli
```

`scripts/init-mise-layout.sh` creates `/data/mise`, copies manifests, writes a manual profile snippet under `/data/mise/runtime-config/profile.sh`, and does not create `/etc/profile.d` files. Install scripts normalize permissions under managed roots to `0755` for directories/executables and `0644` for ordinary files.

`scripts/install-node-runtime.sh lts` installs `node@lts` under `/data/mise/node/data` and writes the selected executable path to `/data/mise/runtime-config/devops-cli-node.path`. Pass that path to `scripts/install-devops-ci-cli.sh --node` when installing the Jenkins agent CLI wrapper.

`scripts/generate-toolchain-index.sh` validates installed Java/Maven/Gradle tools, then writes `/data/devops-ci/index.json`. The generated index maps public keys such as `jdk: "21"` to actual tool homes.

## Distribution

There are two distribution shapes:

- User npm package: a trimmed CLI package for developers to create, validate, print, and resolve toolchain files. Registry configuration is supplied by `.npmrc`, CI, or command-line flags, not committed package metadata.
- Jenkins/platform tarball: scripts, config, docs, Docker templates, Jenkins snippet, optional CLI tarball, and optional `mise` binary resource.

In the extracted platform tarball, optional ancillary artifacts live under:

```text
artifacts/cli/<devops-ci-agent-tarball>
artifacts/mise/<mise-binary>
```

A typical Jenkins node bootstrap sequence is:

```bash
sudo scripts/install-mise.sh --binary artifacts/mise/mise --target /usr/local/bin/mise
sudo scripts/init-mise-layout.sh --root /data/mise
sudo scripts/install-node-runtime.sh --root /data/mise lts
sudo scripts/install-devops-ci-cli.sh \
  --tarball artifacts/cli/devops-ci-agent-linux-x64-0.1.0.tar.gz \
  --node "$(cat /data/mise/runtime-config/devops-cli-node.path)" \
  --prefix /data/tools/devops-cli \
  --index /data/devops-ci/index.json \
  --link /usr/local/bin/devops-cli
sudo scripts/install-java-tools.sh --root /data/mise 11
sudo scripts/install-maven-tools.sh --root /data/mise 3
sudo scripts/generate-toolchain-index.sh --root /data/mise --ci-root /data/devops-ci
```

Root packaging is driven by `Makefile`:

```bash
make cli-user-package
make cli-agent-tarball
make platform-package
make dist
```

The CLI tarball installer defaults to `/data/tools/devops-cli`, records the configured index path in the generated runtime config, and creates a wrapper under `/usr/local/bin/devops-cli` unless disabled. The wrapper uses an explicit Node path when provided and falls back to `command -v node` only during installation.

## Security and Portability

Committed files must not contain real registry URLs, credential ids, tokens, certificates, private keys, or environment-specific hostnames. Use placeholders such as `<your-npm-registry>` and `<your-container-registry>` in documentation when a private endpoint is needed.

The repository should be portable enough for source publication. Private deployment details belong in local manifests, CI variables, `.npmrc`, external package registries, or Jenkins job configuration.
