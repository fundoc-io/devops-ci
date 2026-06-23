# devops-ci

面向 Jenkins DevOps 环境的 CI 工具链制备项目。

`devops-ci` 提供项目级工具链契约、CLI、Docker Runner 模板、宿主机初始化脚本和 Jenkins 可复制 Groovy 片段，用于让 CI 构建的 Node/JDK/构建工具选择更稳定、可治理，而不是散落在各个业务 pipeline 中。

English documentation: [README.md](README.md).

## 项目提供什么

- `.ci/toolchain.json`：项目侧工具链声明，支持 Node.js 和 Java 场景。
- `devops-cli`：用于生成、校验、打印和解析工具链声明的 TypeScript CLI。
- Node Docker Runner：按 Node 大版本选择 Docker 镜像执行构建。
- 宿主机工具脚本：基于 `mise` 制备共享的 `devops-cli` Node.js runtime，以及 Jenkins 节点上的 JDK、Maven、Gradle。
- Jenkins 复制片段：适用于普通 `Pipeline script from SCM` 的 Groovy helper。
- 分发打包：通过 Makefile 和脚本产出 CLI tarball 与平台 tarball。

## 仓库结构

```text
config/                    平台 index 模板和 mise manifests
docker/node-runner/        Node runner Dockerfile 模板和 entrypoint
docs/                      设计与运维文档
jenkins/snippets/          可复制 Jenkins Groovy helper
resources/                 可选本地二进制占位目录
scripts/                   宿主机初始化、镜像构建、安装和打包脚本
tools/devops-toolchain-cli/ TypeScript CLI 子项目
```

## 工具链契约

Node.js 项目：

```json
{
  "type": "node",
  "node": "20",
  "pm": "pnpm",
  "pmver": "9.15.9"
}
```

Java 项目：

```json
{
  "type": "java",
  "jdk": "21",
  "buildTool": "maven",
  "maven": "3",
  "skipTests": true
}
```

`.ci/toolchain.json` 只声明工具链版本，不承载任意构建命令。`commands`、`scripts`、`args` 不属于该契约。

## CLI

从源码运行：

```bash
cd tools/devops-toolchain-cli
pnpm install
pnpm run build
node dist/user-cli.js init
node dist/user-cli.js validate --file ../../.ci/toolchain.json --project-dir ../..
```

发布后的用户侧 npm 包支持 Node.js 12.22.0 及以上，便于在较旧的业务项目本地环境中运行。源码构建和平台产物打包仍按本仓库开发工具链执行，可能使用更高版本的 Node.js 工具。

安装包后的用户命令：

```bash
devops-cli init
devops-cli validate
devops-cli print
devops-cli resolve
```

`init` 会优先读取已有 `.ci/toolchain.json` 作为默认值；没有该文件时，会尝试从 `package.json` 中读取 `engines.node`、`volta.node` 和 `packageManager` 作为 Node 项目默认值。交互式配置支持回退到上一个字段，最终确认后再写入 JSON。

当前 npm 包名使用 `@devops` scope，主要用于私服隔离。后续如果发布到公网 npm registry，应先确认 scope 归属和包名策略。

## Node Docker Runner

构建 Node runner 镜像：

```bash
scripts/build-node-ci-image.sh \
  --node 20 \
  --base node:20-bookworm-slim \
  --image devops-ci/node20:202606
```

运行时 Jenkins 只挂载 workspace 和生成的 runner 脚本。默认 init 步骤会在容器内把声明的包管理器安装到 `/tmp/devops-ci-pm`，不会挂载宿主机 npm/pnpm/yarn cache。

## Jenkins 复制片段

普通 `Pipeline script from SCM` 可将 [jenkins/snippets/devops-ci-toolchain.groovy](jenkins/snippets/devops-ci-toolchain.groovy) 复制到 pipeline 文件末尾：

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

业务 pipeline 可以按需覆盖 Node 构建插槽：

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

从源码构建 agent CLI：

```bash
cd tools/devops-toolchain-cli
pnpm run build:agent-tarball
```

通过 `make dist` 分发时，平台 tarball 内的附属产物路径是：

```text
artifacts/cli/<devops-ci-agent-tarball>
artifacts/mise/<mise-binary>
```

在解压后的平台包目录中安装：

```bash
cd /data/packages/devops-ci/devops-ci-platform-0.1.0

sudo scripts/install-mise.sh \
  --binary artifacts/mise/mise \
  --target /usr/local/bin/mise

sudo scripts/init-mise-layout.sh --root /data/mise
sudo scripts/install-tooling-node.sh --root /data/mise lts

sudo scripts/install-devops-ci-cli.sh \
  --tarball artifacts/cli/devops-ci-agent-linux-x64-0.1.0.tar.gz \
  --node "$(cat /data/mise/devops-cli-node.path)" \
  --prefix /data/tools/devops-cli \
  --index /data/devops-ci/index.json \
  --link /usr/local/bin/devops-cli
```

如果平台包构建时没有带 `mise` 二进制或 CLI tarball，就把 `artifacts/mise/...` 或 `artifacts/cli/...` 替换成复制到该 Jenkins 节点上的外部文件路径。

安装脚本会生成 wrapper，记录 index 路径，并使用安装时指定的 Node 二进制。这个宿主机 Node 只给平台工具使用；业务 Node.js 构建仍然走 Docker runner 镜像。

如果已经有合适的 Node.js 可执行文件，可以跳过 `install-tooling-node.sh`，直接传入：

```bash
sudo scripts/install-devops-ci-cli.sh \
  --tarball /path/to/devops-ci-agent-linux-x64-0.1.0.tar.gz \
  --node /path/to/node \
  --prefix /data/tools/devops-cli \
  --index /data/devops-ci/index.json \
  --link /usr/local/bin/devops-cli
```

Java 构建需要安装对应宿主机工具并重新生成平台 index：

```bash
sudo scripts/install-java-tools.sh --root /data/mise 11
sudo scripts/install-maven-tools.sh --root /data/mise 3
sudo scripts/generate-toolchain-index.sh \
  --root /data/mise \
  --ci-root /data/devops-ci
```

生成的 index 只包含当前节点已经安装的工具。未安装的 manifest 条目默认跳过，所以只安装 Java 11 的节点不会暴露 Java 8/17/21。只有当某个节点必须安装 manifest 中全部条目时，才给 `validate-mise-tools.sh` 或 `generate-toolchain-index.sh` 加 `--strict`。

如果下载慢，可以用本地 archive 离线安装，不走 `mise install` 下载：

```bash
sudo scripts/install-tooling-node.sh \
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

## 平台打包

构建本地产物：

```bash
make cli-agent-tarball
make platform-package
make dist
```

`make dist` 会先构建 Jenkins agent CLI tarball，再打包仓库脚本、配置、Docker 模板、文档、Jenkins 片段和可选本地二进制资源。

## 公开源码注意事项

部署相关的 endpoint、凭据、证书、私有 registry URL 和二进制 payload 不应提交到仓库。仓库使用被忽略的资源目录存放本地二进制，并在文档中使用 `<your-npm-registry>`、`<your-container-registry>` 等占位。

## 文档

- [docs/design.md](docs/design.md)：当前架构与边界。
- [docs/toolchain-json-schema.md](docs/toolchain-json-schema.md)：`.ci/toolchain.json` 契约。
- [docs/node-docker-runner.md](docs/node-docker-runner.md)：Node runner 镜像与运行流程。
- [docs/mise-java-toolchain.md](docs/mise-java-toolchain.md)：Java/Maven/Gradle 宿主机准备。
- [docs/jenkins-copy-paste-helper.md](docs/jenkins-copy-paste-helper.md)：Jenkins 复制片段用法。
