/**
 * Affected-verification tests.
 *
 * The load-bearing property is the floor: whatever the exact changed-file
 * selector chose has to survive, on a fresh graph and on a broken one alike.
 *
 * Since CG2-15 the module answers over a **compact CRK2 index**, so the fixture
 * is a real published generation — `buildContextGraphSnapshot` through the real
 * writer and the real store lifecycle — and every case reads it through the query
 * facade. There is no JSON snapshot anywhere in this suite, which is what makes a
 * reverted migration fail here rather than pass quietly.
 *
 * Two node families exist only to isolate a predicate arm that would otherwise be
 * proved by something else:
 *
 * - `isTest` carried **only** in metadata, on a node whose `kind` is `file`. The
 *   `kind === 'test'` arm cannot cover it, so a reader that lost the metadata's
 *   type — the revision-1 failure — drops these and the run gets faster.
 * - `requiredForPublish` / `alwaysOnRelease` on gates whose `risk` is explicitly
 *   **not** `protected`. The real extractor cannot produce that combination
 *   (`buildGateNodes` sets the flag and `risk: gateRisk(...)` in one call, and
 *   `REQUIRED_FOR_PUBLISH.has(id)` is a disjunct of `gateRisk`), so a fixture
 *   asserting the composite would prove nothing about the metadata arms. Setting
 *   `risk: 'high'` makes the first disjunct false and isolates them exactly.
 *
 * The only workspace touched is an `fs.mkdtempSync` directory under `os.tmpdir()`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import type {
  ContextGraphEdge,
  ContextGraphEdgeType,
  ContextGraphMetadata,
  ContextGraphNode,
  ContextGraphRisk,
  ContextGraphSnapshot
} from '../../triwiki/context-graph/contracts.js';
import { buildContextGraphSnapshot } from '../../triwiki/context-graph/compiler/serialize.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../triwiki/context-graph/ids.js';
import { openWorkspaceContextIndex, type ContextIndexReader } from '../../triwiki/context-graph/query/index.js';
import {
  publishFixtureContextIndex,
  resetContextIndexCache
} from '../../triwiki/context-graph/query/__tests__/workspace-fixtures.js';
import { buildGateEntry, selectGates, type GateManifestEntry } from '../../release/gate-manifest.js';
import {
  contextGraphAffectedVerification,
  contextGraphAffectedVerificationFromIndex,
  missingContextGraphBaselineGates,
  type ContextGraphAffectedResult
} from '../context-graph-affected.js';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

const PATHS = {
  changed: 'src/mod-x/changed.ts',
  dependent: 'src/mod-x/dependent.ts',
  unrelated: 'src/mod-y/unrelated.ts',
  suite: 'src/mod-x/__tests__/changed.test.ts',
  /** `kind: 'file'`; only `metadata.isTest` says it is a suite. */
  flaggedBool: 'src/mod-x/checks/boolean-flagged.mjs',
  /** Same, spelled the way several extractors author it. */
  flaggedString: 'src/mod-x/checks/string-flagged.mjs',
  /** One path, three nodes, two of them with their own suite. */
  multi: 'src/mod-x/multi.ts',
  multiAlphaSuite: 'src/mod-x/__tests__/alpha.test.ts',
  multiBetaSuite: 'src/mod-x/__tests__/beta.test.ts',
  /** Reachable only across the `defines` expansion. */
  hiddenSuite: 'src/mod-x/__tests__/hidden.test.ts'
} as const;

const IDS = {
  changed: contextGraphNodeId({ kind: 'file', path: PATHS.changed }),
  dependent: contextGraphNodeId({ kind: 'file', path: PATHS.dependent }),
  unrelated: contextGraphNodeId({ kind: 'file', path: PATHS.unrelated }),
  suiteFile: contextGraphNodeId({ kind: 'file', path: PATHS.suite }),
  suite: contextGraphNodeId({ kind: 'test', path: PATHS.suite }),
  flaggedBool: contextGraphNodeId({ kind: 'file', path: PATHS.flaggedBool }),
  flaggedString: contextGraphNodeId({ kind: 'file', path: PATHS.flaggedString }),
  multiFile: contextGraphNodeId({ kind: 'file', path: PATHS.multi }),
  multiAlpha: contextGraphNodeId({ kind: 'symbol', path: PATHS.multi, symbolKind: 'function', name: 'alpha', startOffset: 10 }),
  multiBeta: contextGraphNodeId({ kind: 'symbol', path: PATHS.multi, symbolKind: 'function', name: 'beta', startOffset: 20 }),
  multiAlphaSuite: contextGraphNodeId({ kind: 'test', path: PATHS.multiAlphaSuite }),
  multiBetaSuite: contextGraphNodeId({ kind: 'test', path: PATHS.multiBetaSuite }),
  hiddenSymbol: contextGraphNodeId({ kind: 'symbol', path: PATHS.changed, symbolKind: 'function', name: 'hidden', startOffset: 30 }),
  hiddenSuite: contextGraphNodeId({ kind: 'test', path: PATHS.hiddenSuite }),
  gateCustom: contextGraphNodeId({ kind: 'gate', gateId: 'custom:thing' }),
  gateSecurity: contextGraphNodeId({ kind: 'gate', gateId: 'security:secret-scan' }),
  gateLint: contextGraphNodeId({ kind: 'gate', gateId: 'lint:fast' }),
  gatePublishFlag: contextGraphNodeId({ kind: 'gate', gateId: 'custom:publish-flagged' }),
  gateAlwaysFlag: contextGraphNodeId({ kind: 'gate', gateId: 'custom:always-flagged' })
} as const;

/** Gate universe: one always-on release gate plus gates whose globs never match the changed file. */
const GATES: GateManifestEntry[] = [
  buildGateEntry('release:metadata-current'),
  buildGateEntry('custom:thing'),
  buildGateEntry('security:secret-scan'),
  buildGateEntry('lint:fast'),
  buildGateEntry('custom:publish-flagged'),
  buildGateEntry('custom:always-flagged')
];

function fileNode(id: string, filePath: string, metadata: ContextGraphMetadata = {}): ContextGraphNode {
  return {
    id,
    kind: 'file',
    label: path.posix.basename(filePath),
    path: filePath,
    contentHash: `sha-${filePath}`,
    trust: 1,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 40,
    metadata
  };
}

function gateNode(id: string, label: string, risk: ContextGraphRisk, metadata: ContextGraphMetadata): ContextGraphNode {
  return {
    id,
    kind: 'gate',
    label,
    path: 'release-gates.v2.json',
    contentHash: 'sha-gates',
    trust: 0.95,
    freshness: 'fresh',
    risk,
    tokenCost: 20,
    metadata
  };
}

function testNode(id: string, testPath: string): ContextGraphNode {
  return {
    id,
    kind: 'test',
    label: path.posix.basename(testPath),
    path: testPath,
    contentHash: `sha-${testPath}`,
    trust: 1,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 30,
    metadata: {}
  };
}

/**
 * A symbol node with **no `path` field**.
 *
 * The compact index's path table is built from `node.path`, so this node is
 * invisible to a path lookup and can only be reached by expanding the `defines`
 * edge from the file that declares it. That is the whole job of the expansion
 * hop, and no other node in this fixture would notice if it were removed.
 */
function pathlessSymbolNode(id: string, label: string): ContextGraphNode {
  return {
    id,
    kind: 'symbol',
    label,
    contentHash: `sha-${id}`,
    trust: 1,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 12,
    metadata: {}
  };
}

function symbolNode(id: string, symbolPath: string, label: string): ContextGraphNode {
  return {
    id,
    kind: 'symbol',
    label,
    path: symbolPath,
    contentHash: `sha-${id}`,
    trust: 1,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 12,
    metadata: {}
  };
}

function edge(from: string, to: string, type: ContextGraphEdgeType, provenancePath: string, line: number): ContextGraphEdge {
  return {
    id: contextGraphEdgeId({ from, to, type }),
    from,
    to,
    type,
    confidence: 'manifest',
    provenance: { path: provenancePath, line, hash: `sha-${provenancePath}`, extractor: 'affected-fixture' },
    observedAt: OBSERVED_AT
  };
}

function fixtureSnapshot(): ContextGraphSnapshot {
  const nodes: ContextGraphNode[] = [
    fileNode(IDS.changed, PATHS.changed),
    fileNode(IDS.dependent, PATHS.dependent),
    fileNode(IDS.unrelated, PATHS.unrelated),
    fileNode(IDS.suiteFile, PATHS.suite, { isTest: true }),
    fileNode(IDS.flaggedBool, PATHS.flaggedBool, { isTest: true }),
    fileNode(IDS.flaggedString, PATHS.flaggedString, { isTest: 'true' }),
    {
      id: IDS.suite,
      kind: 'test',
      label: 'changed.test.ts',
      path: PATHS.suite,
      contentHash: `sha-${PATHS.suite}`,
      trust: 1,
      freshness: 'fresh',
      risk: 'low',
      tokenCost: 30,
      metadata: { suite: 'file' }
    },
    gateNode(IDS.gateCustom, 'custom:thing', 'high', { namespace: 'custom' }),
    gateNode(IDS.gateSecurity, 'security:secret-scan', 'protected', { namespace: 'security', requiredForPublish: true }),
    gateNode(IDS.gateLint, 'lint:fast', 'medium', { namespace: 'lint' }),
    // `risk` is deliberately not `protected`, so only the metadata arm can answer.
    gateNode(IDS.gatePublishFlag, 'custom:publish-flagged', 'high', { namespace: 'custom', requiredForPublish: true }),
    gateNode(IDS.gateAlwaysFlag, 'custom:always-flagged', 'high', { namespace: 'custom', alwaysOnRelease: true }),
    fileNode(IDS.multiFile, PATHS.multi),
    symbolNode(IDS.multiAlpha, PATHS.multi, 'alpha'),
    symbolNode(IDS.multiBeta, PATHS.multi, 'beta'),
    testNode(IDS.multiAlphaSuite, PATHS.multiAlphaSuite),
    testNode(IDS.multiBetaSuite, PATHS.multiBetaSuite),
    pathlessSymbolNode(IDS.hiddenSymbol, 'hidden'),
    testNode(IDS.hiddenSuite, PATHS.hiddenSuite)
  ];
  const edges: ContextGraphEdge[] = [
    edge(IDS.dependent, IDS.changed, 'imports', PATHS.dependent, 1),
    edge(IDS.suite, IDS.changed, 'tests', PATHS.suite, 2),
    edge(IDS.suiteFile, IDS.suite, 'contains', PATHS.suite, 1),
    edge(IDS.flaggedBool, IDS.changed, 'tests', PATHS.flaggedBool, 3),
    edge(IDS.flaggedString, IDS.changed, 'tests', PATHS.flaggedString, 4),
    // Two symbols at one path, each with its own suite and no edge between them:
    // only an uncapped path lookup reaches both.
    edge(IDS.multiAlphaSuite, IDS.multiAlpha, 'tests', PATHS.multiAlphaSuite, 5),
    edge(IDS.multiBetaSuite, IDS.multiBeta, 'tests', PATHS.multiBetaSuite, 6),
    // The expansion hop, and the only edge that reaches the path-less symbol.
    edge(IDS.changed, IDS.hiddenSymbol, 'defines', PATHS.changed, 7),
    edge(IDS.hiddenSuite, IDS.hiddenSymbol, 'tests', PATHS.hiddenSuite, 8),
    // Reachable only through the dependent, which is exactly what a glob selector misses.
    edge(IDS.gateCustom, IDS.dependent, 'affected_by', 'release-gates.v2.json', 21),
    edge(IDS.gateSecurity, IDS.changed, 'affected_by', 'release-gates.v2.json', 22),
    edge(IDS.gateLint, IDS.unrelated, 'affected_by', 'release-gates.v2.json', 23),
    edge(IDS.gatePublishFlag, IDS.changed, 'affected_by', 'release-gates.v2.json', 24),
    edge(IDS.gateAlwaysFlag, IDS.changed, 'affected_by', 'release-gates.v2.json', 25)
  ];
  return buildContextGraphSnapshot({
    nodes,
    edges,
    cycles: [],
    extractors: [{ id: 'affected-fixture', revision: '1.0.0', nodeCount: nodes.length, edgeCount: edges.length, issueCount: 0, skippedCount: 0 }]
  });
}

/**
 * One published generation for the whole suite.
 *
 * The store refuses a second, different operation on a root until the first is
 * recovered, and the fixture never varies, so publishing once is both correct and
 * the only thing the store allows.
 */
let published: { root: string; reader: ContextIndexReader } | null = null;

async function fixtureReader(): Promise<ContextIndexReader> {
  if (published) return published.reader;
  resetContextIndexCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-affected-'));
  await publishFixtureContextIndex(root, fixtureSnapshot());
  const handle = await openWorkspaceContextIndex(root);
  published = { root, reader: handle.reader };
  return handle.reader;
}

after(() => {
  if (published) fs.rmSync(published.root, { recursive: true, force: true });
  published = null;
});

function baselineIds(changedFiles: string[], publish = false): string[] {
  return selectGates([...GATES], changedFiles, publish ? { publish: true } : {})
    .selected.map((entry) => entry.id)
    .sort();
}

async function run(changedFiles: string[], graphStatus: 'fresh' | 'stale' = 'fresh'): Promise<ContextGraphAffectedResult> {
  return contextGraphAffectedVerificationFromIndex(await fixtureReader(), {
    root: '/workspace-not-read',
    changedFiles,
    gates: GATES,
    graphStatus
  });
}

function assertNeverFewer(result: ContextGraphAffectedResult): void {
  assert.deepEqual(result.dropped_baseline_gates, [], 'the exact selector is a floor, never a ceiling');
  assert.deepEqual(missingContextGraphBaselineGates(result.baseline_gates, result.gates), []);
  for (const id of result.baseline_gates) assert.ok(result.gates.includes(id), `baseline gate ${id} survived`);
  assert.ok(result.gates.length >= result.baseline_gates.length);
}

test('the graph only ever adds to the exact changed-file selection', async () => {
  const result = await run([PATHS.changed]);

  assert.deepEqual(result.baseline_gates, baselineIds([PATHS.changed]));
  assertNeverFewer(result);
  assert.ok(result.gates.length > result.baseline_gates.length, 'the graph found reach the globs missed');
  assert.deepEqual(result.gates, [...new Set([...result.baseline_gates, ...result.added_gates])].sort());
});

test('a gate reachable only through a dependent file is added with its reason path', async () => {
  const result = await run([PATHS.changed]);

  assert.ok(result.added_gates.includes('custom:thing'), 'the transitively affected gate is added');
  assert.ok(!baselineIds([PATHS.changed]).includes('custom:thing'), 'the glob selector really did miss it');
  const detail = result.gate_details.find((row) => row.gate_id === 'custom:thing');
  assert.ok(detail);
  assert.equal(detail.source, 'context_graph');
  assert.deepEqual(detail.reason_path, [IDS.changed, '<-imports', IDS.dependent, '<-affected_by', IDS.gateCustom]);
  assert.equal(detail.explanation.length, 2);
  assert.equal(detail.provenance.at(-1)?.path, 'release-gates.v2.json');
  assert.ok(!result.gates.includes('lint:fast'), 'a gate with no path to the change is not invented');
});

test('protected release and security gates are always in the result', async () => {
  const result = await run([PATHS.unrelated]);

  assert.ok(result.gates.includes('release:metadata-current'), 'an always-on release gate never falls out');
  assert.ok(result.protected_gates.includes('release:metadata-current'));
  const security = await run([PATHS.changed]);
  assert.ok(security.gates.includes('security:secret-scan'));
  const detail = security.gate_details.find((row) => row.gate_id === 'security:secret-scan');
  assert.equal(detail?.protected, true);
});

/**
 * The metadata arms of `isProtectedGateNode`, isolated.
 *
 * Both gates carry `risk: 'high'`, so `node.risk === 'protected'` is false and the
 * only thing that can answer is the flag the compact reader handed back. Neither
 * gate is publish-required or always-on in the manifest, so the entry fallback is
 * false too. The control gate proves the assertion is not vacuous.
 */
test('a gate protected only by its metadata is reported protected, and one without the flag is not', async () => {
  const result = await run([PATHS.changed]);
  const detailOf = (id: string) => result.gate_details.find((row) => row.gate_id === id);

  for (const id of ['custom:publish-flagged', 'custom:always-flagged']) {
    const detail = detailOf(id);
    assert.ok(detail, `${id} reached the result`);
    assert.equal(detail.source, 'context_graph');
    assert.equal(detail.protected, true, `${id} is protected by its metadata alone`);
    assert.ok(result.protected_gates.includes(id));
  }
  const control = detailOf('custom:thing');
  assert.ok(control);
  assert.equal(control.protected, false, 'a same-risk gate without the flag is not protected');
  assert.ok(!result.protected_gates.includes('custom:thing'));
});

test('affected tests are recommended with the hop chain that produced them', async () => {
  const result = await run([PATHS.changed]);

  const suite = result.recommended_tests.find((row) => row.path === PATHS.suite);
  assert.ok(suite, 'the suite that exercises the changed file is recommended');
  assert.deepEqual(suite.reason_path, [IDS.changed, '<-tests', IDS.suite]);
  assert.equal(suite.provenance[0]?.path, PATHS.suite);
  assert.ok(suite.provenance.every((row) => !row.path.startsWith('/')));
});

/**
 * The whole reason `context-graph-affected.ts` was held back until format
 * revision 2 landed. Both nodes are `kind: 'file'`; only `metadata.isTest` marks
 * them, in the two spellings extractors actually author. A reader that flattened
 * metadata to display text — or a predicate narrowed to one spelling — recommends
 * fewer suites and the run gets faster.
 */
test('a suite marked only by metadata is recommended, in either spelling, and an unmarked file is not', async () => {
  const result = await run([PATHS.changed]);
  const paths = result.recommended_tests.map((row) => row.path);

  assert.ok(paths.includes(PATHS.flaggedBool), 'metadata.isTest === true is recognised');
  assert.ok(paths.includes(PATHS.flaggedString), "metadata.isTest === 'true' is recognised");
  assert.ok(!paths.includes(PATHS.dependent), 'a plain dependent file is not recommended as a suite');
  assert.ok(!paths.includes(PATHS.changed), 'the changed file itself is never recommended');
});

/**
 * Seed resolution takes every node at a changed path, uncapped.
 *
 * `src/mod-x/multi.ts` carries a file node and two symbol nodes with no edge
 * between them, and each symbol has its own suite. A per-key cap — the shape
 * `resolveContextSeeds` applies to guessed label seeds — keeps one posting and
 * silently drops the other suite.
 */
test('every node at a changed path seeds the walk, so no suite is lost to a per-path cap', async () => {
  const result = await run([PATHS.multi]);
  const paths = result.recommended_tests.map((row) => row.path);

  assert.ok(paths.includes(PATHS.multiAlphaSuite), 'the suite hanging off the first symbol survived');
  assert.ok(paths.includes(PATHS.multiBetaSuite), 'the suite hanging off the second symbol survived');
  assertNeverFewer(result);
});

/**
 * The expansion hop, isolated.
 *
 * `hidden` is a symbol with no `path`, so the index's path table cannot see it
 * and `defines` is not an impact relation — the reverse walk cannot reach it
 * either. Only expanding the changed file's outgoing `defines` edge puts it in
 * the frontier, and with it the suite that exercises it.
 */
test('a suite reachable only across the seed expansion is still recommended', async () => {
  const result = await run([PATHS.changed]);

  assert.ok(
    result.recommended_tests.some((row) => row.path === PATHS.hiddenSuite),
    'the expansion hop is what makes a symbol-level suite reachable'
  );
});

test('a stale graph keeps the exact selection and refuses to widen or shrink it', async () => {
  const stale = await run([PATHS.changed], 'stale');

  assert.equal(stale.ok, false);
  assert.equal(stale.graph_status, 'stale');
  assert.equal(stale.graph_used, false);
  assert.equal(stale.error_code, 'context_graph_stale');
  assert.equal(stale.repair_command, 'sks align run');
  assert.equal(stale.conservative, true);
  assert.ok(stale.conservative_reasons.includes('context_graph_stale'));
  assert.deepEqual(stale.added_gates, [], 'stale evidence never adds a gate');
  assert.deepEqual(stale.recommended_tests, []);
  assert.deepEqual(stale.gates, stale.baseline_gates);
  assert.ok(stale.errors.some((line) => line.includes('sks align run')));
  assertNeverFewer(stale);
});

test('a changed file the graph has never seen is reported, not silently ignored', async () => {
  const result = await run(['src/brand-new/file.ts']);

  assert.deepEqual(result.unresolved_changed_files, ['src/brand-new/file.ts']);
  assert.ok(result.conservative_reasons.includes('changed_file_not_in_graph'));
  assertNeverFewer(result);
});

test('publish keeps every publish-required gate and still adds graph reach', async () => {
  const result = contextGraphAffectedVerificationFromIndex(await fixtureReader(), {
    root: '/workspace-not-read',
    changedFiles: [PATHS.changed],
    gates: GATES,
    publish: true,
    graphStatus: 'fresh'
  });

  assert.deepEqual(result.baseline_gates, baselineIds([PATHS.changed], true));
  assertNeverFewer(result);
  assert.ok(result.gates.includes('custom:thing'));
});

test('an upstream selector result is carried through untouched', async () => {
  const result = contextGraphAffectedVerificationFromIndex(await fixtureReader(), {
    root: '/workspace-not-read',
    changedFiles: [PATHS.changed],
    gates: GATES,
    baselineGateIds: ['lint:fast'],
    graphStatus: 'fresh'
  });

  assert.ok(result.baseline_gates.includes('lint:fast'));
  assert.ok(result.gates.includes('lint:fast'), 'a gate the caller already committed to is never dropped');
  assertNeverFewer(result);
});

test('a workspace with no compiled index still returns the exact selection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-affected-missing-'));
  try {
    const result = await contextGraphAffectedVerification({ root, changedFiles: [PATHS.changed], gates: GATES });
    assert.equal(result.ok, false);
    assert.equal(result.graph_status, 'missing');
    assert.equal(result.error_code, 'context_graph_missing');
    assert.deepEqual(result.gates, baselineIds([PATHS.changed]));
    assert.deepEqual(result.added_gates, []);
    assert.ok(result.errors.some((line) => line.includes('sks align run')));
    assertNeverFewer(result);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
