import { promises as fs } from 'fs';
import path from 'path';
import type { Diagnostic, PackageManager } from '../types';

export interface LockfileInference {
  pm: PackageManager;
  version?: string;
  versionMajor?: string;
  source: string;
  detail: string;
}

export interface LockfileState {
  packageLock: boolean;
  npmShrinkwrap: boolean;
  pnpmLock: boolean;
  yarnLock: boolean;
  present: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function detectLockfiles(projectDir: string): Promise<LockfileState> {
  const packageLock = await exists(path.join(projectDir, 'package-lock.json'));
  const npmShrinkwrap = await exists(path.join(projectDir, 'npm-shrinkwrap.json'));
  const pnpmLock = await exists(path.join(projectDir, 'pnpm-lock.yaml'));
  const yarnLock = await exists(path.join(projectDir, 'yarn.lock'));

  return {
    packageLock,
    npmShrinkwrap,
    pnpmLock,
    yarnLock,
    present: [
      packageLock ? 'package-lock.json' : '',
      npmShrinkwrap ? 'npm-shrinkwrap.json' : '',
      pnpmLock ? 'pnpm-lock.yaml' : '',
      yarnLock ? 'yarn.lock' : ''
    ].filter(Boolean)
  };
}

export function validateLockfiles(pm: PackageManager, state: LockfileState): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (pm === 'npm') {
    if (!state.packageLock && !state.npmShrinkwrap) {
      diagnostics.push({ level: 'error', message: 'npm project requires package-lock.json or npm-shrinkwrap.json' });
    }
    if (state.pnpmLock || state.yarnLock) {
      diagnostics.push({ level: 'error', message: 'npm project should not contain pnpm-lock.yaml or yarn.lock' });
    }
  }

  if (pm === 'pnpm') {
    if (!state.pnpmLock) {
      diagnostics.push({ level: 'error', message: 'pnpm project requires pnpm-lock.yaml' });
    }
    if (state.packageLock || state.npmShrinkwrap || state.yarnLock) {
      diagnostics.push({ level: 'error', message: 'pnpm project should not contain npm lockfiles or yarn.lock' });
    }
  }

  if (pm === 'yarn') {
    if (!state.yarnLock) {
      diagnostics.push({ level: 'error', message: 'yarn project requires yarn.lock' });
    }
    if (state.packageLock || state.npmShrinkwrap || state.pnpmLock) {
      diagnostics.push({ level: 'error', message: 'yarn project should not contain npm lockfiles or pnpm-lock.yaml' });
    }
  }

  if (state.present.length > 1) {
    diagnostics.push({ level: 'error', message: `multiple lockfiles found: ${state.present.join(', ')}` });
  }

  return diagnostics;
}

export async function inferPackageManagersFromLockfiles(projectDir: string): Promise<LockfileInference[]> {
  const results: LockfileInference[] = [];

  results.push(...await inferNpmLock(path.join(projectDir, 'package-lock.json'), 'package-lock.json'));
  results.push(...await inferNpmLock(path.join(projectDir, 'npm-shrinkwrap.json'), 'npm-shrinkwrap.json'));
  results.push(...await inferPnpmLock(path.join(projectDir, 'pnpm-lock.yaml')));
  results.push(...await inferYarnLock(path.join(projectDir, 'yarn.lock')));

  return results;
}

async function inferNpmLock(file: string, source: string): Promise<LockfileInference[]> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const lockfileVersion = raw.lockfileVersion;
  const inference = npmInferenceFromLockfileVersion(lockfileVersion);
  if (!inference) {
    return [{
      pm: 'npm',
      source,
      detail: `detected ${source}`
    }];
  }

  return [{
    pm: 'npm',
    versionMajor: inference.major,
    source,
    detail: `${source} lockfileVersion ${String(lockfileVersion)} suggests ${inference.description}`
  }];
}

function npmInferenceFromLockfileVersion(value: unknown): { major?: string; description: string } | undefined {
  // These are init-time hints. Validation still relies on the selected pm and
  // lockfile type rather than treating lockfileVersion as a complete version map.
  if (value === 1) {
    return { major: '6', description: 'npm 5.x/6.x; prefer npm 6.x for modern CI' };
  }
  if (value === 2) {
    return { description: 'npm 7.x/8.x' };
  }
  if (value === 3) {
    return { description: 'npm 9.x or newer' };
  }
  return undefined;
}

async function inferPnpmLock(file: string): Promise<LockfileInference[]> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const match = content.match(/^lockfileVersion:\s*['"]?([0-9]+(?:\.[0-9]+)?)['"]?/m);
  const inference = match ? pnpmInferenceFromLockfileVersion(match[1]) : undefined;
  if (!inference) {
    return [{
      pm: 'pnpm',
      source: 'pnpm-lock.yaml',
      detail: 'detected pnpm-lock.yaml'
    }];
  }

  return [{
    pm: 'pnpm',
    versionMajor: inference.major,
    source: 'pnpm-lock.yaml',
    detail: `pnpm-lock.yaml lockfileVersion ${match![1]} suggests ${inference.description}`
  }];
}

function pnpmInferenceFromLockfileVersion(value: string): { major?: string; description: string } | undefined {
  // pnpm lockfiles can be consumed across adjacent releases, so only stable
  // historic shapes become exact major hints.
  if (value.startsWith('5.4')) {
    return { major: '7', description: 'pnpm 7.x' };
  }
  if (value.startsWith('6')) {
    return { major: '8', description: 'pnpm 8.x' };
  }
  if (value.startsWith('9')) {
    return { description: 'pnpm 9.x or newer' };
  }
  return undefined;
}

async function inferYarnLock(file: string): Promise<LockfileInference[]> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  if (/^__metadata:/m.test(content)) {
    return [{
      pm: 'yarn',
      source: 'yarn.lock',
      detail: 'yarn.lock metadata suggests Yarn Berry (2+)'
    }];
  }

  return [{
    pm: 'yarn',
    versionMajor: '1',
    source: 'yarn.lock',
    detail: 'yarn.lock suggests Yarn 1.x'
  }];
}
