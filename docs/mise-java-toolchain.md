# mise Host Toolchain

Host Node.js, Java, Maven, and Gradle are prepared on Jenkins slaves with `mise`.

The host Node.js runtime is only for platform tools such as the `devops-cli` wrapper. Project Node.js builds run inside Docker runner images selected by `.ci/toolchain.json`.

Normal Java builds consume the generated index and do not install tools.

## Fixed Paths

```text
/usr/local/bin/mise
/data/mise
/data/devops-ci/index.json
```

The current phase assumes a local `mise` binary package exists. `scripts/install-mise.sh` installs that local binary; it does not download from the internet.

## Layout

```text
/data/mise/
├── system-config/
├── runtime-config/
├── node/
│   ├── data/
│   ├── cache/
│   └── tmp/
├── java/
│   ├── data/
│   ├── cache/
│   └── tmp/
├── maven/
│   ├── data/
│   ├── cache/
│   └── tmp/
├── gradle/
│   ├── data/
│   ├── cache/
│   └── tmp/
├── manifests/
├── profiles/
└── scripts/
```

`scripts/init-mise-layout.sh` creates the layout, copies manifests, writes base config, and creates `/data/mise/runtime-config/profile.sh` for explicit maintenance sessions. It does not create `/etc/profile.d` files.

It also writes a `.devops-mise-root` marker. Install and permission-normalization scripts require this marker before touching the root recursively.

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
sudo scripts/install-node-runtime.sh --root /data/mise lts

sudo scripts/install-devops-ci-cli.sh \
  --tarball artifacts/cli/devops-ci-agent-linux-x64-0.1.0.tar.gz \
  --node "$(cat /data/mise/runtime-config/devops-cli-node.path)" \
  --prefix /data/tools/devops-cli \
  --index /data/devops-ci/index.json \
  --link /usr/local/bin/devops-cli

# Install only the Java/Maven/Gradle keys required by this Jenkins node.
sudo scripts/install-java-tools.sh --root /data/mise 11
sudo scripts/install-maven-tools.sh --root /data/mise 3

sudo scripts/generate-toolchain-index.sh \
  --root /data/mise \
  --ci-root /data/devops-ci
```

If the platform package was built without `artifacts/mise/mise` or `artifacts/cli/<tarball>`, copy those files to the Jenkins node separately and pass their actual paths to the install scripts.

Each tool family uses its own `MISE_DATA_DIR`, `MISE_CACHE_DIR`, and `MISE_TMP_DIR` under `/data/mise/<tool>/`.

Tools can also be installed from local archives when Jenkins nodes cannot download through `mise`:

```bash
sudo scripts/install-node-runtime.sh \
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

The scripts extract archives into the same managed locations that `mise install` would use:

```text
/data/mise/node/data/installs/node/20
/data/mise/java/data/installs/java/temurin-11
/data/mise/maven/data/installs/maven/3.9.6
/data/mise/gradle/data/installs/gradle/8.8
```

`generate-toolchain-index.sh` does not need to know whether tools came from local archives or from `mise install`.

## Host Node Runtime

Install the shared Node.js runtime used by the `devops-cli` wrapper:

```bash
sudo scripts/install-node-runtime.sh --root /data/mise lts
cat /data/mise/runtime-config/devops-cli-node.path
```

Then pass that executable to the CLI installer:

```bash
sudo scripts/install-devops-ci-cli.sh \
  --tarball artifacts/cli/devops-ci-agent-linux-x64-0.1.0.tar.gz \
  --node "$(cat /data/mise/runtime-config/devops-cli-node.path)" \
  --prefix /data/tools/devops-cli \
  --index /data/devops-ci/index.json \
  --link /usr/local/bin/devops-cli
```

This Node.js runtime should not be used to build application Node.js projects. Those builds remain Docker-based.

Manifest `name` values are public keys. Install scripts resolve explicit arguments through the manifest, so `scripts/install-java-tools.sh 21` installs `java@temurin-21`, and `scripts/install-maven-tools.sh 3` installs `maven@3.9.6`.

After layout or tool installation, the scripts normalize `/data/mise` permissions:

- directories: `0755`
- executable files: `0755`
- ordinary files: `0644`

The normal Jenkins build user should only read and execute these files.

## Mise Root Selection

`mise` is only used during host preparation. Normal Jenkins builds do not run `mise install` or `mise exec`.

The selected `mise` root is the `--root` argument, or `MISE_ROOT`, defaulting to `/data/mise`. During installation each tool family gets an isolated data directory:

```text
<MISE_ROOT>/node/data
<MISE_ROOT>/java/data
<MISE_ROOT>/maven/data
<MISE_ROOT>/gradle/data
```

`generate-toolchain-index.sh` turns installed manifest entries into concrete build-time homes. The manifest `name` is the public platform key used by `.ci/toolchain.json`; the manifest `version` is the actual `mise` install identifier:

```text
"21" -> <MISE_ROOT>/java/data/installs/java/temurin-21 -> JAVA_HOME
"3"  -> <MISE_ROOT>/maven/data/installs/maven/3.9.6    -> MAVEN_HOME
<gradle key> -> <MISE_ROOT>/gradle/data/installs/gradle/<version> -> GRADLE_HOME
```

Jenkins chooses the actual directory by reading `/data/devops-ci/index.json` or `DEVOPS_CI_INDEX`, then matching `.ci/toolchain.json` keys such as `jdk`, `maven`, or `gradle`. To use a different `mise` root, generate a different index:

```bash
sudo scripts/generate-toolchain-index.sh \
  --root /data/mise-prod \
  --ci-root /data/devops-ci
```

## Validation and Index

```bash
sudo scripts/validate-mise-tools.sh
sudo scripts/generate-toolchain-index.sh
```

Manifests are available-version catalogs, not a requirement that every Jenkins node installs every key. By default, `validate-mise-tools.sh` and `generate-toolchain-index.sh` skip missing manifest entries and only validate/index tools that are actually installed on the node.

For example, if a node only installs Java 11 and Maven 3, the generated index only exposes `jdk: "11"` and `maven: "3"`. A project declaring an unavailable key such as `jdk: "8"` will fail during `devops-cli resolve`, which is the expected platform availability check.

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
