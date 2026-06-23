import { promises as fs } from 'fs';
import path from 'path';
import { validateToolchainShape } from '../schema/toolchain-schema';
import { loadPlatformIndex } from '../utils/platform-index';

export interface PrintCommandOptions {
  file?: string;
  index?: string;
  json?: boolean;
}

export async function printCommand(options: PrintCommandOptions = {}): Promise<number> {
  const file = path.resolve(options.file ?? '.ci/toolchain.json');
  const loaded = await loadPlatformIndex(options.index);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  const result = validateToolchainShape(raw, loaded.index);

  if (!result.toolchain) {
    for (const diagnostic of result.diagnostics) {
      console.error(`${diagnostic.level.toUpperCase()}: ${diagnostic.message}`);
    }
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify(result.toolchain, null, 2));
    return 0;
  }

  if (result.toolchain.type === 'node') {
    const tc = result.toolchain;
    console.log(`type: node`);
    console.log(`node image: ${loaded.index?.nodeImages[tc.node] ?? '<requires --index or DEVOPS_CI_INDEX>'}`);
    console.log(`package manager: ${tc.pm}@${tc.pmver}`);
    console.log(`install: ${tc.pm === 'npm' ? 'npm ci' : tc.pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : tc.pmver.startsWith('1.') ? 'yarn install --frozen-lockfile' : 'yarn install --immutable'}`);
    console.log(`build: ${tc.pm} run build`);
    return 0;
  }

  const tc = result.toolchain;
  console.log(`type: java`);
  console.log(`jdk: ${tc.jdk}`);
  console.log(`build tool: ${tc.buildTool}`);
  if (tc.buildTool === 'maven') {
    console.log(`maven: ${tc.maven}`);
    console.log(`build: ${tc.skipTests ? 'mvn clean package -DskipTests' : 'mvn clean package'}`);
  } else {
    console.log(`gradle: ${tc.gradle}`);
    console.log(`build: ${tc.skipTests ? 'gradle clean build -x test' : 'gradle clean build'}`);
  }
  return 0;
}
