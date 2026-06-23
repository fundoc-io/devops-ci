# devops-ci

CI toolchain preparation for Jenkins-based DevOps environments.

`devops-ci` provides a small project contract, a CLI, Docker runner templates, host preparation scripts, and Jenkins copy-paste helpers for teams that want repeatable CI builds without letting every pipeline maintain its own Node/JDK/tooling rules.

中文文档见 [README.zh-CN.md](README.zh-CN.md).

## What This Project Provides

- `.ci/toolchain.json`: a project-level declaration for Node.js or Java build toolchains.
- `devops-cli`: a TypeScript CLI for creating, validating, printing, and resolving toolchain declarations.
- Node Docker Runner: a Dockerfile template and entrypoint for Node.js builds selected by Node major version.
- Java host tooling scripts: `mise`-based setup scripts for JDK, Maven, and Gradle on Jenkins nodes.
- Jenkins helper snippet: a copy-paste Groovy helper for ordinary `Pipeline script from SCM` jobs.
- Distribution packaging: Makefile targets and scripts for building CLI and platform tarballs.

## Repository Layout

```text
config/                    Platform index templates and mise manifests
docker/node-runner/        Node runner Dockerfile template and entrypoint
docs/                      Design and operational documentation
jenkins/snippets/          Copy-paste Jenkins Groovy helper
resources/                 Optional local binary placeholders
scripts/                   Host setup, image build, install, and packaging scripts
tools/devops-toolchain-cli/ TypeScript CLI subproject
```

## Toolchain Contract

Node.js project:

```json
{
  "type": "node",
  "node": "20",
  "pm": "pnpm",
  "pmver": "9.15.9"
}
```

Java project:

```json
{
  "type": "java",
  "jdk": "21",
  "buildTool": "maven",
  "maven": "3",
  "skipTests": true
}
```

The contract declares tool versions only. Build behavior stays in Jenkins helpers or business pipelines; `commands`, `scripts`, and `args` are intentionally not part of `.ci/toolchain.json`.

## CLI

From source:

```bash
cd tools/devops-toolchain-cli
pnpm install
pnpm run build
node dist/user-cli.js init
node dist/user-cli.js validate --file ../../.ci/toolchain.json --project-dir ../..
```

The installed user-side npm package supports Node.js 12.22.0 or newer, so it can run inside older application project environments. Source builds and platform artifact packaging follow this repository's development toolchain and may use newer Node.js tooling.

After package installation, the user-facing command is:

```bash
devops-cli init
devops-cli validate
devops-cli print
devops-cli resolve
```

`init` uses existing `.ci/toolchain.json` as defaults when present. Without that file, it can inspect `package.json`: `engines.node` or `volta.node` provides the Node major default, and `packageManager` provides the package manager default. Interactive setup supports going back to the previous field before writing the final JSON.

The package currently uses the `@devops` npm scope for private-registry isolation. If publishing to a public npm registry later, confirm that scope ownership and package naming are appropriate before publishing.

## Node Docker Runner

Build a Node runner image:

```bash
scripts/build-node-ci-image.sh \
  --node 20 \
  --base node:20-bookworm-slim \
  --image devops-ci/node20:202606
```

At runtime Jenkins mounts the workspace and generated runner scripts. The default init step installs the declared package manager into `/tmp/devops-ci-pm` inside the container and does not mount host npm/pnpm/yarn caches.

## Jenkins Copy-Paste Helper

For ordinary `Pipeline script from SCM` jobs, copy [jenkins/snippets/devops-ci-toolchain.groovy](jenkins/snippets/devops-ci-toolchain.groovy) to the end of the pipeline file:

```groovy
stage('Build') {
    steps {
        script {
            def devopsCi = new DevopsCiToolchain(this)
            devopsCi.buildByToolchain('.ci/toolchain.json')
        }
    }
}
```

Node-specific hooks can be supplied by the business pipeline:

```groovy
devopsCi.nodeDockerBuild(
    initScript: { ctx ->
        """
        ${ctx.initCommand}
        npm config set sass_binary_site <your-node-sass-mirror>
        """
    },
    buildScript: { ctx ->
        "${ctx.buildCommand} -- --mode production"
    },
    afterDocker: { ctx ->
        archiveArtifacts artifacts: 'dist/**', allowEmptyArchive: false
    }
)
```

## Jenkins Agent CLI Tarball

Build and install a self-contained agent CLI bundle:

```bash
cd tools/devops-toolchain-cli
pnpm run build:agent-tarball

cd ../..
scripts/install-devops-ci-cli.sh \
  --tarball tools/devops-toolchain-cli/dist/artifacts/devops-ci-agent-linux-x64-0.1.0.tar.gz \
  --node /path/to/node \
  --prefix /data/tools/devops-cli \
  --index /data/devops-ci/index.json \
  --link /usr/local/bin/devops-cli
```

The generated wrapper records the configured index path and uses the explicit Node binary path supplied during installation.

## Platform Package

Build local distribution artifacts:

```bash
make cli-agent-tarball
make platform-package
make dist
```

`make dist` builds the Jenkins agent CLI tarball and then packages repository scripts, config, Docker templates, docs, Jenkins snippets, and optional local binary resources.

## Public Source Hygiene

Deployment-specific endpoints, credentials, certificates, private registry URLs, and binary payloads should not be committed. The repository keeps local binaries under ignored resource directories and uses placeholders such as `<your-npm-registry>` or `<your-container-registry>` in documentation.

## Documentation

- [docs/design.md](docs/design.md): current architecture and boundaries.
- [docs/toolchain-json-schema.md](docs/toolchain-json-schema.md): `.ci/toolchain.json` contract.
- [docs/node-docker-runner.md](docs/node-docker-runner.md): Node runner image and runtime flow.
- [docs/mise-java-toolchain.md](docs/mise-java-toolchain.md): Java/Maven/Gradle host preparation.
- [docs/jenkins-copy-paste-helper.md](docs/jenkins-copy-paste-helper.md): Jenkins snippet usage.
