import { promises as fs } from 'fs';
import path from 'path';
import { valid as validSemver } from 'semver';
import type { PackageManager } from '../types';

export interface PackageJson {
  packageManager?: string;
  engines?: {
    node?: string;
  };
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface PackageManagerSpec {
  pm: PackageManager;
  pmver: string;
}

export async function readPackageJson(projectDir: string): Promise<PackageJson | null> {
  try {
    const content = await fs.readFile(path.join(projectDir, 'package.json'), 'utf8');
    return JSON.parse(content) as PackageJson;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function parsePackageManagerSpec(value: string | undefined): PackageManagerSpec | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/^(npm|pnpm|yarn)@(.+)$/);
  if (!match) {
    return undefined;
  }

  const rawVersion = match[2];
  return {
    pm: match[1] as PackageManager,
    pmver: validSemver(rawVersion) ?? rawVersion
  };
}
