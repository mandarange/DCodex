import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCodeNavigationAlign } from '../../align/code-navigation-align.js';
import { refreshAlignGate, writeAlignRouteArtifacts } from '../../align/align-route.js';
import { buildCodeNavigationContextPack } from '../../triwiki/code-navigation-context-pack.js';
import { CODE_PACK_SCHEMA, type CodePack } from '../../triwiki/code-pack.js';
import { contextGraphStatus } from '../../triwiki/context-graph/store/graph-status.js';
import { codeNavigationGraphExtractors } from '../../triwiki/context-graph/extractors/index.js';
import {
  inspectTriwikiAgentsMdBlocks,
  TRIWIKI_AGENTS_SCAN_LIMITS
} from '../../triwiki/agents-md-projector.js';
import {
  applyTriWikiCleanup,
  inspectTriWikiBlankState,
  planTriWikiCleanup,
  TRIWIKI_CLEANUP_SCAN_LIMITS,
  validateTriWikiCleanupReceipt
} from '../../triwiki/triwiki-cleanup.js';

const PROJECT_BLOCK = `<!-- BEGIN SKS PROJECT MEMORY (auto) -->\nold memory\n<!-- END SKS PROJECT MEMORY -->`;
const INIT_BLOCK = `<!-- BEGIN SKS INIT-DEEP MANAGED SECTION -->\nold structure\n<!-- END SKS INIT-DEEP MANAGED SECTION -->`;

async function write(root: string, relative: string, contents: string | Buffer) {
  const file = path.join(root, relative);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents);
  return file;
}

async function fixtureRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-v3-'));
  await write(root, 'package.json', JSON.stringify({ name: 'align-fixture', version: '1.0.0', type: 'module' }));
  await write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022' }, include: ['src/**/*.ts'] }));
  await write(root, 'src/main.ts', `/** Main runtime entry. Do not reuse stale cache entries. */\nexport function runTask(value: number) { return hiddenHelper(value); }\nfunction hiddenHelper(value: number) { return value + 1; }\n`);
  await write(root, 'tools/task.py', `"""Task worker from source docstring."""\ndef execute_task(value):\n    return value + 1\n`);
  await write(root, 'Native/Runner.swift', `#if os(macOS)\npublic struct Runner {\n  public func run() {}\n}\n#endif\n`);
  await write(root, '.codex/managed-hooks/fixture-hook.sh', `#!/bin/sh\nfixture_hook() { printf '%s\\n' ok; }\n`);
  await write(root, 'docs/guide.md', 'HOSTILE_DOCUMENT_SENTINEL must never enter the code index.\n');
  await write(root, '.sneakoscope/memory/q2_facts/old.md', 'HOSTILE_MEMORY_SENTINEL\n');
  await write(root, '.sneakoscope/wiki/wrongness/old.json', '{"text":"HOSTILE_WRONGNESS_SENTINEL"}\n');
  await write(root, '.sneakoscope/missions/M-history/mission.json', '{"prompt":"HOSTILE_MISSION_SENTINEL"}\n');
  await write(root, '.sneakoscope/triwiki/proof-bank/proof.json', '{"claim":"HOSTILE_PROOF_SENTINEL"}\n');
  await write(root, 'AGENTS.md', `before\n${PROJECT_BLOCK}\nafter\n`);
  await write(root, 'src/AGENTS.md', `${INIT_BLOCK}\n`);
  return root;
}

async function remove(root: string) {
  await fsp.rm(root, { recursive: true, force: true });
}

test('code-navigation context pack preserves negative source meaning verbatim', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-verbatim-'));
  try {
    await write(root, 'src/cache.ts', '/** Do not reuse stale cache entries. */\nexport const cache = new Map();\n');
    const codePack: CodePack = {
      schema: CODE_PACK_SCHEMA,
      generated_at: '1970-01-01T00:00:00.000Z',
      git_head_sha: null,
      source_file_count: 1,
      index_digest: 'fixture',
      entries: [{
        id: 'file:src/cache.ts',
        text: 'src/cache.ts source purpose: do not reuse stale cache entries.',
        citations: [{ path: 'src/cache.ts', line: 1 }],
        trust_score: 1,
        freshness: 'fresh',
        token_cost: 12
      }],
      token_budget: 100,
      total_token_cost: 12
    };
    const pack = buildCodeNavigationContextPack({
      root,
      codePack,
      snapshotHash: 'fixture-snapshot',
      fileCount: 1,
      symbolCount: 1,
      edgeCount: 0,
      extractorRevisions: [{ id: 'code', revision: 'fixture' }]
    });
    assert.equal(pack.claims[0]?.text, codePack.entries[0]?.text);
    assert.equal(JSON.stringify(pack.claims).includes('negative_priming'), false);
  } finally {
    await remove(root);
  }
});

test('cleanup is explicit, content-bound, idempotent, destructive, and retains no previous generation', async () => {
  const root = await fixtureRoot();
  try {
    const plan = await planTriWikiCleanup(root);
    assert.equal(plan.ok, true);
    assert.equal(plan.risk, 'R3');
    assert.equal(plan.destructive, true);
    assert.equal(plan.retained_backup, false);
    assert.match(await fsp.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /old memory/, 'plan must not mutate');

    const receipt = await applyTriWikiCleanup(root);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.destructive, true);
    assert.equal(receipt.retained_backup, false);
    assert.equal(receipt.temporary_swap_removed, true);
    assert.equal(receipt.deleted_target_count > 0, true);
    assert.equal((await inspectTriWikiBlankState(root)).blank, true);
    assert.equal(await fsp.readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'before\nafter\n', 'removing a block preserves the line boundary');
    assert.equal(await fsp.readFile(path.join(root, 'src/main.ts'), 'utf8').then((text) => text.includes('runTask')), true);
    assert.equal(await fsp.readFile(path.join(root, 'docs/guide.md'), 'utf8').then((text) => text.includes('HOSTILE_DOCUMENT_SENTINEL')), true);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/missions/M-history/mission.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/triwiki/proof-bank/proof.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/memory')), false);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/wiki')), false);

    await write(root, '.sneakoscope/tmp/triwiki-cleanup-current/old/targets/memory/retained.md', 'stale prior generation\n');
    assert.equal((await inspectTriWikiBlankState(root)).blank, false);
    assert.equal((await validateTriWikiCleanupReceipt(root)).ok, false);
    const recovered = await applyTriWikiCleanup(root);
    assert.notEqual(recovered.cleanup_id, receipt.cleanup_id);
    assert.equal(recovered.target_receipts.some((target) => target.key === 'cleanup_current_swap'), true);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/tmp/triwiki-cleanup-current')), false);

    const repeated = await applyTriWikiCleanup(root);
    assert.equal(repeated.cleanup_id, recovered.cleanup_id);
    assert.equal(repeated.idempotent_reuse, true);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/quarantine/triwiki-cleanup')), false);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/tmp/triwiki-cleanup-current')), false);
    assert.equal((await validateTriWikiCleanupReceipt(root)).ok, true);
  } finally {
    await remove(root);
  }
});

test('cleanup refuses a nested symlink without following or mutating it', async () => {
  const root = await fixtureRoot();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-cleanup-outside-'));
  try {
    const outsideFile = await write(outside, 'keep.txt', 'must survive cleanup\n');
    await fsp.symlink(outsideFile, path.join(root, '.sneakoscope/memory/nested-link'));
    const plan = await planTriWikiCleanup(root);
    assert.equal(plan.ok, false);
    assert.ok(plan.blockers.includes('cleanup_nested_symlink_refused:.sneakoscope/memory/nested-link'));
    await assert.rejects(() => applyTriWikiCleanup(root), /triwiki_cleanup_plan_blocked/);
    assert.equal(await fsp.readFile(outsideFile, 'utf8'), 'must survive cleanup\n');
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/memory/nested-link')), true);
  } finally {
    await remove(root);
    await remove(outside);
  }
});

test('cleanup scan is iterative and fails closed beyond its explicit depth bound', async () => {
  const root = await fixtureRoot();
  try {
    let relative = '.sneakoscope/memory/deep';
    for (let depth = 0; depth <= TRIWIKI_CLEANUP_SCAN_LIMITS.maxDepth; depth += 1) {
      relative = `${relative}/d`;
    }
    await write(root, `${relative}/value.txt`, 'too deep\n');
    const plan = await planTriWikiCleanup(root);
    assert.equal(plan.ok, false);
    assert.equal(plan.blockers.some((blocker) => blocker.startsWith('cleanup_scan_depth_limit_exceeded:')), true);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/memory')), true, 'planning must not partially delete');
  } finally {
    await remove(root);
  }
});

test('managed AGENTS traversal is iterative, bounded, and refuses symlinked projections', async () => {
  const root = await fixtureRoot();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-agents-outside-'));
  try {
    let relative = 'deep-agents';
    for (let depth = 0; depth <= TRIWIKI_AGENTS_SCAN_LIMITS.maxDepth; depth += 1) relative += '/d';
    await write(root, `${relative}/AGENTS.md`, PROJECT_BLOCK);
    await assert.rejects(
      () => inspectTriwikiAgentsMdBlocks(root),
      /triwiki_agents_scan_depth_limit_exceeded:/
    );

    await fsp.rm(path.join(root, 'deep-agents'), { recursive: true, force: true });
    const outsideFile = await write(outside, 'AGENTS.md', PROJECT_BLOCK);
    await fsp.mkdir(path.join(root, 'linked-agents'), { recursive: true });
    await fsp.symlink(outsideFile, path.join(root, 'linked-agents', 'AGENTS.md'));
    await assert.rejects(
      () => inspectTriwikiAgentsMdBlocks(root),
      /triwiki_agents_scan_symlink_refused:/
    );
  } finally {
    await remove(root);
    await remove(outside);
  }
});

test('align replaces an existing wrong TriWiki without requiring cleanup or retaining it', async () => {
  const root = await fixtureRoot();
  try {
    const missionId = 'M-align-existing';
    const dir = path.join(root, '.sneakoscope/missions', missionId);
    await fsp.mkdir(dir, { recursive: true });
    await write(root, '.sneakoscope/tmp/triwiki-align/old/previous/wiki/retained.md', 'stale prior generation\n');
    await writeAlignRouteArtifacts(dir, missionId, 'fixture');
    const result = await executeCodeNavigationAlign({ root, missionDir: dir, missionId });
    assert.equal(result.ok, true, result.gate.blockers.join('\n'));
    assert.equal(result.ledger.input_state.mode, 'existing');
    assert.equal(result.ledger.input_state.prior_state_used_as_index_input, false);
    assert.equal(result.ledger.publication.previous_generation_retained, false);
    assert.equal(result.ledger.publication.temporary_swap_removed, true);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/memory')), false);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/tmp/triwiki-align')), false);
    const active = await fsp.readFile(path.join(root, '.sneakoscope/wiki/context-graph.json'), 'utf8');
    assert.equal(active.includes('HOSTILE_WRONGNESS_SENTINEL'), false);

    await write(root, '.sneakoscope/tmp/triwiki-align/orphan/previous/wiki/retained.md', 'late stale generation\n');
    const staleGate = await refreshAlignGate(dir, missionId, root);
    assert.equal(staleGate.gate.passed, false);
    assert.ok(staleGate.gate.blockers.includes('align_temporary_swap_retained'));
    assert.equal(staleGate.gate.previous_generation_not_retained, false);
  } finally {
    await remove(root);
  }
});

test('align final CAS includes resolution config and rolls back before prior-generation deletion', async () => {
  const root = await fixtureRoot();
  try {
    const missionId = 'M-align-final-cas';
    const dir = path.join(root, '.sneakoscope/missions', missionId);
    await fsp.mkdir(dir, { recursive: true });
    await writeAlignRouteArtifacts(dir, missionId, 'final CAS fixture');
    const result = await executeCodeNavigationAlign({
      root,
      missionDir: dir,
      missionId,
      beforeFinalSourceCas: async () => {
        await fsp.appendFile(path.join(root, 'tsconfig.json'), '\n');
      }
    });
    assert.equal(result.ok, false);
    assert.ok(result.ledger.blockers.includes('code_navigation_source_changed_during_scan'));
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/wiki/wrongness/old.json')), true);
    assert.match(await fsp.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /old memory/);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/tmp/triwiki-align')), false);
  } finally {
    await remove(root);
  }
});

test('align initializes the code-only TriWiki when no active TriWiki exists', async () => {
  const root = await fixtureRoot();
  try {
    await fsp.rm(path.join(root, '.sneakoscope/wiki'), { recursive: true, force: true });
    await fsp.rm(path.join(root, '.sneakoscope/memory'), { recursive: true, force: true });
    const missionId = 'M-align-absent';
    const dir = path.join(root, '.sneakoscope/missions', missionId);
    await fsp.mkdir(dir, { recursive: true });
    await writeAlignRouteArtifacts(dir, missionId, 'fixture');
    const result = await executeCodeNavigationAlign({ root, missionDir: dir, missionId });
    assert.equal(result.ok, true, result.gate.blockers.join('\n'));
    assert.equal(result.ledger.input_state.mode, 'absent');
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/wiki/context-graph.json')), true);
  } finally {
    await remove(root);
  }
});

test('align rebuilds a staged code-only exhaustive navigation index from a blank state', async () => {
  const root = await fixtureRoot();
  try {
    await applyTriWikiCleanup(root);
    assert.equal((await validateTriWikiCleanupReceipt(root)).ok, true);
    const missionId = 'M-align-code-navigation';
    const dir = path.join(root, '.sneakoscope/missions', missionId);
    await fsp.mkdir(dir, { recursive: true });
    await writeAlignRouteArtifacts(dir, missionId, 'index all current code');
    const result = await executeCodeNavigationAlign({ root, missionDir: dir, missionId });
    assert.equal(result.ok, true, result.gate.blockers.join('\n'));
    assert.equal(result.gate.passed, true);
    assert.equal(result.ledger.graph.exact_file_coverage, true);
    assert.deepEqual(result.ledger.graph.extractor_ids, ['code']);
    assert.equal(result.ledger.scan.fragment_cache_used, false);
    assert.equal(result.ledger.scan.source_cas_verified, true);
    assert.equal(result.ledger.publication.transactional_directory_replaced, true);

    const graph = JSON.parse(await fsp.readFile(path.join(root, '.sneakoscope/wiki/context-graph.json'), 'utf8'));
    const meta = JSON.parse(await fsp.readFile(path.join(root, '.sneakoscope/wiki/context-graph.meta.json'), 'utf8'));
    const manifest = JSON.parse(await fsp.readFile(path.join(root, '.sneakoscope/wiki/code-navigation-manifest.json'), 'utf8'));
    const contextPack = JSON.parse(await fsp.readFile(path.join(root, '.sneakoscope/wiki/context-pack.json'), 'utf8'));
    const serialized = JSON.stringify({ graph, meta, manifest, contextPack });
    for (const hostile of ['HOSTILE_DOCUMENT_SENTINEL', 'HOSTILE_MEMORY_SENTINEL', 'HOSTILE_WRONGNESS_SENTINEL', 'HOSTILE_MISSION_SENTINEL', 'HOSTILE_PROOF_SENTINEL']) {
      assert.equal(serialized.includes(hostile), false, `${hostile} leaked into code-only artifacts`);
    }
    assert.equal(meta.cacheKeyParts.sourcePolicy, 'repository_code_only');
    assert.equal(contextPack.mode, 'repository_code_navigation_only');
    assert.equal(contextPack.index.exhaustive_artifact, '.sneakoscope/wiki/context-graph.json');
    assert.equal(manifest.source_files.some((file: any) => file.path === '.codex/managed-hooks/fixture-hook.sh'), true);
    assert.equal(graph.nodes.some((node: any) => node.path === 'docs/guide.md'), false);
    assert.equal(graph.nodes.some((node: any) => node.path?.startsWith('.sneakoscope/')), false);

    const hidden = graph.nodes.find((node: any) => node.kind === 'symbol' && node.path === 'src/main.ts' && node.label === 'hiddenHelper');
    assert.equal(hidden.locator.line, 3);
    const python = graph.nodes.find((node: any) => node.kind === 'symbol' && node.path === 'tools/task.py' && node.label === 'execute_task');
    assert.equal(python.locator.line, 2);
    assert.equal(graph.nodes.some((node: any) => node.path === 'Native/Runner.swift' && node.metadata?.purpose === 'if os(macOS)'), false);

    const beforeDocs = await contextGraphStatus(root, { extractors: codeNavigationGraphExtractors() });
    assert.equal(beforeDocs.status, 'fresh', beforeDocs.reasons.join(','));
    await write(root, 'docs/guide.md', 'CHANGED_DOC_STILL_NOT_AN_INDEX_INPUT\n');
    const afterDocs = await contextGraphStatus(root, { extractors: codeNavigationGraphExtractors() });
    assert.equal(afterDocs.status, 'fresh', afterDocs.reasons.join(','));

    await fsp.appendFile(path.join(root, '.sneakoscope/wiki/code-navigation-manifest.json'), '\n');
    const tampered = await refreshAlignGate(dir, missionId, root);
    assert.equal(tampered.gate.passed, false);
    assert.ok(tampered.gate.blockers.includes('align_artifact_changed:.sneakoscope/wiki/code-navigation-manifest.json'));
  } finally {
    await remove(root);
  }
});

test('align fails closed on a supported-source symlink escape and publishes nothing', async () => {
  const root = await fixtureRoot();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-outside-'));
  try {
    await write(outside, 'escape.ts', 'export const escaped = true;\n');
    await fsp.symlink(path.join(outside, 'escape.ts'), path.join(root, 'src/escape.ts'));
    await applyTriWikiCleanup(root);
    const missionId = 'M-align-symlink';
    const dir = path.join(root, '.sneakoscope/missions', missionId);
    await fsp.mkdir(dir, { recursive: true });
    await writeAlignRouteArtifacts(dir, missionId, 'symlink fixture');
    const result = await executeCodeNavigationAlign({ root, missionDir: dir, missionId });
    assert.equal(result.ok, false);
    assert.equal(result.ledger.scan.fatal_skips.some((skip) => skip.reason === 'symlink_escape'), true);
    assert.equal(fs.existsSync(path.join(root, '.sneakoscope/wiki')), false);
  } finally {
    await remove(root);
    await remove(outside);
  }
});
