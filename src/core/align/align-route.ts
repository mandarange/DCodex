import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js';
import { ARCHITECTURE_MAP_ARTIFACT_RELS } from '../triwiki/context-graph/store/architecture-map-store.js';
import { CODE_NAVIGATION_LIMITS } from '../triwiki/code-navigation-policy.js';

export const ALIGN_PLAN_ARTIFACT = 'align-plan.json';
export const ALIGN_LEDGER_ARTIFACT = 'align-ledger.json';
export const ALIGN_GATE_ARTIFACT = 'align-gate.json';
export const ALIGN_STAGING_ROOT_REL = '.sneakoscope/tmp/triwiki-align';

export const ALIGN_SOURCE_POLICY = Object.freeze({
  mode: 'repository_code_navigation_only',
  included: ['repository source-code bytes', 'source comments and docstrings', 'declarations', 'exact source coordinates', 'source-provenance relations'],
  excluded: ['prior TriWiki memory', 'wrongness memory', 'missions', 'ordinary documentation', 'external documentation', 'LLM inference', 'proof banks', 'release evidence'],
  full_rebuild: true,
  incremental_reuse: false,
  fragment_cache: false
} as const);

export const ALIGN_OUTPUT_ARTIFACTS = Object.freeze([
  '.sneakoscope/wiki/context-graph.json',
  '.sneakoscope/wiki/context-graph.meta.json',
  // The CRK2 generation store's pointer and meta mirror. Listed as outputs so the
  // align gate hashes them after promotion: without them a run that published no
  // v2 generation would still pass, which is exactly how this seam went unwired.
  '.sneakoscope/wiki/context-graph/current.json',
  '.sneakoscope/wiki/context-graph/context-graph.meta.json',
  '.sneakoscope/wiki/code-navigation-manifest.json',
  '.sneakoscope/wiki/code-pack.json',
  '.sneakoscope/wiki/context-pack.json',
  ...ARCHITECTURE_MAP_ARTIFACT_RELS
]);

export interface AlignPlan {
  schema: 'sks.align-plan.v3';
  schema_version: 3;
  generated_at: string;
  mission_id: string;
  task: string;
  purpose: 'rebuild_triwiki_as_repository_code_navigation_index';
  requires_cleanup_receipt: false;
  source_policy: typeof ALIGN_SOURCE_POLICY;
  limits: typeof CODE_NAVIGATION_LIMITS;
  outputs: readonly string[];
  acceptance: {
    exact_source_file_coverage: true;
    exact_file_symbol_coordinates: true;
    absent_or_existing_triwiki_supported: true;
    prior_state_ignored_as_index_input: true;
    retained_previous_generation_forbidden: true;
    staged_transactional_publication: true;
    fatal_scan_skips_block: true;
    source_changed_during_scan_blocks: true;
  };
  next_actions: string[];
}

export interface AlignLedger {
  schema: 'sks.align-ledger.v3';
  schema_version: 3;
  generated_at: string;
  mission_id: string;
  status: 'pending' | 'complete' | 'blocked';
  input_state: {
    mode: 'absent' | 'existing';
    active_surfaces_at_start: string[];
    prior_state_digest: string | null;
    prior_state_used_as_index_input: false;
  };
  scan: {
    full_rebuild: true;
    fragment_cache_used: false;
    inventory_digest: string | null;
    source_file_count: number;
    source_bytes: number;
    source_lines: number;
    languages: Record<string, number>;
    allowed_exclusions: Array<{ path: string; reason: string }>;
    fatal_skips: Array<{ path: string; reason: string; detail?: string }>;
    duration_ms: number;
    source_cas_verified: boolean;
  };
  graph: {
    snapshot_hash: string | null;
    extractor_ids: string[];
    file_nodes: number;
    symbol_nodes: number;
    module_nodes: number;
    test_nodes: number;
    edge_count: number;
    edges_by_type: Record<string, number>;
    exact_file_coverage: boolean;
    missing_files: string[];
    unexpected_files: string[];
  };
  publication: {
    staged: boolean;
    transactional_directory_replaced: boolean;
    previous_generation_retained: false;
    temporary_swap_removed: boolean;
    active_artifacts: string[];
    artifact_sha256: Record<string, string>;
    agents_projections: Array<{ path: string; sha256: string }>;
  };
  validation: {
    absent_or_existing_input_supported: boolean;
    prior_state_ignored: boolean;
    source_inventory_complete: boolean;
    graph_compile: boolean;
    graph_schema: boolean;
    code_pack: boolean;
    context_pack: boolean;
    staged_readback: boolean;
    projection: boolean;
    artifact_hashes: boolean;
  };
  blockers: string[];
}

export interface AlignGate {
  schema: 'sks.align-gate.v3';
  schema_version: 3;
  generated_at: string;
  mission_id: string;
  passed: boolean;
  ok: boolean;
  status: 'pass' | 'blocked';
  plan_present: boolean;
  ledger_present: boolean;
  mission_id_consistent: boolean;
  absent_or_existing_input_supported: boolean;
  prior_state_ignored_as_input: boolean;
  previous_generation_not_retained: boolean;
  source_policy_code_only: boolean;
  full_rebuild_verified: boolean;
  fatal_skips_clear: boolean;
  exact_source_file_coverage: boolean;
  source_cas_verified: boolean;
  code_extractor_only: boolean;
  staged_transactional_publication: boolean;
  active_artifacts_verified: boolean;
  projections_verified: boolean;
  outputs_complete: boolean;
  blockers: string[];
}

interface AlignActiveVerification {
  artifacts: boolean;
  projections: boolean;
  temporarySwapAbsent: boolean;
  blockers: string[];
}

export function buildAlignPlan(missionId: string, task: string): AlignPlan {
  return {
    schema: 'sks.align-plan.v3',
    schema_version: 3,
    generated_at: nowIso(),
    mission_id: missionId,
    task: String(task || '').trim() || 'Rebuild TriWiki as a code-only repository navigation index',
    purpose: 'rebuild_triwiki_as_repository_code_navigation_index',
    requires_cleanup_receipt: false,
    source_policy: ALIGN_SOURCE_POLICY,
    limits: CODE_NAVIGATION_LIMITS,
    outputs: ALIGN_OUTPUT_ARTIFACTS,
    acceptance: {
      exact_source_file_coverage: true,
      exact_file_symbol_coordinates: true,
      absent_or_existing_triwiki_supported: true,
      prior_state_ignored_as_index_input: true,
      retained_previous_generation_forbidden: true,
      staged_transactional_publication: true,
      fatal_scan_skips_block: true,
      source_changed_during_scan_blocks: true
    },
    next_actions: [
      'Accept either an absent TriWiki or an existing/wrong TriWiki without requiring Cleanup',
      'Read every accepted repository source file from current bytes without cache or prior memory',
      'Build exact file, symbol, coordinate, containment, import, call, reference, and module navigation records supported by each extractor',
      'Re-read source hashes, validate all artifacts in staging, transactionally replace the active generation, and delete the temporary prior-state handle',
      'Project only the bounded fast map into managed AGENTS.md blocks; keep the exhaustive graph as authority'
    ]
  };
}

export function buildInitialAlignLedger(missionId: string): AlignLedger {
  return {
    schema: 'sks.align-ledger.v3',
    schema_version: 3,
    generated_at: nowIso(),
    mission_id: missionId,
    status: 'pending',
    input_state: { mode: 'absent', active_surfaces_at_start: [], prior_state_digest: null, prior_state_used_as_index_input: false },
    scan: {
      full_rebuild: true,
      fragment_cache_used: false,
      inventory_digest: null,
      source_file_count: 0,
      source_bytes: 0,
      source_lines: 0,
      languages: {},
      allowed_exclusions: [],
      fatal_skips: [],
      duration_ms: 0,
      source_cas_verified: false
    },
    graph: {
      snapshot_hash: null,
      extractor_ids: [],
      file_nodes: 0,
      symbol_nodes: 0,
      module_nodes: 0,
      test_nodes: 0,
      edge_count: 0,
      edges_by_type: {},
      exact_file_coverage: false,
      missing_files: [],
      unexpected_files: []
    },
    publication: {
      staged: false,
      transactional_directory_replaced: false,
      previous_generation_retained: false,
      temporary_swap_removed: false,
      active_artifacts: [],
      artifact_sha256: {},
      agents_projections: []
    },
    validation: {
      absent_or_existing_input_supported: false,
      prior_state_ignored: false,
      source_inventory_complete: false,
      graph_compile: false,
      graph_schema: false,
      code_pack: false,
      context_pack: false,
      staged_readback: false,
      projection: false,
      artifact_hashes: false
    },
    blockers: []
  };
}

export function evaluateAlignGate(
  plan: AlignPlan | null,
  ledger: AlignLedger | null,
  missionId: string,
  activeVerification: AlignActiveVerification = { artifacts: false, projections: false, temporarySwapAbsent: false, blockers: [] }
): AlignGate {
  const blockers = new Set<string>();
  const planPresent = plan?.schema === 'sks.align-plan.v3' && plan.schema_version === 3;
  const ledgerPresent = ledger?.schema === 'sks.align-ledger.v3' && ledger.schema_version === 3;
  const consistent = Boolean(planPresent && ledgerPresent && plan?.mission_id === missionId && ledger?.mission_id === missionId);
  if (!planPresent) blockers.add('align_plan_missing_or_stale');
  if (!ledgerPresent) blockers.add('align_ledger_missing_or_stale');
  if (!consistent) blockers.add('align_mission_id_mismatch');
  for (const blocker of ledger?.blockers ?? []) blockers.add(blocker);
  for (const blocker of activeVerification.blockers) blockers.add(blocker);
  const checks = {
    input: plan?.requires_cleanup_receipt === false
      && plan?.acceptance.absent_or_existing_triwiki_supported === true
      && ledger?.validation.absent_or_existing_input_supported === true,
    ignored: ledger?.input_state.prior_state_used_as_index_input === false && ledger?.validation.prior_state_ignored === true,
    noRetention: ledger?.publication.previous_generation_retained === false
      && ledger?.publication.temporary_swap_removed === true
      && activeVerification.temporarySwapAbsent,
    policy: plan?.source_policy.mode === 'repository_code_navigation_only'
      && plan.source_policy.full_rebuild === true
      && plan.source_policy.incremental_reuse === false
      && plan.source_policy.fragment_cache === false,
    rebuild: ledger?.scan.full_rebuild === true && ledger.scan.fragment_cache_used === false,
    skips: (ledger?.scan.fatal_skips.length ?? 1) === 0,
    coverage: ledger?.graph.exact_file_coverage === true && ledger.graph.missing_files.length === 0 && ledger.graph.unexpected_files.length === 0,
    cas: ledger?.scan.source_cas_verified === true,
    extractor: Array.isArray(ledger?.graph.extractor_ids)
      && ledger.graph.extractor_ids.length === 3
      && ledger.graph.extractor_ids[0] === 'code'
      && ledger.graph.extractor_ids[1] === 'topology'
      && ledger.graph.extractor_ids[2] === 'triwiki-evidence',
    publication: ledger?.publication.staged === true && ledger.publication.transactional_directory_replaced === true,
    artifacts: ledger?.validation.artifact_hashes === true && activeVerification.artifacts,
    projection: ledger?.validation.projection === true && activeVerification.projections,
    outputs: ALIGN_OUTPUT_ARTIFACTS.every((artifact) => ledger?.publication.active_artifacts.includes(artifact))
  };
  for (const [name, passed] of Object.entries(checks)) if (!passed) blockers.add(`align_${name}_not_verified`);
  const passed = planPresent && ledgerPresent && consistent && ledger?.status === 'complete' && blockers.size === 0;
  return {
    schema: 'sks.align-gate.v3',
    schema_version: 3,
    generated_at: nowIso(),
    mission_id: missionId,
    passed,
    ok: passed,
    status: passed ? 'pass' : 'blocked',
    plan_present: planPresent,
    ledger_present: ledgerPresent,
    mission_id_consistent: consistent,
    absent_or_existing_input_supported: checks.input,
    prior_state_ignored_as_input: checks.ignored,
    previous_generation_not_retained: checks.noRetention,
    source_policy_code_only: checks.policy,
    full_rebuild_verified: checks.rebuild,
    fatal_skips_clear: checks.skips,
    exact_source_file_coverage: checks.coverage,
    source_cas_verified: checks.cas,
    code_extractor_only: checks.extractor,
    staged_transactional_publication: checks.publication,
    active_artifacts_verified: checks.artifacts,
    projections_verified: checks.projection,
    outputs_complete: checks.outputs,
    blockers: [...blockers].sort()
  };
}

export async function writeAlignRouteArtifacts(dir: string, missionId: string, task: string) {
  const plan = buildAlignPlan(missionId, task);
  const ledger = buildInitialAlignLedger(missionId);
  const gate = evaluateAlignGate(plan, ledger, missionId);
  await writeJsonAtomic(path.join(dir, ALIGN_PLAN_ARTIFACT), plan);
  await writeJsonAtomic(path.join(dir, ALIGN_LEDGER_ARTIFACT), ledger);
  await writeJsonAtomic(path.join(dir, ALIGN_GATE_ARTIFACT), gate);
  return { plan, ledger, gate };
}

async function fileSha256(file: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyActiveArtifacts(root: string, ledger: AlignLedger | null): Promise<AlignActiveVerification> {
  if (!ledger || ledger.status !== 'complete') return { artifacts: false, projections: false, temporarySwapAbsent: false, blockers: [] };
  const blockers: string[] = [];
  const temporarySwapAbsent = await fsp.lstat(path.join(root, ALIGN_STAGING_ROOT_REL))
    .then(() => false)
    .catch((error: any) => {
      if (error?.code === 'ENOENT') return true;
      throw error;
    });
  if (!temporarySwapAbsent) blockers.push('align_temporary_swap_retained');
  for (const artifact of ALIGN_OUTPUT_ARTIFACTS) {
    const expected = ledger.publication.artifact_sha256[artifact];
    if (!expected) {
      blockers.push(`align_artifact_hash_missing:${artifact}`);
      continue;
    }
    const actual = await fileSha256(path.join(root, artifact)).catch(() => null);
    if (actual !== expected) blockers.push(`align_artifact_changed:${artifact}`);
  }
  for (const projection of ledger.publication.agents_projections) {
    const absolute = path.resolve(root, projection.path);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      blockers.push(`align_projection_outside_root:${projection.path}`);
      continue;
    }
    const actual = await fileSha256(absolute).catch(() => null);
    if (actual !== projection.sha256) blockers.push(`align_projection_changed:${projection.path}`);
  }
  return {
    artifacts: !blockers.some((blocker) => blocker.startsWith('align_artifact_')),
    projections: ledger.publication.agents_projections.length > 0
      && !blockers.some((blocker) => blocker.startsWith('align_projection_')),
    temporarySwapAbsent,
    blockers
  };
}

export async function refreshAlignGate(dir: string, missionId: string, rootInput?: string) {
  const plan = await readJson<AlignPlan | null>(path.join(dir, ALIGN_PLAN_ARTIFACT), null);
  const ledger = await readJson<AlignLedger | null>(path.join(dir, ALIGN_LEDGER_ARTIFACT), null);
  const root = path.resolve(rootInput || path.join(dir, '..', '..', '..'));
  const activeVerification = await verifyActiveArtifacts(root, ledger);
  const gate = evaluateAlignGate(plan, ledger, missionId, activeVerification);
  await writeJsonAtomic(path.join(dir, ALIGN_GATE_ARTIFACT), gate);
  return { plan, ledger, gate };
}

export async function readAlignGate(dir: string): Promise<AlignGate | null> {
  return readJson<AlignGate | null>(path.join(dir, ALIGN_GATE_ARTIFACT), null);
}

export function alignNextActionText(missionId: string): string {
  return `Run sks align run ${missionId}; Align accepts an absent or existing TriWiki, rebuilds the code-only index from current repository bytes, replaces the active generation, and retains no previous generation.`;
}
