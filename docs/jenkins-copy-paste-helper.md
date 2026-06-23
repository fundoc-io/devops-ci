# Jenkins Copy-Paste Helper

Use this mode when a Jenkins job points to one Groovy file through `Pipeline script from SCM`.

Copy `jenkins/snippets/devops-ci-toolchain.groovy` to the end of the business pipeline file. The helper exposes one class, `DevopsCiToolchain`, and does not add global methods.

## Minimal Usage

```groovy
script {
    def devopsCi = new DevopsCiToolchain(this)
    devopsCi.buildByToolchain('.ci/toolchain.json')
}
```

`buildByToolchain` calls `devops-cli resolve` and dispatches by the returned `type`.

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
    initScript: { ctx ->
        """
        ${ctx.initCommand}
        npm config set sass_binary_site <your-node-sass-mirror>
        """
    },
    installScript: { ctx ->
        ctx.toolchain.pm == 'npm'
            ? 'npm install --update-checksums --unsafe-perm'
            : ctx.installCommand
    },
    buildScript: { ctx ->
        "${ctx.buildCommand} -- --mode production"
    }
)
```

Host-side work such as uploading static files or building a final Docker image should usually stay in the business pipeline or in `afterDocker`, because those tools may not exist inside the Node runner image.

## What The Helper Does Not Do

- It does not call `load` or `libraryResource`.
- It does not read `/data/devops-ci/index.json` in Groovy.
- It does not maintain project-specific version lists.
- It does not run `chmod +x` for generated scripts; the runner entrypoint executes them with `bash`.
- It does not install host Node/npm/yarn/pnpm for the application build.
- It does not mount host npm/pnpm/yarn caches or configure HOME/global prefix on the Jenkins node.
