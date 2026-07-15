#!/usr/bin/env node
import { cac } from 'cac';
import { run } from './cli/run';
import { initCommand } from './commands/init';
import { printCommand } from './commands/print';
import { resolveCommand } from './commands/resolve';
import { validateCommand } from './commands/validate';

const cli = cac('devops-toolchain');

cli
  .command('init', 'Generate .ci/toolchain.json without commands/scripts/args')
  .option('--file <file>', 'Toolchain file path', { default: '.ci/toolchain.json' })
  .option('--project-dir <dir>', 'Project directory used for package.json discovery')
  .option('--index <file>', 'Platform index path')
  .option('--type <type>', 'Toolchain type: node or java')
  .option('--node <major>', 'Node major version')
  .option('--pm <manager>', 'Package manager: npm, pnpm, or yarn')
  .option('--pmver <version>', 'Exact package manager version')
  .option('--jdk <version>', 'JDK version key such as 8, 11, 17, or 21')
  .option('--build-tool <tool>', 'Java build tool: maven or gradle')
  .option('--maven <version>', 'Maven version')
  .option('--gradle <version>', 'Gradle version')
  .option('--skip-tests <boolean>', 'Skip Java tests')
  .option('--lang <locale>', 'Interactive language: en or zh-CN')
  .option('--no-registry-lookup', 'Do not query npm registry when expanding inferred package manager major versions')
  .option('--yes', 'Accept defaults and overwrite without confirmation')
  .option('--backup', 'Backup existing toolchain file before writing')
  .action(run(initCommand));

cli
  .command('validate', 'Validate toolchain declaration, platform index, package.json, and lockfiles')
  .option('--file <file>', 'Toolchain file path', { default: '.ci/toolchain.json' })
  .option('--project-dir <dir>', 'Project directory used for package.json and lockfile checks')
  .option('--index <file>', 'Platform index path')
  .action(run(validateCommand));

cli
  .command('print', 'Print the resolved build plan')
  .option('--file <file>', 'Toolchain file path', { default: '.ci/toolchain.json' })
  .option('--index <file>', 'Platform index path')
  .option('--json', 'Print normalized JSON')
  .action(run(printCommand));

cli
  .command('resolve', 'Resolve a stable CI execution plan as JSON')
  .option('--file <file>', 'Toolchain file path', { default: '.ci/toolchain.json' })
  .option('--project-dir <dir>', 'Project directory used for package.json and lockfile checks')
  .option('--index <file>', 'Platform index path')
  .action(run(resolveCommand));

cli.help();
cli.version('0.1.0');
cli.parse();

if (process.argv.slice(2).length === 0) {
  cli.outputHelp();
}
