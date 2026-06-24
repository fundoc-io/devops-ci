# mise Host Toolchain

Host Node.js, Java, Maven, and Gradle are prepared on Jenkins nodes with `mise`.

The host Node.js runtime is only for platform tools such as the `devops-cli` wrapper. Project Node.js builds run inside Docker runner images selected by `.ci/toolchain.json`.

Normal Java builds consume the generated index and do not install tools during a business pipeline.

## Fixed Paths

```text
/usr/local/bin/mise
/usr/local/bin/devops-mise
/data/mise
/data/mise/mise-env.sh
/data/mise/devops-cli-node.path
/data/devops-ci/index.json
```

The current phase assumes a local `mise` binary package exists. `scripts/install-mise.sh` installs that local binary; it does not download from the internet.

## Layout

```text
/data/mise/
├── .devops-mise-root
├── mise-env.sh
├── devops-cli-node.path
├── data/
│   └── installs/
│       ├── java/
│       ├── maven/
│       ├── gradle/
│       └── node/
├── config/
│   └── config.toml
├── cache/
├── state/
├── tmp/
├── manifests/
│   ├── java.json
│   ├── maven.json
│   ├── gradle.json
│   └── tooling-node.json
└── scripts/
```

`scripts/init-mise-layout.sh` creates the layout, copies manifests and maintenance scripts, writes `/data/mise/mise-env.sh`, and creates `/usr/local/bin/devops-mise`. It does not create `/etc/profile.d` files.

`/data/mise/data` is the single `MISE_DATA_DIR` for Java, Maven, Gradle, and the platform tooling Node.js runtime.

The script also writes a `.devops-mise-root` marker. Install and permission-normalization scripts require this marker before touching the root recursively.

If the configured index file does not exist, initialization copies the base index to `/data/devops-ci/index.json`. That gives `devops-cli resolve` enough data for Node Docker builds immediately. Java/Maven/Gradle entries are added later by `generate-toolchain-index.sh` after the host tools are installed.

## Manual Mise Maintenance

The scripts are automation entry points, not the only supported way to operate `mise`. For an interactive maintenance shell, load the base environment and use `mise` directly:

```bash
source /data/mise/mise-env.sh

mise install java@temurin-21
mise install maven@3.9.6
mise install gradle@8.8
mise install node@20

mise where java@temurin-21
mise where maven@3.9.6
mise where gradle@8.8
mise where node@20
```

`/usr/local/bin/devops-mise` is just a convenience wrapper that sources the same environment before executing `/usr/local/bin/mise`:

```bash
devops-mise where java@temurin-21
devops-mise use -g java@temurin-21 maven@3.9.6
```

`mise use -g ...` writes to `/data/mise/config/config.toml` because `mise-env.sh` sets `MISE_GLOBAL_CONFIG_FILE`. The environment also prepends `/data/mise/data/shims` to `PATH`, so a maintenance shell can use mise shims after `mise use -g`. Jenkins business builds still consume `/data/devops-ci/index.json`; they should not depend on shell activation or shims.

## Installation

From an extracted platform package, ancillary artifacts use this layout:

```text
artifacts/cli/<devops-ci-agent-tarball>
artifacts/mise/<mise-binary>
```

Recommended Jenkins node bootstrap order:

```bash
cd /data/packages/devops-ci/devops-ci-platform-0.1.0

sudo scripts/install-mise.sh \
  --binary artifacts/mise/mise \
  --target /usr/local/bin/mise

sudo scripts/init-mise-layout.sh --root /data/mise

# Runtime used by /usr/local/bin/devops-cli, not by project Node builds.
sudo scripts/install-tooling-node.sh --root /data/mise lts

sudo scripts/install-devops-ci-cli.sh \
  --tarball artifacts/cli/devops-ci-agent-linux-x64-0.1.0.tar.gz \
  --node "$(cat /data/mise/devops-cli-node.path)" \
  --prefix /data/tools/devops-cli \
  --index /data/devops-ci/index.json \
  --link /usr/local/bin/devops-cli

devops-cli resolve \
  --file .ci/toolchain.json \
  --project-dir .

# Install only the Java/Maven/Gradle keys required by this Jenkins node.
sudo scripts/install-java-tools.sh --root /data/mise 11
sudo scripts/install-maven-tools.sh --root /data/mise 3

sudo scripts/generate-toolchain-index.sh \
  --root /data/mise \
  --ci-root /data/devops-ci
```

Install a JDK that satisfies the Maven or Gradle runtime requirement before Maven or Gradle. Their install scripts verify the installed tool with `mvn -v` or `gradle -v`. The probe first selects a matching JDK installed under the same `MISE_ROOT`; only when no matching managed JDK exists does it consider the current `JAVA_HOME` as a last-resort probe background.

If the platform package was built without `artifacts/mise/mise` or `artifacts/cli/<tarball>`, copy those files to the Jenkins node separately and pass their actual paths to the install scripts.

## Offline Archives

Tools can be installed from local archives when Jenkins nodes cannot download through `mise`:

```bash
sudo scripts/install-tooling-node.sh \
  --root /data/mise \
  --archive /data/packages/node/node-v20-linux-x64.tar.gz \
  20

sudo scripts/install-java-tools.sh \
  --root /data/mise \
  --archive /data/packages/jdk/temurin-11-linux-x64.tar.gz \
  11

sudo scripts/install-maven-tools.sh \
  --root /data/mise \
  --archive /data/packages/maven/apache-maven-3.9.6-bin.tar.gz \
  3

sudo scripts/install-gradle-tools.sh \
  --root /data/mise \
  --archive /data/packages/gradle/gradle-8.8-bin.tar.gz \
  8.8
```

Each archive must contain the expected executable:

```text
Node.js: bin/node
Java:    bin/java
Maven:   bin/mvn
Gradle:  bin/gradle
```

The scripts extract archives into the same managed locations that the platform index expects:

```text
/data/mise/data/installs/node/20
/data/mise/data/installs/java/temurin-11
/data/mise/data/installs/maven/3.9.6
/data/mise/data/installs/gradle/8.8
```

`generate-toolchain-index.sh` does not need to know whether tools came from local archives or from `mise install`.

## Host Node Runtime

Install the shared Node.js runtime used by the `devops-cli` wrapper:

```bash
sudo scripts/install-tooling-node.sh --root /data/mise lts
cat /data/mise/devops-cli-node.path
```

Then pass that executable to the CLI installer:

```bash
sudo scripts/install-devops-ci-cli.sh \
  --tarball artifacts/cli/devops-ci-agent-linux-x64-0.1.0.tar.gz \
  --node "$(cat /data/mise/devops-cli-node.path)" \
  --prefix /data/tools/devops-cli \
  --index /data/devops-ci/index.json \
  --link /usr/local/bin/devops-cli
```

This Node.js runtime should not be used to build application Node.js projects. Those builds remain Docker-based.

## Manifest Keys

Manifest `name` values are public keys. Install scripts resolve explicit arguments through the manifest:

```text
scripts/install-java-tools.sh 21 installs java@temurin-21
scripts/install-maven-tools.sh 3 installs maven@3.9.6
scripts/install-tooling-node.sh 20 installs node@20
```

The `tooling-node.json` manifest is only for the platform Node.js runtime used by `devops-cli`. Business Node.js versions are resolved from Docker runner images instead.

After layout or tool installation, the scripts normalize `/data/mise` permissions:

- directories: `0755`
- executable files: `0755`
- ordinary files: `0644`

The normal Jenkins build user should only read and execute these files.

## Mise Root Selection

`mise` is only used during host preparation. Normal Jenkins builds do not run `mise install` or `mise exec`.

The selected `mise` root is the `--root` argument, or `MISE_ROOT`, defaulting to `/data/mise`. All tools share the same explicit mise environment:

```bash
export MISE_DATA_DIR=/data/mise/data
export MISE_CONFIG_DIR=/data/mise/config
export MISE_CACHE_DIR=/data/mise/cache
export MISE_STATE_DIR=/data/mise/state
export MISE_TMP_DIR=/data/mise/tmp
export MISE_GLOBAL_CONFIG_FILE=/data/mise/config/config.toml
export PATH=/data/mise/data/shims:/usr/local/bin:$PATH
```

`/usr/local/bin/devops-mise` sources `/data/mise/mise-env.sh` before executing `/usr/local/bin/mise`.

`generate-toolchain-index.sh` turns installed manifest entries into concrete build-time homes. The manifest `name` is the public platform key used by `.ci/toolchain.json`; the manifest `version` is the actual `mise` install identifier:

```text
"21" -> /data/mise/data/installs/java/temurin-21 -> JAVA_HOME
"3"  -> /data/mise/data/installs/maven/3.9.6    -> MAVEN_HOME
<gradle key> -> /data/mise/data/installs/gradle/<version> -> GRADLE_HOME
```

Jenkins chooses the actual directory by reading `/data/devops-ci/index.json` or `DEVOPS_CI_INDEX`, then matching `.ci/toolchain.json` keys such as `jdk`, `maven`, or `gradle`.

To use a different `mise` root, initialize that root and generate a matching index:

```bash
sudo scripts/init-mise-layout.sh \
  --root /data/mise-prod \
  --index /data/devops-ci-prod/index.json

sudo scripts/generate-toolchain-index.sh \
  --root /data/mise-prod \
  --ci-root /data/devops-ci-prod
```

## Validation and Index

```bash
sudo scripts/validate-mise-tools.sh
sudo scripts/generate-toolchain-index.sh
```

Manifests are available-version catalogs, not a requirement that every Jenkins node installs every key. By default, `validate-mise-tools.sh` and `generate-toolchain-index.sh` skip missing manifest entries and only validate/index tools that are actually installed on the node.

For example, if a node only installs Java 11 and Maven 3, the generated index only exposes `jdk: "11"` and `maven: "3"`. A project declaring an unavailable key such as `jdk: "8"` will fail during `devops-cli resolve`, which is the expected platform availability check.

Maven and Gradle need a Java runtime even for `mvn -v` or `gradle -v`. Each `maven.json` or `gradle.json` entry can declare `minJava`, for example Maven 3 uses `minJava: "8"` and Maven 4 should use `minJava: "17"`. Validation and index generation probe each Maven/Gradle version with a Java runtime chosen in this order:

1. The lowest installed JDK in the same `MISE_ROOT` that satisfies `minJava`.
2. The current environment `JAVA_HOME`, only if no matching managed JDK exists and it appears to satisfy `minJava`.

The probe does not write a `mise use -g` default and does not affect Jenkins build selection. The generated index records `minJava`, `probeJavaHome`, and `probeJavaSource` for auditability. If no probe Java is available, the entry is skipped by default or fails under `--strict`.

Use `--strict` when preparing a node that is expected to contain every manifest entry:

```bash
sudo scripts/validate-mise-tools.sh --strict
sudo scripts/generate-toolchain-index.sh --strict
```

## Jenkins Consumption

`devops-cli resolve` reads the index and returns Java runtime information. The Jenkins copy-paste helper consumes that result and injects:

- `JAVA_HOME`
- `MAVEN_HOME` or `GRADLE_HOME`
- `PATH+JAVA`
- `PATH+MAVEN` or `PATH+GRADLE`

It then runs only the default Maven or Gradle command derived from `.ci/toolchain.json`.
