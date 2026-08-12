/**
 * Align publishes a v2 generation, and the generation it publishes can answer.
 *
 * The seam this asserts is the one that was missing: every part of the compile
 * existed, and nothing in production called `encodeContextIndex`, so no real
 * workspace had a published index. A test that only checked "a file appeared"
 * would pass against an index with four empty dictionary sections — the exact
 * state that answered a pasted path and nothing else. So the assertions that
 * matter here are the two queries: a symbol, and a Korean phrase.
 *
 * The workspace is an `fsp.mkdtemp` directory under `os.tmpdir()`, removed in
 * `finally`. Nothing here touches the real `$HOME`.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearContextGraphSnapshotCache,
  clearWorkspaceContextIndex,
  queryWorkspaceContext
} from '../../triwiki/context-graph/query/index.js';
import { contextIndexOperationJournalPath } from '../../triwiki/context-graph/store/generation-layout.js';
import { resolveCurrentContextIndex } from '../../triwiki/context-graph/store/generation-resolve.js';
import { listContextIndexGenerations } from '../../triwiki/context-graph/store/generation-retention.js';
import { ALIGN_OUTPUT_ARTIFACTS, writeAlignRouteArtifacts } from '../align-route.js';
import { executeCodeNavigationAlign } from '../code-navigation-align.js';

const POINTER_ARTIFACT = '.sneakoscope/wiki/context-graph/current.json';

async function write(root: string, relative: string, contents: string): Promise<void> {
  const file = path.join(root, relative);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents);
}

async function fixtureRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-align-publish-'));
  await write(root, 'package.json', JSON.stringify({ name: 'align-publish-fixture', version: '1.0.0', type: 'module' }));
  await write(
    root,
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022' }, include: ['src/**/*.ts'] })
  );
  await write(
    root,
    'src/runner.ts',
    '/** Runs the queued service task. */\nexport function runService(value: number) { return value + 1; }\n'
  );
  // A Korean docstring becomes `metadata.purpose`, which the lexicon indexes as
  // free text. Without a threaded lexicon config this file is unreachable by any
  // query that is not its literal path.
  await write(
    root,
    'src/budget.ts',
    '/** 컨텍스트 예산 정책을 계산한다. */\nexport function computeBudget(tokens: number) { return tokens * 2; }\n'
  );
  await fsp.mkdir(path.join(root, 'config'), { recursive: true });
  await fsp.copyFile(
    path.join(process.cwd(), 'config/architecture-map-policy.v1.json'),
    path.join(root, 'config/architecture-map-policy.v1.json')
  );
  return root;
}

async function align(root: string, missionId: string) {
  const dir = path.join(root, '.sneakoscope/missions', missionId);
  await fsp.mkdir(dir, { recursive: true });
  await writeAlignRouteArtifacts(dir, missionId, 'index all current code');
  const result = await executeCodeNavigationAlign({ root, missionDir: dir, missionId });
  assert.equal(result.ok, true, result.gate.blockers.join('\n'));
  return result;
}

async function selectedCount(root: string, query: string): Promise<number> {
  const answer = await queryWorkspaceContext(root, { query }, { cache: null });
  return answer.kernel.selected.length;
}

test('align publishes a v2 generation the query facade can open', async () => {
  const root = await fixtureRoot();
  try {
    const result = await align(root, 'M-align-publish');

    const resolved = await resolveCurrentContextIndex(root);
    assert.equal(resolved.pointer.snapshotHash, result.ledger.graph.snapshot_hash);
    assert.equal(resolved.meta.snapshotHash, resolved.pointer.snapshotHash);
    assert.equal(resolved.pointer.generationPath, `.sneakoscope/wiki/context-graph/generations/${resolved.pointer.snapshotHash}.idx`);
    const stat = await fsp.stat(resolved.generationPath);
    assert.equal(stat.size, resolved.pointer.indexBytes);
    assert.ok(resolved.meta.nodeCount > 0 && resolved.meta.edgeCount > 0);

    // A published generation, not a staged one: no journal survives, and the
    // staging root the store wrote into is gone with the rest of the swap.
    assert.equal(await fsp.stat(contextIndexOperationJournalPath(root)).catch(() => null), null);
    assert.deepEqual([...(await listContextIndexGenerations(root))], [resolved.pointer.snapshotHash]);
    assert.equal(await fsp.stat(path.join(root, '.sneakoscope/tmp/triwiki-align')).catch(() => null), null);
  } finally {
    clearWorkspaceContextIndex(root);
    clearContextGraphSnapshotCache();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the published index answers a symbol query and a Korean query', async () => {
  const root = await fixtureRoot();
  try {
    await align(root, 'M-align-publish-query');

    // The regression this guards: omitting the lexicon config writes
    // LEXICON_TABLE, LEXICON_POSTINGS, COARSE_TERM_TABLE and COARSE_POSTINGS
    // zero-length. Only the anchor lane survives that, so a pasted path still
    // answers and both of these return zero.
    assert.ok(await selectedCount(root, 'runService') > 0, 'symbol query returned nothing');
    assert.ok(await selectedCount(root, '컨텍스트 예산') > 0, 'Korean query returned nothing');

    // The anchor lane is unaffected either way; asserted so a failure above is
    // attributable to the dictionary lanes rather than to a broken index.
    assert.ok(await selectedCount(root, 'src/runner.ts') > 0, 'path anchor query returned nothing');
  } finally {
    clearWorkspaceContextIndex(root);
    clearContextGraphSnapshotCache();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the align gate hashes the published pointer as an output artifact', async () => {
  const root = await fixtureRoot();
  try {
    const result = await align(root, 'M-align-publish-gate');
    assert.ok(ALIGN_OUTPUT_ARTIFACTS.includes(POINTER_ARTIFACT));
    assert.ok(result.ledger.publication.artifact_sha256[POINTER_ARTIFACT], 'pointer was not hashed as an output');
    assert.equal(result.gate.active_artifacts_verified, true);
    assert.equal(result.gate.outputs_complete, true);
  } finally {
    clearWorkspaceContextIndex(root);
    clearContextGraphSnapshotCache();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a second align republishes and retains one generation, not a stale pair', async () => {
  const root = await fixtureRoot();
  try {
    const first = await align(root, 'M-align-publish-1');
    await write(root, 'src/extra.ts', '/** Adds a second module. */\nexport const extra = 3;\n');
    const second = await align(root, 'M-align-publish-2');

    assert.notEqual(second.ledger.graph.snapshot_hash, first.ledger.graph.snapshot_hash);
    const resolved = await resolveCurrentContextIndex(root);
    assert.equal(resolved.pointer.snapshotHash, second.ledger.graph.snapshot_hash);
    // Align replaces `.sneakoscope/wiki` wholesale and retains no previous TriWiki
    // generation, so the store it promotes always holds exactly the one it built.
    assert.deepEqual([...(await listContextIndexGenerations(root))], [resolved.pointer.snapshotHash]);
    assert.equal(resolved.pointer.previousSnapshotHash, null);
    assert.ok(await selectedCount(root, 'extra') > 0);
  } finally {
    clearWorkspaceContextIndex(root);
    clearContextGraphSnapshotCache();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
