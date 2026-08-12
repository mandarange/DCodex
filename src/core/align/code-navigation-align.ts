import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ensureDir,
  nowIso,
  readJson,
  writeJsonAtomic
} from '../fsx.js';
import { guardedRename, guardedRm, guardContextForRoute } from '../safety/mutation-guard.js';
import { createRequestedScopeContract } from '../safety/requested-scope-contract.js';
import {
  projectTriwikiToAgentsMdTransactional,
  type ProjectorTransaction
} from '../triwiki/agents-md-projector.js';
import {
  buildCodeNavigationContextPack,
  validateCodeNavigationContextPack
} from '../triwiki/code-navigation-context-pack.js';
import {
  CODE_NAVIGATION_FATAL_SKIP_REASONS,
  CODE_NAVIGATION_LIMITS
} from '../triwiki/code-navigation-policy.js';
import type { ContextGraphSkip } from '../triwiki/context-graph/contracts.js';
import {
  isCodePackProjectionBoundToSnapshot,
  validateCodePack,
  type CodePack
} from '../triwiki/code-pack.js';
import {
  validateContextGraphSnapshot,
  type ContextGraphSnapshot
} from '../triwiki/context-graph/contracts.js';
import { compileContextGraph } from '../triwiki/context-graph/compiler/index.js';
import {
  ARCHITECTURE_MAP_EXTRACTOR_IDS,
  architectureMapGraphExtractors
} from '../triwiki/context-graph/extractors/index.js';
import { computeContextGraphCacheKey } from '../triwiki/context-graph/compiler/cache-key.js';
import { walkCodeInventory } from '../triwiki/context-graph/extractors/code/inventory.js';
import { codeInventoryInputHashes } from '../triwiki/code-navigation-policy.js';
import {
  clearContextGraphSnapshotCache,
  clearWorkspaceContextIndex
} from '../triwiki/context-graph/query/index.js';
import { withTriWikiStateLock } from '../triwiki/triwiki-cleanup.js';
import { publishArchitectureMapToStage } from '../triwiki/context-graph/store/architecture-map-store.js';
import {
  alignPendingRoot,
  alignPendingWiki,
  alignSourceFingerprint,
  projectAlignCodePack,
  publishAlignContextIndex
} from './align-context-index.js';
import {
  ALIGN_GATE_ARTIFACT,
  ALIGN_LEDGER_ARTIFACT,
  ALIGN_OUTPUT_ARTIFACTS,
  ALIGN_PLAN_ARTIFACT,
  ALIGN_STAGING_ROOT_REL,
  buildInitialAlignLedger,
  refreshAlignGate,
  type AlignGate,
  type AlignLedger,
  type AlignPlan
} from './align-route.js';

const WIKI_PREFIX = '.sneakoscope/wiki/';

/** Evidence/topology may skip absent optional generated inputs; Align must not treat those as fatal. */
function isArchitectureMapOptionalSkip(skip: ContextGraphSkip): boolean {
  const rel = skip.path.replace(/\\/g, '/');
  if (skip.reason !== 'unreadable' && skip.reason !== 'excluded') return false;
  if (rel === '.sneakoscope/wiki/context-pack.json') return true;
  if (rel.startsWith('.sneakoscope/triwiki/proof-bank')) return true;
  if (rel.startsWith('.sneakoscope/wiki/')) return true;
  return false;
}

function isAlignFatalSkip(skip: ContextGraphSkip): boolean {
  if (!CODE_NAVIGATION_FATAL_SKIP_REASONS.has(skip.reason)) return false;
  return !isArchitectureMapOptionalSkip(skip);
}

if (new Set(ALIGN_OUTPUT_ARTIFACTS).size !== ALIGN_OUTPUT_ARTIFACTS.length) {
  throw new Error('align_output_artifacts_not_unique');
}

export interface ExecuteCodeNavigationAlignResult {
  ok: boolean;
  mission_id: string;
  ledger: AlignLedger;
  gate: AlignGate;
}

interface CodeNavigationManifest {
  schema: 'sks.code-navigation-manifest.v1';
  generated_at: string;
  source_policy: 'repository_code_only';
  exhaustive_graph: 'context-graph.json';
  inventory_digest: string;
  snapshot_hash: string;
  source_file_count: number;
  symbol_count: number;
  edge_count: number;
  extractors: Array<{ id: string; revision: string }>;
  source_files: Array<{
    path: string;
    sha256: string;
    language: string;
    lines: number;
    bytes: number;
    purpose?: string;
  }>;
  edges_by_type: Record<string, number>;
}

interface PriorSurface {
  key: string;
  rel: string;
  absolute: string;
  type: 'file' | 'directory';
  descriptor: string;
}

const ALIGN_REPLACED_SURFACES = Object.freeze([
  { key: 'wiki', rel: '.sneakoscope/wiki' },
  { key: 'memory', rel: '.sneakoscope/memory' },
  { key: 'context_graph_cache', rel: '.sneakoscope/cache/context-graph' },
  { key: 'code_pack_freshness_cache', rel: '.sneakoscope/cache/code-pack-head-freshness.json' },
  { key: 'generated_agents_projection', rel: '.sneakoscope/context/AGENTS.generated.md' },
  { key: 'context_graph_benchmark_report', rel: '.sneakoscope/reports/context-graph-benchmark.json' },
  { key: 'context_graph_experiment_log', rel: '.sneakoscope/reports/context-graph-experiments.jsonl' },
  { key: 'context_graph_optimizer_reports', rel: '.sneakoscope/reports/context-graph-optimizer' }
]);

function relativePosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function countsBy<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function difference(left: readonly string[], right: ReadonlySet<string>): string[] {
  return left.filter((value) => !right.has(value)).sort();
}

function alignGuard(root: string) {
  const contract = createRequestedScopeContract({
    route: '$sks-align',
    userRequest: 'Replace the active TriWiki with the validated code-only generation and retain no previous generation',
    projectRoot: root
  });
  return guardContextForRoute(root, contract, 'transactionally publish the validated code-navigation TriWiki generation');
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeEmptyDirectory(guard: ReturnType<typeof alignGuard>, directory: string): Promise<void> {
  const stat = await lstatOrNull(directory);
  if (!stat?.isDirectory()) return;
  if ((await fsp.readdir(directory)).length > 0) return;
  await guardedRm(guard, directory, { recursive: true, force: false });
}

async function inspectPriorSurfaces(root: string): Promise<PriorSurface[]> {
  const surfaces: PriorSurface[] = [];
  for (const target of ALIGN_REPLACED_SURFACES) {
    const absolute = path.join(root, target.rel);
    const stat = await lstatOrNull(absolute);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`align_prior_surface_symlink_refused:${target.rel}`);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`align_prior_surface_type_refused:${target.rel}`);
    surfaces.push({
      ...target,
      absolute,
      type: stat.isDirectory() ? 'directory' : 'file',
      descriptor: `${target.rel}\u0000${stat.isDirectory() ? 'directory' : 'file'}\u0000${stat.size}\u0000${Math.floor(stat.mtimeMs)}`
    });
  }
  return surfaces;
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

async function writeEvidence(root: string, dir: string, ledger: AlignLedger, missionId: string) {
  await writeJsonAtomic(path.join(dir, ALIGN_LEDGER_ARTIFACT), ledger);
  return (await refreshAlignGate(dir, missionId, root)).gate;
}

function buildManifest(
  generatedAt: string,
  inventory: ReturnType<typeof walkCodeInventory>,
  inventoryDigest: string,
  snapshot: ContextGraphSnapshot
): CodeNavigationManifest {
  return {
    schema: 'sks.code-navigation-manifest.v1',
    generated_at: generatedAt,
    source_policy: 'repository_code_only',
    exhaustive_graph: 'context-graph.json',
    inventory_digest: inventoryDigest,
    snapshot_hash: snapshot.snapshotHash,
    source_file_count: inventory.files.length,
    symbol_count: snapshot.nodes.filter((node) => node.kind === 'symbol').length,
    edge_count: snapshot.edgeCount,
    extractors: snapshot.extractors.map(({ id, revision }) => ({ id, revision })),
    source_files: inventory.files.map((file) => ({
      path: file.rel,
      sha256: file.hash,
      language: file.language,
      lines: file.lines,
      bytes: file.bytes,
      ...(file.purpose ? { purpose: file.purpose } : {})
    })),
    edges_by_type: countsBy(snapshot.edges, (edge) => edge.type)
  };
}

async function validateStaging(input: {
  stageWiki: string;
  root: string;
  snapshot: ContextGraphSnapshot;
  pack: CodePack;
  contextPack: any;
  manifest: CodeNavigationManifest;
}) {
  for (const artifact of ALIGN_OUTPUT_ARTIFACTS) {
    if (!artifact.startsWith(WIKI_PREFIX)) return false;
    const stageFile = path.join(input.stageWiki, artifact.slice(WIKI_PREFIX.length));
    const stat = await fsp.stat(stageFile).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) return false;
  }
  const meta = await readJson<any>(path.join(input.stageWiki, 'context-graph.meta.json'), null);
  if (meta?.snapshotHash !== input.snapshot.snapshotHash || meta?.cacheKeyParts?.sourcePolicy !== 'workspace') return false;
  const manifest = await readJson<any>(path.join(input.stageWiki, 'code-navigation-manifest.json'), null);
  if (manifest?.inventory_digest !== input.manifest.inventory_digest || manifest?.source_file_count !== input.manifest.source_file_count) return false;
  const pack = await readJson<any>(path.join(input.stageWiki, 'code-pack.json'), null);
  const packValidation = await validateCodePack(pack, input.root);
  if (!packValidation.ok || !isCodePackProjectionBoundToSnapshot(input.snapshot.snapshotHash, pack)) return false;
  const contextPack = await readJson<any>(path.join(input.stageWiki, 'context-pack.json'), null);
  return validateCodeNavigationContextPack(contextPack, input.root).ok;
}

async function runLocked(
  root: string,
  dir: string,
  missionId: string,
  plan: AlignPlan,
  ledger: AlignLedger,
  beforeFinalSourceCas?: () => Promise<void>
): Promise<ExecuteCodeNavigationAlignResult> {
  const startedAt = Date.now();
  const guard = alignGuard(root);
  const stageBase = path.join(root, ALIGN_STAGING_ROOT_REL);
  const staleStage = await lstatOrNull(stageBase);
  if (staleStage?.isSymbolicLink()) throw new Error('code_navigation_staging_symlink_refused');
  if (staleStage) {
    await guardedRm(guard, stageBase, { recursive: true, force: true });
    if (await lstatOrNull(stageBase)) throw new Error('code_navigation_stale_staging_not_removed');
  }
  ledger.validation.absent_or_existing_input_supported = plan.requires_cleanup_receipt === false
    && plan.acceptance.absent_or_existing_triwiki_supported === true;
  ledger.validation.prior_state_ignored = true;

  const extractorIdentities = architectureMapGraphExtractors();
  const inventory = walkCodeInventory(root, CODE_NAVIGATION_LIMITS);
  const inputHashes = codeInventoryInputHashes(inventory);
  const codeInventoryDigest = crypto
    .createHash('sha256')
    .update(
      Object.entries(inputHashes)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([relative, hash]) => `${relative}\0${hash}`)
        .join('\n')
    )
    .digest('hex');
  // Architecture Map Align uses the full workspace cache key so topology/evidence
  // inputs (gates, manifests, wiki, proofs) participate in freshness.
  const cacheKey = await computeContextGraphCacheKey({ root, extractors: extractorIdentities });
  const fatalSkips = inventory.skipped.filter((skip) => isAlignFatalSkip(skip));
  ledger.scan.inventory_digest = codeInventoryDigest;
  ledger.scan.source_file_count = inventory.files.length;
  ledger.scan.source_bytes = inventory.files.reduce((sum, file) => sum + file.bytes, 0);
  ledger.scan.source_lines = inventory.files.reduce((sum, file) => sum + file.lines, 0);
  ledger.scan.languages = countsBy(inventory.files, (file) => file.language);
  ledger.scan.allowed_exclusions = inventory.skipped
    .filter((skip) => !isAlignFatalSkip(skip))
    .map((skip) => ({ path: skip.path, reason: skip.reason }));
  ledger.scan.fatal_skips = fatalSkips.map((skip) => ({ ...skip }));
  ledger.validation.source_inventory_complete = fatalSkips.length === 0;
  if (fatalSkips.length) throw new Error(`code_navigation_fatal_skips:${fatalSkips.map((skip) => `${skip.reason}:${skip.path}`).join('|')}`);

  const extractors = architectureMapGraphExtractors({ preparedInventory: inventory });
  const generatedAt = nowIso();
  const compiled = await compileContextGraph({
    root,
    extractors,
    changedPaths: null,
    limits: CODE_NAVIGATION_LIMITS,
    observedAt: generatedAt,
    useFragmentCache: false,
    cacheKey,
    persistArtifacts: false,
    useCompileLock: false
  });
  ledger.validation.graph_compile = compiled.ok;
  const compileFatal = compiled.skipped.filter((skip) => isAlignFatalSkip(skip));
  if (compileFatal.length) ledger.scan.fatal_skips.push(...compileFatal.map((skip) => ({ ...skip })));
  if (!compiled.ok || !compiled.snapshot || !compiled.meta || compileFatal.length) {
    throw new Error(`code_navigation_compile_blocked:${compiled.blockers.concat(compileFatal.map((skip) => `${skip.reason}:${skip.path}`)).join('|')}`);
  }
  const snapshot = compiled.snapshot;
  const meta = compiled.meta;
  ledger.graph.snapshot_hash = snapshot.snapshotHash;
  ledger.graph.extractor_ids = snapshot.extractors.map((extractor) => extractor.id).sort();
  ledger.graph.file_nodes = snapshot.nodes.filter((node) => node.kind === 'file').length;
  ledger.graph.symbol_nodes = snapshot.nodes.filter((node) => node.kind === 'symbol').length;
  ledger.graph.module_nodes = snapshot.nodes.filter((node) => node.kind === 'module').length;
  ledger.graph.test_nodes = snapshot.nodes.filter((node) => node.kind === 'test').length;
  ledger.graph.edge_count = snapshot.edgeCount;
  ledger.graph.edges_by_type = countsBy(snapshot.edges, (edge) => edge.type);
  const inventoryPaths = inventory.files.map((file) => file.rel).sort();
  const fileNodePaths = snapshot.nodes.filter((node) => node.kind === 'file').map((node) => String(node.path || '')).filter(Boolean).sort();
  const inventorySet = new Set(inventoryPaths);
  const fileNodeSet = new Set(fileNodePaths);
  ledger.graph.missing_files = difference(inventoryPaths, fileNodeSet);
  ledger.graph.unexpected_files = difference(fileNodePaths, inventorySet);
  ledger.graph.exact_file_coverage = ledger.graph.missing_files.length === 0
    && ledger.graph.unexpected_files.length === 0
    && fileNodePaths.length === inventoryPaths.length;
  if (!ledger.graph.exact_file_coverage) throw new Error('code_navigation_exact_file_coverage_failed');
  const expectedExtractors = [...ARCHITECTURE_MAP_EXTRACTOR_IDS];
  if (ledger.graph.extractor_ids.length !== expectedExtractors.length
    || expectedExtractors.some((id, index) => ledger.graph.extractor_ids[index] !== id)) {
    throw new Error(`code_navigation_architecture_map_extractors_mismatch:${ledger.graph.extractor_ids.join(',')}`);
  }
  const graphValidation = validateContextGraphSnapshot(snapshot);
  ledger.validation.graph_schema = graphValidation.ok;
  if (!graphValidation.ok || meta.cacheKeyParts.sourcePolicy !== 'workspace') {
    throw new Error('code_navigation_graph_validation_failed');
  }

  const stageRoot = path.join(stageBase, `${missionId}-${randomUUID().slice(0, 8)}`);
  // The staged wiki is the `.sneakoscope/wiki` of a pending workspace root, so the
  // CRK2 generation store publishes at the workspace-relative paths it will keep
  // after promotion. See `align-context-index.ts` for why neither publishing into
  // the live root before the rename nor after it can work.
  const pendingRoot = alignPendingRoot(stageRoot);
  const stageWiki = alignPendingWiki(stageRoot);
  const previousRoot = path.join(stageRoot, 'previous');
  const activeWiki = path.join(root, '.sneakoscope', 'wiki');
  const movedPrior: Array<{ surface: PriorSurface; temporary: string }> = [];
  let promoted = false;
  let projection: ProjectorTransaction | null = null;
  let commitStarted = false;
  try {
    await ensureDir(stageWiki);
    // The v2 generation is published *before* the pack, because the pack is
    // projected from the published generation through the query facade. A publish
    // failure throws here, leaving the live wiki — and its pointer — untouched.
    const sourceFingerprint = alignSourceFingerprint(inputHashes);
    const published = await publishAlignContextIndex({
      pendingRoot,
      snapshot,
      sourceFingerprint,
      fragmentManifestHash: null,
      lintWarnings: compiled.issues.length
    });
    const pack = await projectAlignCodePack({
      root,
      pendingRoot,
      gitHeadSha: meta.cacheKeyParts.head,
      generatedAt,
      sourceFingerprint: published.sourceFingerprint
    });
    const packValidation = await validateCodePack(pack, root);
    ledger.validation.code_pack = packValidation.ok
      && pack.source_file_count === inventoryPaths.length
      && isCodePackProjectionBoundToSnapshot(snapshot.snapshotHash, pack);
    if (!ledger.validation.code_pack) throw new Error(`code_navigation_code_pack_invalid:${packValidation.issues.join('|')}`);
    const contextPack = buildCodeNavigationContextPack({
      root,
      codePack: pack,
      snapshotHash: snapshot.snapshotHash,
      fileCount: inventoryPaths.length,
      symbolCount: ledger.graph.symbol_nodes,
      edgeCount: snapshot.edgeCount,
      extractorRevisions: snapshot.extractors.map(({ id, revision }) => ({ id, revision }))
    });
    const contextValidation = validateCodeNavigationContextPack(contextPack, root);
    ledger.validation.context_pack = contextValidation.ok;
    if (!contextValidation.ok) throw new Error('code_navigation_context_pack_invalid');
    const manifest = buildManifest(generatedAt, inventory, codeInventoryDigest, snapshot);
    await writeJsonAtomic(path.join(stageWiki, 'context-graph.json'), snapshot);
    await writeJsonAtomic(path.join(stageWiki, 'context-graph.meta.json'), meta);
    await writeJsonAtomic(path.join(stageWiki, 'code-navigation-manifest.json'), manifest);
    await writeJsonAtomic(path.join(stageWiki, 'code-pack.json'), pack);
    await writeJsonAtomic(path.join(stageWiki, 'context-pack.json'), contextPack);
    await publishArchitectureMapToStage(stageWiki, snapshot, { root, missionId });
    ledger.publication.staged = true;
    ledger.validation.staged_readback = await validateStaging({ stageWiki, root, snapshot, pack, contextPack, manifest });
    if (!ledger.validation.staged_readback) throw new Error('code_navigation_staging_validation_failed');

    const prior = await inspectPriorSurfaces(root);
    ledger.input_state.mode = prior.length ? 'existing' : 'absent';
    ledger.input_state.active_surfaces_at_start = prior.map((surface) => surface.rel).sort();
    ledger.input_state.prior_state_digest = prior.length
      ? crypto.createHash('sha256').update(prior.map((surface) => surface.descriptor).sort().join('\n')).digest('hex')
      : null;
    for (const surface of prior) {
      const temporary = path.join(previousRoot, surface.key);
      await ensureDir(path.dirname(temporary));
      await guardedRename(guard, surface.absolute, temporary);
      movedPrior.push({ surface, temporary });
    }
    await ensureDir(path.dirname(activeWiki));
    await guardedRename(guard, stageWiki, activeWiki);
    promoted = true;
    clearContextGraphSnapshotCache();
    // The published generation moved with the directory, so any reader resident
    // from before the rename describes a store that no longer exists.
    clearWorkspaceContextIndex(root);
    ledger.publication.transactional_directory_replaced = true;
    ledger.publication.active_artifacts = [...ALIGN_OUTPUT_ARTIFACTS];

    projection = await projectTriwikiToAgentsMdTransactional(root);
    ledger.validation.projection = projection.report.ok;
    if (!projection.report.ok) throw new Error(`code_navigation_projection_failed:${projection.report.reason}`);
    const projectionPaths = [...new Set(projection.report.written)].sort();
    ledger.publication.agents_projections = [];
    for (const file of projectionPaths) {
      ledger.publication.agents_projections.push({ path: relativePosix(root, file), sha256: await fileSha256(file) });
    }
    ledger.publication.artifact_sha256 = {};
    for (const artifact of ALIGN_OUTPUT_ARTIFACTS) {
      ledger.publication.artifact_sha256[artifact] = await fileSha256(path.join(root, artifact));
    }
    ledger.validation.artifact_hashes = Object.keys(ledger.publication.artifact_sha256).length === ALIGN_OUTPUT_ARTIFACTS.length;

    await beforeFinalSourceCas?.();
    const finalInventory = walkCodeInventory(root, CODE_NAVIGATION_LIMITS);
    const finalFatal = finalInventory.skipped.filter((skip) => isAlignFatalSkip(skip));
    const finalCacheKey = await computeContextGraphCacheKey({ root, extractors: extractorIdentities });
    const finalCodeDigest = crypto
      .createHash('sha256')
      .update(
        Object.entries(codeInventoryInputHashes(finalInventory))
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([relative, hash]) => `${relative}\0${hash}`)
          .join('\n')
      )
      .digest('hex');
    // Align rewrites `.sneakoscope/wiki/**`, so CAS compares code + topology inputs only —
    // not wikiContextHash / git dirty fingerprints that always move during promotion.
    const casStable =
      finalCacheKey.parts.tsconfigHash === cacheKey.parts.tsconfigHash
      && finalCacheKey.parts.commandManifestHash === cacheKey.parts.commandManifestHash
      && finalCacheKey.parts.gateManifestHash === cacheKey.parts.gateManifestHash
      && finalCacheKey.parts.schemaRevision === cacheKey.parts.schemaRevision
      && finalCacheKey.parts.proofIndexHash === cacheKey.parts.proofIndexHash
      && finalCodeDigest === codeInventoryDigest;
    ledger.scan.source_cas_verified = finalFatal.length === 0 && casStable;
    if (!ledger.scan.source_cas_verified) throw new Error('code_navigation_source_changed_during_scan');

    commitStarted = true;
    if (await lstatOrNull(stageBase)) await guardedRm(guard, stageBase, { recursive: true, force: true });
    if (await lstatOrNull(stageBase)) throw new Error('code_navigation_temporary_swap_not_removed');
    await removeEmptyDirectory(guard, path.dirname(stageBase));
    ledger.publication.previous_generation_retained = false;
    ledger.publication.temporary_swap_removed = true;
    ledger.scan.duration_ms = Date.now() - startedAt;
    ledger.status = 'complete';
    ledger.generated_at = nowIso();
    const gate = await writeEvidence(root, dir, ledger, missionId);
    if (!gate.passed) throw new Error(`code_navigation_gate_blocked:${gate.blockers.join('|')}`);
    return { ok: true, mission_id: missionId, ledger, gate };
  } catch (error) {
    const rollbackFailures: string[] = [];
    if (!commitStarted) {
      if (projection) {
        try {
          await projection.rollback();
        } catch (rollbackError) {
          rollbackFailures.push(`projection:${String(rollbackError)}`);
        }
      }
      if (promoted) {
        try {
          await ensureDir(path.dirname(stageWiki));
          await guardedRename(guard, activeWiki, stageWiki);
          clearContextGraphSnapshotCache();
          clearWorkspaceContextIndex(root);
        } catch (rollbackError) {
          rollbackFailures.push(`wiki:${String(rollbackError)}`);
        }
      }
      for (const entry of [...movedPrior].reverse()) {
        try {
          if (await lstatOrNull(entry.temporary)) {
            await ensureDir(path.dirname(entry.surface.absolute));
            await guardedRename(guard, entry.temporary, entry.surface.absolute);
          }
        } catch (rollbackError) {
          rollbackFailures.push(`prior:${entry.surface.rel}:${String(rollbackError)}`);
        }
      }
    }
    if (await lstatOrNull(stageBase)) {
      try {
        await guardedRm(guard, stageBase, { recursive: true, force: true });
      } catch (cleanupError) {
        rollbackFailures.push(`staging:${String(cleanupError)}`);
      }
    }
    if (rollbackFailures.length) throw new Error(`${String(error)};align_rollback_or_cleanup_failed:${rollbackFailures.join('|')}`);
    throw error;
  }
}

export async function executeCodeNavigationAlign(input: {
  root: string;
  missionDir: string;
  missionId: string;
  beforeFinalSourceCas?: () => Promise<void>;
}): Promise<ExecuteCodeNavigationAlignResult> {
  const root = path.resolve(input.root);
  const plan = await readJson<AlignPlan | null>(path.join(input.missionDir, ALIGN_PLAN_ARTIFACT), null);
  const ledger = buildInitialAlignLedger(input.missionId);
  if (!plan || plan.schema !== 'sks.align-plan.v3' || plan.mission_id !== input.missionId) {
    ledger.status = 'blocked';
    ledger.blockers = ['align_plan_missing_or_stale'];
    const gate = await writeEvidence(root, input.missionDir, ledger, input.missionId);
    return { ok: false, mission_id: input.missionId, ledger, gate };
  }
  try {
    return await withTriWikiStateLock(root, () => runLocked(
      root,
      input.missionDir,
      input.missionId,
      plan,
      ledger,
      input.beforeFinalSourceCas
    ));
  } catch (error) {
    ledger.status = 'blocked';
    ledger.scan.duration_ms ||= 0;
    ledger.blockers = [...new Set([...ledger.blockers, String(error instanceof Error ? error.message : error)])];
    ledger.generated_at = nowIso();
    const gate = await writeEvidence(root, input.missionDir, ledger, input.missionId);
    return { ok: false, mission_id: input.missionId, ledger, gate };
  }
}
