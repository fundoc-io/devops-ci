# mise Java Toolchain

Java, Maven, and Gradle are prepared on Jenkins slaves with `mise`. Normal Jenkins builds consume the generated index and do not install tools.

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

```bash
sudo scripts/install-mise.sh --binary /path/to/mise --target /usr/local/bin/mise
sudo scripts/init-mise-layout.sh
sudo scripts/install-java-tools.sh
sudo scripts/install-maven-tools.sh
sudo scripts/install-gradle-tools.sh
```

Each tool family uses its own `MISE_DATA_DIR`, `MISE_CACHE_DIR`, and `MISE_TMP_DIR` under `/data/mise/<tool>/`.

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
<MISE_ROOT>/java/data
<MISE_ROOT>/maven/data
<MISE_ROOT>/gradle/data
```

`generate-toolchain-index.sh` turns manifest entries into concrete build-time homes. The manifest `name` is the public platform key used by `.ci/toolchain.json`; the manifest `version` is the actual `mise` install identifier:

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

`generate-toolchain-index.sh` validates every manifest entry before writing `/data/devops-ci/index.json` by default. If any Java, Maven, or Gradle executable is missing or fails its version command, the index is not written.

## Jenkins Consumption

`devops-cli resolve` reads the index and returns Java runtime information. The Jenkins copy-paste helper consumes that result and injects:

- `JAVA_HOME`
- `MAVEN_HOME` or `GRADLE_HOME`
- `PATH+JAVA`
- `PATH+MAVEN` or `PATH+GRADLE`

It then runs only the default Maven or Gradle command derived from `.ci/toolchain.json`.
