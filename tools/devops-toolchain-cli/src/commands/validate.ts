import { promises as fs } from 'fs';
import path from 'path';
import { validateToolchainShape } from '../schema/toolchain-schema';
import type { Diagnostic, Toolchain } from '../types';
import { loadPlatformIndex } from '../utils/platform-index';
import { detectLockfiles, validateLockfiles } from '../utils/lockfile';
import { parsePackageManagerSpec, readPackageJson } from '../utils/package-json';

export interface ValidateCommandOptions {
  file?: string;
  projectDir?: string;
  index?: string;
}

export async function validateCommand(options: ValidateCommandOptions = {}): Promise<number> {
  const file = path.resolve(options.file ?? '.ci/toolchain.json');
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const index = options.index;
  const diagnostics: Diagnostic[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    console.error(`ERROR: failed to read or parse ${file}: ${(error as Error).message}`);
    return 1;
  }

  const loaded = await loadPlatformIndex(index);
  const shape = validateToolchainShape(raw, loaded.index);
  diagnostics.push(...shape.diagnostics);

  if (shape.toolchain) {
    diagnostics.push(...await validateProjectFiles(shape.toolchain, projectDir));
  }

  for (const diagnostic of diagnostics) {
    const prefix = diagnostic.level === 'error' ? 'ERROR' : 'WARNING';
    console.log(`${prefix}: ${diagnostic.message}`);
  }

  const errorCount = diagnostics.filter((item) => item.level === 'error').length;
  if (errorCount > 0) {
    console.log(`Invalid: ${file}`);
    return 1;
  }

  console.log(`Valid: ${file}`);
  console.log(`Platform index: ${loaded.source ?? 'not configured; platform availability was not checked'}`);
  return 0;
}

export async function validateProjectFiles(toolchain: Toolchain, projectDir: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  if (toolchain.type !== 'node') {
    return diagnostics;
  }

  const pkg = await readPackageJson(projectDir);
  if (!pkg) {
    diagnostics.push({ level: 'error', message: 'package.json not found' });
    return diagnostics;
  }

  if (pkg.packageManager) {
    const expected = `${toolchain.pm}@${toolchain.pmver}`;
    const actual = parsePackageManagerSpec(pkg.packageManager);
    if (!actual || actual.pm !== toolchain.pm || actual.pmver !== toolchain.pmver) {
      diagnostics.push({
        level: 'error',
        message: `package.json packageManager mismatch. expected ${expected}, got ${pkg.packageManager}`
      });
    }
  } else {
    diagnostics.push({
      level: 'warning',
      message: `package.json packageManager is missing; using .ci/toolchain.json ${toolchain.pm}@${toolchain.pmver}`
    });
  }

  if (!pkg.scripts || !pkg.scripts.build) {
    diagnostics.push({
      level: 'error',
      message: 'package.json scripts.build is required because default build command is <pm> run build'
    });
  }

  const lockfiles = await detectLockfiles(projectDir);
  diagnostics.push(...validateLockfiles(toolchain.pm, lockfiles));

  return diagnostics;
}
