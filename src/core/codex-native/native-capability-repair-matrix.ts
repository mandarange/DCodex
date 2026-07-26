import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, nowIso, writeJsonAtomic } from '../fsx.js';
import { detectImagegenCapability } from '../imagegen/imagegen-capability.js';
import { buildCodexNativeFeatureMatrix } from './codex-native-feature-broker.js';
import { messageOf } from '../errors/message.js';

export type NativeCapabilityId =
  | 'image_generation'
  | 'image_followup_edit'
  | 'computer_use'
  | 'chrome_web_review'
  | 'codex_app_screenshot'
  | 'app_handoff'
  | 'image_path_exposure'
  | 'saved_artifact_path_contract';

export type ReadinessScope =
  | 'core-cli'
  | 'mad-interactive'
  | 'managed-migration'
  | 'route-computer-use'
  | 'route-chrome-web-review'
  | 'route-image'
  | 'route-app-handoff';

export type CapabilityAvailability =
  | 'verified'
  | 'available-unverified'
  | 'manual-required'
  | 'unavailable'
  | 'not-applicable';

export interface NativeCapabilityRepairState {
  id: NativeCapabilityId;
  before: 'verified' | 'missing' | 'degraded' | 'unknown' | 'blocked';
  availability: CapabilityAvailability;
  required_for: ReadinessScope[];
  repairability: 'auto' | 'doctor-fix' | 'manual-required' | 'unavailable';
  repair_actions: string[];
  after: 'verified' | 'missing' | 'degraded' | 'unknown' | 'blocked' | null;
  artifact_path: string;
  core_blockers: string[];
  route_blockers: Partial<Record<ReadinessScope, string[]>>;
  manual_actions: string[];
  blockers: string[];
  warnings: string[];
  evidence_level?: 'real-interaction' | 'configuration' | 'environment-hint' | 'fixture' | 'none';
  real_interaction_verified?: boolean;
}

export interface NativeCapabilityRepairMatrix {
  schema: 'sks.native-capability-repair-matrix.v1';
  generated_at: string;
  ok: boolean;
  capabilities: NativeCapabilityRepairState[];
  core_blockers: string[];
  route_blockers: Partial<Record<ReadinessScope, string[]>>;
  optional_manual_required: string[];
  blockers: string[];
  warnings: string[];
}

export const NATIVE_CAPABILITY_IDS: NativeCapabilityId[] = [
  'image_generation',
  'image_followup_edit',
  'computer_use',
  'chrome_web_review',
  'codex_app_screenshot',
  'app_handoff',
  'image_path_exposure',
  'saved_artifact_path_contract'
];

export async function buildNativeCapabilityRepairMatrix(input: {
  root: string;
  capabilities?: NativeCapabilityId[];
  fixture?: 'all-repairable' | 'manual-required' | false;
  reportPath?: string | null;
}): Promise<NativeCapabilityRepairMatrix> {
  const root = path.resolve(input.root);
  const selected = new Set(input.capabilities || NATIVE_CAPABILITY_IDS);
  const fixture = input.fixture || false;
  const needsImageCapability = selected.has('image_generation');
  const imageCapability = fixture
    ? fixtureImageCapability(fixture)
    : needsImageCapability
      ? await detectImagegenCapability({ timeoutMs: 2500 }).catch((err: unknown) => ({ blockers: [messageOf(err)], auth_readiness: null, codex_app: { available: false } }))
      : { blockers: [], auth_readiness: null, codex_app: { available: false } };
  const needsNativeFeatureMatrix = selected.has('app_handoff') || selected.has('image_path_exposure');
  const nativeFeatureMatrix = fixture
    ? fixtureNativeFeatureMatrix(fixture)
    : needsNativeFeatureMatrix
      ? await buildCodexNativeFeatureMatrix({ root, mode: 'read-only' }).catch((err: unknown) => ({ ok: false, features: {}, blockers: [messageOf(err)], invocation_defaults: {} }))
      : { ok: true, features: {}, blockers: [], invocation_defaults: {} };
  const states = await Promise.all(NATIVE_CAPABILITY_IDS
    .filter((id) => selected.has(id))
    .map((id) => stateForCapability(root, id, imageCapability, nativeFeatureMatrix, fixture)));
  const coreBlockers = states.flatMap((state) => state.core_blockers || state.blockers);
  const routeBlockers = mergeRouteBlockers(states);
  const warnings = states.flatMap((state) => state.warnings);
  const matrix: NativeCapabilityRepairMatrix = {
    schema: 'sks.native-capability-repair-matrix.v1',
    generated_at: nowIso(),
    ok: coreBlockers.length === 0,
    capabilities: states,
    core_blockers: coreBlockers,
    route_blockers: routeBlockers,
    optional_manual_required: states
      .filter((state) => state.availability === 'manual-required' && state.required_for.every((scope) => !isCoreScope(scope)))
      .map((state) => state.id),
    blockers: coreBlockers,
    warnings
  };
  const reportPath = input.reportPath === null
    ? null
    : input.reportPath || path.join(root, '.sneakoscope', 'reports', 'native-capability-repair-matrix.json');
  if (reportPath) await writeJsonAtomic(reportPath, matrix).catch(() => undefined);
  return matrix;
}

async function stateForCapability(
  root: string,
  id: NativeCapabilityId,
  imageCapability: any,
  nativeFeatureMatrix: any,
  fixture: 'all-repairable' | 'manual-required' | false
): Promise<NativeCapabilityRepairState> {
  const reports = path.join(root, '.sneakoscope', 'reports');
  if (id === 'image_generation') {
    const fixtureVerified = fixture === 'all-repairable';
    const builtInConfigured = imageCapability?.codex_app?.available === true;
    const authReady = imageCapability?.auth_readiness?.headless_auto_available === true;
    const realOutputVerified = (
      builtInConfigured
      && imageCapability?.real_generation_available === true
      && imageCapability?.real_output_verified_by_capability_check === true
      && fixture === false
    );
    const verified = fixtureVerified || realOutputVerified;
    const routeBlocker = builtInConfigured
      ? 'codex_imagegen_real_output_unverified'
      : 'codex_app_builtin_imagegen_capability_missing';
    return {
      id,
      before: verified ? 'verified' : builtInConfigured ? 'degraded' : 'blocked',
      repairability: verified ? 'auto' : 'manual-required',
      availability: verified ? 'verified' : 'manual-required',
      required_for: ['route-image'],
      repair_actions: verified
        ? ['postcheck-imagegen-path-contract']
        : builtInConfigured
          ? ['Invoke Codex App $imagegen with gpt-image-2 in a fresh task and record the selected raster output path before retrying the image route.']
          : ['Sign in to Codex App, enable the built-in $imagegen / gpt-image-2 surface, then verify it with a real generated raster output before retrying the image route.'],
      after: null,
      artifact_path: path.join(reports, 'native-capability-repair-matrix.json'),
      core_blockers: [],
      route_blockers: verified ? {} : { 'route-image': [routeBlocker] },
      manual_actions: verified ? [] : [
        builtInConfigured
          ? 'Generate one real raster with Codex App $imagegen / gpt-image-2 and bind its output path to the route evidence.'
          : 'Sign in to Codex App and enable/use the built-in $imagegen / gpt-image-2 surface before image routes.'
      ],
      blockers: [],
      warnings: verified ? [] : [
        'image_generation_not_verified_without_real_capability',
        ...(authReady && !builtInConfigured ? ['imagegen_auth_readiness_is_not_builtin_output_proof'] : [])
      ],
      evidence_level: fixtureVerified ? 'fixture' : realOutputVerified ? 'real-interaction' : builtInConfigured ? 'configuration' : authReady ? 'environment-hint' : 'none',
      real_interaction_verified: realOutputVerified
    };
  }
  if (id === 'image_followup_edit') {
    const contractReady = await fileExists(path.join(root, '.sneakoscope', 'reports', 'saved-artifact-path-contract.json'));
    return autoState(id, contractReady, path.join(reports, 'saved-artifact-path-contract.json'), ['create-saved-artifact-path-contract']);
  }
  if (id === 'codex_app_screenshot') {
    const dir = path.join(root, '.sneakoscope', 'app-screenshots');
    const ready = await dirWritable(dir);
    return autoState(id, ready, path.join(root, '.sneakoscope', 'app-screenshots', 'screenshot-registry.json'), ['create-app-screenshot-directory', 'create-screenshot-registry']);
  }
  if (id === 'saved_artifact_path_contract') {
    const ready = await fileExists(path.join(reports, 'saved-artifact-path-contract.json'));
    return autoState(id, ready, path.join(reports, 'saved-artifact-path-contract.json'), ['create-saved-artifact-path-contract']);
  }
  if (id === 'app_handoff') {
    const ok = featureOk(nativeFeatureMatrix, 'app_handoff');
    return {
      id,
      before: ok ? 'verified' : 'unknown',
      repairability: ok ? 'auto' : 'manual-required',
      availability: ok ? 'verified' : 'manual-required',
      required_for: ['route-app-handoff'],
      repair_actions: ok ? ['postcheck-app-handoff'] : ['Open Codex App and approve/enable app handoff, then rerun `sks doctor --capabilities --yes`.'],
      after: null,
      artifact_path: path.join(reports, 'native-capability-repair-matrix.json'),
      core_blockers: [],
      route_blockers: ok ? {} : { 'route-app-handoff': ['codex_app_handoff_not_verified'] },
      manual_actions: ok ? [] : ['Open Codex App and approve/enable app handoff before app handoff routes.'],
      blockers: [],
      warnings: ok ? [] : ['manual_app_handoff_approval_required']
    };
  }
  if (id === 'image_path_exposure') {
    const ok = featureOk(nativeFeatureMatrix, 'image_path_exposure');
    const fallback = await fileExists(path.join(reports, 'saved-artifact-path-contract.json'));
    return {
      id,
      before: ok ? 'verified' : fallback ? 'degraded' : 'missing',
      repairability: ok ? 'auto' : 'doctor-fix',
      availability: ok ? 'verified' : fallback ? 'available-unverified' : 'unavailable',
      required_for: ['route-image'],
      repair_actions: ok ? ['postcheck-image-path-exposure'] : ['create-saved-artifact-path-contract'],
      after: null,
      artifact_path: path.join(reports, 'saved-artifact-path-contract.json'),
      core_blockers: [],
      route_blockers: ok || fallback ? {} : { 'route-image': ['image_path_exposure_missing_without_fallback_contract'] },
      manual_actions: [],
      blockers: [],
      warnings: ok ? [] : ['using_saved_artifact_path_contract_fallback']
    };
  }
  if (id === 'computer_use') {
    const fixtureVerified = fixture === 'all-repairable';
    const envHint = process.env.SKS_COMPUTER_USE_CAPABILITY === 'verified';
    return {
      id,
      before: fixtureVerified ? 'verified' : envHint ? 'degraded' : 'unknown',
      availability: fixtureVerified ? 'verified' : 'manual-required',
      required_for: ['route-computer-use'],
      repairability: fixtureVerified ? 'auto' : 'manual-required',
      repair_actions: fixtureVerified ? ['postcheck-computer-use'] : ['Enable Codex Computer Use and macOS Screen Recording/Accessibility permissions; execute a real native interaction, then rerun `sks doctor --capabilities --yes`.'],
      after: null,
      artifact_path: path.join(reports, 'native-capability-repair-matrix.json'),
      core_blockers: [],
      route_blockers: fixtureVerified ? {} : { 'route-computer-use': ['computer_use_os_permission_or_capability_unknown'] },
      manual_actions: fixtureVerified ? [] : ['Enable Codex Computer Use and macOS Screen Recording/Accessibility permissions and verify a real interaction before `$CU` routes.'],
      blockers: [],
      warnings: fixtureVerified ? [] : [
        'manual_os_permission_required',
        ...(envHint ? ['computer_use_environment_hint_is_not_interaction_proof'] : [])
      ],
      evidence_level: fixtureVerified ? 'fixture' : envHint ? 'environment-hint' : 'none',
      real_interaction_verified: false
    };
  }
  const fixtureVerified = fixture === 'all-repairable';
  const chromeHint = process.env.SKS_CHROME_EXTENSION_READY === '1';
  return {
    id,
    before: fixtureVerified ? 'verified' : chromeHint ? 'degraded' : 'unknown',
    availability: fixtureVerified ? 'verified' : 'manual-required',
    required_for: ['route-chrome-web-review'],
    repairability: fixtureVerified ? 'auto' : 'manual-required',
    repair_actions: fixtureVerified ? ['postcheck-chrome-extension-readiness'] : ['Install/enable the official Codex Chrome Extension, approve it in Codex App, then verify a real browser interaction; web/browser/localhost verification must use the Chrome extension path first.'],
    after: null,
    artifact_path: path.join(reports, 'native-capability-repair-matrix.json'),
    core_blockers: [],
    route_blockers: fixtureVerified ? {} : { 'route-chrome-web-review': ['codex_chrome_extension_readiness_not_verified'] },
    manual_actions: fixtureVerified ? [] : ['Install/enable the official Codex Chrome Extension and verify a real interaction before browser/web review routes.'],
    blockers: [],
    warnings: fixtureVerified ? [] : [
      'manual_chrome_extension_setup_required',
      ...(chromeHint ? ['chrome_extension_environment_hint_is_not_interaction_proof'] : [])
    ],
    evidence_level: fixtureVerified ? 'fixture' : chromeHint ? 'environment-hint' : 'none',
    real_interaction_verified: false
  };
}

export async function writeSavedArtifactPathContract(root: string): Promise<string> {
  const artifactPath = path.join(root, '.sneakoscope', 'reports', 'saved-artifact-path-contract.json');
  await writeJsonAtomic(artifactPath, {
    schema: 'sks.saved-artifact-path-contract.v1',
    generated_at: nowIso(),
    root,
    image_artifacts: path.join(root, '.sneakoscope', 'image-artifacts'),
    app_screenshots: path.join(root, '.sneakoscope', 'app-screenshots'),
    model_visible_path_strategy: 'saved-artifact-path',
    raw_secret_values_recorded: false
  });
  return artifactPath;
}

export async function ensureNativeCapabilityArtifactRoots(root: string): Promise<string[]> {
  const imageDir = path.join(root, '.sneakoscope', 'image-artifacts');
  const appDir = path.join(root, '.sneakoscope', 'app-screenshots');
  await ensureDir(imageDir);
  await ensureDir(appDir);
  const imageRegistry = path.join(imageDir, 'image-artifact-registry.json');
  const screenshotRegistry = path.join(appDir, 'screenshot-registry.json');
  const created: string[] = [];
  if (!(await fileExists(imageRegistry))) {
    await writeJsonAtomic(imageRegistry, { schema: 'sks.image-artifact-registry.v1', generated_at: nowIso(), images: [] });
    created.push(imageRegistry);
  }
  if (!(await fileExists(screenshotRegistry))) {
    await writeJsonAtomic(screenshotRegistry, { schema: 'sks.app-screenshot-registry.v1', generated_at: nowIso(), screenshots: [] });
    created.push(screenshotRegistry);
  }
  created.push(await writeSavedArtifactPathContract(root));
  return created;
}

function autoState(id: NativeCapabilityId, ready: boolean, artifactPath: string, actions: string[]): NativeCapabilityRepairState {
  return {
    id,
    before: ready ? 'verified' : 'missing',
    availability: ready ? 'verified' : 'available-unverified',
    required_for: routeScopesForCapability(id),
    repairability: ready ? 'auto' : 'doctor-fix',
    repair_actions: ready ? [`postcheck-${id}`] : actions,
    after: null,
    artifact_path: artifactPath,
    core_blockers: [],
    route_blockers: ready ? {} : routeBlockerForCapability(id, `${id}_repair_required`),
    manual_actions: [],
    blockers: [],
    warnings: []
  };
}

function routeScopesForCapability(id: NativeCapabilityId): ReadinessScope[] {
  if (id === 'image_followup_edit' || id === 'saved_artifact_path_contract' || id === 'codex_app_screenshot') return ['route-image'];
  if (id === 'app_handoff') return ['route-app-handoff'];
  if (id === 'computer_use') return ['route-computer-use'];
  if (id === 'chrome_web_review') return ['route-chrome-web-review'];
  return [];
}

function routeBlockerForCapability(id: NativeCapabilityId, blocker: string): Partial<Record<ReadinessScope, string[]>> {
  const scopes = routeScopesForCapability(id);
  return Object.fromEntries(scopes.map((scope) => [scope, [blocker]]));
}

function mergeRouteBlockers(states: NativeCapabilityRepairState[]): Partial<Record<ReadinessScope, string[]>> {
  const merged: Partial<Record<ReadinessScope, string[]>> = {};
  for (const state of states) {
    for (const [scope, blockers] of Object.entries(state.route_blockers || {}) as Array<[ReadinessScope, string[]]>) {
      const next = [...(merged[scope] || []), ...blockers];
      merged[scope] = [...new Set(next)];
    }
  }
  return merged;
}

function isCoreScope(scope: ReadinessScope): boolean {
  return scope === 'core-cli' || scope === 'mad-interactive' || scope === 'managed-migration';
}

function featureOk(matrix: any, feature: string): boolean {
  return matrix?.features?.[feature]?.ok === true;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirWritable(dir: string): Promise<boolean> {
  try {
    await ensureDir(dir);
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
}

function fixtureImageCapability(mode: 'all-repairable' | 'manual-required'): any {
  return mode === 'all-repairable'
    ? {
        codex_app: { available: true },
        auth_readiness: { headless_auto_available: true },
        real_generation_available: true,
        real_output_verified_by_capability_check: false,
        blockers: []
      }
    : { codex_app: { available: false }, auth_readiness: { headless_auto_available: false }, blockers: ['fixture_manual_required'] };
}

function fixtureNativeFeatureMatrix(mode: 'all-repairable' | 'manual-required'): any {
  const ok = mode === 'all-repairable';
  return {
    ok,
    features: {
      app_handoff: { ok },
      image_path_exposure: { ok },
      plugin_json: { ok }
    },
    blockers: ok ? [] : ['fixture_manual_required']
  };
}
