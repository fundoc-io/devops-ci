#!/usr/bin/env node
import { cac } from 'cac';
import { run } from './cli/run';
import { printCommand } from './commands/print';
import { resolveCommand } from './commands/resolve';
import { validateCommand } from './commands/validate';

const cli = cac('devops-cli');

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
