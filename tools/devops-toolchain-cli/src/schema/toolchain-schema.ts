import { valid as validSemver } from 'semver';
import type { Diagnostic, JavaToolchain, NodeToolchain, PackageManager, PlatformIndex, Toolchain } from '../types';

export const supportedNodeMajors = ['12', '14', '16', '18', '20', '22', '24'];
export const supportedPackageManagers: PackageManager[] = ['npm', 'pnpm', 'yarn'];
const forbiddenFields = ['commands', 'scripts', 'args'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string, diagnostics: Diagnostic[]): string | undefined {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    diagnostics.push({ level: 'error', message: `${key} is required` });
    return undefined;
  }
  return value;
}

export function validateToolchainShape(value: unknown, platformIndex?: PlatformIndex): { toolchain?: Toolchain; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];

  if (!isRecord(value)) {
    return {
      diagnostics: [{ level: 'error', message: 'toolchain file must be a JSON object' }]
    };
  }

  for (const field of forbiddenFields) {
    if (value[field] != null) {
      diagnostics.push({ level: 'error', message: `${field} is not allowed in .ci/toolchain.json` });
    }
  }

  const type = requireString(value, 'type', diagnostics);
  if (!type) {
    return { diagnostics };
  }

  if (type === 'node') {
    const node = requireString(value, 'node', diagnostics);
    const pm = requireString(value, 'pm', diagnostics);
    const pmver = requireString(value, 'pmver', diagnostics);

    if (node && !supportedNodeMajors.includes(node)) {
      diagnostics.push({ level: 'error', message: `node must be one of ${supportedNodeMajors.join(', ')}` });
    }

    if (pm && !supportedPackageManagers.includes(pm as PackageManager)) {
      diagnostics.push({ level: 'error', message: `pm must be one of ${supportedPackageManagers.join(', ')}` });
    }

    if (pmver && !isExactSemverVersion(pmver)) {
      diagnostics.push({ level: 'error', message: `pmver must be an exact version, got: ${pmver}` });
    }

    if (platformIndex && node && !platformIndex.nodeImages[node]) {
      diagnostics.push({ level: 'error', message: `No Docker image configured for Node ${node}` });
    }

    if (diagnostics.some((item) => item.level === 'error')) {
      return { diagnostics };
    }

    return {
      toolchain: { type: 'node', node: node!, pm: pm as PackageManager, pmver: pmver! } satisfies NodeToolchain,
      diagnostics
    };
  }

  if (type === 'java') {
    const jdk = requireString(value, 'jdk', diagnostics);
    const buildTool = requireString(value, 'buildTool', diagnostics);
    const skipTests = value.skipTests;

    if (buildTool && !['maven', 'gradle'].includes(buildTool)) {
      diagnostics.push({ level: 'error', message: 'buildTool must be maven or gradle' });
    }

    const maven = buildTool === 'maven' ? requireString(value, 'maven', diagnostics) : undefined;
    const gradle = buildTool === 'gradle' ? requireString(value, 'gradle', diagnostics) : undefined;

    if (skipTests != null && typeof skipTests !== 'boolean') {
      diagnostics.push({ level: 'error', message: 'skipTests must be boolean when present' });
    }

    if (platformIndex && jdk && !platformIndex.java.jdks[jdk]) {
      diagnostics.push({ level: 'error', message: `No JDK configured: ${jdk}` });
    }

    if (platformIndex && buildTool === 'maven' && maven && !platformIndex.java.maven[maven]) {
      diagnostics.push({ level: 'error', message: `No Maven configured: ${maven}` });
    }

    if (platformIndex && buildTool === 'gradle' && gradle && !platformIndex.java.gradle[gradle]) {
      diagnostics.push({ level: 'error', message: `No Gradle configured: ${gradle}` });
    }

    if (platformIndex && jdk && buildTool === 'maven' && maven && platformIndex.java.maven[maven]) {
      const minJava = platformIndex.java.maven[maven].minJava;
      if (minJava && !javaMajorSatisfies(jdk, minJava)) {
        diagnostics.push({ level: 'error', message: `Maven ${maven} requires Java ${minJava}+; selected JDK is ${jdk}` });
      }
    }

    if (platformIndex && jdk && buildTool === 'gradle' && gradle && platformIndex.java.gradle[gradle]) {
      const minJava = platformIndex.java.gradle[gradle].minJava;
      if (minJava && !javaMajorSatisfies(jdk, minJava)) {
        diagnostics.push({ level: 'error', message: `Gradle ${gradle} requires Java ${minJava}+; selected JDK is ${jdk}` });
      }
    }

    if (diagnostics.some((item) => item.level === 'error')) {
      return { diagnostics };
    }

    const toolchain: JavaToolchain = {
      type: 'java',
      jdk: jdk!,
      buildTool: buildTool as 'maven' | 'gradle',
      skipTests: typeof skipTests === 'boolean' ? skipTests : false
    };
    if (maven) {
      toolchain.maven = maven;
    }
    if (gradle) {
      toolchain.gradle = gradle;
    }

    return { toolchain, diagnostics };
  }

  diagnostics.push({ level: 'error', message: `Unsupported toolchain type: ${type}` });
  return { diagnostics };
}

function isExactSemverVersion(value: string): boolean {
  return validSemver(value) === value;
}

function javaMajorSatisfies(jdk: string, minJava: string): boolean {
  const selected = firstNumber(jdk);
  const minimum = firstNumber(minJava);
  if (selected == null || minimum == null) {
    return true;
  }
  return selected >= minimum;
}

function firstNumber(value: string): number | undefined {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : undefined;
}
