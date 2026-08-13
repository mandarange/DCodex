/**
 * File-coverage contract, checked where the graph is produced.
 *
 * Align refuses to publish unless the snapshot's `file` nodes are exactly the
 * code source inventory (`code-navigation-align.ts`). Extractors discover paths
 * from many other places — gate cache inputs, proof-card input paths, context
 * pack citations — and every one of those channels is armed in this fixture
 * with the exact artifacts that broke Align in the field (`AGENTS.md`,
 * `.codex/config.toml`) plus the structural offenders (`package.json`,
 * `package-lock.json`, `release-gates.v2.json`). A `file` node minted for any
 * of them must fail HERE, in the compiler suite, not at align time on a user
 * machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_GRAPH_LIMITS, compileContextGraph } from '../index.js';
import { contextGraphExtractors } from '../../extractors/index.js';
import { walkCodeInventory } from '../../extractors/code/inventory.js';
import {
  FIXED_OBSERVED_AT,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureFile
} from './graph-test-fixtures.js';

const OUT_OF_INVENTORY = [
  'AGENTS.md',
  '.codex/config.toml',
  'package.json',
  'package-lock.json',
  'release-gates.v2.json'
];

function seedWorkspace(prefix: string): string {
  const root = makeFixtureRoot(prefix);
  // Code inventory members.
  writeFixtureFile(root, 'src/a.ts', "import { B } from './b.js';\nexport const A = B + 1;\n");
  writeFixtureFile(root, 'src/b.ts', 'export const B = 1;\n');
  writeFixtureFile(root, 'src/scripts/demo-check.ts', 'export const demo = 1;\n');
  // Discovery channels that must never become `file` nodes.
  writeFixtureFile(root, 'AGENTS.md', '# agents\n');
  writeFixtureFile(root, '.codex/config.toml', 'model = "demo"\n');
  writeFixtureFile(root, 'package.json', '{"name":"fixture"}\n');
  writeFixtureFile(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  // Topology channel: a gate citing config/docs/source as cache inputs.
  writeFixtureFile(
    root,
    'release-gates.v2.json',
    `${JSON.stringify({
      schema: 'sks.release-gates.v2',
      gates: [
        {
          id: 'release:coverage',
          command: 'node ./dist/scripts/demo-check.js',
          deps: [],
          resource: ['cpu-light'],
          side_effect: 'hermetic',
          timeout_ms: 120000,
          cache: {
            enabled: true,
            inputs: ['AGENTS.md', '.codex/config.toml', 'package.json', 'src/a.ts']
          },
          preset: ['release'],
          output_contract: 'sks.gate-result.v2'
        }
      ]
    }, null, 2)}\n`
  );
  // Evidence channels: a context pack citing the docs pair, and a proof card
  // pinning release surfaces by hash while naming config + source input paths.
  writeFixtureFile(
    root,
    '.sneakoscope/wiki/context-pack.json',
    `${JSON.stringify({
      mission: 'project-wiki',
      role: 'worker',
      q3: ['sks'],
      wiki: { schema: 'sks.wiki-coordinate.v1', a: [] },
      attention: { use_first: [], hydrate_first: [] },
      claims: [
        {
          id: 'doc-claim',
          text: 'the agents doc and codex config describe this workspace',
          source_paths: ['AGENTS.md', '.codex/config.toml', 'src/a.ts'],
          trust_score: 0.9,
          status: 'supported'
        }
      ],
      provenance: {
        schema: 'sks.triwiki-context-pack-provenance.v1',
        generated_at: FIXED_OBSERVED_AT,
        source_manifest: { schema: 'sks.triwiki-source-manifest.v1', entries: [] }
      }
    }, null, 2)}\n`
  );
  writeFixtureFile(
    root,
    '.sneakoscope/triwiki/proof-bank/gates/gate-coverage/proof-coverage.json',
    `${JSON.stringify({
      schema: 'sks.triwiki-proof-card.v1',
      proof_id: 'proof-coverage',
      subject_type: 'gate',
      subject_id: 'gate-coverage',
      cache_key: 'cache-key-coverage',
      input_hash: 'a'.repeat(64),
      implementation_hash: 'b'.repeat(64),
      gate_impl_hash: 'b'.repeat(64),
      package_lock_hash: 'c'.repeat(64),
      release_gates_hash: 'd'.repeat(64),
      env_allowlist_hash: 'e'.repeat(64),
      tool_versions: { sks: 'pinned' },
      tool_version: 'pinned',
      fixture_version: 'fixture-1',
      result: 'passed',
      reusable: true,
      evidence: { checks: 1 },
      input_paths: ['.codex/config.toml', 'src/a.ts'],
      invalidation_reasons: [],
      expires_at: null,
      duration_ms: 12,
      created_at: FIXED_OBSERVED_AT
    }, null, 2)}\n`
  );
  return root;
}

test('every file node in a compiled snapshot is exactly the code source inventory', async () => {
  const root = seedWorkspace('cg-file-coverage');
  try {
    const compiled = await compileContextGraph({
      root,
      extractors: contextGraphExtractors(),
      changedPaths: null,
      limits: DEFAULT_CONTEXT_GRAPH_LIMITS,
      observedAt: FIXED_OBSERVED_AT,
      useFragmentCache: false,
      persistArtifacts: false,
      useCompileLock: false
    });
    assert.equal(compiled.ok, true, `compile must succeed: ${compiled.blockers.join(',')}`);
    assert.ok(compiled.snapshot);
    const snapshot = compiled.snapshot;
    assert.deepEqual(
      snapshot.extractors.map((extractor) => extractor.id).sort(),
      ['code', 'topology', 'triwiki-evidence'],
      'the contract must be proven against the full registry'
    );

    // The exact predicate Align enforces before publishing: no unexpected file
    // nodes, no missing inventory files, same cardinality.
    const inventoryPaths = walkCodeInventory(root, DEFAULT_CONTEXT_GRAPH_LIMITS)
      .files.map((file) => file.rel)
      .sort();
    const fileNodePaths = snapshot.nodes
      .filter((node) => node.kind === 'file')
      .map((node) => String(node.path ?? ''))
      .filter(Boolean)
      .sort();
    const inventorySet = new Set(inventoryPaths);
    const fileNodeSet = new Set(fileNodePaths);
    const unexpected = fileNodePaths.filter((rel) => !inventorySet.has(rel));
    const missing = inventoryPaths.filter((rel) => !fileNodeSet.has(rel));
    assert.deepEqual(unexpected, [], 'file nodes outside the code source inventory poison Align');
    assert.deepEqual(missing, [], 'every inventory file must still be represented');
    assert.equal(fileNodePaths.length, inventoryPaths.length);

    for (const rel of OUT_OF_INVENTORY) {
      assert.ok(
        !snapshot.nodes.some((node) => node.id === `file:${rel}`),
        `file:${rel} must never be minted by any extractor`
      );
    }
    // The discovery channels themselves must have produced their own kinds, so
    // this test cannot silently pass because an armed channel went dark.
    assert.ok(snapshot.nodes.some((node) => node.id === 'gate:release:coverage'), 'the gate channel must be live');
    assert.ok(snapshot.nodes.some((node) => node.kind === 'wiki_claim'), 'the claims channel must be live');
    assert.ok(snapshot.nodes.some((node) => node.kind === 'proof'), 'the proof channel must be live');
    assert.ok(
      snapshot.nodes.filter((node) => node.kind === 'source').length >= 3,
      'cited paths must keep their source nodes'
    );
  } finally {
    removeFixtureRoot(root);
  }
});
