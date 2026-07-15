import { promises as fs } from 'fs';
import https from 'https';
import path from 'path';
import pc from 'picocolors';
import prompts from 'prompts';
import { coerce, maxSatisfying, minVersion, valid as validSemver } from 'semver';
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
import { parsePackageManagerReference, readPackageJson } from '../utils/package-json';
import { writeJsonFile } from '../utils/write-json';
import { inferPackageManagersFromLockfiles } from '../utils/lockfile';

type WizardKey = 'type' | 'node' | 'pm' | 'pmver' | 'jdk' | 'buildTool' | 'maven' | 'gradle' | 'skipTests';

const commonJdkChoices = ['8', '11', '17', '21'];
const commonMavenChoices = ['3', '4'];
const packageManagers: PackageManager[] = ['npm', 'pnpm', 'yarn'];
const npmPackageVersionsCache = new Map<string, Promise<string[]>>();

type Locale = 'en' | 'zh-CN';

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
  candidates: InitCandidates;
}

interface InitCandidates {
  pmSources: Partial<Record<PackageManager, string[]>>;
  pmVersionChoices: Partial<Record<PackageManager, InferredChoice[]>>;
  pmVersionHints: Partial<Record<PackageManager, string[]>>;
}

interface InferredChoice {
  value: string;
  sources: string[];
}

interface WizardStep {
  key: WizardKey;
  label: string;
  choices: WizardChoice[];
  defaultValue?: string;
  manual?: boolean;
  manualHint?: string;
}

interface WizardChoice {
  value: string;
  title?: string;
  description?: string;
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
  lang?: string;
  registryLookup?: boolean;
}

export async function initCommand(options: InitCommandOptions = {}): Promise<number> {
  const loaded = await loadPlatformIndex(options.index);
  const file = path.resolve(options.file ?? '.ci/toolchain.json');
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const yes = options.yes === true;
  const backup = options.backup === true;
  const locale = resolveLocale(options.lang);
  const defaults = await resolveInitDefaults(file, projectDir, loaded.index, options.registryLookup !== false);

  try {
    const toolchain = await collectToolchain(options, loaded.index, defaults, yes, locale);
    if (!toolchain) {
      console.log(t(locale, 'noChanges'));
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

    const writeDecision = await decideExistingFile(file, yes, backup, locale);
    if (writeDecision === 'exit') {
      console.log(t(locale, 'noChanges'));
      return 0;
    }

    if (writeDecision === 'backup') {
      const backupFile = `${file}.${timestamp()}.bak`;
      await fs.copyFile(file, backupFile);
      console.log(t(locale, 'backedUp', { file: backupFile }));
    }

    await writeJsonFile(file, toolchain);
    console.log(t(locale, 'wrote', { file }));
    console.log(t(locale, 'defaults', { source: defaults.source }));
    console.log(t(locale, 'platformIndex', { source: loaded.source ?? t(locale, 'platformIndexMissing') }));
    return 0;
  } catch (error) {
    if (error instanceof PromptCancelled) {
      console.log(t(locale, 'noChanges'));
      return 0;
    }
    throw error;
  }
}

async function collectToolchain(
  options: InitCommandOptions,
  platformIndex: PlatformIndex | undefined,
  defaults: InitDefaults,
  yes: boolean,
  locale: Locale
): Promise<Toolchain | null> {
  const state = applyOptionDefaults({ ...defaults.state }, options);
  let stepIndex = 0;

  while (true) {
    const steps = buildSteps(state, platformIndex, defaults.candidates, locale);

    if (stepIndex >= steps.length) {
      const toolchain = stateToToolchain(state);
      const decision = await confirmToolchain(toolchain, yes, locale);
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

    if (yes || !process.stdin.isTTY) {
      ensureStepHasValue(step, state);
      stepIndex += 1;
      continue;
    }

    const result = await promptStep(step, stepIndex > 0, locale);
    if (result === 'back') {
      stepIndex = Math.max(stepIndex - 1, 0);
      continue;
    }

    applyStepValue(state, step.key, result);
    stepIndex += 1;
  }
}

function buildSteps(
  state: InitState,
  platformIndex: PlatformIndex | undefined,
  candidates: InitCandidates,
  locale: Locale
): WizardStep[] {
  const typeChoices = choices(['node', 'java']);
  const steps: WizardStep[] = [
    {
      key: 'type',
      label: t(locale, 'projectType'),
      choices: typeChoices,
      defaultValue: state.type
    }
  ];

  if (state.type === 'node') {
    const nodeChoices = choices(supportedNodeMajors);
    const pm = state.pm ?? 'pnpm';
    const pmVersions = versionChoices(candidates.pmVersionChoices[pm] ?? [], state.pmver);
    const hints = candidates.pmVersionHints[pm] ?? [];

    steps.push(
      {
        key: 'node',
        label: t(locale, 'nodeMajor'),
        choices: nodeChoices,
        defaultValue: state.node ?? '20'
      },
      {
        key: 'pm',
        label: t(locale, 'packageManager'),
        choices: packageManagerChoices(candidates),
        defaultValue: pm,
        manual: true
      },
      {
        key: 'pmver',
        label: t(locale, 'pmVersion', { pm }),
        choices: pmVersions,
        defaultValue: state.pmver ?? firstOrUndefined(pmVersions),
        manual: true,
        manualHint: hints.join('; ')
      }
    );
  }

  if (state.type === 'java') {
    const buildTool = state.buildTool ?? 'maven';
    steps.push(
      {
        key: 'jdk',
        label: t(locale, 'jdk'),
        choices: withDefaultChoice(choices(commonJdkChoices), state.jdk),
        defaultValue: state.jdk ?? '21',
        manual: true
      },
      {
        key: 'buildTool',
        label: t(locale, 'buildTool'),
        choices: choices(['maven', 'gradle']),
        defaultValue: buildTool
      }
    );

    if (buildTool === 'maven') {
      steps.push({
        key: 'maven',
        label: t(locale, 'mavenVersion'),
        choices: withDefaultChoice(choices(commonMavenChoices), state.maven),
        defaultValue: state.maven ?? '3',
        manual: true
      });
    } else {
      steps.push({
        key: 'gradle',
        label: t(locale, 'gradleVersion'),
        choices: withDefaultChoice(choices(Object.keys(platformIndex?.java.gradle ?? {})), state.gradle),
        defaultValue: state.gradle,
        manual: true
      });
    }

    steps.push({
      key: 'skipTests',
      label: t(locale, 'skipTests'),
      choices: choices(['false', 'true']),
      defaultValue: String(state.skipTests ?? false)
    });
  }

  return steps;
}

async function promptStep(step: WizardStep, canBack: boolean, locale: Locale): Promise<string | 'back'> {
  while (true) {
    const choices: Array<{ title: string; value: string; description?: string }> = step.choices.map((choice) => ({
      title: choice.title ?? choice.value,
      value: choice.value,
      description: choice.description
    }));

    if (step.manual) {
      choices.push({
        title: step.manualHint ? t(locale, 'manualWithHint', { hint: step.manualHint }) : t(locale, 'manualInput'),
        value: MANUAL_VALUE
      });
    }

    if (canBack) {
      choices.push({ title: t(locale, 'back'), value: BACK_VALUE });
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
          message: step.manualHint
            ? `${t(locale, 'manualValue', { label: step.label })} (${step.manualHint})`
            : t(locale, 'manualValue', { label: step.label }),
          initial: step.defaultValue
        },
        promptOptions
      );

      const value = String(manual.value ?? '').trim();
      if (canBack && isBack(value)) {
        return 'back';
      }
      if (value) {
        validateManualValue(step, value);
        return value;
      }
      console.log(yellow(t(locale, 'valueCannotBeEmpty')));
      continue;
    }

    return response.value as string;
  }
}

function validateManualValue(step: WizardStep, value: string): void {
  if (step.key === 'pm' && !packageManagers.includes(value as PackageManager)) {
    throw new Error(`unsupported package manager: ${value}`);
  }
}

async function confirmToolchain(
  toolchain: Toolchain,
  yes: boolean,
  locale: Locale
): Promise<'write' | 'back' | 'exit'> {
  console.log(cyan(`\n${t(locale, 'generatedToolchain')}`));
  console.log(JSON.stringify(toolchain, null, 2));

  if (yes || !process.stdin.isTTY) {
    return 'write';
  }

  const decision = await promptStep({
    key: 'type',
    label: t(locale, 'confirm'),
    choices: choices(['write', 'back', 'exit']),
    defaultValue: 'write'
  }, false, locale);

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

async function resolveInitDefaults(
  file: string,
  projectDir: string,
  platformIndex: PlatformIndex | undefined,
  registryLookup: boolean
): Promise<InitDefaults> {
  const existingDefaults = await readExistingToolchainDefaults(file);
  if (existingDefaults) {
    return {
      state: mergeBaseDefaults(existingDefaults, platformIndex),
      source: file,
      candidates: emptyCandidates()
    };
  }

  const inferred = await inferProjectDefaults(projectDir, registryLookup);

  return {
    state: mergeBaseDefaults(inferred.state, platformIndex),
    source: inferred.source,
    candidates: inferred.candidates
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

async function inferProjectDefaults(projectDir: string, registryLookup: boolean): Promise<InitDefaults> {
  const pkg = await readPackageJson(projectDir);
  const candidates = emptyCandidates();
  const state: InitState = {};
  const sources: string[] = [];

  if (!pkg) {
    return {
      state,
      source: 'schema defaults',
      candidates
    };
  }

  state.type = 'node';
  sources.push(path.join(projectDir, 'package.json'));

  const nodeMajor = nodeMajorFromPackageJson(pkg);
  if (nodeMajor) {
    state.node = nodeMajor;
  }

  const packageManager = parsePackageManagerReference(pkg.packageManager);
  if (packageManager) {
    state.pm = packageManager.pm;
    addPmSource(candidates, packageManager.pm, `package.json packageManager ${pkg.packageManager}`);
    if (packageManager.exactVersion) {
      state.pmver = packageManager.exactVersion;
      addVersionChoice(candidates, packageManager.pm, packageManager.exactVersion, `package.json packageManager ${pkg.packageManager}`);
    } else if (packageManager.range) {
      const resolved = registryLookup ? await latestPackageManagerVersion(packageManager.pm, packageManager.range) : undefined;
      if (resolved) {
        state.pmver = resolved;
        addVersionChoice(candidates, packageManager.pm, resolved, `registry latest ${packageManager.pm}@${packageManager.range}`);
      } else {
        addVersionHint(candidates, packageManager.pm, `package.json packageManager range ${packageManager.rawVersion}`);
      }
    } else {
      addVersionHint(candidates, packageManager.pm, `package.json packageManager version ${packageManager.rawVersion}`);
    }
  }

  const lockInferences = await inferPackageManagersFromLockfiles(projectDir);
  if (lockInferences.length > 0) {
    sources.push('lockfiles');
  }

  for (const inference of lockInferences) {
    addPmSource(candidates, inference.pm, inference.detail);
    if (inference.version) {
      addVersionChoice(candidates, inference.pm, inference.version, inference.detail);
      if (!state.pm) {
        state.pm = inference.pm;
      }
      if (state.pm === inference.pm && !state.pmver) {
        state.pmver = inference.version;
      }
      continue;
    }

    if (inference.versionMajor) {
      const range = `${inference.versionMajor}.x`;
      const resolved = registryLookup ? await latestPackageManagerVersion(inference.pm, range) : undefined;
      if (resolved) {
        addVersionChoice(candidates, inference.pm, resolved, `${inference.detail}; registry latest ${inference.pm}@${range}`);
        if (!state.pm) {
          state.pm = inference.pm;
        }
        if (state.pm === inference.pm && !state.pmver) {
          state.pmver = resolved;
        }
      } else {
        addVersionHint(candidates, inference.pm, inference.detail);
        if (!state.pm) {
          state.pm = inference.pm;
        }
      }
    }
  }

  return {
    state,
    source: sources.length > 0 ? sources.join(', ') : 'schema defaults',
    candidates
  };
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
    const hint = step.manualHint ? ` (${step.manualHint})` : '';
    throw new Error(`missing required option for non-interactive mode: ${step.label}${hint}`);
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

function emptyCandidates(): InitCandidates {
  return {
    pmSources: {},
    pmVersionChoices: {},
    pmVersionHints: {}
  };
}

function addPmSource(candidates: InitCandidates, pm: PackageManager, source: string): void {
  candidates.pmSources[pm] = unique([...(candidates.pmSources[pm] ?? []), source]);
}

function addVersionChoice(candidates: InitCandidates, pm: PackageManager, value: string, source: string): void {
  const choices = candidates.pmVersionChoices[pm] ?? [];
  const existing = choices.find((choice) => choice.value === value);
  if (existing) {
    existing.sources = unique([...existing.sources, source]);
  } else {
    choices.push({ value, sources: [source] });
  }
  candidates.pmVersionChoices[pm] = choices;
}

function addVersionHint(candidates: InitCandidates, pm: PackageManager, hint: string): void {
  candidates.pmVersionHints[pm] = unique([...(candidates.pmVersionHints[pm] ?? []), hint]);
}

function choices(values: string[]): WizardChoice[] {
  return values.map((value) => ({ value }));
}

function packageManagerChoices(candidates: InitCandidates): WizardChoice[] {
  return packageManagers.map((pm) => ({
    value: pm,
    title: pmTitle(pm, candidates.pmSources[pm] ?? []),
    description: (candidates.pmSources[pm] ?? []).join('; ') || undefined
  }));
}

function pmTitle(pm: PackageManager, sources: string[]): string {
  if (sources.length === 0) {
    return pm;
  }
  const shortSources = sources
    .map((source) => source.match(/\b(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|package\.json)\b/)?.[1])
    .filter((source): source is string => Boolean(source));
  return shortSources.length > 0 ? `${pm} (from ${unique(shortSources).join(', ')})` : `${pm} (inferred)`;
}

function versionChoices(inferred: InferredChoice[], defaultValue?: string): WizardChoice[] {
  const values = inferred.map((choice) => ({
    value: choice.value,
    description: choice.sources.join('; ')
  }));
  return withDefaultChoice(values, defaultValue);
}

function withDefaultChoice(choices: WizardChoice[], defaultValue?: string): WizardChoice[] {
  if (!defaultValue || choices.some((choice) => choice.value === defaultValue)) {
    return choices;
  }
  return [{ value: defaultValue }, ...choices];
}

function firstOrUndefined(values: WizardChoice[]): string | undefined {
  return values.length > 0 ? values[0].value : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function latestPackageManagerVersion(pm: PackageManager, range: string): Promise<string | undefined> {
  const versions = await fetchNpmPackageVersions(pm);
  if (versions.length === 0) {
    return undefined;
  }
  return maxSatisfying(versions, range) ?? undefined;
}

async function fetchNpmPackageVersions(name: string): Promise<string[]> {
  const cached = npmPackageVersionsCache.get(name);
  if (cached) {
    return cached;
  }

  const request = fetchNpmPackageVersionsUncached(name);
  npmPackageVersionsCache.set(name, request);
  return request;
}

async function fetchNpmPackageVersionsUncached(name: string): Promise<string[]> {
  try {
    const encoded = encodeURIComponent(name);
    const body = await httpsGetJson(`https://registry.npmjs.org/${encoded}`, 2500);
    const versions = (body as { versions?: Record<string, unknown> }).versions;
    if (!versions) {
      return [];
    }
    return Object.keys(versions).filter((version) => validSemver(version) === version);
  } catch {
    return [];
  }
}

function httpsGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: timeoutMs,
      headers: {
        accept: 'application/json',
        'user-agent': 'devops-toolchain'
      }
    }, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode ?? 0}`));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', reject);
  });
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
  backup: boolean,
  locale: Locale
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
    choices: choices(['overwrite', 'backup', 'exit']),
    defaultValue: 'exit'
  }, false, locale)) as 'overwrite' | 'backup' | 'exit';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
}

function resolveLocale(lang: string | undefined): Locale {
  const raw = (lang ?? process.env.DEVOPS_TOOLCHAIN_LANG ?? process.env.LANG ?? '').toLowerCase();
  return raw.startsWith('zh') ? 'zh-CN' : 'en';
}

type MessageKey =
  | 'noChanges'
  | 'backedUp'
  | 'wrote'
  | 'defaults'
  | 'platformIndex'
  | 'platformIndexMissing'
  | 'projectType'
  | 'nodeMajor'
  | 'packageManager'
  | 'pmVersion'
  | 'jdk'
  | 'buildTool'
  | 'mavenVersion'
  | 'gradleVersion'
  | 'skipTests'
  | 'manualInput'
  | 'manualWithHint'
  | 'back'
  | 'manualValue'
  | 'valueCannotBeEmpty'
  | 'generatedToolchain'
  | 'confirm';

const messages: Record<Locale, Record<MessageKey, string>> = {
  en: {
    noChanges: 'No changes written.',
    backedUp: 'Backed up existing file to {file}',
    wrote: 'Wrote {file}',
    defaults: 'Defaults: {source}',
    platformIndex: 'Platform index: {source}',
    platformIndexMissing: 'not configured; platform availability was not checked',
    projectType: 'Project type',
    nodeMajor: 'Node major',
    packageManager: 'Package manager',
    pmVersion: '{pm} version',
    jdk: 'JDK',
    buildTool: 'Build tool',
    mavenVersion: 'Maven version',
    gradleVersion: 'Gradle version',
    skipTests: 'Skip tests',
    manualInput: 'Manual input',
    manualWithHint: 'Manual input ({hint})',
    back: 'Back',
    manualValue: '{label} manual value',
    valueCannotBeEmpty: 'Value cannot be empty.',
    generatedToolchain: 'Generated .ci/toolchain.json:',
    confirm: 'Confirm'
  },
  'zh-CN': {
    noChanges: '未写入任何变更。',
    backedUp: '已备份现有文件到 {file}',
    wrote: '已写入 {file}',
    defaults: '默认值来源：{source}',
    platformIndex: '平台索引：{source}',
    platformIndexMissing: '未配置；未校验平台可用性',
    projectType: '项目类型',
    nodeMajor: 'Node 主版本',
    packageManager: '包管理器',
    pmVersion: '{pm} 版本',
    jdk: 'JDK',
    buildTool: '构建工具',
    mavenVersion: 'Maven 版本',
    gradleVersion: 'Gradle 版本',
    skipTests: '跳过测试',
    manualInput: '手动输入',
    manualWithHint: '手动输入（{hint}）',
    back: '返回上一步',
    manualValue: '{label} 手动值',
    valueCannotBeEmpty: '值不能为空。',
    generatedToolchain: '生成的 .ci/toolchain.json：',
    confirm: '确认'
  }
};

function t(locale: Locale, key: MessageKey, values: Record<string, string> = {}): string {
  return messages[locale][key].replace(/\{([^}]+)\}/g, (_, name: string) => values[name] ?? '');
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
