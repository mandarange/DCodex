/**
 * Real-scale extraction-cap contract, checked where the graph is produced.
 *
 * On 2026-08-13 `sks align run` on this repository blocked with 16 fatal
 * `cap_reached` skips because the extraction caps had never faced the product's
 * own inputs: a 162-gate `release-gates.v2.json` whose widest cache input
 * (`src/**`) matched 2368 files (14 distinct inputs exceeded the 48-match glob
 * cap, one check pattern matched 57), and an 880-entry proof-bank index against
 * a 512-record ceiling. This fixture is built at-or-above every one of those
 * measured axes, so the next time the caps fall below the product's real scale
 * the failure happens HERE, in the compiler suite, not at align time:
 *
 *   gates                170 >= 162 measured
 *   over-cap glob inputs  15 >= 14 measured (widest matches every fixture file,
 *                                            >= 2368 measured for `src/**`)
 *   per-gate affected_by 100 >= 74 measured  (`migration:upgrade-safety`)
 *   per-gate verified_by  49 >= 40 measured  (`test:commands-regression`)
 *   proof index entries 1000 >= 880 measured
 *   secret-named gate ids  1 >= 1 measured   (`secret:preservation`, cited by
 *                                             proof entries past the old cap)
 *
 * The compile must succeed with ZERO `cap_reached` skips: over-wide globs are a
 * deliberate whole-glob representation (`excluded` skip + raw metadata on the
 * gate node), and every sized cap (`TOPOLOGY_GATE_AFFECTED_CAP`,
 * `TOPOLOGY_GATE_VERIFIED_CAP`, `MAX_PROOF_RECORDS`) must clear these fan-ins.
 * Shrinking any of them below this fixture's scale fails this test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileContextGraph } from '../index.js';
import { architectureMapGraphExtractors, createTopologyGraphExtractor } from '../../extractors/index.js';
import { walkCodeInventory } from '../../extractors/code/inventory.js';
import { CODE_NAVIGATION_LIMITS } from '../../../code-navigation-policy.js';
import {
  FIXED_OBSERVED_AT,
  makeFixtureRoot,
  removeFixtureRoot,
  writeFixtureFile
} from './graph-test-fixtures.js';

/** Fixture floors pinned to the 2026-08-13 measurement of this repository. */
const GATE_COUNT = 170;
const AFFECTED_FAN_IN = 100;
const VERIFIED_GLOB_MATCHES = 48;
const PROOF_INDEX_ENTRIES = 1000;
const WIDE_DIRS = 13;
const WIDE_FILES_PER_DIR = 190;

interface FixtureGate {
  id: string;
  command: string;
  deps: string[];
  resource: string[];
  side_effect: string;
  timeout_ms: number;
  cache: { enabled: boolean; inputs: string[] };
  preset: string[];
  output_contract: string;
}

function fixtureGate(id: string, command: string, inputs: string[]): FixtureGate {
  return {
    id,
    command,
    deps: [],
    resource: ['cpu-light'],
    side_effect: 'hermetic',
    timeout_ms: 120000,
    cache: { enabled: true, inputs },
    preset: ['release'],
    output_contract: 'sks.gate-result.v2'
  };
}

function seedWorkspace(): { root: string; wideInputs: string[] } {
  const root = makeFixtureRoot('cg-real-scale');
  writeFixtureFile(root, 'package.json', '{"name":"fixture"}\n');
  writeFixtureFile(root, 'src/scripts/scale-check.ts', 'export const scale = 1;\n');
  writeFixtureFile(root, 'src/scripts/big-check.ts', 'export const big = 1;\n');

  // Per-gate affected_by fan-in above the real maximum (74), fed through
  // narrow globs so every one of them expands (5 dirs x 20 files, each dir
  // well under the glob match cap).
  const affInputs: string[] = [];
  for (let dir = 0; dir < 5; dir += 1) {
    for (let index = 0; index < AFFECTED_FAN_IN / 5; index += 1) {
      writeFixtureFile(
        root,
        `src/aff/d${dir}/f${String(index).padStart(2, '0')}.ts`,
        `export const aff_${dir}_${index} = 1;\n`
      );
    }
    affInputs.push(`src/aff/d${dir}/**`);
  }

  // Per-gate verified_by fan-in above the real maximum (40): a check pattern
  // matching exactly the glob cap (so it expands) plus one literal script.
  for (let index = 0; index < VERIFIED_GLOB_MATCHES; index += 1) {
    writeFixtureFile(
      root,
      `src/wideverify/f${String(index).padStart(2, '0')}.test.ts`,
      `export const verify_${index} = 1;\n`
    );
  }

  // The wide tree: enough non-code files that `src/**` matches at-or-above the
  // real 2368, without the code extractor having to parse any of them.
  for (let dir = 0; dir < WIDE_DIRS; dir += 1) {
    for (let index = 0; index < WIDE_FILES_PER_DIR; index += 1) {
      writeFixtureFile(root, `src/wide/w${String(dir).padStart(2, '0')}/f${String(index).padStart(3, '0')}.txt`, 'wide\n');
    }
  }
  const wideInputs = [
    'src/**',
    'src/aff/**',
    ...Array.from({ length: WIDE_DIRS }, (_, dir) => `src/wide/w${String(dir).padStart(2, '0')}/**`)
  ];

  writeFixtureFile(root, 'src/mod/secret-preservation.ts', 'export const preserved = 1;\n');
  const gates: FixtureGate[] = [
    fixtureGate('scale:affected-fan-in', 'node ./dist/scripts/scale-check.js', affInputs),
    fixtureGate(
      'scale:verified-fan-in',
      'node ./dist/scripts/big-check.js dist/wideverify/*.test.js',
      ['src/scripts/big-check.ts']
    ),
    // The real manifest declares `secret:preservation`; its id reads like a
    // `secret: <value>` assignment to the raw secret heuristic, and proof
    // records referencing it only surface once the record cap clears the real
    // proof-bank size. The compile must accept the honest name.
    fixtureGate('secret:preservation', 'node ./dist/scripts/scale-check.js', ['src/mod/secret-preservation.ts'])
  ];
  // Distribute the over-cap inputs across gates the way the real manifest does:
  // one wide directory glob next to the gate's own narrow input.
  for (let index = gates.length; index < GATE_COUNT; index += 1) {
    const own = `src/mod/g${String(index).padStart(3, '0')}.ts`;
    writeFixtureFile(root, own, `export const g${index} = 1;\n`);
    const wide = wideInputs[index % wideInputs.length] ?? 'src/**';
    gates.push(fixtureGate(`scale:g${String(index).padStart(3, '0')}`, 'node ./dist/scripts/scale-check.js', [own, wide]));
  }
  assert.equal(gates.length, GATE_COUNT);
  writeFixtureFile(root, 'release-gates.v2.json', `${JSON.stringify({ schema: 'sks.release-gates.v2', gates }, null, 2)}\n`);

  // Proof-bank index above the real 880 entries. Cards are deliberately absent:
  // discovery must represent every entry (missing cards become `invalidates`
  // evidence, never truncation).
  const proofs = Array.from({ length: PROOF_INDEX_ENTRIES }, (_, index) => ({
    proof_id: `proof-${String(index).padStart(4, '0')}`,
    subject_type: 'gate',
    // Only ever reference gates the manifest really declares, so the evidence
    // extractor links instead of minting stub gate nodes — including the
    // secret-named gate the real proof bank cites.
    subject_id:
      index % 150 === 0
        ? 'secret:preservation'
        : `scale:g${String(3 + (index % (GATE_COUNT - 3))).padStart(3, '0')}`,
    cache_key: `cache-${String(index).padStart(4, '0')}`,
    reusable: true,
    expires_at: null,
    path: `.sneakoscope/triwiki/proof-bank/gates/scale/proof-${String(index).padStart(4, '0')}.json`,
    hash: 'a'.repeat(64),
    invalidation_reasons: []
  }));
  writeFixtureFile(
    root,
    '.sneakoscope/triwiki/proof-bank/index.json',
    `${JSON.stringify({ schema: 'sks.triwiki-proof-index.v1', proofs }, null, 2)}\n`
  );
  return { root, wideInputs };
}

test('a manifest at the product\'s real scale compiles with zero cap_reached skips', async () => {
  const { root, wideInputs } = seedWorkspace();
  try {
    const compiled = await compileContextGraph({
      root,
      extractors: architectureMapGraphExtractors(),
      changedPaths: null,
      limits: CODE_NAVIGATION_LIMITS,
      observedAt: FIXED_OBSERVED_AT,
      useFragmentCache: false,
      persistArtifacts: false,
      useCompileLock: false
    });
    assert.equal(compiled.ok, true, `compile must succeed: ${compiled.blockers.join(',')}`);
    assert.ok(compiled.snapshot);
    const snapshot = compiled.snapshot;

    // THE regression signal from the field: any cap_reached skip here would be
    // an Align-fatal blocker on a workspace shaped like this repository.
    const capReached = compiled.skipped.filter((skip) => skip.reason === 'cap_reached');
    assert.deepEqual(
      capReached,
      [],
      `an extraction cap fired below the product's own real scale: ${JSON.stringify(capReached)}`
    );

    // Over-wide globs stay whole on the gate node and are observable, not silent.
    for (const wide of wideInputs) {
      assert.ok(
        compiled.skipped.some(
          (skip) =>
            skip.reason === 'excluded'
            && String(skip.detail ?? '').includes(`cache input ${wide} matched `)
            && String(skip.detail ?? '').includes('kept whole as cacheInputs metadata')
        ),
        `over-cap input ${wide} must be reported as a non-fatal excluded skip`
      );
    }
    assert.ok(
      !snapshot.nodes.some((node) => node.id.startsWith('file:src/wide/')),
      'an over-wide glob must not flood the snapshot with file nodes'
    );

    const gateNodes = snapshot.nodes.filter((node) => node.kind === 'gate');
    assert.equal(gateNodes.length, GATE_COUNT);

    const proofNodes = snapshot.nodes.filter((node) => node.kind === 'proof');
    assert.equal(
      proofNodes.length,
      PROOF_INDEX_ENTRIES,
      'every proof-bank index entry must be represented; a shortfall means the record cap truncated'
    );

    // The honest secret-named gate id must survive the evidence identity guard
    // with its proof relations intact, exactly as the snapshot lint accepts it.
    assert.ok(
      snapshot.nodes.some((node) => node.id === 'gate:secret:preservation'),
      'the secret-named gate the real manifest declares must stay in the graph'
    );
    assert.ok(
      snapshot.edges.some(
        (edge) => edge.to === 'gate:secret:preservation' || edge.from === 'gate:secret:preservation'
      ),
      'proof records referencing the secret-named gate must keep their evidence relation'
    );

    // The 9.0.4 invariant, still holding at this scale: file nodes are exactly
    // the code source inventory.
    const inventoryPaths = walkCodeInventory(root, CODE_NAVIGATION_LIMITS)
      .files.map((file) => file.rel)
      .sort();
    const fileNodePaths = snapshot.nodes
      .filter((node) => node.kind === 'file')
      .map((node) => String(node.path ?? ''))
      .filter(Boolean)
      .sort();
    assert.deepEqual(
      fileNodePaths.filter((rel) => !new Set(inventoryPaths).has(rel)),
      [],
      'no file node may leave the code source inventory'
    );
    assert.equal(fileNodePaths.length, inventoryPaths.length, 'exact file coverage must hold at real scale');
  } finally {
    removeFixtureRoot(root);
  }
});

/**
 * The per-gate edge caps are enforced (and must therefore be sized) at the
 * extractor, so the fan-in floors are pinned against the topology fragment:
 * the merge later re-judges `derived` edges on its own justification rule,
 * which is not the contract under test here. Shrinking
 * `TOPOLOGY_GATE_AFFECTED_CAP` below 100 or `TOPOLOGY_GATE_VERIFIED_CAP`
 * below 49 turns these equalities into `cap_reached` skips and fails this test.
 */
test('the widest real per-gate fan-ins extract without hitting a per-gate edge cap', async () => {
  const { root } = seedWorkspace();
  try {
    const fragment = await createTopologyGraphExtractor().extract({
      root,
      changedPaths: null,
      limits: CODE_NAVIGATION_LIMITS,
      observedAt: FIXED_OBSERVED_AT
    });
    assert.deepEqual(
      fragment.skipped.filter((skip) => skip.reason === 'cap_reached'),
      [],
      'no topology cap may fire below the product\'s own real scale'
    );
    const affectedEdges = fragment.edges.filter(
      (edge) => edge.type === 'affected_by' && edge.from === 'gate:scale:affected-fan-in'
    );
    assert.equal(
      affectedEdges.length,
      AFFECTED_FAN_IN,
      'every member file of the widest real gate fan-in must get its affected_by edge'
    );
    const verifiedEdges = fragment.edges.filter(
      (edge) => edge.type === 'verified_by' && edge.from === 'gate:scale:verified-fan-in'
    );
    assert.equal(
      verifiedEdges.length,
      VERIFIED_GLOB_MATCHES + 1,
      'every check implementation of the widest real verification fan-in must get its verified_by edge'
    );
  } finally {
    removeFixtureRoot(root);
  }
});
