import { promises as fs } from 'fs';
import path from 'path';
import { coerce, minVersion } from 'semver';
import { supportedNodeMajors, validateToolchainShape } from '../schema/toolchain-schema';
import type { Diagnostic, PackageManager, PlatformIndex, Toolchain } from '../types';
import { loadPlatformIndex } from '../utils/platform-index';
import { parsePackageManagerSpec, readPackageJson } from '../utils/package-json';
import { validateProjectFiles } from './validate';

export interface ResolveCommandOptions {
  file?: string;
  projectDir?: string;
  index?: string;
}

interface ToolchainSource {
  toolchain: unknown;
  source: string;
}

export async function resolveCommand(options: ResolveCommandOptions = {}): Promise<number> {
  const file = path.resolve(options.file ?? '.ci/toolchain.json');
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  let loaded: Awaited<ReturnType<typeof loadPlatformIndex>>;

  try {
    loaded = await loadPlatformIndex(options.index);
  } catch (error) {
    writeResolveError([`failed to load platform index: ${(error as Error).message}`]);
    return 1;
  }

  if (!loaded.index) {
    writeResolveError(['platform index is required for resolve; pass --index or set DEVOPS_CI_INDEX']);
    return 1;
  }

  let source: ToolchainSource;
  try {
    source = await readToolchainOrInfer(file, projectDir);
  } catch (error) {
    writeResolveError([(error as Error).message], loaded.source);
    return 1;
  }

  const shape = validateToolchainShape(source.toolchain, loaded.index);
  const diagnostics: Diagnostic[] = [...shape.diagnostics];

  if (shape.toolchain?.type === 'node') {
    diagnostics.push(...await validateProjectFiles(shape.toolchain, projectDir));
  }

  const errors = diagnostics.filter((item) => item.level === 'error');
  if (!shape.toolchain || errors.length > 0) {
    writeResolveError(errors.map((item) => item.message), loaded.source, diagnostics);
    return 1;
  }

  writeResolveOk(shape.toolchain, source.source, loaded.source!, loaded.index);
  return 0;
}

async function readToolchainOrInfer(file: string, projectDir: string): Promise<ToolchainSource> {
  try {
    return {
      toolchain: JSON.parse(await fs.readFile(file, 'utf8')) as unknown,
      source: file
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`failed to read or parse ${file}: ${(error as Error).message}`);
    }
  }

  const inferred = await inferNodeToolchainFromPackageJson(projectDir);
  return {
    toolchain: inferred,
    source: path.join(projectDir, 'package.json')
  };
}

async function inferNodeToolchainFromPackageJson(projectDir: string): Promise<Toolchain> {
  const pkg = await readPackageJson(projectDir);
  if (!pkg) {
    throw new Error(`toolchain file not found and package.json not found: ${projectDir}`);
  }

  const node = nodeMajorFromPackageJson(pkg);
  if (!node) {
    throw new Error('toolchain file not found and package.json does not declare engines.node or volta.node');
  }

  const pm = parsePackageManagerSpec(pkg.packageManager);
  if (!pm) {
    throw new Error('toolchain file not found and package.json does not declare packageManager');
  }

  return {
    type: 'node',
    node,
    pm: pm.pm,
    pmver: pm.pmver
  };
}

function nodeMajorFromPackageJson(pkg: Record<string, unknown>): string | undefined {
  const engines = pkg.engines as Record<string, unknown> | undefined;
  const volta = pkg.volta as Record<string, unknown> | undefined;
  const candidates = [
    typeof engines?.node === 'string' ? engines.node : undefined,
    typeof volta?.node === 'string' ? volta.node : undefined
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const normalizedRange = candidate.replace(/\bxx\b/gi, 'x');
    const parsedVersion = minVersion(normalizedRange) ?? coerce(normalizedRange);
    if (parsedVersion) {
      const major = String(parsedVersion.major);
      if (supportedNodeMajors.includes(major)) {
        return major;
      }
    }
  }

  return undefined;
}

function writeResolveOk(toolchain: Toolchain, toolchainSource: string, indexSource: string, platformIndex: PlatformIndex): void {
  if (toolchain.type === 'node') {
    console.log(JSON.stringify({
      schemaVersion: 'devops-ci.resolve/v1',
      status: 'ok',
      type: 'node',
      mode: 'docker',
      source: {
        toolchain: toolchainSource,
        index: indexSource
      },
      toolchain,
      runtime: {
        image: platformIndex.nodeImages[toolchain.node],
        packageManager: {
          name: toolchain.pm,
          version: toolchain.pmver,
          installPolicy: 'runtime',
          prefix: '/tmp/devops-ci-pm'
        }
      },
      execution: {
        workdir: '/workspace',
        scriptMount: {
          host: '.ci-runtime',
          container: '/ci-scripts',
          readonly: true
        },
        initScriptMode: 'source',
        entrypointScripts: [
          '/ci-scripts/init.sh',
          '/ci-scripts/install.sh',
          '/ci-scripts/build.sh'
        ],
      },
      display: {
        install: displayNodeInstallCommand(toolchain.pm, toolchain.pmver),
        build: `${toolchain.pm} run build`
      }
    }, null, 2));
    return;
  }

  const jdk = platformIndex.java.jdks[toolchain.jdk];
  const env: Record<string, string> = {
    JAVA_HOME: jdk.JAVA_HOME!
  };
  const pathPrepend = [`${jdk.JAVA_HOME}/bin`];
  const probes = ['java -version'];
  let build: string;

  if (toolchain.buildTool === 'maven') {
    const maven = platformIndex.java.maven[toolchain.maven!];
    env.MAVEN_HOME = maven.MAVEN_HOME!;
    pathPrepend.push(`${maven.MAVEN_HOME}/bin`);
    probes.push('mvn -v');
    build = toolchain.skipTests ? 'mvn clean package -DskipTests' : 'mvn clean package';
  } else {
    const gradle = platformIndex.java.gradle[toolchain.gradle!];
    env.GRADLE_HOME = gradle.GRADLE_HOME!;
    pathPrepend.push(`${gradle.GRADLE_HOME}/bin`);
    probes.push('gradle -v');
    build = toolchain.skipTests ? 'gradle clean build -x test' : 'gradle clean build';
  }

  console.log(JSON.stringify({
    schemaVersion: 'devops-ci.resolve/v1',
    status: 'ok',
    type: 'java',
    mode: 'process-env',
    source: {
      toolchain: toolchainSource,
      index: indexSource
    },
    toolchain,
    runtime: {
      env,
      pathPrepend
    },
    display: {
      probes,
      build
    }
  }, null, 2));
}

function displayNodeInstallCommand(pm: PackageManager, pmver: string): string {
  if (pm === 'npm') {
    return 'npm ci';
  }
  if (pm === 'pnpm') {
    return 'pnpm install --frozen-lockfile';
  }
  return pmver.startsWith('1.') ? 'yarn install --frozen-lockfile' : 'yarn install --immutable';
}

function writeResolveError(messages: string[], indexSource?: string, diagnostics?: Diagnostic[]): void {
  console.log(JSON.stringify({
    schemaVersion: 'devops-ci.resolve/v1',
    status: 'error',
    source: {
      index: indexSource
    },
    errors: messages,
    diagnostics
  }, null, 2));
}
