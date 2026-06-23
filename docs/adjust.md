# DevOps Toolchain 改造 Handoff：Java/mise + Node Docker Runner + Toolchain CLI

## 1. 背景

当前 DevOps/Jenkins 构建环境需要统一治理 JDK、Maven、Gradle、Node.js、npm、pnpm、yarn 等工具链版本。

经过多轮方案收敛，最终确定为：

* Java/Maven/Gradle 生态边界相对清晰，继续使用 Jenkins slave 宿主机工具链，由 mise 管理版本。
* DevOps 平台自身工具链运行所需的 Node.js，也由 mise 管理。
* 业务项目构建使用的 Node.js 不走 mise，统一改为 Docker Runner 模式。
* Node.js Docker 镜像只按 Node 大版本制备，例如 node12、node14、node16、node18、node20、node22、node24。
* npm/pnpm/yarn 不作为镜像维度，不在镜像内预置全部组合版本。
* 业务项目通过 `.ci/toolchain.json` 声明构建契约。
* Jenkins Groovy 片段 根据 `.ci/toolchain.json` 解析工具链并执行构建。
* Node 类型构建不允许项目自由声明 install/build 命令，统一由 Groovy 辅助方法按 pm 类型生成标准命令。
* Java 类型构建不允许项目自由声明 mvn/gradle 命令，统一由 Groovy 辅助方法按 buildTool 生成标准命令。
* 提供一个 Node.js CLI 工具，辅助开发生成和校验 `.ci/toolchain.json`，但 CLI 不生成任意 commands 字段。

## 2. 最终边界

### 2.1 业务构建 Node

业务构建 Node 指业务项目执行前端构建时使用的 Node.js runtime，例如：

```text
pnpm install --frozen-lockfile
pnpm run build
npm ci
npm run build
yarn install --frozen-lockfile
yarn run build
```

规则：

* 不使用 mise。
* 使用 Docker Runner。
* `.ci/toolchain.json` 中 `node` 只写大版本，例如 `"20"`。
* Jenkins 根据 `node` 大版本选择对应 Node Docker image。
* npm/pnpm/yarn 在容器内临时安装到 `/tmp/ci-home/.npm-global`。
* cache/store 默认使用容器内 `/tmp`，容器退出即丢弃。
* 只挂载 Jenkins workspace。
* workspace 由 Jenkins job 生命周期清理。
* 未匹配到 Docker image 或 pm 版本不在白名单时，直接失败。

### 2.2 平台工具 Node

平台工具 Node 指 DevOps 平台自身工具链运行所需的 Node.js runtime，例如：

```text
devops-cli init
devops-cli validate
devops-cli print
生成/校验 .ci/toolchain.json
执行平台侧 Node.js 辅助脚本
```

规则：

* 使用 mise 管理。
* 不参与业务项目构建。
* 建议只维护一个或少量 LTS 版本，例如 node@20 或 node@22。
* 可用于运行 `tools/devops-toolchain-cli`。
* 该 Node 和业务构建 Node 语义不同，即使版本号相同也不能混用概念。

### 2.3 Java/Maven/Gradle

Java 构建工具链规则：

* 使用 mise 管理 JDK、Maven、Gradle。
* Jenkins 构建阶段不通过 mise 动态切换，而是消费平台生成的 index.json。
* Jenkins Groovy 片段 注入 JAVA_HOME、MAVEN_HOME、GRADLE_HOME、PATH。
* 普通 Jenkins 用户不允许现场 `mise install`。
* 缺少版本直接失败。
* 不使用 `/etc/profile.d` 自动污染全局 shell。

## 3. 项目侧配置文件

默认路径：

```text
.ci/toolchain.json
```

第一版固定使用 `.ci/toolchain.json`。后续如需兼容其他路径，可在 Groovy 片段方法中增加参数。

## 4. Node 类型 toolchain.json

### 4.1 最小格式

pnpm 项目：

```json
{
  "type": "node",
  "node": "20",
  "pm": "pnpm",
  "pmver": "9.15.9"
}
```

npm 项目：

```json
{
  "type": "node",
  "node": "16",
  "pm": "npm",
  "pmver": "8.19.4"
}
```

yarn 项目：

```json
{
  "type": "node",
  "node": "14",
  "pm": "yarn",
  "pmver": "1.22.22"
}
```

### 4.2 字段规则

```text
type:
  必填。
  必须为 node。

node:
  必填。
  只写 Node 大版本。
  第一版允许值：12、14、16、18、20、22、24。
  不要求精确版本。
  具体 Node 精确版本由平台 Docker image 决定。

pm:
  必填。
  允许值：npm、pnpm、yarn。

pmver:
  必填。
  必须是精确版本。
  例如 9.15.9、8.19.4、1.22.22。
  不允许 latest、9、9.x、^9.15.9、~9.15.9。
```

禁止字段：

```text
commands:
  禁止。
  不允许项目通过 toolchain.json 注入任意 install/build 命令。

scripts:
  禁止。
  不允许在 toolchain.json 中定义任意脚本。

args:
  第一版禁止。
  后续如果需要扩展，必须通过受控字段实现。
```

禁止 commands 的原因：

* 避免项目配置引入任意脚本执行风险。
* 避免 CI 行为被项目自由改写。
* 统一平台构建套路。
* 老项目特殊命令后续通过平台白名单或特例机制处理，不在第一版开放。

## 5. Node 默认构建流程

Jenkins Groovy 辅助方法根据 `pm` 自动生成标准流程。

### 5.1 npm

初始化：

```bash
npm install -g "npm@${PMVER}"
npm config set registry "${NPM_REGISTRY}"
npm config set cache "/tmp/npm-cache"
```

安装：

```bash
npm ci
```

构建：

```bash
npm run build
```

要求：

* 必须存在 `package-lock.json` 或 `npm-shrinkwrap.json`。
* 不存在 lockfile 时直接失败。
* 第一版不自动降级到 `npm install`。

### 5.2 pnpm

初始化：

```bash
npm install -g "pnpm@${PMVER}"
pnpm config set registry "${NPM_REGISTRY}"
pnpm config set store-dir "/tmp/pnpm-store"
pnpm config set cache-dir "/tmp/pnpm-cache"
pnpm config set fetch-retries "3"
pnpm config set fetch-timeout "60000"
pnpm config set network-concurrency "16"
```

安装：

```bash
pnpm install --frozen-lockfile
```

构建：

```bash
pnpm run build
```

要求：

* 必须存在 `pnpm-lock.yaml`。
* 不允许同时存在 `package-lock.json` 或 `yarn.lock`，第一版建议直接失败。
* 平台只模板化 registry/cache/store 等基础设施配置。
* 不由平台注入 `node-linker`、`shamefully-hoist`、`strict-peer-dependencies`、`auto-install-peers`、`public-hoist-pattern` 等会改变项目依赖语义的配置。

### 5.3 yarn

初始化：

```bash
npm install -g "yarn@${PMVER}"
yarn config set registry "${NPM_REGISTRY}"
yarn config set cache-folder "/tmp/yarn-cache"
```

Yarn 1.x 安装：

```bash
yarn install --frozen-lockfile
```

Yarn 2+ 安装：

```bash
yarn install --immutable
```

构建：

```bash
yarn run build
```

要求：

* 必须存在 `yarn.lock`。
* 第一版重点支持 Yarn 1.x。
* 如支持 Yarn 2+，根据 `pmver` 主版本判断安装命令。

## 6. Node 项目一致性校验

package.json 不作为工具链权威配置，但做一致性校验。

规则：

* 如果 package.json 中存在 `packageManager`，必须与 `.ci/toolchain.json` 中的 `pm` 和 `pmver` 一致。
* 如果 package.json 缺失 `packageManager`，允许继续，但输出 warning。
* 如果 package.json 中存在 `engines.node`，可校验当前 Node 大版本是否满足。
* 如果 pm 与 lockfile 不匹配，直接失败。
* 如果多个 lockfile 同时存在，建议直接失败。
* package.json 必须存在 `scripts.build`，因为默认构建命令是 `<pm> run build`。

示例一致配置：

`.ci/toolchain.json`：

```json
{
  "type": "node",
  "node": "20",
  "pm": "pnpm",
  "pmver": "9.15.9"
}
```

package.json：

```json
{
  "packageManager": "pnpm@9.15.9",
  "scripts": {
    "build": "vite build"
  }
}
```

如果 package.json 中是：

```json
{
  "packageManager": "yarn@1.22.22"
}
```

则直接失败。

## 7. Java 类型 toolchain.json

### 7.1 Maven 项目

```json
{
  "type": "java",
  "jdk": "21",
  "buildTool": "maven",
  "maven": "3.9.6",
  "skipTests": true
}
```

### 7.2 Gradle 项目

```json
{
  "type": "java",
  "jdk": "17",
  "buildTool": "gradle",
  "gradle": "8.8",
  "skipTests": true
}
```

### 7.3 字段规则

```text
type:
  必填。
  必须为 java。

jdk:
  必填。
  例如 8、11、17、21。具体发行版由平台 index 映射，项目侧不感知 Temurin。

buildTool:
  必填。
  允许值：maven、gradle。

maven:
  buildTool=maven 时必填。

gradle:
  buildTool=gradle 时必填。

skipTests:
  可选。
  默认 false。
```

禁止字段：

```text
commands:
  禁止。
  不允许项目自由配置 mvn/gradle 命令。

args:
  第一版禁止。
  后续如需支持 Maven profile、module、settings 等，必须通过受控字段扩展。
```

### 7.4 Java 默认构建流程

Maven：

```bash
mvn clean package
```

Maven 跳过测试：

```bash
mvn clean package -DskipTests
```

Gradle：

```bash
gradle clean build
```

Gradle 跳过测试：

```bash
gradle clean build -x test
```

第一版不开放任意 Maven/Gradle 命令。后续可受控扩展：

```json
{
  "type": "java",
  "jdk": "21",
  "buildTool": "maven",
  "maven": "3.9.6",
  "skipTests": true,
  "mavenProfiles": ["prod"],
  "module": "service-api"
}
```

但第一阶段不实现这些扩展字段。

## 8. 平台 allowlist/index

建议路径：

```text
/data/devops-ci/index.json
```

第一版可用本地 JSON 文件维护。后续可改为由平台配置中心或 DevOps 系统下发。

示例：

```json
{
  "nodeImages": {
    "12": "<your-container-registry>/devops-ci/node12:202606",
    "14": "<your-container-registry>/devops-ci/node14:202606",
    "16": "<your-container-registry>/devops-ci/node16:202606",
    "18": "<your-container-registry>/devops-ci/node18:202606",
    "20": "<your-container-registry>/devops-ci/node20:202606",
    "22": "<your-container-registry>/devops-ci/node22:202606",
    "24": "<your-container-registry>/devops-ci/node24:202606"
  },
  "packageManagers": {
    "npm": [
      "6.14.18",
      "8.19.4",
      "10.8.2"
    ],
    "pnpm": [
      "8.15.9",
      "9.15.9",
      "10.12.1"
    ],
    "yarn": [
      "1.22.22",
      "4.9.2"
    ]
  },
  "tooling": {
    "node": {
      "20.18.3": {
        "NODE_HOME": "/data/mise/data/installs/node/20.18.3",
        "purpose": "tooling"
      }
    }
  },
  "java": {
    "jdks": {
      "8": {
        "JAVA_HOME": "/data/mise/data/installs/java/temurin-8"
      },
      "11": {
        "JAVA_HOME": "/data/mise/data/installs/java/temurin-11"
      },
      "17": {
        "JAVA_HOME": "/data/mise/data/installs/java/temurin-17"
      },
      "21": {
        "JAVA_HOME": "/data/mise/data/installs/java/temurin-21"
      }
    },
    "maven": {
      "3.6.3": {
        "MAVEN_HOME": "/data/mise/data/installs/maven/3.6.3"
      },
      "3.9.6": {
        "MAVEN_HOME": "/data/mise/data/installs/maven/3.9.6"
      }
    },
    "gradle": {
      "7.6.4": {
        "GRADLE_HOME": "/data/mise/data/installs/gradle/7.6.4"
      },
      "8.8": {
        "GRADLE_HOME": "/data/mise/data/installs/gradle/8.8"
      }
    }
  }
}
```

规则：

* `nodeImages` 是业务构建 Node Docker image。
* `tooling.node` 是平台工具 Node。
* 两者不得混用。
* Node image 以大版本为 key。
* pmver 必须在 `packageManagers` 对应数组中。
* Java 工具链必须在 java 配置中。
* 缺失即失败，不现场安装。

## 9. mise 管理方案

### 9.1 mise 管理范围

mise 管理：

```text
JDK
Maven
Gradle
平台工具 Node.js
```

mise 不管理：

```text
业务项目构建 Node.js
业务项目 npm/pnpm/yarn
业务项目 node_modules
```

### 9.2 目录结构

```text
/usr/local/bin/mise
/usr/local/bin/devops-mise

/data/mise/
├── mise-env.sh
├── data/
│   └── installs/
│       ├── java/
│       ├── maven/
│       ├── gradle/
│       └── node/
├── config/
│   └── config.toml
├── cache/
├── state/
├── tmp/
├── manifests/
│   ├── java.json
│   ├── maven.json
│   ├── gradle.json
│   └── tooling-node.json
└── scripts/
```

说明：

* `/usr/local/bin/mise` 是原始 mise 二进制。
* `/usr/local/bin/devops-mise` 是平台维护便捷入口，只负责加载 mise 环境后执行 mise。
* `/data/mise/mise-env.sh` 是平台统一 mise 环境入口。
* `/data/mise/data` 是唯一 `MISE_DATA_DIR`。
* Java/Maven/Gradle/平台工具 Node 共用同一个 mise data root。
* 业务构建 Node 不放入该目录体系。

### 9.3 显式 MISE 目录变量

不用 XDG 作为主要控制方式。使用显式 `MISE_*_DIR`：

```bash
MISE_DATA_DIR=/data/mise/data
MISE_CONFIG_DIR=/data/mise/config
MISE_CACHE_DIR=/data/mise/cache
MISE_STATE_DIR=/data/mise/state
MISE_TMP_DIR=/data/mise/tmp
```

原因：

* 显式 `MISE_*_DIR` 更直观。
* Jenkins 节点环境里看到这些变量可以明确知道它们用于 mise。
* XDG 变量不直观，后续维护者不一定能看出它们影响 mise。
* mise 的 data/config/cache/state/tmp 彼此独立，设置 `MISE_DATA_DIR` 不会自动推导其他目录。

### 9.4 mise-env.sh

文件：

```text
/data/mise/mise-env.sh
```

内容：

```bash
# /data/mise/mise-env.sh
# Platform-controlled mise environment for DevOps toolchain management.

export MISE_DATA_DIR=/data/mise/data
export MISE_CONFIG_DIR=/data/mise/config
export MISE_CACHE_DIR=/data/mise/cache
export MISE_STATE_DIR=/data/mise/state
export MISE_TMP_DIR=/data/mise/tmp
export MISE_GLOBAL_CONFIG_FILE=/data/mise/config/config.toml

export PATH=/data/mise/data/shims:/usr/local/bin:$PATH
```

权限：

```bash
chown root:root /data/mise/mise-env.sh
chmod 0644 /data/mise/mise-env.sh
```

要求：

* 所有 mise 安装、校验、生成 index 的脚本都必须 `source /data/mise/mise-env.sh`。
* 不允许在多个脚本里散落硬编码 `MISE_*_DIR`。
* Jenkins node 全局环境变量可以直接配置这 5 个 `MISE_*_DIR`，但平台脚本仍以 `mise-env.sh` 为准。
* 不使用 XDG 变量作为主要控制方式。

### 9.5 devops-mise wrapper

文件：

```text
/usr/local/bin/devops-mise
```

内容：

```bash
#!/usr/bin/env bash
set -euo pipefail

source /data/mise/mise-env.sh

exec /usr/local/bin/mise "$@"
```

权限：

```bash
chown root:root /usr/local/bin/devops-mise
chmod 0755 /usr/local/bin/devops-mise
```

说明：

`devops-mise` 不是业务构建 wrapper，不用于封装 Jenkins 业务命令。它只是平台维护便捷入口，确保没有显式 source 环境时也能固定使用 `/data/mise` 目录体系。

安装工具链时可以直接使用基础环境：

```bash
source /data/mise/mise-env.sh
mise install java@temurin-21
mise install maven@3.9.6
mise install gradle@8.8
mise install node@20.18.3
mise where java@temurin-21
mise use -g java@temurin-21 maven@3.9.6
```

也可以使用等价便捷入口：

```bash
devops-mise where java@temurin-21
```

## 10. mise manifests

### 10.1 java.json

```json
{
  "java": [
    {
      "name": "8",
      "version": "temurin-8"
    },
    {
      "name": "11",
      "version": "temurin-11"
    },
    {
      "name": "17",
      "version": "temurin-17"
    },
    {
      "name": "21",
      "version": "temurin-21"
    }
  ]
}
```

### 10.2 maven.json

```json
{
  "maven": [
    {
      "name": "3.6.3",
      "version": "3.6.3"
    },
    {
      "name": "3.9.6",
      "version": "3.9.6"
    }
  ]
}
```

### 10.3 gradle.json

```json
{
  "gradle": [
    {
      "name": "7.6.4",
      "version": "7.6.4"
    },
    {
      "name": "8.8",
      "version": "8.8"
    }
  ]
}
```

### 10.4 tooling-node.json

```json
{
  "node": [
    {
      "name": "node20",
      "version": "20.18.3",
      "purpose": "tooling"
    }
  ]
}
```

说明：

* `purpose=tooling` 表示该 Node 只用于平台工具链运行。
* 不得将该 Node 作为业务项目构建 Node 使用。
* 业务构建 Node 仍由 Docker image 决定。

## 11. mise 安装和维护脚本

需要提供脚本：

```text
scripts/install-mise.sh
scripts/init-mise-layout.sh
scripts/install-java-tools.sh
scripts/install-maven-tools.sh
scripts/install-gradle-tools.sh
scripts/install-tooling-node.sh
scripts/validate-mise-tools.sh
scripts/generate-toolchain-index.sh
```

所有脚本要求：

```bash
set -euo pipefail
source /data/mise/mise-env.sh
```

或者统一通过：

```bash
source /data/mise/mise-env.sh
mise ...
```

调用 mise。

### 11.1 install-mise.sh

职责：

* root 执行。
* 安装 mise glibc linux-x64 版本。
* 安装到 `/usr/local/bin/mise`。
* 设置权限 0755。
* 校验 `mise --version`。
* 不负责安装工具链。

示例目标：

```bash
install -m 0755 mise-v2026.6.10-linux-x64 /usr/local/bin/mise
/usr/local/bin/mise --version
```

### 11.2 init-mise-layout.sh

职责：

* 创建 `/data/mise` 目录结构。
* 创建 `/data/mise/mise-env.sh`。
* 创建 `/usr/local/bin/devops-mise`。
* 创建 `/data/mise/config/config.toml`。
* 创建 manifests 目录。
* 设置权限。

目录初始化：

```bash
mkdir -p \
  /data/mise/data \
  /data/mise/config \
  /data/mise/cache \
  /data/mise/state \
  /data/mise/tmp \
  /data/mise/manifests \
  /data/mise/scripts
```

权限建议：

```bash
chown -R root:root /data/mise
find /data/mise -type d -exec chmod 0755 {} \;
find /data/mise -type f -exec chmod 0644 {} \;
chmod 0755 /usr/local/bin/devops-mise
```

说明：

* `/data/mise` 由 root 管理。
* 普通 Jenkins 用户只读可执行。
* 普通 Jenkins 用户不应写 `/data/mise`。
* 不创建 `/etc/profile.d/mise-base.sh`。
* 不自动污染所有登录 shell。

### 11.3 安装行为

安装 JDK：

```bash
source /data/mise/mise-env.sh
mise install java@temurin-21
```

安装 Maven：

```bash
source /data/mise/mise-env.sh
mise install maven@3.9.6
```

安装 Gradle：

```bash
source /data/mise/mise-env.sh
mise install gradle@8.8
```

安装平台工具 Node：

```bash
source /data/mise/mise-env.sh
mise install node@20.18.3
```

实际路径应类似：

```text
/data/mise/data/installs/java/temurin-21
/data/mise/data/installs/maven/3.9.6
/data/mise/data/installs/gradle/8.8
/data/mise/data/installs/node/20.18.3
```

### 11.4 validate-mise-tools.sh

必须实际执行版本命令。

JDK：

```bash
JAVA_HOME=/data/mise/data/installs/java/temurin-21
PATH="$JAVA_HOME/bin:$PATH"
java -version
```

Maven：

```bash
MAVEN_HOME=/data/mise/data/installs/maven/3.9.6
PATH="$MAVEN_HOME/bin:$PATH"
mvn -v
```

Gradle：

```bash
GRADLE_HOME=/data/mise/data/installs/gradle/8.8
PATH="$GRADLE_HOME/bin:$PATH"
gradle -v
```

平台工具 Node：

```bash
NODE_HOME=/data/mise/data/installs/node/20.18.3
PATH="$NODE_HOME/bin:$PATH"
node -v
npm -v
```

要求：

* 验证失败不得写入平台 index。
* 不要只检查目录存在。
* 必须实际执行版本命令。
* 可使用 `mise where ...` 或 `devops-mise where ...` 辅助确认路径，但最终 index 应写入确定路径。

## 12. Node Docker Runner 镜像

### 12.1 镜像职责

Node Docker Runner 镜像只负责：

* 提供指定 Node 大版本 runtime。
* 提供 Node 自带 npm。
* 提供 bash、git、curl、ca-certificates、tzdata、python3、make、g++ 等基础构建依赖。
* 配置字符集、时区。
* 可选导入公司 CA。
* 提供固定 entrypoint runner。
* 设置默认工作目录 `/workspace`。

镜像不负责：

* 固化 pnpm/yarn 多版本。
* 固化项目依赖。
* 固化 node_modules。
* 持久化 cache。
* 推断 pm。
* 执行项目构建命令。
* 修改项目 package.json。

### 12.2 Dockerfile 模板

路径建议：

```text
docker/node-runner/Dockerfile.tpl
```

模板：

```dockerfile
ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE}

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash \
       ca-certificates \
       git \
       curl \
       tzdata \
       python3 \
       make \
       g++ \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo "$TZ" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

# Optional:
# COPY certs/internal-ca.crt /usr/local/share/ca-certificates/internal-ca.crt
# RUN update-ca-certificates

COPY ci-entrypoint.sh /usr/local/bin/ci-entrypoint
RUN chmod +x /usr/local/bin/ci-entrypoint

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/ci-entrypoint"]
```

注意：

* Node 20/22 可使用 bookworm-slim。
* Node 12/14 老版本应根据官方镜像实际可用 tag 选择 bullseye/buster 或内部归档基础镜像。
* 不强制所有 Node 大版本统一 Debian 版本。
* 以“能稳定构建老项目”为优先。

### 12.3 ci-entrypoint.sh

路径建议：

```text
docker/node-runner/ci-entrypoint.sh
```

内容：

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="${CI_SCRIPT_DIR:-/ci-scripts}"

run_step() {
  local name="$1"
  local file="${SCRIPT_DIR}/${name}.sh"

  if [[ ! -f "$file" ]]; then
    echo "CI step script not found: $file" >&2
    exit 1
  fi

  echo "========== CI STEP: ${name} =========="
  bash "$file"
}

run_step init
run_step install
run_step build
```

说明：

* entrypoint 固定执行 `/ci-scripts/init.sh`、`install.sh`、`build.sh`。
* 这些脚本由 Jenkins Groovy 方法根据 toolchain.json 生成。
* `.ci-runtime` 挂载为只读。

## 13. Node Docker 镜像构建脚本

需要提供脚本：

```text
scripts/build-node-ci-image.sh
```

命令示例：

```bash
./scripts/build-node-ci-image.sh \
  --node 20 \
  --base node:20-bookworm-slim \
  --image <your-container-registry>/devops-ci/node20:202606 \
  --push
```

参数：

```text
--node:
  Node 大版本，例如 20。

--base:
  基础镜像，例如 node:20-bookworm-slim。

--image:
  输出镜像 tag。

--ca-file:
  可选，公司 CA 证书路径。

--push:
  构建后推送。

--no-cache:
  docker build --no-cache。

--keep-context:
  保留临时构建上下文用于调试。
```

要求：

* 使用 `set -euo pipefail`。
* 不硬编码 Harbor 用户名密码。
* 外部提前 docker login。
* 参数缺失时输出 usage。
* 构建失败直接退出。
* 支持多个 Node 大版本重复执行。

## 14. Jenkins Shared Library 需求

建议提供：

```text
jenkins/snippets/devops-ci-toolchain.groovy


```

### 14.1 devopsToolchainBuild 方法

职责：

* 读取 `.ci/toolchain.json`。
* 根据 type 分发到 nodeDockerBuild 或 javaToolchainBuild。
* 不支持的 type 直接失败。

示例：

```groovy
def call(String toolchainFile = '.ci/toolchain.json') {
    if (!fileExists(toolchainFile)) {
        error "Toolchain file not found: ${toolchainFile}"
    }

    def tc = readJSON file: toolchainFile

    if (!tc.type) {
        error "toolchain.type is required"
    }

    switch (tc.type) {
        case 'node':
            return nodeDockerBuild(tc)
        case 'java':
            return javaToolchainBuild(tc)
        default:
            error "Unsupported toolchain type: ${tc.type}"
    }
}
```

### 14.2 nodeDockerBuild 方法

职责：

* 校验 Node toolchain。
* 读取平台 index。
* 解析 Node image。
* 校验 pm/pmver 白名单。
* 校验 lockfile 和 package.json packageManager。
* 生成 `.ci-runtime/init.sh`、`install.sh`、`build.sh`。
* 执行 docker run。
* 不清理 workspace，由 Jenkins job 策略处理。

核心逻辑：

```groovy
def call(Map tc) {
    validateNodeToolchain(tc)

    def index = readJSON file: '/data/devops-ci/index.json'
    def image = resolveNodeImage(index, tc.node)
    validatePackageManager(index, tc.pm, tc.pmver)
    validateNodeProjectFiles(tc)
    validatePackageJsonConsistency(tc)

    sh 'rm -rf .ci-runtime && mkdir -p .ci-runtime'

    writeFile file: '.ci-runtime/init.sh', text: generateNodeInitScript(tc)
    writeFile file: '.ci-runtime/install.sh', text: generateNodeInstallScript(tc)
    writeFile file: '.ci-runtime/build.sh', text: generateNodeBuildScript(tc)

    sh 'chmod +x .ci-runtime/*.sh'

    withCredentials([string(credentialsId: 'npm-token', variable: 'NPM_TOKEN')]) {
        sh """
        docker run --rm \\
          --user \$(id -u):\$(id -g) \\
          -e HOME=/tmp/ci-home \\
          -e CI=true \\
          -e PM='${tc.pm}' \\
          -e PMVER='${tc.pmver}' \\
          -e NPM_REGISTRY='<your-npm-registry-url>' \\
          -e NPM_TOKEN="\$NPM_TOKEN" \\
          -v "\$WORKSPACE:/workspace" \\
          -v "\$WORKSPACE/.ci-runtime:/ci-scripts:ro" \\
          -w /workspace \\
          ${image}
        """
    }
}
```

Node 校验：

```groovy
def validateNodeToolchain(Map tc) {
    if (tc.type != 'node') {
        error 'toolchain type must be node'
    }

    if (!tc.node) {
        error 'node is required'
    }

    if (!(tc.node ==~ /^(12|14|16|18|20|22|24)$/)) {
        error "node must be a supported major version, got: ${tc.node}"
    }

    if (!tc.pm) {
        error 'pm is required'
    }

    if (!['npm', 'pnpm', 'yarn'].contains(tc.pm)) {
        error "Unsupported package manager: ${tc.pm}"
    }

    if (!tc.pmver) {
        error 'pmver is required'
    }

    if (!(tc.pmver ==~ /^[0-9]+\\.[0-9]+\\.[0-9]+([-.+][0-9A-Za-z.-]+)?$/)) {
        error "pmver must be an exact version, got: ${tc.pmver}"
    }

    if (tc.commands != null) {
        error 'commands is not allowed in node toolchain.json; build commands are generated by Jenkins Groovy 片段'
    }

    if (tc.scripts != null) {
        error 'scripts is not allowed in node toolchain.json'
    }

    if (tc.args != null) {
        error 'args is not allowed in node toolchain.json in phase 1'
    }
}
```

解析 Node image：

```groovy
def resolveNodeImage(Map index, String nodeMajor) {
    def image = index.nodeImages[nodeMajor]
    if (!image) {
        error "No Docker image configured for Node ${nodeMajor}"
    }
    return image
}
```

校验 pm：

```groovy
def validatePackageManager(Map index, String pm, String pmver) {
    def versions = index.packageManagers[pm]
    if (!versions) {
        error "No package manager allowlist found for ${pm}"
    }

    if (!versions.contains(pmver)) {
        error "Package manager version is not allowed: ${pm}@${pmver}"
    }
}
```

项目文件校验：

```groovy
def validateNodeProjectFiles(Map tc) {
    if (!fileExists('package.json')) {
        error 'package.json not found'
    }

    if (tc.pm == 'npm') {
        if (!fileExists('package-lock.json') && !fileExists('npm-shrinkwrap.json')) {
            error 'npm project requires package-lock.json or npm-shrinkwrap.json'
        }
        if (fileExists('pnpm-lock.yaml') || fileExists('yarn.lock')) {
            error 'npm project should not contain pnpm-lock.yaml or yarn.lock'
        }
    }

    if (tc.pm == 'pnpm') {
        if (!fileExists('pnpm-lock.yaml')) {
            error 'pnpm project requires pnpm-lock.yaml'
        }
        if (fileExists('package-lock.json') || fileExists('yarn.lock')) {
            error 'pnpm project should not contain package-lock.json or yarn.lock'
        }
    }

    if (tc.pm == 'yarn') {
        if (!fileExists('yarn.lock')) {
            error 'yarn project requires yarn.lock'
        }
        if (fileExists('package-lock.json') || fileExists('pnpm-lock.yaml')) {
            error 'yarn project should not contain package-lock.json or pnpm-lock.yaml'
        }
    }
}
```

package.json 校验：

```groovy
def validatePackageJsonConsistency(Map tc) {
    def pkg = readJSON file: 'package.json'

    if (pkg.packageManager) {
        def expected = "${tc.pm}@${tc.pmver}"
        if (pkg.packageManager != expected) {
            error "package.json packageManager mismatch. expected ${expected}, got ${pkg.packageManager}"
        }
    } else {
        echo "WARNING: package.json packageManager is missing; using .ci/toolchain.json ${tc.pm}@${tc.pmver}"
    }

    if (pkg.scripts == null || pkg.scripts.build == null) {
        error 'package.json scripts.build is required because default build command is <pm> run build'
    }
}
```

生成 init 脚本：

```groovy
def generateNodeInitScript(Map tc) {
    if (tc.pm == 'npm') {
        return """#!/usr/bin/env bash
set -euo pipefail

export HOME="\${HOME:-/tmp/ci-home}"
export NPM_GLOBAL_PREFIX="\$HOME/.npm-global"
export PATH="\$NPM_GLOBAL_PREFIX/bin:\$PATH"

mkdir -p "\$HOME" "\$NPM_GLOBAL_PREFIX" /tmp/npm-cache

cat > "\$HOME/.npmrc" <<EOF
registry=\${NPM_REGISTRY}
always-auth=true
cache=/tmp/npm-cache
prefer-offline=false
EOF

if [[ -n "\${NPM_TOKEN:-}" ]]; then
  echo "//<your-npm-registry-host>/repository/npm-private/:_authToken=\${NPM_TOKEN}" >> "\$HOME/.npmrc"
fi

npm config set prefix "\$NPM_GLOBAL_PREFIX"

echo "Node version:"
node -v

echo "npm version before setup:"
npm -v

npm install -g "npm@\${PMVER}"

echo "npm version after setup:"
npm -v
"""
    }

    if (tc.pm == 'pnpm') {
        return """#!/usr/bin/env bash
set -euo pipefail

export HOME="\${HOME:-/tmp/ci-home}"
export NPM_GLOBAL_PREFIX="\$HOME/.npm-global"
export PATH="\$NPM_GLOBAL_PREFIX/bin:\$PATH"

mkdir -p "\$HOME" "\$NPM_GLOBAL_PREFIX" /tmp/pnpm-store /tmp/pnpm-cache

cat > "\$HOME/.npmrc" <<EOF
registry=\${NPM_REGISTRY}
always-auth=true
EOF

if [[ -n "\${NPM_TOKEN:-}" ]]; then
  echo "//<your-npm-registry-host>/repository/npm-private/:_authToken=\${NPM_TOKEN}" >> "\$HOME/.npmrc"
fi

npm config set prefix "\$NPM_GLOBAL_PREFIX"

echo "Node version:"
node -v

echo "npm version:"
npm -v

npm install -g "pnpm@\${PMVER}"

echo "pnpm version:"
pnpm -v

pnpm config set registry "\${NPM_REGISTRY}"
pnpm config set store-dir "/tmp/pnpm-store"
pnpm config set cache-dir "/tmp/pnpm-cache"
pnpm config set fetch-retries "3"
pnpm config set fetch-timeout "60000"
pnpm config set network-concurrency "16"
"""
    }

    if (tc.pm == 'yarn') {
        return """#!/usr/bin/env bash
set -euo pipefail

export HOME="\${HOME:-/tmp/ci-home}"
export NPM_GLOBAL_PREFIX="\$HOME/.npm-global"
export PATH="\$NPM_GLOBAL_PREFIX/bin:\$PATH"

mkdir -p "\$HOME" "\$NPM_GLOBAL_PREFIX" /tmp/yarn-cache

cat > "\$HOME/.npmrc" <<EOF
registry=\${NPM_REGISTRY}
always-auth=true
EOF

if [[ -n "\${NPM_TOKEN:-}" ]]; then
  echo "//<your-npm-registry-host>/repository/npm-private/:_authToken=\${NPM_TOKEN}" >> "\$HOME/.npmrc"
fi

npm config set prefix "\$NPM_GLOBAL_PREFIX"

echo "Node version:"
node -v

echo "npm version:"
npm -v

npm install -g "yarn@\${PMVER}"

echo "yarn version:"
yarn -v

yarn config set registry "\${NPM_REGISTRY}"
yarn config set cache-folder "/tmp/yarn-cache"
"""
    }

    error "Unsupported pm: ${tc.pm}"
}
```

生成 install 脚本：

```groovy
def generateNodeInstallScript(Map tc) {
    def command

    if (tc.pm == 'npm') {
        command = 'npm ci'
    } else if (tc.pm == 'pnpm') {
        command = 'pnpm install --frozen-lockfile'
    } else if (tc.pm == 'yarn') {
        if (tc.pmver.startsWith('1.')) {
            command = 'yarn install --frozen-lockfile'
        } else {
            command = 'yarn install --immutable'
        }
    } else {
        error "Unsupported pm: ${tc.pm}"
    }

    return """#!/usr/bin/env bash
set -euo pipefail

export HOME="\${HOME:-/tmp/ci-home}"
export NPM_GLOBAL_PREFIX="\$HOME/.npm-global"
export PATH="\$NPM_GLOBAL_PREFIX/bin:\$PATH"

${command}
"""
}
```

生成 build 脚本：

```groovy
def generateNodeBuildScript(Map tc) {
    def command = "${tc.pm} run build"

    return """#!/usr/bin/env bash
set -euo pipefail

export HOME="\${HOME:-/tmp/ci-home}"
export NPM_GLOBAL_PREFIX="\$HOME/.npm-global"
export PATH="\$NPM_GLOBAL_PREFIX/bin:\$PATH"

${command}
"""
}
```

### 14.3 javaToolchainBuild 方法

职责：

* 校验 Java toolchain。
* 读取平台 index。
* 匹配 JDK。
* 匹配 Maven 或 Gradle。
* 注入 env/path。
* 生成默认构建命令。
* 不允许任意 commands。

核心逻辑：

```groovy
def call(Map tc) {
    validateJavaToolchain(tc)

    def index = readJSON file: '/data/devops-ci/index.json'
    def envs = resolveJavaEnv(index, tc)

    def buildCommand = generateJavaBuildCommand(tc)

    withEnv(envs) {
        sh 'java -version'

        if (tc.buildTool == 'maven') {
            sh 'mvn -v'
        }

        if (tc.buildTool == 'gradle') {
            sh 'gradle -v'
        }

        sh buildCommand
    }
}
```

Java 校验：

```groovy
def validateJavaToolchain(Map tc) {
    if (tc.type != 'java') {
        error 'toolchain type must be java'
    }

    if (!tc.jdk) {
        error 'jdk is required'
    }

    if (!tc.buildTool) {
        error 'buildTool is required'
    }

    if (!['maven', 'gradle'].contains(tc.buildTool)) {
        error "Unsupported buildTool: ${tc.buildTool}"
    }

    if (tc.buildTool == 'maven' && !tc.maven) {
        error 'maven version is required when buildTool=maven'
    }

    if (tc.buildTool == 'gradle' && !tc.gradle) {
        error 'gradle version is required when buildTool=gradle'
    }

    if (tc.commands != null) {
        error 'commands is not allowed in java toolchain.json; build commands are generated by Jenkins Groovy 片段'
    }

    if (tc.args != null) {
        error 'args is not allowed in java toolchain.json in phase 1'
    }
}
```

解析 Java env：

```groovy
def resolveJavaEnv(Map index, Map tc) {
    def jdk = index.java.jdks[tc.jdk]
    if (!jdk) {
        error "No JDK configured: ${tc.jdk}"
    }

    def envs = [
        "JAVA_HOME=${jdk.JAVA_HOME}",
        "PATH+JAVA=${jdk.JAVA_HOME}/bin"
    ]

    if (tc.buildTool == 'maven') {
        def mvn = index.java.maven[tc.maven]
        if (!mvn) {
            error "No Maven configured: ${tc.maven}"
        }

        envs << "MAVEN_HOME=${mvn.MAVEN_HOME}"
        envs << "PATH+MAVEN=${mvn.MAVEN_HOME}/bin"
    }

    if (tc.buildTool == 'gradle') {
        def gradle = index.java.gradle[tc.gradle]
        if (!gradle) {
            error "No Gradle configured: ${tc.gradle}"
        }

        envs << "GRADLE_HOME=${gradle.GRADLE_HOME}"
        envs << "PATH+GRADLE=${gradle.GRADLE_HOME}/bin"
    }

    return envs
}
```

生成 Java 构建命令：

```groovy
def generateJavaBuildCommand(Map tc) {
    boolean skipTests = false
    if (tc.containsKey('skipTests')) {
        skipTests = tc.skipTests as boolean
    }

    if (tc.buildTool == 'maven') {
        if (skipTests) {
            return 'mvn clean package -DskipTests'
        }
        return 'mvn clean package'
    }

    if (tc.buildTool == 'gradle') {
        if (skipTests) {
            return 'gradle clean build -x test'
        }
        return 'gradle clean build'
    }

    error "Unsupported buildTool: ${tc.buildTool}"
}
```

## 15. CLI 子项目

### 15.1 目标

新增 Node.js CLI，用于辅助开发生成和校验 `.ci/toolchain.json`。

CLI 只负责生成工具链声明，不负责生成任意 commands。

### 15.2 建议包名

```text
@devops/devops-toolchain-cli
```

命令：

```bash
devops-cli init
devops-cli validate
devops-cli print
```

也可支持：

```bash
npx @devops/devops-toolchain-cli init
```

### 15.3 技术选型

建议：

* Node.js + TypeScript。
* commander 或 cac。
* prompts 或 inquirer。
* zod 或 ajv。
* fs-extra。
* prettier 可选。

### 15.4 init 行为

交互流程：

1. 选择 type：node/java。
2. 如果 node：

    * 选择 Node 大版本：12/14/16/18/20/22/24。
    * 选择 pm：npm/pnpm/yarn。
    * 选择 pmver：从 allowlist 选择，也允许手填。
    * 不询问 install/build 命令。
    * 不生成 commands 字段。
3. 如果 java：

    * 选择 JDK。
    * 选择 buildTool：maven/gradle。
    * 选择 maven 或 gradle 版本。
    * 选择 skipTests：true/false。
    * 不询问 build 命令。
    * 不生成 commands 字段。
4. 输出 `.ci/toolchain.json`。
5. 如果文件已存在，提示覆盖、备份或退出。

### 15.5 validate 行为

校验：

* JSON 格式。
* type 合法。
* Node 字段完整。
* Node 大版本合法。
* pm 合法。
* pmver 精确版本。
* pmver 是否在 allowlist。
* Java 字段完整。
* JDK/Maven/Gradle 是否在 allowlist。
* 不允许 commands/scripts/args 字段。
* package.json packageManager 与 toolchain.json 是否冲突。
* lockfile 与 pm 是否匹配。
* package.json 是否存在 scripts.build。

### 15.6 print 行为

打印解析后的配置摘要，例如：

```text
type: node
node: 20
pm: pnpm
pmver: 9.15.9
```

或：

```text
type: java
jdk: 21
buildTool: maven
maven: 3.9.6
skipTests: true
```

### 15.7 CLI 项目结构

```text
tools/devops-toolchain-cli/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── commands/
│   │   ├── init.ts
│   │   ├── validate.ts
│   │   └── print.ts
│   ├── schema/
│   │   └── toolchain-schema.ts
│   ├── utils/
│   │   ├── package-json.ts
│   │   ├── lockfile.ts
│   │   ├── allowlist.ts
│   │   └── write-json.ts
│   └── types.ts
└── README.md
```

## 16. 安全与凭据

规则：

* 不要把 npm token 写入项目仓库。
* 不要把 npm token 写入持久化 workspace 文件。
* 尽量在容器内 HOME 写临时 `.npmrc`。
* `.ci-runtime` 挂载只读。
* 更推荐通过 docker run `-e NPM_TOKEN=...` 注入 token。
* Harbor 登录凭据不写入脚本，外部提前 docker login 或由 Jenkins 凭据管理。
* Node 容器以 Jenkins 当前 UID/GID 运行，避免 workspace 权限污染。
* npm/pnpm/yarn cache 默认不挂载宿主机，避免权限和污染问题。
* Java/mise 工具链由 root 维护，普通 Jenkins 用户只读可执行。
* 普通 Jenkins 用户不允许写 `/data/mise`。
* 普通 Jenkins 用户不允许现场安装工具链。

## 17. 需要交付的文件清单

### 17.1 文档

```text
docs/toolchain-design.md
docs/node-docker-runner.md
docs/mise-java-toolchain.md
docs/toolchain-json-schema.md
```

### 17.2 Docker

```text
docker/node-runner/Dockerfile.tpl
docker/node-runner/ci-entrypoint.sh
```

### 17.3 scripts

```text
scripts/build-node-ci-image.sh
scripts/install-mise.sh
scripts/init-mise-layout.sh
scripts/install-java-tools.sh
scripts/install-maven-tools.sh
scripts/install-gradle-tools.sh
scripts/install-tooling-node.sh
scripts/validate-mise-tools.sh
scripts/generate-toolchain-index.sh
```

### 17.4 Jenkins Groovy 片段 示例

```text
jenkins/snippets/devops-ci-toolchain.groovy


```

### 17.5 CLI

```text
tools/devops-toolchain-cli/
```

## 18. 第一阶段验收标准

### 18.1 Node Docker Runner

* 能构建 Node 20 CI runner 镜像。
* 能推送 Harbor。
* 能使用 `.ci/toolchain.json` 中的 node=20 匹配 Node 20 镜像。
* 能在容器内安装 pnpm@9.15.9。
* 能配置 npm registry。
* 能执行 `pnpm install --frozen-lockfile`。
* 能执行 `pnpm run build`。
* 不挂载 npm/pnpm cache。
* 容器退出后 cache 丢弃。
* workspace 文件权限不被 root 污染。
* Node image 缺失时失败。
* pmver 不在白名单时失败。
* commands 字段存在时失败。

### 18.2 mise Java/Tooling Node

* 能安装 mise 到 `/usr/local/bin/mise`。
* 能初始化 `/data/mise`。
* 能创建 `/data/mise/mise-env.sh`。
* 能创建 `/usr/local/bin/devops-mise`。
* 能安装 JDK、Maven、Gradle。
* 能安装平台工具 Node。
* 能生成或维护 `/data/devops-ci/index.json`。
* 能通过 Jenkins withEnv 注入 Java/Maven/Gradle 环境。
* 能执行默认 Maven/Gradle 构建命令。
* commands 字段存在时失败。
* 缺少 JDK/Maven/Gradle 时失败。
* 平台 CLI 能使用 tooling node 运行。

### 18.3 CLI

* 能生成 Node 类型 `.ci/toolchain.json`，且不包含 commands。
* 能生成 Java 类型 `.ci/toolchain.json`，且不包含 commands。
* 能校验 pmver 精确版本。
* 能校验 lockfile。
* 能校验 package.json packageManager 冲突。
* 能校验 commands/scripts/args 禁止字段。
* 能从 allowlist 加载候选版本。
* 允许手动填写版本，但 CI 阶段仍以平台白名单为准。

## 19. 非目标

第一阶段不做：

* 不做 mixed 类型。
* 不做 Corepack。
* 不做 Node cache 持久化。
* 不做项目任意 commands。
* 不做自动修复 package.json。
* 不做自动修改 lockfile。
* 不做 npm install fallback。
* 不做动态自动安装缺失 Node image。
* 不做 Jenkins slave 上业务 Node mise 管理。
* 不做复杂 UI。
* 不做所有历史项目的一次性迁移。
* 不做 Maven/Gradle 任意参数自由透传。
* 不做 Node 项目任意脚本自由透传。

## 20. 最终结论

最终模式：

```text
业务 Node:
  .ci/toolchain.json 声明 node 大版本 + pm + pmver。
  Jenkins 根据 node 大版本选择 Docker image。
  容器内临时安装 pm。
  Groovy 方法生成 init/install/build 脚本。
  不允许项目配置任意 commands。
  cache 丢弃。
  workspace 由 Jenkins job 清理。

平台工具 Node:
  使用 mise 管理。
  用于 devops-toolchain-cli 和平台辅助脚本。
  不参与业务项目构建。

Java:
  .ci/toolchain.json 声明 jdk + buildTool + maven/gradle + skipTests。
  Jenkins 根据 mise 工具链 index 注入环境。
  Groovy 方法生成默认 build 命令。
  不允许项目配置任意 commands。

mise:
  显式 MISE_*_DIR。
  单一 MISE_DATA_DIR=/data/mise/data。
  /data/mise/mise-env.sh 作为统一入口。
  /usr/local/bin/devops-mise 作为平台维护便捷入口。

失败策略:
  缺工具链直接失败。
  不随机。
  不自动猜。
  不现场补装。
```
