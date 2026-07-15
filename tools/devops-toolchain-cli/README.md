# @devops/toolchain-cli

User-side CLI for creating and validating `.ci/toolchain.json` declarations used by the `devops-ci` toolchain platform.

This npm package is intentionally small. It is for application developers who need to add or check a project toolchain declaration. It does not install Jenkins node tooling, build Docker runner images, install `mise`, or package platform scripts.

## Install

From a private registry:

```bash
npm install -D @devops/toolchain-cli
```

or run it with your package manager's one-shot executor:

```bash
npx @devops/toolchain-cli init
```

The installed `devops-toolchain` runtime supports Node.js 12.22.0 or newer. It is published as a bundled CommonJS CLI with no runtime dependencies, so application projects do not install its CLI libraries separately. Source `devDependencies` are only for repository builds and platform artifact packaging; building this package from source follows the repository development toolchain and may require a newer Node.js version than the installed CLI runtime.

The package name is `@devops/toolchain-cli`; the installed executable remains `devops-toolchain`.
The `devops-cli` executable name is intentionally reserved for a future general-purpose DevOps CLI.

The package currently uses the `@devops` scope for private-registry isolation. If it is later published to a public npm registry, confirm scope ownership and naming policy before publishing.

## Commands

```bash
devops-toolchain init
devops-toolchain validate
devops-toolchain print
devops-toolchain resolve
```

### init

Create or update `.ci/toolchain.json`:

```bash
devops-toolchain init
```

Default value resolution:

1. Existing `.ci/toolchain.json`.
2. Current project `package.json`.
3. Built-in common values.

When `package.json` is used, the CLI defaults `type` to `node`, reads `engines.node` or `volta.node` for the Node major version, and reads `packageManager` plus lockfiles for package-manager candidates. The interactive choices show inference sources, for example `npm (from package-lock.json)`, while the stored value remains `npm`.

If an exact package-manager version is available from `packageManager`, it is preferred. If only a range or lockfile-derived major such as `npm 6.x` is known, `init` tries to query `registry.npmjs.org` for the latest exact version in that range. If the lookup fails or `--no-registry-lookup` is passed, the CLI keeps `Manual input` and shows the inferred major as a hint.

Interactive prompts can be localized with `--lang zh-CN` or `DEVOPS_TOOLCHAIN_LANG=zh-CN`. This only changes human-facing prompt text; JSON fields, validation messages, and resolve output stay stable.

The interactive flow supports going back to the previous field and prints the final JSON before writing.

### validate

Validate schema and local project files:

```bash
devops-toolchain validate --file .ci/toolchain.json --project-dir .
```

For Node projects, validation checks `package.json`, `packageManager`, `scripts.build`, and lockfile consistency.

Pass a platform index only when you also want to verify platform availability:

```bash
devops-toolchain validate --index /data/devops-ci/index.json
```

### print

Print a human-readable view:

```bash
devops-toolchain print --file .ci/toolchain.json
```

Print normalized JSON:

```bash
devops-toolchain print --json
```

### resolve

Resolve a CI execution plan as stable JSON:

```bash
devops-toolchain resolve \
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
