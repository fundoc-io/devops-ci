import { promises as fs } from 'fs';
import path from 'path';
import pc from 'picocolors';
import prompts from 'prompts';
import { coerce, minVersion } from 'semver';
import { supportedNodeMajors, validateToolchainShape } from '../schema/toolchain-schema';
import type {
  JavaBuildTool,
  JavaToolchain,
  NodeToolchain,
  PackageManager,
  PlatformIndex,
  Toolchain,
  ToolchainType
} from '../types';
import { loadPlatformIndex } from '../utils/platform-index';
import { parsePackageManagerSpec, readPackageJson } from '../utils/package-json';
import { writeJsonFile } from '../utils/write-json';

type WizardKey = 'type' | 'node' | 'pm' | 'pmver' | 'jdk' | 'buildTool' | 'maven' | 'gradle' | 'skipTests';

const commonJdkChoices = ['8', '11', '17', '21'];
const commonMavenChoices = ['3', '4'];

interface InitState {
  type?: ToolchainType;
  node?: string;
  pm?: PackageManager;
  pmver?: string;
  jdk?: string;
  buildTool?: JavaBuildTool;
  maven?: string;
  gradle?: string;
  skipTests?: boolean;
}

interface InitDefaults {
  state: InitState;
  source: string;
}

interface WizardStep {
  key: WizardKey;
  label: string;
  choices: string[];
  defaultValue?: string;
  manual?: boolean;
}

export interface InitCommandOptions {
  file?: string;
  projectDir?: string;
  index?: string;
  type?: string;
  node?: string | number;
  pm?: string;
  pmver?: string | number;
  jdk?: string;
  buildTool?: string;
  maven?: string | number;
  gradle?: string | number;
  skipTests?: string | boolean;
  yes?: boolean;
  backup?: boolean;
}

export async function initCommand(options: InitCommandOptions = {}): Promise<number> {
  const loaded = await loadPlatformIndex(options.index);
  const file = path.resolve(options.file ?? '.ci/toolchain.json');
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const yes = options.yes === true;
  const backup = options.backup === true;
  const defaults = await resolveInitDefaults(file, projectDir, loaded.index);

  try {
    const toolchain = await collectToolchain(options, loaded.index, defaults, yes);
    if (!toolchain) {
      console.log('No changes written.');
      return 0;
    }

    const shape = validateToolchainShape(toolchain);
    const errors = shape.diagnostics.filter((item) => item.level === 'error');
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`ERROR: ${error.message}`);
      }
      return 1;
    }

    if (loaded.index) {
      const indexCheck = validateToolchainShape(toolchain, loaded.index);
      for (const diagnostic of indexCheck.diagnostics.filter((item) => item.level === 'error')) {
        console.warn(`WARNING: ${diagnostic.message}. CI will fail until platform index is updated.`);
      }
    }

    const writeDecision = await decideExistingFile(file, yes, backup);
    if (writeDecision === 'exit') {
      console.log('No changes written.');
      return 0;
    }

    if (writeDecision === 'backup') {
      const backupFile = `${file}.${timestamp()}.bak`;
      await fs.copyFile(file, backupFile);
      console.log(`Backed up existing file to ${backupFile}`);
    }

    await writeJsonFile(file, toolchain);
    console.log(`Wrote ${file}`);
    console.log(`Defaults: ${defaults.source}`);
    console.log(`Platform index: ${loaded.source ?? 'not configured; platform availability was not checked'}`);
    return 0;
  } catch (error) {
    if (error instanceof PromptCancelled) {
      console.log('No changes written.');
      return 0;
    }
    throw error;
  }
}

async function collectToolchain(
  options: InitCommandOptions,
  platformIndex: PlatformIndex | undefined,
  defaults: InitDefaults,
  yes: boolean
): Promise<Toolchain | null> {
  const state = applyOptionDefaults({ ...defaults.state }, options);
  let stepIndex = 0;

  while (true) {
    const steps = buildSteps(state, platformIndex);

    if (stepIndex >= steps.length) {
      const toolchain = stateToToolchain(state);
      const decision = await confirmToolchain(toolchain, yes);
      if (decision === 'write') {
        return toolchain;
      }
      if (decision === 'exit') {
        return null;
      }
      stepIndex = Math.max(steps.length - 1, 0);
      continue;
    }

    const step = steps[stepIndex];
    if (isProvidedByOption(step.key, options)) {
      stepIndex += 1;
      continue;
    }

    if (!process.stdin.isTTY) {
      ensureStepHasValue(step, state);
      stepIndex += 1;
      continue;
    }

    const result = await promptStep(step, stepIndex > 0);
    if (result === 'back') {
      stepIndex = Math.max(stepIndex - 1, 0);
      continue;
    }

    applyStepValue(state, step.key, result);
    stepIndex += 1;
  }
}

function buildSteps(state: InitState, platformIndex: PlatformIndex | undefined): WizardStep[] {
  const typeChoices = ['node', 'java'];
  const steps: WizardStep[] = [
    {
      key: 'type',
      label: 'Project type',
      choices: typeChoices,
      defaultValue: state.type
    }
  ];

  if (state.type === 'node') {
    const nodeChoices = supportedNodeMajors;
    const pm = state.pm ?? 'pnpm';
    const pmVersions = withDefaultChoice([], state.pmver);

    steps.push(
      {
        key: 'node',
        label: 'Node major',
        choices: nodeChoices,
        defaultValue: state.node ?? '20'
      },
      {
        key: 'pm',
        label: 'Package manager',
        choices: ['npm', 'pnpm', 'yarn'],
        defaultValue: pm
      },
      {
        key: 'pmver',
        label: `${pm} version`,
        choices: pmVersions,
        defaultValue: state.pmver ?? firstOrUndefined(pmVersions),
        manual: true
      }
    );
  }

  if (state.type === 'java') {
    const buildTool = state.buildTool ?? 'maven';
    steps.push(
      {
        key: 'jdk',
        label: 'JDK',
        choices: withDefaultChoice(commonJdkChoices, state.jdk),
        defaultValue: state.jdk ?? '21',
        manual: true
      },
      {
        key: 'buildTool',
        label: 'Build tool',
        choices: ['maven', 'gradle'],
        defaultValue: buildTool
      }
    );

    if (buildTool === 'maven') {
      steps.push({
        key: 'maven',
        label: 'Maven version',
        choices: withDefaultChoice(commonMavenChoices, state.maven),
        defaultValue: state.maven ?? '3',
        manual: true
      });
    } else {
      steps.push({
        key: 'gradle',
        label: 'Gradle version',
        choices: withDefaultChoice(Object.keys(platformIndex?.java.gradle ?? {}), state.gradle),
        defaultValue: state.gradle,
        manual: true
      });
    }

    steps.push({
      key: 'skipTests',
      label: 'Skip tests',
      choices: ['false', 'true'],
      defaultValue: String(state.skipTests ?? false)
    });
  }

  return steps;
}

async function promptStep(step: WizardStep, canBack: boolean): Promise<string | 'back'> {
  while (true) {
    const choices = step.choices.map((choice) => ({
      title: choice,
      value: choice
    }));

    if (step.manual) {
      choices.push({ title: 'Manual input', value: MANUAL_VALUE });
    }

    if (canBack) {
      choices.push({ title: 'Back', value: BACK_VALUE });
    }

    const initial = Math.max(choices.findIndex((choice) => choice.value === step.defaultValue), 0);
    const response = await prompts(
      {
        type: 'select',
        name: 'value',
        message: step.label,
        choices,
        initial
      },
      promptOptions
    );

    if (response.value === BACK_VALUE) {
      return 'back';
    }

    if (response.value === MANUAL_VALUE) {
      const manual = await prompts(
        {
          type: 'text',
          name: 'value',
          message: `${step.label} manual value`,
          initial: step.defaultValue
        },
        promptOptions
      );

      const value = String(manual.value ?? '').trim();
      if (canBack && isBack(value)) {
        return 'back';
      }
      if (value) {
        return value;
      }
      console.log(yellow('Value cannot be empty.'));
      continue;
    }

    return response.value as string;
  }
}

async function confirmToolchain(
  toolchain: Toolchain,
  yes: boolean
): Promise<'write' | 'back' | 'exit'> {
  console.log(cyan('\nGenerated .ci/toolchain.json:'));
  console.log(JSON.stringify(toolchain, null, 2));

  if (yes || !process.stdin.isTTY) {
    return 'write';
  }

  const decision = await promptStep({
    key: 'type',
    label: 'Confirm',
    choices: ['write', 'back', 'exit'],
    defaultValue: 'write'
  }, false);

  return decision as 'write' | 'back' | 'exit';
}

function applyStepValue(state: InitState, key: WizardKey, value: string): void {
  if (key === 'type') {
    const nextType = value as ToolchainType;
    state.type = nextType;
    return;
  }

  if (key === 'node') {
    state.node = value;
    return;
  }

  if (key === 'pm') {
    const nextPm = value as PackageManager;
    if (state.pm !== nextPm) {
      state.pmver = undefined;
    }
    state.pm = nextPm;
    return;
  }

  if (key === 'pmver') {
    state.pmver = value;
    return;
  }

  if (key === 'jdk') {
    state.jdk = value;
    return;
  }

  if (key === 'buildTool') {
    const nextBuildTool = value as JavaBuildTool;
    state.buildTool = nextBuildTool;
    return;
  }

  if (key === 'maven') {
    state.maven = value;
    return;
  }

  if (key === 'gradle') {
    state.gradle = value;
    return;
  }

  state.skipTests = parseBooleanValue(value, false);
}

function stateToToolchain(state: InitState): Toolchain {
  if (state.type === 'node') {
    if (!state.node || !state.pm || !state.pmver) {
      throw new Error('node, pm, and pmver are required for node toolchain');
    }
    return {
      type: 'node',
      node: state.node,
      pm: state.pm,
      pmver: state.pmver
    } satisfies NodeToolchain;
  }

  if (state.type === 'java') {
    if (!state.jdk || !state.buildTool) {
      throw new Error('jdk and buildTool are required for java toolchain');
    }

    if (state.buildTool === 'maven') {
      if (!state.maven) {
        throw new Error('maven version is required when buildTool=maven');
      }
      return {
        type: 'java',
        jdk: state.jdk,
        buildTool: 'maven',
        maven: state.maven,
        skipTests: state.skipTests ?? false
      } satisfies JavaToolchain;
    }

    if (!state.gradle) {
      throw new Error('gradle version is required when buildTool=gradle');
    }

    return {
      type: 'java',
      jdk: state.jdk,
      buildTool: 'gradle',
      gradle: state.gradle,
      skipTests: state.skipTests ?? false
    } satisfies JavaToolchain;
  }

  throw new Error('type is required');
}

async function resolveInitDefaults(file: string, projectDir: string, platformIndex: PlatformIndex | undefined): Promise<InitDefaults> {
  const existingDefaults = await readExistingToolchainDefaults(file);
  if (existingDefaults) {
    return {
      state: mergeBaseDefaults(existingDefaults, platformIndex),
      source: file
    };
  }

  const packageDefaults = await readPackageDefaults(projectDir);
  if (packageDefaults) {
    return {
      state: mergeBaseDefaults(packageDefaults, platformIndex),
      source: path.join(projectDir, 'package.json')
    };
  }

  return {
    state: mergeBaseDefaults({}, platformIndex),
    source: 'schema defaults'
  };
}

async function readExistingToolchainDefaults(file: string): Promise<InitState | null> {
  try {
    await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  return knownFieldsToState(raw);
}

async function readPackageDefaults(projectDir: string): Promise<InitState | null> {
  const pkg = await readPackageJson(projectDir);
  if (!pkg) {
    return null;
  }

  const state: InitState = {
    type: 'node'
  };

  const nodeMajor = nodeMajorFromPackageJson(pkg);
  if (nodeMajor) {
    state.node = nodeMajor;
  }

  const packageManager = parsePackageManagerSpec(pkg.packageManager);
  if (packageManager) {
    state.pm = packageManager.pm;
    state.pmver = packageManager.pmver;
  }

  return state;
}

function knownFieldsToState(raw: Record<string, unknown>): InitState {
  const state: InitState = {};

  if (raw.type === 'node' || raw.type === 'java') {
    state.type = raw.type;
  }
  if (typeof raw.node === 'string') {
    state.node = raw.node;
  }
  if (raw.pm === 'npm' || raw.pm === 'pnpm' || raw.pm === 'yarn') {
    state.pm = raw.pm;
  }
  if (typeof raw.pmver === 'string') {
    state.pmver = raw.pmver;
  }
  if (typeof raw.jdk === 'string') {
    state.jdk = raw.jdk;
  }
  if (raw.buildTool === 'maven' || raw.buildTool === 'gradle') {
    state.buildTool = raw.buildTool;
  }
  if (typeof raw.maven === 'string') {
    state.maven = raw.maven;
  }
  if (typeof raw.gradle === 'string') {
    state.gradle = raw.gradle;
  }
  if (typeof raw.skipTests === 'boolean') {
    state.skipTests = raw.skipTests;
  }

  return state;
}

function mergeBaseDefaults(state: InitState, platformIndex: PlatformIndex | undefined): InitState {
  const pm = state.pm ?? 'pnpm';
  const buildTool = state.buildTool ?? 'maven';

  return {
    type: state.type,
    node: state.node ?? '20',
    pm,
    pmver: state.pmver ?? '',
    jdk: state.jdk ?? '21',
    buildTool,
    maven: state.maven ?? '3',
    gradle: state.gradle,
    skipTests: state.skipTests ?? false
  };
}

function applyOptionDefaults(state: InitState, options: InitCommandOptions): InitState {
  if (options.type === 'node' || options.type === 'java') {
    state.type = options.type;
  }

  const node = textOption(options.node);
  if (node) {
    state.node = node;
  }

  if (options.pm === 'npm' || options.pm === 'pnpm' || options.pm === 'yarn') {
    state.pm = options.pm;
  }

  const pmver = textOption(options.pmver);
  if (pmver) {
    state.pmver = pmver;
  }

  if (options.jdk) {
    state.jdk = options.jdk;
  }

  if (options.buildTool === 'maven' || options.buildTool === 'gradle') {
    state.buildTool = options.buildTool;
  }

  const maven = textOption(options.maven);
  if (maven) {
    state.maven = maven;
  }

  const gradle = textOption(options.gradle);
  if (gradle) {
    state.gradle = gradle;
  }

  if (options.skipTests != null) {
    state.skipTests = parseBooleanValue(options.skipTests, false);
  }

  return state;
}

function isProvidedByOption(key: WizardKey, options: InitCommandOptions): boolean {
  return options[key] != null;
}

function textOption(value: string | number | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  return String(value);
}

function ensureStepHasValue(step: WizardStep, state: InitState): void {
  const value = state[step.key];
  if (value == null || value === '') {
    throw new Error(`missing required option for non-interactive mode: ${step.label}`);
  }
}

function nodeMajorFromPackageJson(pkg: Record<string, unknown>): string | undefined {
  const engines = pkg.engines as Record<string, unknown> | undefined;
  const volta = pkg.volta as Record<string, unknown> | undefined;
  const candidates = [
    typeof engines?.node === 'string' ? engines.node : undefined,
    typeof volta?.node === 'string' ? volta.node : undefined
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const major = nodeMajorFromVersionRange(candidate);
    if (major) {
      return major;
    }
  }

  return undefined;
}

function nodeMajorFromVersionRange(versionRange: string): string | undefined {
  const normalizedRange = normalizeNodeVersionRange(versionRange);
  const parsedVersion = minVersion(normalizedRange) ?? coerce(normalizedRange);
  if (!parsedVersion) {
    return undefined;
  }

  const major = String(parsedVersion.major);
  return supportedNodeMajors.includes(major) ? major : undefined;
}

function normalizeNodeVersionRange(versionRange: string): string {
  return versionRange.replace(/\bxx\b/gi, 'x');
}

function withDefaultChoice(choices: string[], defaultValue?: string): string[] {
  if (!defaultValue || choices.includes(defaultValue)) {
    return choices;
  }
  return [defaultValue, ...choices];
}

function firstOrUndefined(values: string[]): string | undefined {
  return values.length > 0 ? values[0] : undefined;
}

function isBack(value: string): boolean {
  return ['b', 'back'].includes(value.toLowerCase());
}

function parseBooleanValue(value: string | boolean, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === '') {
    return fallback;
  }

  if (['1', 'true', 'yes', 'y'].includes(value.toLowerCase())) {
    return true;
  }
  if (['0', 'false', 'no', 'n'].includes(value.toLowerCase())) {
    return false;
  }

  throw new Error(`invalid boolean value: ${value}`);
}

async function decideExistingFile(
  file: string,
  yes: boolean,
  backup: boolean
): Promise<'overwrite' | 'backup' | 'exit'> {
  try {
    await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'overwrite';
    }
    throw error;
  }

  if (backup) {
    return 'backup';
  }

  if (yes) {
    return 'overwrite';
  }

  return (await promptStep({
    key: 'type',
    label: `${file} exists`,
    choices: ['overwrite', 'backup', 'exit'],
    defaultValue: 'exit'
  }, false)) as 'overwrite' | 'backup' | 'exit';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
}

const MANUAL_VALUE = '__manual__';
const BACK_VALUE = '__back__';

const promptOptions = {
  onCancel: () => {
    throw new PromptCancelled();
  }
};

class PromptCancelled extends Error {
  constructor() {
    super('Prompt cancelled');
  }
}

function cyan(value: string): string {
  return process.stdout.isTTY ? pc.cyan(value) : value;
}

function yellow(value: string): string {
  return process.stdout.isTTY ? pc.yellow(value) : value;
}
