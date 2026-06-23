import { promises as fs } from 'fs';
import path from 'path';
import type { Diagnostic, PackageManager } from '../types';

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
