import path from 'node:path';
import fsp from 'node:fs/promises';
import { appendJsonlBounded, ensureDir, exists, formatBytes, nowIso, PACKAGE_VERSION, readJson, runProcess, sksRoot, writeJsonAtomic } from '../fsx.js';
import { contextCapsule } from '../triwiki-attention.js';
import { rgbaKey, rgbaToWikiCoord, validateWikiCoordinateIndex } from '../wiki-coordinate.js';
import { pruneWikiArtifacts } from '../retention.js';
import { stackCurrentDocsPolicy } from '../routes.js';
import { writeMemorySweepReport } from '../memory-governor.js';
import { writeSkillForgeReport } from '../skill-forge.js';
import { writeMistakeMemoryReport } from '../mistake-memory.js';
import { writeCodeStructureReport } from '../code-structure.js';
import { rebuildMemorySummaries } from '../memory-summary.js';
import { missionDir, createMission } from '../mission.js';
import { addImageRelation, addVisualAnchor, ingestImage, imageVoxelSummary, readImageVoxelLedger } from '../wiki-image/image-voxel-ledger.js';
import { imageVoxelProofEvidence } from '../wiki-image/proof-linker.js';
import { validateImageVoxelLedger } from '../wiki-image/validation.js';
import { maybeFinalizeRoute } from '../proof/auto-finalize.js';
import { wikiWrongnessCommand } from '../triwiki-wrongness/wrongness-cli.js';
import { wrongnessContextForRoute } from '../triwiki-wrongness/wrongness-retrieval.js';
import { readCombinedWrongnessRecords } from '../triwiki-wrongness/wrongness-ledger.js';
import { recordImageWrongnessFromValidation } from '../triwiki-wrongness/image-wrongness.js';
import { publishSharedMemory, rebuildSharedIndexes, sharedMemorySummary, validateSharedMemory } from '../git-hygiene/shared-memory-publish.js';
import {
  codePackPath,
  isCodePackProjectionBoundToSnapshot,
  validateCodePack,
  writeCodePackAtomic,
  type CodePack
} from '../triwiki/code-pack.js';
import { repairTriWikiProofIndex } from '../triwiki/triwiki-proof-bank-index.js';
import { runContextGraphLint } from '../triwiki/context-graph/lint/index.js';
import { contextGraphStatus } from '../triwiki/context-graph/store/graph-status.js';
import { readContextGraphMeta, readContextGraphSnapshot } from '../triwiki/context-graph/store/snapshot-store.js';
import { compileContextGraph } from '../triwiki/context-graph/compiler/index.js';
import { contextGraphExtractors } from '../triwiki/context-graph/extractors/index.js';
import { buildWorkspaceCodePack } from '../triwiki/context-graph/projections/code-pack-workspace.js';
import { CONTEXT_GRAPH_REPAIR_COMMAND } from '../triwiki/context-graph/contracts.js';
import { inspectCodePackHeadFreshness } from '../triwiki/code-pack-head-freshness.js';
import { sealTriWikiContextPack, validateTriWikiContextPackProvenance } from '../triwiki-provenance.js';
import { flag, positionalArgs, readFlagValue, readOption, resolveMissionId } from './command-utils.js';

export async function wikiCommand(sub: any, args: any = []) {
  if (!sub || sub === 'help' || sub === '--help') {
    console.log('Usage: sks wiki coords --rgba R,G,B,A | sks wiki pack|refresh|publish|rebuild-index|rebuild-summary|validate|validate-shared|wrongness | sks wiki image-ingest|anchor-add|relation-add|image-validate|image-summary');
    return;
  }
  if (sub === 'image-ingest') return wikiImageIngest(args);
  if (sub === 'image-validate') return wikiImageValidate(args);
  if (sub === 'image-summary') return wikiImageSummary(args);
  if (sub === 'wrongness') return wikiWrongnessCommand(args);
  if (sub === 'anchor-add') return wikiAnchorAdd(args);
  if (sub === 'relation-add') return wikiRelationAdd(args);
  if (sub === 'image-link-proof') return wikiImageLinkProof(args);
  if (sub === 'coords') {
    const raw = readFlagValue(args, '--rgba', positionalArgs(args)[0] || '');
    const parts = String(raw).split(/[,\s]+/).filter(Boolean).map((x: any) => Number.parseInt(x, 10));
    if (parts.length < 3) throw new Error('Usage: sks wiki coords --rgba R,G,B,A');
    const coord = rgbaToWikiCoord({ r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 255 });
    console.log(JSON.stringify({ rgba: coord.rgba, rgba_key: rgbaKey(coord.rgba), coord }, null, 2));
    return;
  }
  if (sub === 'pack') {
    const root = await sksRoot();
    const { pack, file, written, validation } = await writeWikiContextPack(root, args);
    process.exitCode = validation.result.ok ? 0 : 2;
    if (flag(args, '--json')) return console.log(JSON.stringify({ ...pack, path: file, written, validation }, null, 2));
    printWikiPackSummary(root, file, pack);
    console.log(`Validation: ${validation.result.ok ? 'ok' : 'failed'} (${validation.result.checked} anchors)`);
    return;
  }
  if (sub === 'publish') {
    const root = await sksRoot();
    if (!flag(args, '--shared')) throw new Error('Usage: sks wiki publish latest --shared [--redact] [--json]');
    const target = positionalArgs(args)[0] || 'latest';
    if (target !== 'latest') throw new Error('Usage: sks wiki publish latest --shared [--redact] [--json]');
    const result = await publishSharedMemory(root, { target: 'wiki', redact: flag(args, '--redact') });
    process.exitCode = result.ok ? 0 : 2;
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Shared wiki publish: ${result.ok ? 'ok' : 'blocked'}`);
    console.log(`Written: ${result.written.length}`);
    for (const blocker of result.blockers) console.log(`- ${blocker}`);
    return;
  }
  if (sub === 'rebuild-index') {
    const root = await sksRoot();
    const result = await rebuildSharedIndexes(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Shared wiki indexes rebuilt: ${result.indexes.join(', ')}`);
    return;
  }
  if (sub === 'validate-shared') {
    const root = await sksRoot();
    const result = await validateSharedMemory(root);
    process.exitCode = result.ok ? 0 : 2;
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Shared wiki validation: ${result.ok ? 'ok' : 'failed'} (${result.checked} checked)`);
    for (const issue of result.issues) console.log(`- ${issue}`);
    return;
  }
  if (sub === 'shared-summary') {
    const root = await sksRoot();
    const result = await sharedMemorySummary(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Shared wiki summary: ${result.ok ? 'ok' : 'blocked'} (${result.files} files)`);
    return;
  }
  if (sub === 'rebuild-summary') {
    const root = await sksRoot();
    const result = await rebuildMemorySummaries(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Memory summary rebuilt: ${result.ok ? 'ok' : 'blocked'}`);
    return;
  }
  if (sub === 'refresh' && flag(args, '--code')) {
    return wikiRefreshCode(args);
  }
  if (sub === 'refresh') {
    const root = await sksRoot();
    const dryRun = flag(args, '--dry-run');
    const { pack, file, written, validation } = await writeWikiContextPack(root, args, { dryRun });
    const exitCode = validation.result.ok ? 0 : 2;
    const pruneRequested = flag(args, '--prune');
    const pruneResult = pruneRequested ? await pruneWikiArtifacts(root, { dryRun }) : null;
    if (!dryRun) {
      const { id, dir } = await createMission(root, { mode: 'wiki', prompt: 'sks wiki refresh' });
      const gateBlockers = wikiGateBlockers(validation.result.ok, validation.result.issues, 'wiki_context_pack_validation_failed');
      const gate = { schema_version: 1, passed: validation.result.ok, ok: validation.result.ok, blockers: gateBlockers, context_pack: '.sneakoscope/wiki/context-pack.json', anchors: wikiAnchorCount(pack.wiki), voxels: wikiVoxelRowCount(pack.wiki) };
      await writeJsonAtomic(path.join(dir, 'wiki-gate.json'), gate);
      await maybeFinalizeRoute(root, {
        missionId: id,
        route: '$Wiki',
        gateFile: 'wiki-gate.json',
        gate,
        artifacts: ['wiki-gate.json', 'completion-proof.json'],
        statusHint: validation.result.ok ? 'verified_partial' : 'blocked',
        blockers: gateBlockers,
        command: { cmd: 'sks wiki refresh', status: exitCode },
        failureAnalysis: wikiRefreshFailureAnalysis(validation.result, gate)
      });
    }
    if (flag(args, '--json')) {
      process.exitCode = exitCode;
      return console.log(JSON.stringify({
        path: file,
        dryRun,
        written,
        claims: pack.claims.length,
        anchors: wikiAnchorCount(pack.wiki),
        attention: wikiAttentionSummary(pack),
        trust_summary: pack.trust_summary,
        validation,
        ...(pruneResult ? { prune: { dryRun: pruneResult.dryRun, scanned: pruneResult.scanned, candidates: pruneResult.candidates, actions: pruneResult.actions } } : {})
      }, null, 2));
    }
    console.log('Sneakoscope LLM Wiki Refresh');
    if (dryRun) console.log('Dry run: context pack was built and validated in memory; no wiki file was written.');
    printWikiPackSummary(root, file, pack);
    console.log(`Validation: ${validation.result.ok ? 'ok' : 'failed'} (${validation.result.checked} anchors, ${validation.trustAnchors} trust anchors)`);
    if (pruneResult) {
      console.log(`${pruneResult.dryRun ? 'Prune dry run' : 'Prune'}: ${pruneResult.candidates} wiki artifact(s), ${pruneResult.scanned} scanned`);
      for (const a of pruneResult.actions.slice(0, 20)) console.log(`- ${a.reason} ${path.relative(root, a.path)} ${a.bytes ? formatBytes(a.bytes) : ''}`.trim());
    } else {
      console.log('Prune: skipped (pass --prune to prune stale/low-trust wiki artifacts)');
    }
    process.exitCode = exitCode;
    return;
  }
  if (sub === 'prune') {
    const root = await sksRoot();
    const pruneResult = await pruneWikiArtifacts(root, { dryRun: flag(args, '--dry-run') });
    if (flag(args, '--json')) return console.log(JSON.stringify({ dryRun: pruneResult.dryRun, scanned: pruneResult.scanned, candidates: pruneResult.candidates, actions: pruneResult.actions }, null, 2));
    console.log('Sneakoscope LLM Wiki Prune');
    console.log(`${pruneResult.dryRun ? 'Dry run' : 'Pruned'}: ${pruneResult.candidates} wiki artifact(s), ${pruneResult.scanned} scanned`);
    return;
  }
  if (sub === 'sweep') {
    const root = await sksRoot();
    const id = await resolveMissionId(root, positionalArgs(args)[0]);
    const dir = id ? missionDir(root, id) : path.join(root, '.sneakoscope', 'reports');
    const report = await writeMemorySweepReport(root, dir, { missionId: id || 'project-wiki' });
    if (id) {
      await writeSkillForgeReport(dir, { mission_id: id, route: 'wiki', task_signature: 'memory sweep' });
      await writeMistakeMemoryReport(dir, { mission_id: id, route: 'wiki', task: 'memory sweep' });
      await writeCodeStructureReport(root, dir, { missionId: id, exception: 'Generated by wiki sweep; split decisions are reported, not applied automatically.' });
    }
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log('Sneakoscope TriWiki Sweep');
    console.log(`Operations: ${report.operations.length}`);
    console.log(`Forget queue: ${report.operations.filter((op: any) => ['DEMOTE', 'SOFT_FORGET', 'ARCHIVE', 'HARD_DELETE', 'CONSOLIDATE'].includes(op.operation)).length}`);
    console.log(`Budget: ${report.retrieval_budget.actual_tokens}/${report.retrieval_budget.max_tokens} tokens`);
    return;
  }
  if (sub === 'validate') {
    const root = await sksRoot();
    const target = positionalArgs(args)[0] || path.join(root, '.sneakoscope', 'wiki', 'context-pack.json');
    const pack = await readJson(path.resolve(target));
    const { result, trustAnchors } = wikiValidationResult(pack, root);
    const codePack = await codePackFreshness(root);
    const graph = await wikiValidateContextGraph(root);
    const ok = result.ok && graph.ok;
    process.exitCode = ok ? 0 : 2;
    if (flag(args, '--json')) {
      return console.log(JSON.stringify({ ...result, ok, code_pack: codePack, context_graph: graph }, null, 2));
    }
    console.log(`Wiki coordinate index: ${result.ok ? 'ok' : 'failed'}`);
    console.log(`Anchors checked: ${result.checked}`);
    console.log(`Trust anchors: ${trustAnchors}/${result.checked}`);
    for (const issue of result.issues) console.log(`- ${issue.severity}: ${issue.id}${issue.anchor ? ` ${issue.anchor}` : ''}`);
    console.log(`Code pack: ${codePack.status}${codePack.status === 'stale' ? ` — run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\`` : ''}`);
    console.log(`Context graph: ${graph.status}${graph.ok ? '' : ` — run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\``}`);
    for (const issue of graph.issues) console.log(`- ${issue}`);
    return;
  }
  console.error('Usage: sks wiki coords|pack|refresh|publish|rebuild-index|rebuild-summary|validate|validate-shared|wrongness|image-ingest|anchor-add|relation-add|image-validate|image-summary');
  process.exitCode = 1;
}

/**
 * Graph half of `sks wiki validate`: schema and lint, snapshot/meta parity,
 * source-hash freshness, and projection parity between the snapshot and the
 * code pack that was projected from it. A stale or missing graph is reported,
 * never repaired here — repair belongs to `sks wiki refresh --code`.
 */
async function wikiValidateContextGraph(root: string): Promise<{ ok: boolean; status: string; snapshot_hash: string | null; issues: string[] }> {
  const status = await contextGraphStatus(root, { extractors: contextGraphExtractors() });
  if (status.status !== 'fresh') {
    return {
      ok: false,
      status: status.status,
      snapshot_hash: status.snapshotHash,
      issues: [status.errorCode ?? 'context_graph_not_fresh', ...status.reasons]
    };
  }
  const snapshotLoad = await readContextGraphSnapshot(root);
  const metaLoad = await readContextGraphMeta(root);
  if (snapshotLoad.status !== 'ok' || !snapshotLoad.snapshot || metaLoad.status !== 'ok' || !metaLoad.meta) {
    return { ok: false, status: 'corrupt', snapshot_hash: status.snapshotHash, issues: ['context_graph_snapshot_meta_unreadable'] };
  }
  const lint = runContextGraphLint({ root, snapshot: snapshotLoad.snapshot, meta: metaLoad.meta });
  const issues = lint.errors.slice(0, 20).map((issue) => `${issue.code}: ${issue.message}`);
  // Projection parity: a code pack that does not name the snapshot it came from
  // is a pack from some other graph generation.
  const pack = await readJson<CodePack | null>(codePackPath(root), null).catch(() => null);
  const digest = typeof pack?.index_digest === 'string' ? pack.index_digest : '';
  const boundToSnapshot = Boolean(
    pack
    && Array.isArray(pack.entries)
    && isCodePackProjectionBoundToSnapshot(snapshotLoad.snapshot.snapshotHash, pack)
  );
  if (digest && !boundToSnapshot) issues.push('code_pack_not_bound_to_current_snapshot');
  return {
    ok: lint.ok && (!digest || boundToSnapshot),
    status: 'fresh',
    snapshot_hash: snapshotLoad.snapshot.snapshotHash,
    issues
  };
}

/**
 * `sks wiki refresh --code` owns the full graph rebuild: compile the Context
 * Graph incrementally, lint it, write the snapshot atomically, then project the
 * code pack from that snapshot. There is no second scanner running alongside —
 * the graph is the single compiled source and the pack is its projection.
 */
async function wikiRefreshCode(args: any = []): Promise<void> {
  const root = await sksRoot();
  const tokenBudgetRaw = readFlagValue(args, '--token-budget', null);
  const parsedBudget = tokenBudgetRaw ? Number.parseInt(String(tokenBudgetRaw), 10) : Number.NaN;
  const tokenBudget = Number.isFinite(parsedBudget) ? parsedBudget : undefined;

  // This is the explicit maintenance path, so it is where the proof reverse
  // index is seeded or healed. Proof writes deliberately never walk the bank to
  // create it, and the evidence extractor needs it to avoid a directory read.
  const proofIndex = repairTriWikiProofIndex(root);

  const compiled = await compileContextGraph({ root, extractors: contextGraphExtractors() });
  const lintErrors = compiled.issues.filter((issue: any) => issue.severity === 'error');
  if (!compiled.ok || !compiled.snapshot) {
    const blocked = {
      schema: 'sks.wiki-refresh-code.v1',
      ok: false,
      reason: compiled.reason ?? 'context_graph_compile_failed',
      blockers: compiled.blockers ?? [],
      issues: lintErrors.slice(0, 20).map((issue: any) => `${issue.code}: ${issue.message}`),
      repair_command: CONTEXT_GRAPH_REPAIR_COMMAND,
      written: null
    };
    process.exitCode = 2;
    process.stderr.write(`wiki-refresh-code: root=${root} graph=blocked reason=${blocked.reason} blockers=${JSON.stringify(blocked.blockers)}\n`);
    if (flag(args, '--json')) return console.log(JSON.stringify(blocked, null, 2));
    console.log('Sneakoscope TriWiki Context Graph Refresh');
    console.log(`Context graph: blocked (${blocked.reason})`);
    for (const issue of blocked.issues) console.log(`- ${issue}`);
    return;
  }

  const projected = await buildWorkspaceCodePack(root, {
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    status: { status: 'fresh', snapshotHash: compiled.snapshotHash }
  });
  const pack = projected.pack;
  const validation = pack ? await validateCodePack(pack, root) : { ok: false, issues: projected.errors };
  const written = pack && validation.ok ? await writeCodePackAtomic(root, pack) : null;

  const result = {
    schema: 'sks.wiki-refresh-code.v1',
    ok: validation.ok,
    issues: validation.issues,
    snapshot_hash: compiled.snapshotHash,
    nodes: compiled.snapshot.nodeCount,
    edges: compiled.snapshot.edgeCount,
    graph_warnings: compiled.issues.filter((issue: any) => issue.severity === 'warning').length,
    incremental: Boolean(compiled.incremental),
    proof_index: { ok: proofIndex.ok, indexed: proofIndex.indexed_count, previous_status: proofIndex.previous_status },
    compile_ms: compiled.durationMs,
    entries: pack ? pack.entries.length : 0,
    token_cost: pack ? pack.total_token_cost : 0,
    token_budget: pack ? pack.token_budget : 0,
    written: written ? written.path : null
  };
  process.exitCode = validation.ok ? 0 : 2;
  // Always note the counts/issues on stderr (even in --json mode, where stdout must
  // stay pure JSON) so a blocked run is diagnosable from stderr_tail alone without
  // needing to reproduce it separately in an isolated environment.
  process.stderr.write(`wiki-refresh-code: root=${root} nodes=${result.nodes} edges=${result.edges} entries=${result.entries} token_cost=${result.token_cost}/${result.token_budget} issues=${JSON.stringify(validation.issues)}\n`);
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('Sneakoscope TriWiki Context Graph Refresh');
  console.log(`Context graph: ok (${result.nodes} nodes, ${result.edges} edges, snapshot ${String(result.snapshot_hash).slice(0, 12)})`);
  console.log(`Code pack projection: ${validation.ok ? 'ok' : 'blocked'} (${result.entries} entries, ${result.token_cost}/${result.token_budget} tokens)`);
  for (const issue of validation.issues) console.log(`- ${issue}`);
}

/** Cheap freshness check: compares the code pack's recorded git HEAD sha (at
 * generation time) against the current HEAD. A commit containing only the two
 * tracked code-pack metadata files is equivalent to the generating HEAD, which
 * avoids an impossible self-referential commit hash. Any other uncertainty
 * resolves to 'stale' rather than 'fresh', never overclaiming. */
/** Active-wrongness counts per TriWiki module id (from wrongness records' module_ids),
 * so attention can hydrate frequently-wrong modules' code entries first. */
async function buildWrongnessByModule(root: any): Promise<Record<string, number>> {
  const records = await readCombinedWrongnessRecords(root, null).catch(() => []);
  const counts: Record<string, number> = {};
  for (const record of records) {
    if ((record as any)?.status && (record as any).status !== 'active') continue;
    for (const moduleId of Array.isArray((record as any)?.module_ids) ? (record as any).module_ids : []) {
      if (moduleId) counts[moduleId] = (counts[moduleId] || 0) + 1;
    }
  }
  return counts;
}

async function codePackFreshness(root: any): Promise<{ status: 'fresh' | 'stale' | 'missing'; git_head_sha: string | null; pack_sha: string | null }> {
  const packPath = path.join(root, '.sneakoscope', 'wiki', 'code-pack.json');
  if (!(await exists(packPath))) return { status: 'missing', git_head_sha: null, pack_sha: null };
  const pack = await readJson<any>(packPath, null).catch(() => null);
  const packSha = pack?.git_head_sha || null;
  if (!packSha) return { status: 'missing', git_head_sha: null, pack_sha: null };
  const freshness = await inspectCodePackHeadFreshness(root, packSha, { timeoutMs: 5_000 });
  return {
    status: freshness.fresh ? 'fresh' : 'stale',
    git_head_sha: freshness.current_sha,
    pack_sha: freshness.pack_sha
  };
}

function wikiRefreshFailureAnalysis(validationResult: any, gate: any = {}) {
  if (validationResult?.ok) {
    return {
      status: 'complete',
      root_cause: 'Wiki refresh intentionally finalizes as verified_partial because a context-pack refresh can verify TriWiki schema and anchors, but active wrongness memory may still prevent full trust verification.',
      corrective_action: 'The Wiki route records the fresh context-pack validation, wiki gate counts, and completion-proof evidence while keeping the route below full verified status until wrongness memory is separately resolved.',
      evidence: [
        '.sneakoscope/wiki/context-pack.json',
        'wiki-gate.json',
        { anchors: gate.anchors || 0, voxels: gate.voxels || 0 }
      ]
    };
  }
  const blockers = wikiGateBlockers(false, validationResult?.issues, 'wiki_context_pack_validation_failed');
  return {
    status: 'complete',
    root_cause: `Wiki context-pack validation failed during refresh: ${blockers.join(', ')}.`,
    corrective_action: 'The Wiki route finalized as blocked and preserved validation issues in the completion proof so the context pack can be corrected before any completion claim.',
    evidence: [
      '.sneakoscope/wiki/context-pack.json',
      'wiki-gate.json',
      ...blockers
    ]
  };
}

async function wikiImageIngest(args: any = []) {
  const root = await sksRoot();
  const imagePath = args.find((arg: any, i: any) => i >= 0 && !String(arg).startsWith('--'));
  const { id, dir } = await createMission(root, { mode: 'wiki', prompt: `sks wiki image-ingest ${imagePath || ''}`.trim() });
  const result = await ingestImage(root, imagePath, { source: readOption(args, '--source', 'manual'), missionId: readOption(args, '--mission-id', id) || id });
  const gateBlockers = wikiGateBlockers(result.ok, result.validation?.issues, 'wiki_image_ingest_validation_failed');
  const gate = { schema_version: 1, passed: result.ok, ok: result.ok, blockers: gateBlockers, image_id: result.image.id, image_voxel_ledger: 'image-voxel-ledger.json' };
  await writeJsonAtomic(path.join(dir, 'wiki-image-gate.json'), gate);
  const fixtureMode = flag(args, '--mock') || String(imagePath || '').includes('test/fixtures/images/');
  const proof = await maybeFinalizeRoute(root, { missionId: id, route: '$Wiki', gateFile: 'wiki-image-gate.json', gate, visual: true, mock: fixtureMode, artifacts: ['image-voxel-ledger.json', 'visual-anchors.json', 'completion-proof.json'], statusHint: result.ok ? 'verified_partial' : 'blocked', blockers: gateBlockers, command: { cmd: `sks wiki image-ingest ${imagePath}`, status: result.ok ? 0 : 1 } });
  const output = { ...result, mission_id: id, completion_proof: { ok: proof.ok, validation: proof.validation } };
  if (flag(args, '--json')) return console.log(JSON.stringify(output, null, 2));
  console.log(`Image ingested: ${result.image.id}`);
  if (!result.ok) process.exitCode = 1;
}

async function wikiImageValidate(args: any = []) {
  const root = await sksRoot();
  const ledgerPath = args.find((arg: any, i: any) => i >= 0 && !String(arg).startsWith('--'));
  const ledger = await readImageVoxelLedger(root, ledgerPath ? path.resolve(root, ledgerPath) : undefined);
  const result = { schema: 'sks.image-voxel-validation.v1', ...validateImageVoxelLedger(ledger, { requireAnchors: flag(args, '--require-anchors'), requireRelations: flag(args, '--require-relations'), route: readOption(args, '--route', '$Wiki') }) };
  const wrongness = await recordImageWrongnessFromValidation(root, {
    ledger,
    validation: result,
    missionId: readOption(args, '--mission-id', ledger.mission_id || null),
    route: readOption(args, '--route', '$Wiki'),
    artifact: ledgerPath || '.sneakoscope/wiki/image-voxel-ledger.json'
  });
  const output = { ...result, wrongness };
  if (flag(args, '--json')) return console.log(JSON.stringify(output, null, 2));
  console.log(`Image voxel ledger: ${result.ok ? 'pass' : 'blocked'}`);
  for (const issue of result.issues) console.log(`- ${issue}`);
  if (!result.ok) process.exitCode = 1;
}

async function wikiImageSummary(args: any = []) {
  const root = await sksRoot();
  const result = await imageVoxelSummary(root);
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Images: ${result.images}`);
  console.log(`Anchors: ${result.anchors}`);
  console.log(`Relations: ${result.relations}`);
  if (!result.ok) process.exitCode = 1;
}

async function wikiAnchorAdd(args: any = []) {
  const root = await sksRoot();
  const result = await addVisualAnchor(root, {
    imageId: readOption(args, '--image-id', null),
    bbox: parseBbox(readOption(args, '--bbox', '')),
    label: readOption(args, '--label', 'Visual anchor'),
    source: readOption(args, '--source', 'manual'),
    evidencePath: readOption(args, '--evidence', null),
    route: readOption(args, '--route', '$Wiki'),
    claimId: readOption(args, '--claim-id', null),
    missionId: readOption(args, '--mission-id', null)
  });
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Visual anchor: ${result.ok ? 'added' : 'blocked'} ${result.anchor.id}`);
  if (!result.ok) process.exitCode = 1;
}

async function wikiRelationAdd(args: any = []) {
  const root = await sksRoot();
  const result = await addImageRelation(root, {
    type: readOption(args, '--type', 'before_after'),
    beforeImageId: readOption(args, '--before', null),
    afterImageId: readOption(args, '--after', null),
    anchors: String(readOption(args, '--anchors', '') || '').split(',').map((x: any) => x.trim()).filter(Boolean),
    verification: readOption(args, '--verification', 'changed-screen-recheck'),
    status: readOption(args, '--status', 'verified_partial'),
    route: readOption(args, '--route', '$Wiki'),
    missionId: readOption(args, '--mission-id', null)
  });
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Image relation: ${result.ok ? 'added' : 'blocked'} ${result.relation.type}`);
  if (!result.ok) process.exitCode = 1;
}

async function wikiImageLinkProof(args: any = []) {
  const root = await sksRoot();
  const result = await imageVoxelProofEvidence(root, null);
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Image voxel proof link: ${result.ok ? 'ok' : 'blocked'}`);
  if (!result.ok) process.exitCode = 1;
}

export async function writeWikiContextPack(root: any, args: any = [], opts: any = {}) {
  const role = readFlagValue(args, '--role', 'worker');
  const maxAnchors = Number(readFlagValue(args, '--max-anchors', role.includes('verifier') ? 48 : 32));
  const codePackData = await readJson<any>(path.join(root, '.sneakoscope', 'wiki', 'code-pack.json'), null).catch(() => null);
  const codePackEntries = Array.isArray(codePackData?.entries)
    ? codePackData.entries.filter((entry: any) => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
    : [];
  const wrongnessByModule = await buildWrongnessByModule(root);
  const pack = contextCapsule({
    mission: { id: 'project-wiki', coord: { rgba: { r: 48, g: 132, b: 212, a: 240 } } },
    role,
    contractHash: null,
    claims: await projectWikiClaims(root),
    q4: { mode: 'project-continuity', package: PACKAGE_VERSION, hydrate: 'anchor-first' },
    q3: ['sks', 'llm-wiki', 'wiki-coordinate', 'gx', 'skills'],
    budget: { maxWikiAnchors: maxAnchors, includeTrustSummary: true },
    codePackEntries,
    wrongnessByModule
  });
  const wrongnessContext = await wrongnessContextForRoute(root, { route: '$Wiki', limit: 12 });
  // buildTriWikiAttention's use_first/hydrate_first can reference code: ids that were
  // never routed through selectClaims (no fabricated RGBA coordinate for them — see
  // codePackAttentionRows), so append their real summary text here or a recallpulse
  // consumer resolving pack.claims by id would only see the bare id string.
  const attentionCodeIds = new Set([
    ...(pack.attention?.use_first || []),
    ...(pack.attention?.hydrate_first || [])
  ].map((row: any) => Array.isArray(row) ? row[0] : row?.id).filter((id: any) => typeof id === 'string' && id.startsWith('code:')));
  const selectedClaimIds = new Set((pack.claims || []).map((claim: any) => claim?.id).filter(Boolean));
  const codePackClaimRows = codePackEntries
    .filter((entry: any) => attentionCodeIds.has(entry.id) && !selectedClaimIds.has(entry.id))
    .map((entry: any) => ({
      id: entry.id,
      text: `${entry.text}${Array.isArray(entry.citations) && entry.citations.length ? ` (source: ${entry.citations.map((c: any) => c?.path).filter(Boolean).join(', ')})` : ''}`,
      source: 'code-pack',
      source_paths: Array.isArray(entry.citations) ? entry.citations.map((citation: any) => citation?.path).filter(Boolean) : [],
      trust_score: entry.trust_score
    }));
  const enrichedPack = sealTriWikiContextPack({
    ...pack,
    claims: [...(pack.claims || []), ...codePackClaimRows],
    wrongness_context: wrongnessContext,
    q3: Array.from(new Set([...(pack.q3 || []), 'wrongness-memory', 'negative-evidence']))
  }, { root });
  const file = path.join(root, '.sneakoscope', 'wiki', 'context-pack.json');
  const persistence = opts.dryRun
    ? { written: false, validation: wikiValidationResult(enrichedPack, root) }
    : await writeValidatedWikiContextPack(file, enrichedPack, root);
  return { pack: enrichedPack, file, role, maxAnchors, ...persistence };
}

export async function writeValidatedWikiContextPack(file: string, pack: any, root: string) {
  const validation = wikiValidationResult(pack, root);
  if (!validation.result.ok) return { written: false, validation };
  await ensureDir(path.dirname(file));
  await writeJsonAtomic(file, pack);
  return { written: true, validation };
}

function wikiAnchorCount(wiki: any = {}) {
  return (wiki.anchors || wiki.a || []).length;
}

export function wikiVoxelRowCount(wiki: any = {}) {
  const overlay = wiki.vx || wiki.voxel_overlay || {};
  return (overlay.rows || overlay.v || []).length;
}

function wikiValidationResult(pack: any = {}, root: string | null = null) {
  const wikiIndex = pack.wiki || pack;
  const coordinate = validateWikiCoordinateIndex(wikiIndex, { root, claims: pack.claims });
  const provenance = validateTriWikiContextPackProvenance(pack, { root });
  const structureIssues = [
    ...(!Array.isArray(pack.claims) ? [{ id: 'context_pack_claims_missing', severity: 'error' }] : []),
    ...(!pack.attention || !Array.isArray(pack.attention.use_first) || !Array.isArray(pack.attention.hydrate_first)
      ? [{ id: 'context_pack_attention_missing', severity: 'error' }]
      : [])
  ];
  const issues = [...coordinate.issues, ...provenance.issues, ...structureIssues];
  const result = { ok: issues.length === 0, checked: coordinate.checked, issues };
  return { result, trustAnchors: countTrustAnchors(wikiIndex) };
}

export function wikiGateBlockers(ok: any, issues: any = [], fallback = 'wiki_validation_failed') {
  if (ok === true) return [];
  const normalized = (Array.isArray(issues) ? issues : [issues])
    .map((issue: any) => {
      if (typeof issue === 'string') return issue.trim();
      if (!issue || typeof issue !== 'object') return String(issue || '').trim();
      const id = String(issue.id || issue.code || issue.message || '').trim();
      const detail = String(issue.anchor || issue.path || issue.image_id || '').trim();
      return id && detail ? `${id}:${detail}` : id;
    })
    .filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : [fallback];
}

function printWikiPackSummary(root: any, file: any, pack: any) {
  console.log('Sneakoscope LLM Wiki Context Pack');
  console.log(`Path:     ${path.relative(root, file)}`);
  console.log(`Claims:   ${pack.claims.length} hydrated text claims`);
  console.log(`Anchors:  ${wikiAnchorCount(pack.wiki)} coordinate anchors (${pack.wiki.overflow_count ?? pack.wiki.o ?? 0} overflow)`);
  console.log(`Voxels:   ${wikiVoxelRowCount(pack.wiki)} metadata rows (${pack.wiki.vx?.s || pack.wiki.vx?.schema || 'none'})`);
  if (pack.attention) console.log(`Attention: use_first=${pack.attention.use_first?.length || 0} hydrate_first=${pack.attention.hydrate_first?.length || 0} (${pack.attention.mode})`);
  console.log(`Schema:   ${pack.wiki.schema}`);
  console.log(`Trust:    avg=${pack.trust_summary.avg} needs_evidence=${pack.trust_summary.needs_evidence}`);
  console.log('Guidance: follow high-trust claims; hydrate source/evidence before relying on lower-trust claims. Stack/version changes require current Context7 or official-doc TriWiki claims before coding.');
  console.log(`Validate: sks wiki validate ${path.relative(root, file)}`);
}

function wikiAttentionSummary(pack: any = {}) {
  const attention = pack.attention || {};
  return {
    mode: attention.mode || null,
    use_first: Array.isArray(attention.use_first) ? attention.use_first.length : 0,
    hydrate_first: Array.isArray(attention.hydrate_first) ? attention.hydrate_first.length : 0,
    fields: { use_first: ['id', 'rgba', 'h'], hydrate_first: ['id', 'reason'] }
  };
}

function countTrustAnchors(wiki: any = {}) {
  const rows = Array.isArray(wiki.a) ? wiki.a : (Array.isArray(wiki.anchors) ? wiki.anchors.map((anchor: any) => [anchor.id, null, null, null, null, null, null, null, null, anchor.trust_score, anchor.trust_band]) : []);
  return rows.filter((row: any) => row?.[9] != null && row?.[10]).length;
}

function projectPathIsInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

interface ProjectCitationRoot {
  resolved: string;
  real: string;
  cache: Map<string, string | null>;
}

async function projectCitationRoot(root: string): Promise<ProjectCitationRoot | null> {
  const resolvedRoot = path.resolve(root);
  const realRoot = await fsp.realpath(resolvedRoot).catch(() => null);
  return realRoot ? { resolved: resolvedRoot, real: realRoot, cache: new Map() } : null;
}

async function firstHydratableProjectCitation(root: ProjectCitationRoot | null, candidates: string[]) {
  if (!root) return null;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) continue;
    if (root.cache.has(candidate)) {
      const cached = root.cache.get(candidate);
      if (cached) return cached;
      continue;
    }
    const resolvedCandidate = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root.resolved, candidate);
    let citation: string | null = null;
    if (projectPathIsInside(root.resolved, resolvedCandidate)) {
      const realCandidate = await fsp.realpath(resolvedCandidate).catch(() => null);
      if (realCandidate && projectPathIsInside(root.real, realCandidate)) citation = path.relative(root.resolved, resolvedCandidate) || '.';
    }
    root.cache.set(candidate, citation);
    if (citation) return citation;
  }
  return null;
}

export async function projectWikiClaims(root: any) {
  const citationRoot = await projectCitationRoot(root);
  if (!citationRoot) return [];
  const claims = [
    ['wiki-hooks', '.codex/hooks.json routes UserPromptSubmit, tool, permission, and Stop events through SKS guards.', ['.codex/hooks.json'], 'code', 'high'],
    ['wiki-config', '.codex/config.toml enables Codex App profiles, multi-agent support, and official subagent limits.', ['.codex/config.toml'], 'code', 'high'],
    ['wiki-skills', '.agents/skills provides official repo-local routes plus support skills for dfix, naruto, goal, research, autoresearch, db, gx, wiki, reflection, evaluation, design-system/UI editing, and imagegen workflows.', ['.agents/skills'], 'code', 'medium'],
    ['wiki-agents', '.codex/agents defines Naruto official-subagent analysis, planning, implementation, DB safety, and QA reviewer roles.', ['.codex/agents'], 'code', 'medium'],
    ['wiki-policy', '.sneakoscope/policy.json stores update-check, honest-mode, retention, database, performance, and prompt-pipeline policy.', ['.sneakoscope/policy.json'], 'contract', 'high'],
    ['wiki-memory', '.sneakoscope/memory stores Q0 raw, Q1 evidence, Q2 facts, Q3 tags, and Q4 control bits for hydratable context.', ['.sneakoscope/memory'], 'wiki', 'high'],
    ['wiki-gx', 'GX cartridges keep vgraph.json and beta.json as deterministic visual context sources with render, validation, drift, and snapshot outputs.', ['.sneakoscope/gx/cartridges'], 'vgraph', 'medium'],
    ['wiki-db', 'Database safety blocks destructive SQL, risky Supabase commands, unsafe MCP writes, and production data mutation.', ['.sneakoscope/db-safety.json'], 'code', 'critical'],
    ['wiki-hproof', 'H-Proof blocks completion when unsupported critical claims, DB safety issues, missing tests, or high visual/wiki drift remain.', ['.sneakoscope/hproof'], 'test', 'critical'],
    ['wiki-eval', 'sks eval run measures token savings, evidence-weighted accuracy proxy, required recall, unsupported critical filtering, and build runtime.', ['src/core/evaluation.ts', '.agents/skills/performance-evaluator/SKILL.md'], 'test', 'medium'],
    ['wiki-trig', 'TriWiki maps RGBA channels to domain angle, layer radius, phase, and concentration using deterministic trigonometric coordinates.', ['src/core/wiki-coordinate.ts', 'docs/voxel-triwiki.md'], 'code', 'high']
  ];
  const out: any[] = [];
  for (const [id, text, candidates, authority, risk] of claims as Array<[string, string, string[], string, string]>) {
    const citation = await firstHydratableProjectCitation(citationRoot, candidates);
    if (!citation) continue;
    out.push({ id, text, authority, risk, status: 'supported', freshness: 'fresh', source: citation, file: citation, evidence_count: 1 });
  }
  const stackPolicy = stackCurrentDocsPolicy();
  const wrongnessCitation = await firstHydratableProjectCitation(citationRoot, ['src/core/triwiki-wrongness', '.sneakoscope/wiki/wrongness-ledger.json', 'AGENTS.md']);
  if (wrongnessCitation) out.push({
    id: 'wiki-wrongness-memory',
    text: 'TriWiki wrongness memory stores negative evidence, failed assumptions, stale proof, mock-real confusion, visual anchor errors, DB safety mismatches, hook policy mismatch, and trust overclaim as project and mission ledgers that retrieval and trust gates must consult before verification claims.',
    authority: 'code',
    risk: 'critical',
    status: 'supported',
    freshness: 'fresh',
    source: wrongnessCitation,
    file: wrongnessCitation,
    evidence_count: 2,
    required_weight: 1.4,
    trust_score: 0.9
  });
  const stackPolicyCitation = await firstHydratableProjectCitation(citationRoot, ['src/core/routes.ts', '.agents/skills/context7-docs/SKILL.md', '.codex/SNEAKOSCOPE.md', 'AGENTS.md']);
  if (stackPolicyCitation) out.push({
    id: 'wiki-stack-current-docs-policy',
    text: `When project tech stack, framework, package, runtime, SDK, MCP, or deployment-platform versions change, use Context7 or official vendor docs, write current syntax/security/limit guidance to ${stackPolicy.memory_path}, refresh TriWiki, validate it, and prefer those claims over stale model defaults before coding.`,
    authority: 'contract',
    risk: 'critical',
    status: 'supported',
    freshness: 'fresh',
    source: stackPolicyCitation,
    file: stackPolicyCitation,
    evidence_count: 3,
    required_weight: 1.35,
    trust_score: 0.95
  });
  const attentionCitation = await firstHydratableProjectCitation(citationRoot, ['src/core/triwiki-attention.ts', '.agents/skills/wiki/SKILL.md', '.codex/SNEAKOSCOPE.md', 'AGENTS.md']);
  if (attentionCitation) out.push({
    id: 'wiki-aggressive-active-recall',
    text: 'TriWiki should be used aggressively for performance and accuracy: route prompts and worker handoffs should consume attention.use_first for compact high-trust recall and attention.hydrate_first for source hydration of risky or lower-trust claims before decisions.',
    authority: 'code',
    risk: 'high',
    status: 'supported',
    freshness: 'fresh',
    source: attentionCitation,
    file: attentionCitation,
    evidence_count: 3,
    required_weight: 1.45,
    trust_score: 0.95
  });
  out.push(...(await memoryWikiClaims(root, citationRoot)));
  out.push(...(await userRequestSignalWikiClaims(root)));
  return out;
}

async function memoryWikiClaims(root: any, citationRoot: ProjectCitationRoot) {
  const base = path.join(root, '.sneakoscope', 'memory');
  const files = await listMemoryClaimFiles(base);
  const claims: any[] = [];
  for (const file of files.slice(0, 80)) {
    let text = '';
    try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const relFile = path.relative(root, file);
    if (!text.trim()) continue;
    for (const row of selectMemoryClaimRows(parseMemoryClaimRows(text, relFile), 48)) {
      const source = row.source || relFile;
      const sourceCitation = await firstHydratableProjectCitation(citationRoot, [source]);
      const hydrationCitation = sourceCitation || await firstHydratableProjectCitation(citationRoot, [relFile]);
      if (!hydrationCitation) continue;
      claims.push({
        id: row.id || `memory-${slugifyClaimId(relFile)}-${claims.length + 1}`,
        text: row.text,
        source,
        file: hydrationCitation,
        authority: row.authority || 'wiki',
        risk: row.risk || 'high',
        status: row.status || (sourceCitation || source === relFile ? 'supported' : 'unknown'),
        freshness: row.freshness || 'fresh',
        evidence_count: row.evidence_count ?? (sourceCitation ? 2 : 1),
        required_weight: row.required_weight ?? 0.85,
        trust_score: row.trust_score
      });
    }
  }
  return claims;
}

function selectMemoryClaimRows(rows: any = [], limit: any = 48) {
  return rows.slice(-limit);
}

async function listMemoryClaimFiles(base: any) {
  const out: any[] = [];
  async function walk(dir: any, depth: any = 0) {
    if (depth > 3) return;
    let entries: any[] = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p, depth + 1);
      else if (/\.(md|txt|json)$/i.test(entry.name)) out.push(p);
    }
  }
  await walk(base);
  return out;
}

function parseMemoryClaimRows(text: any, relFile: any) {
  if (/\.json$/i.test(relFile)) {
    try {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.claims) ? parsed.claims : []);
      return rows.map((row: any) => normalizeMemoryClaimRow(row, relFile)).filter(Boolean);
    } catch {
      return [];
    }
  }
  return text.split(/\r?\n/).map((line: any) => line.trim()).filter((line: any) => line && !line.startsWith('#')).map((line: any) => normalizeMemoryClaimRow(line.replace(/^[-*]\s*/, ''), relFile)).filter(Boolean);
}

function normalizeMemoryClaimRow(row: any, relFile: any) {
  if (!row) return null;
  if (typeof row === 'object') {
    const text = String(row.text || row.claim || '').trim();
    if (!text) return null;
    return { id: row.id ? String(row.id) : null, text: text.slice(0, 320), source: row.source || row.file || relFile, authority: row.authority, risk: row.risk, status: row.status || row.confidence, freshness: row.freshness, evidence_count: parseOptionalNumber(row.evidence_count), required_weight: parseOptionalNumber(row.required_weight), trust_score: parseOptionalNumber(row.trust_score) };
  }
  const clean = String(row || '').trim();
  if (!/\bclaim\s*:/i.test(clean)) return null;
  return { id: extractClaimField(clean, 'id'), text: clean.slice(0, 320), source: extractClaimField(clean, 'source') || extractClaimField(clean, 'file') || relFile, authority: extractClaimField(clean, 'authority') || 'wiki', risk: extractClaimField(clean, 'risk') || 'high', status: extractClaimField(clean, 'status'), freshness: extractClaimField(clean, 'freshness') || 'fresh', evidence_count: parseOptionalNumber(extractClaimField(clean, 'evidence_count')), required_weight: parseOptionalNumber(extractClaimField(clean, 'required_weight')), trust_score: parseOptionalNumber(extractClaimField(clean, 'trust_score')) };
}

function extractClaimField(text: any, key: any) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`\\b${escaped}\\s*[:=]\\s*\`?([^\`|,;]+)`, 'i'));
  return match?.[1] ? match[1].trim().replace(/[.;)]$/, '') : null;
}

function parseOptionalNumber(value: any) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function slugifyClaimId(value: any) {
  return String(value || 'claim').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'claim';
}

async function userRequestSignalWikiClaims(root: any) {
  const base = path.join(root, '.sneakoscope', 'missions');
  let entries: any[] = [];
  try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { return []; }
  const topics = new Map();
  for (const id of entries.filter((item: any) => item.isDirectory() && item.name.startsWith('M-')).map((item: any) => item.name).sort().reverse().slice(0, 120)) {
    const mission = await readJson(path.join(base, id, 'mission.json'), null);
    const prompt = String(mission?.prompt || '').trim();
    if (!prompt) continue;
    for (const topic of userRequestSignal(prompt).topics) {
      const current = topics.get(topic) || { count: 0, examples: [] };
      current.count += 1;
      if (current.examples.length < 3) current.examples.push(id);
      topics.set(topic, current);
    }
  }
  return [...topics.entries()].sort((a: any, b: any) => b[1].count - a[1].count).slice(0, 16).map(([topic, row]: any) => ({
    id: `user-request-frequency-${slugifyClaimId(topic)}`,
    text: `User request topic "${topic}" appeared ${row.count} time(s); repeated topics should be consulted before asking predictable clarification questions.`,
    authority: 'wiki',
    risk: 'medium',
    status: 'supported',
    freshness: 'fresh',
    source: '.sneakoscope/missions',
    file: '.sneakoscope/missions',
    evidence_count: row.count,
    required_weight: Math.min(1.25, 0.45 + row.count * 0.12)
  }));
}

function userRequestSignal(prompt: any = '') {
  const lower = String(prompt || '').toLowerCase();
  const topicRules = [
    ['ambiguity-questions', /모호|ambiguity|clarification|질문|답변|answers?\.json|decision-contract|추론|예측/],
    ['triwiki-priority-memory', /triwiki|wiki|메모리|memory|기억|우선|반복|자주|카운팅|count|frequency|weight/],
    ['install-bootstrap', /bootstrap|postinstall|doctor|deps|tmux|최초\s*설치|셋업|setup/],
    ['version-release', /버전|version|publish:dry|release|npm\s+pack/],
    ['qa-loop', /qa|e2e|검증|리포트|report/],
    ['naruto-pipeline', /naruto|team|subagent|세션|cleanup|reflection|회고|반성/],
    ['safety-boundary', /삭제|파괴|destructive|production|권한|보안|인증|결제/]
  ];
  const topics = topicRules.filter(([, pattern]: any) => pattern.test(lower)).map(([topic]: any) => topic);
  if (!topics.length) topics.push('general-user-preference');
  return { topics };
}

function parseBbox(raw: any) {
  const parts = String(raw || '').split(',').map((part: any) => Number(part.trim()));
  return parts.length === 4 && parts.every(Number.isFinite) ? parts : null;
}
