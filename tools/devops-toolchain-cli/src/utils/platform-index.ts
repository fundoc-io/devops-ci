import { promises as fs } from 'fs';
import path from 'path';
import type { PlatformIndex } from '../types';

const emptyPlatformIndex: PlatformIndex = {
  nodeImages: {},
  java: {
    jdks: {},
    maven: {},
    gradle: {}
  }
};

export interface LoadedPlatformIndex {
  index?: PlatformIndex;
  source?: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function normalizePlatformIndex(value: Partial<PlatformIndex>): PlatformIndex {
  return {
    nodeImages: value.nodeImages ?? emptyPlatformIndex.nodeImages,
    java: {
      jdks: value.java?.jdks ?? emptyPlatformIndex.java.jdks,
      maven: value.java?.maven ?? emptyPlatformIndex.java.maven,
      gradle: value.java?.gradle ?? emptyPlatformIndex.java.gradle
    }
  };
}

export async function loadPlatformIndex(indexPath?: string): Promise<LoadedPlatformIndex> {
  const explicitPath = indexPath || process.env.DEVOPS_CI_INDEX || await readConfiguredIndex();
  if (explicitPath) {
    const content = await fs.readFile(explicitPath, 'utf8');
    return {
      index: normalizePlatformIndex(JSON.parse(content) as Partial<PlatformIndex>),
      source: explicitPath
    };
  }

  return {};
}

async function readConfiguredIndex(): Promise<string | undefined> {
  const candidates = [
    process.env.DEVOPS_TOOLCHAIN_CONFIG,
    path.resolve(__dirname, '..', 'config', 'devops-toolchain.json'),
    path.resolve(__dirname, '..', '..', 'config', 'devops-toolchain.json')
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (!(await exists(candidate))) {
      continue;
    }

    const config = JSON.parse(await fs.readFile(candidate, 'utf8')) as { index?: unknown };
    if (typeof config.index === 'string' && config.index.length > 0) {
      return config.index;
    }
  }

  return undefined;
}
