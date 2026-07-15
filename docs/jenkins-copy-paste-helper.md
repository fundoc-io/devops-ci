# Jenkins Copy-Paste Helper

Use this mode when a Jenkins job points to one Groovy file through `Pipeline script from SCM`.

Copy `jenkins/snippets/devops-ci-toolchain.groovy` to the end of the business pipeline file. The helper exposes one class, `DevopsCiToolchain`, and does not add global methods.

## Minimal Usage

```groovy
script {
    def devopsCi = new DevopsCiToolchain(this)
    devopsCi.buildByToolchain()
}
```

All helper entry points accept named args. `file` defaults to `.ci/toolchain.json`, so ordinary pipelines only pass the options they actually customize. Use `file: '<path>'` only for non-standard toolchain file paths.

## Frontend Build With Custom Business Logic

```groovy
stage('Build frontend') {
    steps {
        timeout(time: 1, unit: 'HOURS') {
            script {
                def devopsCi = new DevopsCiToolchain(this)

                devopsCi.nodeDockerBuild(
                    npmRegistry: env.NPM_REGISTRY ?: 'https://registry.npmjs.org/',
                    pmConfig: [
                        sass_binary_site: '<your-node-sass-mirror>',
                        electron_mirror: '<your-electron-mirror>',
                        chromedriver_cdnurl: '<your-chromedriver-mirror>'
                    ],
                    buildArgsMode: 'script',
                    buildArgs: [mode: 'production'],
                    afterDocker: { ctx ->
                        archiveArtifacts artifacts: 'dist/**', allowEmptyArchive: false
                    }
                )
            }
        }
    }
}
```

The project owns Node and package manager choices in `.ci/toolchain.json`; the pipeline owns special init/install/build behavior for that job family.

## Custom Commands

The helper creates three Node runner slots:

- `init.sh` defaults to installing the declared package manager into `/tmp/devops-ci-pm` inside the container.
- `install.sh` runs the default lockfile install command.
- `build.sh` runs the default `<pm> run build` command.

Override only the part that is truly project-specific:

```groovy
devopsCi.nodeDockerBuild(
    pmConfig: [
        sass_binary_site: '<your-node-sass-mirror>',
        chromedriver_cdnurl: '<your-chromedriver-mirror>'
    ],
    installScript: { ctx ->
        if (ctx.toolchain.pm == 'npm') {
            return 'npm install --update-checksums --unsafe-perm'
        }
        if (ctx.toolchain.pm == 'yarn') {
            return 'yarn install --update-checksums'
        }
        return ctx.installCommand
    },
    buildArgsMode: 'script',
    buildArgs: [mode: 'production']
)
```

`pmConfig` is written into `init.sh` as package-install environment variables. For example, `chromedriver_cdnurl` becomes `npm_config_chromedriver_cdnurl`, which is what old package installers such as `chromedriver` commonly read. When `pm` is `pnpm`, the helper also exports `pnpm_config_<name>` for pnpm-side config compatibility. Yarn registry uses `YARN_NPM_REGISTRY_SERVER`; package-specific mirrors still depend on the package install script reading the exported `npm_config_*` variable. Use `pmConfig` for package-level mirrors; keep project-specific command logic in `installScript` or `buildScript`.

`buildArgs` defaults to `direct` mode, which appends arguments directly to `<pm> run build`. This preserves old npm-style pipelines that read values through `npm_config_*` or command-specific parsing. Prefer a `Map` or `List` because the helper quotes each argument:

```groovy
def buildPath = "https://<your-static-cdn>/${projectName}/${processBusinessKey}"

devopsCi.nodeDockerBuild(
    buildArgs: [
        silent: true,
        buildpath: buildPath
    ]
)
```

That produces a build slot equivalent to:

```bash
<pm> run build '--silent' '--buildpath=https://<your-static-cdn>/<project>/<business-key>'
```

Use `buildArgsMode: 'script'` when the values are real script arguments. In that mode the helper inserts `--` for npm and pnpm, but not for yarn:

```groovy
devopsCi.nodeDockerBuild(
    buildArgsMode: 'script',
    buildArgs: [mode: 'production']
)
```

Use `buildScript` only when the command structure must be fully controlled by the pipeline:

```groovy
devopsCi.nodeDockerBuild(
    buildArgs: [mode: 'production'],
    buildScript: { ctx ->
        if (!ctx.buildArgs) {
            return "${ctx.toolchain.pm} run custom-build"
        }
        if (ctx.toolchain.pm in ['npm', 'pnpm']) {
            return "${ctx.toolchain.pm} run custom-build -- ${ctx.buildArgs}"
        }
        return "${ctx.toolchain.pm} run custom-build ${ctx.buildArgs}"
    }
)
```

For legacy npm/gulp projects that already depended on commands such as
`npm run build --silent --buildpath=...`, keep that shape in `buildScript`.
This is useful when the project parses npm's command metadata instead of plain
script arguments:

```groovy
def buildPath = "https://<your-static-cdn>/${projectName}/${processBusinessKey}"

devopsCi.nodeDockerBuild(
    npmRegistry: '<your-npm-registry>',
    pmConfig: [
        sass_binary_site: '<your-node-sass-mirror>',
        chromedriver_cdnurl: '<your-chromedriver-mirror>'
    ],
    buildScript: { ctx ->
        String buildPathArg = DevopsCiToolchain.shellQuote(buildPath)
        if (ctx.toolchain.pm == 'npm') {
            return "npm run build --silent --buildpath=${buildPathArg}"
        }
        if (ctx.toolchain.pm == 'pnpm') {
            return "pnpm run build -- --buildpath=${buildPathArg}"
        }
        return "yarn run build --buildpath=${buildPathArg}"
    }
)
```

If an old project has `package-lock.json` with `lockfileVersion: 1` and its build
script parses `npm_config_argv`, prefer an npm 6.x `pmver` unless the project has
already been verified on npm 7+. npm 7+ may still install the dependency tree,
but its command metadata behavior can differ from the original npm 5/6 workflow.

Host-side work such as uploading static files or building a final Docker image should usually stay in the business pipeline or in `afterDocker`, because those tools may not exist inside the Node runner image.

## What The Helper Does Not Do

- It does not call `load` or `libraryResource`.
- It does not read `/data/devops-ci/index.json` in Groovy.
- It does not maintain project-specific version lists.
- It does not run `chmod +x` for generated scripts; the runner entrypoint executes them with `bash`.
- It does not install host Node/npm/yarn/pnpm for the application build.
- It does not mount host npm/pnpm/yarn caches or configure HOME/global prefix on the Jenkins node.
