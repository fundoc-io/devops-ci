/*
 * Copy-paste helper for ordinary "Pipeline script from SCM" Groovy files.
 *
 * Paste this class at the end of a pipeline Groovy file. The pipeline body only
 * constructs DevopsCiToolchain and passes business hooks. Internal helper
 * modules stay nested, so the pasted block exposes no global methods.
 */
class DevopsCiToolchain implements Serializable {
    private final def steps
    private final Resolver resolver
    private final NodeRunner nodeRunner
    private final JavaRunner javaRunner

    DevopsCiToolchain(def steps) {
        this.steps = steps
        this.resolver = new Resolver(steps)
        this.nodeRunner = new NodeRunner(steps, resolver)
        this.javaRunner = new JavaRunner(steps, resolver)
    }

    def buildByToolchain(String toolchainFile = '.ci/toolchain.json') {
        return buildByToolchain([file: toolchainFile])
    }

    def buildByToolchain(Map options) {
        Map plan = resolver.resolve(options)
        Map next = copyOptions(options)
        next.plan = plan

        if (plan.type == 'node') {
            return nodeRunner.run(next)
        }
        if (plan.type == 'java') {
            return javaRunner.run(next)
        }
        steps.error "Unsupported resolved toolchain type: ${plan.type}"
    }

    def nodeDockerBuild(String toolchainFile = '.ci/toolchain.json') {
        return nodeDockerBuild([file: toolchainFile])
    }

    def nodeDockerBuild(Map options) {
        return nodeRunner.run(options)
    }

    def javaBuild(String toolchainFile = '.ci/toolchain.json') {
        return javaBuild([file: toolchainFile])
    }

    def javaBuild(Map options) {
        return javaRunner.run(options)
    }

    private static Map copyOptions(Map options) {
        Map next = new LinkedHashMap()
        next.putAll(options)
        return next
    }

    private static class Resolver implements Serializable {
        private final def steps

        Resolver(def steps) {
            this.steps = steps
        }

        Map resolve(Map options = [:]) {
            String runtimeDir = Tools.text(options.runtimeDir, '.ci-runtime')
            String resolveFile = Tools.text(options.resolveOutput, "${runtimeDir}/resolve.json")
            steps.dir(runtimeDir) {
                steps.writeFile(file: '.keep', text: '')
            }

            String resolveCommand = command(options)
            int status = steps.sh(script: "${resolveCommand} > ${Tools.shellQuote(resolveFile)}", returnStatus: true)
            String output = steps.readFile(resolveFile).trim()
            if (!output) {
                steps.error "devops-cli resolve produced no JSON; status=${status}; command=${resolveCommand}"
            }
            Map plan = new groovy.json.JsonSlurperClassic().parseText(output) as Map
            if (status != 0 || plan.status != 'ok') {
                steps.error "devops-cli resolve failed: ${output}"
            }
            return plan
        }

        private String command(Map options) {
            List args = [
                Tools.text(options.cli, steps.env.DEVOPS_CI_CLI ?: 'devops-cli'),
                'resolve',
                '--file', Tools.text(options.file, '.ci/toolchain.json'),
                '--project-dir', Tools.text(options.projectDir, '.')
            ]
            if (Tools.text(options.index, '').trim()) {
                args.add('--index')
                args.add(options.index.toString())
            }
            return args.collect { Tools.shellQuote(it.toString()) }.join(' ')
        }
    }

    private static class NodeRunner implements Serializable {
        private final def steps
        private final Resolver resolver

        NodeRunner(def steps, Resolver resolver) {
            this.steps = steps
            this.resolver = resolver
        }

        Map run(Map options) {
            Map plan = options.plan instanceof Map ? (Map) options.plan : resolver.resolve(options)
            Map ctx = context(plan, options)

            writeSlots(ctx, options)
            Tools.callHook(options.beforeDocker, ctx)
            withNpmToken(options) {
                runDocker(ctx, options)
            }
            Tools.callHook(options.afterDocker, ctx)
            return ctx
        }

        private Map context(Map plan, Map options) {
            Map tc = plan.toolchain as Map
            String runtimeDir = Tools.text(options.runtimeDir, '.ci-runtime')
            String npmRegistry = Tools.text(options.npmRegistry, steps.env.NPM_REGISTRY ?: 'https://registry.npmjs.org/')
            return [
                steps: steps,
                plan: plan,
                toolchain: tc,
                image: plan.runtime.image.toString(),
                runtimeDir: runtimeDir,
                resolveFile: Tools.text(options.resolveOutput, "${runtimeDir}/resolve.json"),
                npmRegistry: npmRegistry,
                pmConfig: options.pmConfig instanceof Map ? (Map) options.pmConfig : [:],
                initCommand: defaultInitCommand(),
                installCommand: plan.display.install.toString(),
                buildCommand: plan.display.build.toString()
            ]
        }

        private void writeSlots(Map ctx, Map options) {
            steps.dir(ctx.runtimeDir.toString()) {
                steps.deleteDir()
                steps.writeFile(file: 'resolve.json', text: groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(ctx.plan)) + '\n')
                steps.writeFile(file: 'init.sh', text: Tools.shellScript(Tools.commandValue(options.initScript, ctx, ctx.initCommand.toString())))
                steps.writeFile(file: 'install.sh', text: Tools.shellScript(Tools.commandValue(options.installScript, ctx, ctx.installCommand.toString())))
                steps.writeFile(file: 'build.sh', text: Tools.shellScript(Tools.commandValue(options.buildScript, ctx, ctx.buildCommand.toString())))
            }
        }

        private void runDocker(Map ctx, Map options) {
            String tokenEnv = steps.env.NPM_TOKEN ? '  -e NPM_TOKEN="$NPM_TOKEN" \\\n' : ''
            String dockerArgs = Tools.dockerArgs(options.dockerArgs)

            steps.sh """
docker run --rm \\
  --user \$(id -u):\$(id -g) \\
  -e CI=true \\
  -e PM=${Tools.shellQuote(ctx.toolchain.pm.toString())} \\
  -e PMVER=${Tools.shellQuote(ctx.toolchain.pmver.toString())} \\
  -e NPM_REGISTRY=${Tools.shellQuote(ctx.npmRegistry.toString())} \\
${tokenEnv}${dockerArgs}  -v "\$WORKSPACE:/workspace" \\
  -v "\$WORKSPACE/${ctx.runtimeDir}:/ci-scripts:ro" \\
  -w /workspace \\
  ${Tools.shellQuote(ctx.image.toString())}
"""
        }

        private void withNpmToken(Map options, Closure body) {
            String credentialId = Tools.text(options.npmTokenCredentialId, steps.env.NPM_TOKEN_CREDENTIAL_ID ?: '')
            if (!credentialId.trim()) {
                body.call()
                return
            }

            steps.withCredentials([['$class': 'StringBinding', credentialsId: credentialId.trim(), variable: 'NPM_TOKEN']]) {
                body.call()
            }
        }

        private static String defaultInitCommand() {
            return '''
            : "${PM:?PM is required}"
            : "${PMVER:?PMVER is required}"
            : "${NPM_REGISTRY:=https://registry.npmjs.org/}"

            export DEVOPS_CI_PM_PREFIX="${DEVOPS_CI_PM_PREFIX:-/tmp/devops-ci-pm}"
            export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/tmp/devops-ci-npm-cache}"
            export NPM_CONFIG_USERCONFIG="${NPM_CONFIG_USERCONFIG:-/tmp/devops-ci-npmrc}"
            export npm_config_registry="${npm_config_registry:-$NPM_REGISTRY}"
            export YARN_NPM_REGISTRY_SERVER="${YARN_NPM_REGISTRY_SERVER:-$NPM_REGISTRY}"

            mkdir -p "$DEVOPS_CI_PM_PREFIX" "$NPM_CONFIG_CACHE"
            touch "$NPM_CONFIG_USERCONFIG"

            npm config set registry "$NPM_REGISTRY"
            case "$PM" in
              npm)
                npm install -g --prefix "$DEVOPS_CI_PM_PREFIX" "npm@${PMVER}"
                ;;
              pnpm)
                npm install -g --prefix "$DEVOPS_CI_PM_PREFIX" "pnpm@${PMVER}"
                ;;
              yarn)
                if [[ "$PMVER" == 1.* ]]; then
                  npm install -g --prefix "$DEVOPS_CI_PM_PREFIX" "yarn@${PMVER}"
                else
                  npm install -g --prefix "$DEVOPS_CI_PM_PREFIX" "@yarnpkg/cli-dist@${PMVER}"
                fi
                ;;
              *)
                echo "Unsupported package manager: $PM" >&2
                exit 1
                ;;
            esac
            export PATH="$DEVOPS_CI_PM_PREFIX/bin:$PATH"

            case "$PM" in
              npm)
                npm -v
                ;;
              pnpm)
                pnpm config set registry "$NPM_REGISTRY"
                pnpm -v
                ;;
              yarn)
                yarn -v
                ;;
              *)
                echo "Unsupported package manager: $PM" >&2
                exit 1
                ;;
            esac
            '''
        }
    }

    private static class JavaRunner implements Serializable {
        private final def steps
        private final Resolver resolver

        JavaRunner(def steps, Resolver resolver) {
            this.steps = steps
            this.resolver = resolver
        }

        Map run(Map options) {
            Map plan = options.plan instanceof Map ? (Map) options.plan : resolver.resolve(options)
            Map ctx = [
                steps: steps,
                plan: plan,
                toolchain: plan.toolchain as Map,
                buildCommand: plan.display.build.toString()
            ]
            ctx.buildCommand = Tools.commandValue(options.buildCommand, ctx, ctx.buildCommand.toString())

            Tools.callHook(options.beforeJava, ctx)
            steps.withEnv(env(plan)) {
                ((List) plan.display.probes).each { steps.sh(it.toString()) }
                if (ctx.buildCommand.trim()) {
                    steps.sh(ctx.buildCommand)
                }
            }
            Tools.callHook(options.afterJava, ctx)
            return ctx
        }

        private static List env(Map plan) {
            List envs = []
            (plan.runtime.env as Map).each { key, value -> envs << "${key}=${value}" }
            ((List) plan.runtime.pathPrepend).eachWithIndex { item, index -> envs << "PATH+DEVOPSCI${index}=${item}" }
            return envs
        }
    }

    private static class Tools implements Serializable {
        static String commandValue(Object custom, Map ctx, String fallback) {
            if (custom == null) {
                return fallback
            }
            if (custom instanceof Closure) {
                return String.valueOf(evaluate(custom, ctx))
            }
            return custom.toString()
        }

        static void callHook(Object hook, Map ctx) {
            if (hook instanceof Closure) {
                evaluate(hook, ctx)
            }
        }

        static Object evaluate(Object value, Map ctx) {
            Closure closure = (Closure) ((Closure) value).clone()
            closure.delegate = ctx
            closure.resolveStrategy = Closure.DELEGATE_FIRST
            return closure.maximumNumberOfParameters == 0 ? closure.call() : closure.call(ctx)
        }

        static String shellScript(String body) {
            String text = body == null ? ':' : body.stripIndent().trim()
            if (text.startsWith('#!')) {
                return text + '\n'
            }
            return '#!/usr/bin/env bash\nset -euo pipefail\n\n' + (text ?: ':') + '\n'
        }

        static String dockerArgs(Object value) {
            List args = value instanceof List ? (List) value : (value == null ? [] : [value])
            String text = args.collect { it.toString().trim() }.findAll { it }.join(' \\\n')
            return text ? "${text} \\\n" : ''
        }

        static String text(Object value, String fallback) {
            String result = value == null ? '' : value.toString()
            return result ? result : fallback
        }

        static String shellQuote(String value) {
            return "'" + value.replace("'", "'\"'\"'") + "'"
        }
    }
}
