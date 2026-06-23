# .ci/toolchain.json Contract

The project contract path is:

```text
.ci/toolchain.json
```

The file declares toolchain versions only. It must not include `commands`, `scripts`, or `args`.

## Node

```json
{
  "type": "node",
  "node": "20",
  "pm": "pnpm",
  "pmver": "9.15.9"
}
```

Rules:

- `type` must be `node`.
- `node` must be one of `12`, `14`, `16`, `18`, `20`, `22`, or `24`.
- `pm` must be `npm`, `pnpm`, or `yarn`.
- `pmver` must be an exact installable version such as `9.15.9`.
- `pmver` must not be `latest`, `9`, `9.x`, `^9.15.9`, or `~9.15.9`.
- `pmver` must not include semver build metadata such as `+sha512...`; when `package.json#packageManager` includes that metadata, the CLI normalizes it before writing `.ci/toolchain.json`.
- `pmver` is installed by the Node Docker Runner during init. The first-phase platform index does not need to maintain package manager version lists.

Lockfile rules:

- `npm` requires `package-lock.json` or `npm-shrinkwrap.json`.
- `pnpm` requires `pnpm-lock.yaml`.
- `yarn` requires `yarn.lock`.
- Multiple package manager lockfiles fail.

`package.json` rules:

- If `packageManager` exists, it must equal `<pm>@<pmver>`.
- `scripts.build` is required.
- Missing `packageManager` is a warning, not an error.

## Java

Maven:

```json
{
  "type": "java",
  "jdk": "21",
  "buildTool": "maven",
  "maven": "3",
  "skipTests": true
}
```

Gradle:

```json
{
  "type": "java",
  "jdk": "17",
  "buildTool": "gradle",
  "gradle": "8.8",
  "skipTests": true
}
```

Rules:

- `type` must be `java`.
- `jdk` is a JDK version key such as `8`, `11`, `17`, or `21`; it must be present in `/data/devops-ci/index.json`.
- `buildTool` must be `maven` or `gradle`.
- `maven` is required when `buildTool=maven`; the user-facing value can be a platform generation key such as `3` or `4`.
- `gradle` is required when `buildTool=gradle`.
- `skipTests` is optional and defaults to `false`.

Default commands:

- Maven with tests: `mvn clean package`
- Maven skipping tests: `mvn clean package -DskipTests`
- Gradle with tests: `gradle clean build`
- Gradle skipping tests: `gradle clean build -x test`
