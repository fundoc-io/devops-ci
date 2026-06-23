# DevOps CI Toolchain Design

This project prepares the CI environment and toolchain assets used by Jenkins jobs. It covers platform configuration, host-level Java tooling, Docker-based Node runners, Jenkins copy-paste helper snippets, and a project-side CLI for `.ci/toolchain.json`.

## Boundaries

- Node.js builds run in Docker Runner images selected by Node major version.
- Java, Maven, and Gradle are installed on Jenkins slaves through `mise` under `/data/mise`.
- `.ci/toolchain.json` is the project contract. It declares toolchain versions, not arbitrary commands.
- `/data/devops-ci/index.json` is the platform resolution index.
- Missing tools, missing images, unsupported versions, and forbidden fields fail fast.

## Repository Modules

- `config/devops-toolchain/index.base.json`: base Node image mapping.
- `config/mise/manifests/*.json`: desired Java/Maven/Gradle versions to install with `mise`.
- `docker/node-runner/`: reusable Node Runner image template and entrypoint.
- `scripts/`: environment preparation and image build scripts.
- `jenkins/snippets/`: copy-paste Jenkins helper for ordinary Pipeline script files.
- `tools/devops-toolchain-cli/`: CLI submodule for project developers.

## Build Dispatch

Jenkins uses the copy-paste helper under `jenkins/snippets/` for ordinary `Pipeline script from SCM` files.

For `type=node`, Jenkins validates:

- Node major version is supported.
- Package manager is `npm`, `pnpm`, or `yarn`.
- `pmver` is an exact version.
- Lockfile matches the package manager.
- `package.json` has a compatible `packageManager` when present.
- `package.json` has `scripts.build`.
- `commands`, `scripts`, and `args` are absent.

For `type=java`, Jenkins validates:

- JDK is present in the platform index.
- Maven or Gradle version is present in the platform index.
- `skipTests` is boolean when present.
- `commands`, `scripts`, and `args` are absent.

## Failure Policy

The platform does not guess, randomly select versions, install missing host tooling during normal Jenkins builds, or fall back from lockfile-based installs to mutable installs.

## Copy-Paste Pipeline Helper

Some Jenkins jobs keep a single Groovy pipeline file under an application pipeline repository. For that mode, append `jenkins/snippets/devops-ci-toolchain.groovy` to the end of the pipeline file and construct the helper inside `script` blocks:

```groovy
def devopsCi = new DevopsCiToolchain(this)
devopsCi.nodeDockerBuild(
    pmConfig: [
        sass_binary_site: '<your-node-sass-mirror>'
    ],
    initScript: { ctx ->
        def npmrcLines = ['npm', 'pnpm'].contains(ctx.toolchain.pm)
            ? ctx.pmConfig.collect { key, value -> "npm config set ${key} ${value}" }.join('\n')
            : ''
        """
        ${ctx.initCommand}
        ${npmrcLines}
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

The helper does not use `load`, `libraryResource`, or direct platform-index reads. It shells out to `devops-cli resolve`, checks `status`, and consumes the returned plan. It writes `init.sh`, `install.sh`, and `build.sh` as extension slots with Jenkins `writeFile`; executable permissions are left to the Docker runner entrypoint. The entrypoint sources `init.sh` so PATH and package-manager config exported there are visible to later steps, then executes `install.sh` and `build.sh` with `bash`.
