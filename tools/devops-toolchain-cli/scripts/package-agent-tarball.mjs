import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as tar from 'tar';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const artifactName = `devops-ci-agent-linux-x64-${version}`;
const bundledEntry = path.join(packageRoot, 'dist', 'agent', 'index.js');
const stagingRoot = path.join(packageRoot, 'dist', 'agent-package');
const artifactRoot = path.join(stagingRoot, artifactName);
const artifactDir = path.join(packageRoot, 'dist', 'artifacts');
const artifactFile = path.join(artifactDir, `${artifactName}.tar.gz`);

await fs.rm(stagingRoot, { recursive: true, force: true });
await fs.mkdir(path.join(artifactRoot, 'cli'), { recursive: true });
await fs.mkdir(artifactDir, { recursive: true });

await fs.copyFile(bundledEntry, path.join(artifactRoot, 'cli', 'devops-toolchain.cjs'));
await fs.writeFile(path.join(artifactRoot, 'VERSION'), `${version}\n`, 'utf8');
await fs.writeFile(path.join(artifactRoot, 'MANIFEST.json'), `${JSON.stringify({
  name: 'devops-ci-agent',
  version,
  entry: 'cli/devops-toolchain.cjs',
  generatedAt: new Date().toISOString()
}, null, 2)}\n`, 'utf8');
await fs.chmod(path.join(artifactRoot, 'cli', 'devops-toolchain.cjs'), 0o755);

await tar.c(
  {
    gzip: true,
    file: artifactFile,
    cwd: stagingRoot,
    portable: true
  },
  [artifactName]
);

console.log(`Wrote ${artifactFile}`);
