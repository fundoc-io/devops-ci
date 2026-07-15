# DevOps CI Toolchain Design

## Purpose

This repository prepares the CI toolchain used by Jenkins nodes and project builds. It contains platform scripts, `mise` layout configuration, Node Docker Runner templates, a Jenkins copy-paste helper, and a CLI submodule for `.ci/toolchain.json`.

The CLI is only one module. The root project also packages scripts, Docker templates, config, docs, and optional binary resources for Jenkins node distribution.

## Module Boundaries

- `tools/devops-toolchain-cli/`: TypeScript CLI subproject. The user npm package exposes `devops-toolchain init`, `validate`, `print`, and `resolve`. The Jenkins agent tarball exposes the same root command names without an extra namespace.
- `scripts/`: host preparation, `mise` setup, index generation, CLI tarball installation, Docker image build, and platform package creation.
- `config/devops-toolchain/`: base platform index, primarily Node major to Docker image mapping.
- `config/mise/manifests/`: host Node.js, Java, Maven, and Gradle install manifests. Manifest `name` is the public key; manifest `version` is the actual `mise` install identifier.
- `docker/node-runner/`: Node Runner Dockerfile template and fixed entrypoint.
- `jenkins/snippets/`: a copy-paste Groovy helper for ordinary `Pipeline script from SCM` files.
- `resources/`: optional local binary resources such as a pre-supplied `mise` binary. Large binaries are not committed.

Jenkins jobs should copy `jenkins/snippets/devops-ci-toolchain.groovy` to the end of the business pipeline file.

The focused toolchain package is named `@devops/toolchain-cli` and installs `devops-toolchain`. The `devops-cli` executable name is reserved for a future general-purpose DevOps CLI; that CLI may expose these shared modules under a `toolchain` command group.

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

`devops-toolchain init` chooses defaults in this order:

1. Existing `.ci/toolchain.json`.
2. Current project `package.json`.
3. Built-in common values.

When `package.json` exists and no toolchain file exists, `type` defaults to `node`. `engines.node` or `volta.node` provides the Node major default; ranges such as `>=20.18.xx` resolve to major `20`. `packageManager` provides package-manager candidates, and lockfiles provide additional PM/version-major hints with visible sources in the prompt. Exact package-manager versions from `packageManager` win. If only a range or inferred major is available, `init` may query `registry.npmjs.org` for the latest matching exact version; when that lookup fails or is disabled, the prompt keeps manual input and shows the inferred major as a hint. Users can still change all values during the interactive flow and can go back to the previous question.

`devops-toolchain resolve` returns stable JSON for Jenkins and requires a platform index from `--index`, `DEVOPS_CI_INDEX`, or the installed CLI config. If `.ci/toolchain.json` is absent, resolve can infer a Node toolchain from `package.json`.

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

`init.sh` is sourced so PATH and package-manager config exported by the init slot are visible to later steps. The default helper init installs the declared package manager with npm into `/tmp/devops-ci-pm` and exports registry variables for the selected package manager. Package-level mirrors are passed as install-script environment variables. It does not mount host npm/pnpm/yarn cache, HOME directory, or global prefix.

Pipeline-specific acceleration sources belong in the business pipeline's `initScript` slot. Prefer npm-compatible config only for npm and pnpm; unsupported yarn-specific mirror keys should be omitted or handled explicitly by that pipeline.

## Jenkins Helper

The copy-paste helper exposes one class:

```groovy
def devopsCi = new DevopsCiToolchain(this)
devopsCi.buildByToolchain()
```

The helper:

- runs `devops-toolchain resolve`;
- checks only the stable JSON `status`;
- writes `.ci-runtime/init.sh`, `install.sh`, and `build.sh` with Jenkins `writeFile`;
- runs Node projects in Docker;
- injects Java environment variables from the resolve result;
- accepts closures for `initScript`, `installScript`, `buildScript`, `beforeDocker`, `afterDocker`, `beforeJava`, and `afterJava`.

Groovy does not read `/data/devops-ci/index.json` or maintain version allowlists. Platform availability and fallback behavior are owned by `devops-toolchain resolve`.

## Mise Layout

`mise` is used for host preparation. The host Node.js runtime installed by `scripts/install-tooling-node.sh` is only for platform tools such as `devops-toolchain`; project Node.js builds still run in Docker.

Default paths:

```text
/usr/local/bin/mise
/usr/local/bin/devops-mise
/data/mise
/data/mise/mise-env.sh
/data/mise/devops-toolchain-node.path
/data/devops-ci/index.json
/data/tools/devops-toolchain
/usr/local/bin/devops-toolchain
```

`scripts/init-mise-layout.sh` creates `/data/mise`, writes `/data/mise/mise-env.sh`, creates `/usr/local/bin/devops-mise`, copies manifests, and does not create `/etc/profile.d` files. Install scripts normalize permissions under managed roots to `0755` for directories/executables and `0644` for ordinary files.

If `/data/devops-ci/index.json` does not exist, layout initialization copies the base index there so `devops-toolchain resolve` can immediately resolve Node Docker builds. Java entries are generated after Java/Maven/Gradle installation.

For manual maintenance, source `/data/mise/mise-env.sh` and use `mise` directly:

```bash
source /data/mise/mise-env.sh
mise where java@temurin-21
mise use -g java@temurin-21 maven@3.9.6
```

`devops-mise` is only a convenience wrapper around that same environment. Jenkins business builds should keep using `devops-toolchain resolve` and the generated `/data/devops-ci/index.json`, not a shell-activated mise environment.

`scripts/install-tooling-node.sh lts` installs host/platform Node through the shared mise data root under `/data/mise/data/installs/node`, and writes the selected executable path to `/data/mise/devops-toolchain-node.path`. Pass that path to `scripts/install-devops-toolchain-cli.sh --node` when installing the Jenkins agent CLI wrapper.

`scripts/generate-toolchain-index.sh` validates installed Java/Maven/Gradle tools, then writes `/data/devops-ci/index.json`. The generated index maps public keys such as `jdk: "21"` to actual tool homes. Maven/Gradle validation uses each manifest entry's `minJava` to choose a probe Java: first a matching JDK from the same `MISE_ROOT`, then the current `JAVA_HOME` only as a last resort. It does not require or write a `mise use -g` default. Missing manifest entries are skipped by default; pass `--strict` only when the node must contain every manifest entry.

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
sudo scripts/install-tooling-node.sh --root /data/mise lts
sudo scripts/install-devops-toolchain-cli.sh \
  --tarball artifacts/cli/devops-ci-agent-linux-x64-0.1.0.tar.gz \
  --node "$(cat /data/mise/devops-toolchain-node.path)" \
  --prefix /data/tools/devops-toolchain \
  --index /data/devops-ci/index.json \
  --link /usr/local/bin/devops-toolchain
sudo scripts/install-java-tools.sh --root /data/mise 11
sudo scripts/install-maven-tools.sh --root /data/mise 3
sudo scripts/generate-toolchain-index.sh --root /data/mise --ci-root /data/devops-ci
```

For offline installation, Node.js, Java, Maven, and Gradle install scripts all support `--archive <tool.tar.gz> <key>`. Local archives are extracted to the same managed install directories used by `mise install`, so generated indexes and Jenkins runtime behavior stay unchanged.

Root packaging is driven by `Makefile`:

```bash
make cli-user-package
make cli-agent-tarball
make platform-package
make dist
```

The CLI tarball installer defaults to `/data/tools/devops-toolchain`, records the configured index path in the generated runtime config, and creates a wrapper under `/usr/local/bin/devops-toolchain` unless disabled. The wrapper uses an explicit Node path when provided and falls back to `command -v node` only during installation.

## Security and Portability

Committed files must not contain real registry URLs, credential ids, tokens, certificates, private keys, or environment-specific hostnames. Use placeholders such as `<your-npm-registry>` and `<your-container-registry>` in documentation when a private endpoint is needed.

The repository should be portable enough for source publication. Private deployment details belong in local manifests, CI variables, `.npmrc`, external package registries, or Jenkins job configuration.
