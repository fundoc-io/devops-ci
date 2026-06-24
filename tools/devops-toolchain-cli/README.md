# @devops/devops-cli

User-side CLI for creating and validating `.ci/toolchain.json` declarations used by the `devops-ci` toolchain platform.

This npm package is intentionally small. It is for application developers who need to add or check a project toolchain declaration. It does not install Jenkins node tooling, build Docker runner images, install `mise`, or package platform scripts.

## Install

From a private registry:

```bash
npm install -D @devops/devops-cli
```

or run it with your package manager's one-shot executor:

```bash
npx @devops/devops-cli init
```

The installed `devops-cli` runtime supports Node.js 12.22.0 or newer. It is published as a bundled CommonJS CLI with no runtime dependencies, so application projects do not install its CLI libraries separately. Source `devDependencies` are only for repository builds and platform artifact packaging; building this package from source follows the repository development toolchain and may require a newer Node.js version than the installed CLI runtime.

The package name is `@devops/devops-cli`; the installed executable remains `devops-cli`.

The package currently uses the `@devops` scope for private-registry isolation. If it is later published to a public npm registry, confirm scope ownership and naming policy before publishing.

## Commands

```bash
devops-cli init
devops-cli validate
devops-cli print
devops-cli resolve
```

### init

Create or update `.ci/toolchain.json`:

```bash
devops-cli init
```

Default value resolution:

1. Existing `.ci/toolchain.json`.
2. Current project `package.json`.
3. Built-in common values.

When `package.json` is used, the CLI defaults `type` to `node`, reads `engines.node` or `volta.node` for the Node major version, and reads `packageManager` for the package manager and version. Ranges such as `>=20.18.xx` default to Node major `20`.

The interactive flow supports going back to the previous field and prints the final JSON before writing.

### validate

Validate schema and local project files:

```bash
devops-cli validate --file .ci/toolchain.json --project-dir .
```

For Node projects, validation checks `package.json`, `packageManager`, `scripts.build`, and lockfile consistency.

Pass a platform index only when you also want to verify platform availability:

```bash
devops-cli validate --index /data/devops-ci/index.json
```

### print

Print a human-readable view:

```bash
devops-cli print --file .ci/toolchain.json
```

Print normalized JSON:

```bash
devops-cli print --json
```

### resolve

Resolve a CI execution plan as stable JSON:

```bash
devops-cli resolve \
  --file .ci/toolchain.json \
  --project-dir . \
  --index /data/devops-ci/index.json
```

`resolve` is mainly for automation such as Jenkins wrappers. It requires a platform index from `--index`, `DEVOPS_CI_INDEX`, or an installed CLI config. If `.ci/toolchain.json` is missing, it can infer a Node declaration from `package.json`.

## Toolchain Examples

Node.js:

```json
{
  "type": "node",
  "node": "20",
  "pm": "pnpm",
  "pmver": "9.15.9"
}
```

Java with Maven:

```json
{
  "type": "java",
  "jdk": "21",
  "buildTool": "maven",
  "maven": "3",
  "skipTests": true
}
```

The file declares tool versions only. It must not contain `commands`, `scripts`, or `args`; build behavior belongs to CI helpers or business pipelines.

## Platform Data

The user npm package does not embed your Jenkins platform availability data. Without `--index` or `DEVOPS_CI_INDEX`, it validates schema and local project files only.

Java distribution details are intentionally hidden from project configuration. A project declares `jdk: "21"`; the platform index maps that key to the actual installed JDK.

## Related Artifacts

The source repository also contains a Jenkins agent CLI tarball build and platform packaging scripts. Those are distribution artifacts for Jenkins nodes and are not part of this user-side npm package.
