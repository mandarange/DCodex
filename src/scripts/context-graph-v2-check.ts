#!/usr/bin/env node
// @ts-nocheck
/**
 * One check implementation behind four `context-graph-v2:*` gate ids, selected
 * by `--mode`, matching the shape of `context-graph-check.ts`:
 *
 *   contract        the frozen CRK2 contract: floors are equalities, sections and
 *                   lanes are declared, every failure names a repair command
 *   quality         corrupt-input rejection, operation fault recovery, and the
 *                   measured metadata gap
 *   performance     index bytes, open cost and bounded scan against a hermetic
 *                   fixture, plus the coarse lane's prove-or-delete evidence
 *   legacy-closure  nothing can lower a floor, and no benchmark-only engine is
 *                   reachable from production
 *
 * The rule this gate exists to enforce is the one a passing benchmark cannot
 * enforce for itself: **a threshold is never lowered to make a run pass.** The
 * CRK2 floors are literal `'eq'` comparisons with no tolerance field, and
 * `contract` and `legacy-closure` both check that structurally — a floor
 * relaxed into a `gte`, or given a tolerance, fails here rather than passing
 * quietly with a wider bound.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex >= 0 ? String(process.argv[modeIndex + 1] || '') : '';
const MODES = new Set(['contract', 'quality', 'performance', 'legacy-closure']);
assertGate(MODES.has(mode), 'context_graph_v2_check_unknown_mode', { mode, modes: [...MODES] });

const GATE_ID = `context-graph-v2:${mode}`;

function gitGrep(pattern, pathspecs) {
  const result = spawnSync('git', ['grep', '-n', '-I', '-E', pattern, '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0 && result.status !== 1) {
    assertGate(false, 'context_graph_v2_git_grep_failed', { pattern, stderr: (result.stderr || '').slice(0, 400) });
  }
  return String(result.stdout || '').split('\n').filter(Boolean);
}

async function runContract() {
  const types = await importDist('core/triwiki/context-graph/benchmark/crk2-types.js');
  const floors = await importDist('core/triwiki/context-graph/benchmark/crk2-floors.js');
  const format = await importDist('core/triwiki/context-graph/runtime-index/format.js');
  const readerErrors = await importDist('core/triwiki/context-graph/runtime-index/reader-errors.js');
  const kernel = await importDist('core/triwiki/context-graph/query/kernel-types.js');
  const journal = await importDist('core/triwiki/context-graph/store/operation-journal-schema.js');

  // 1. Every declared floor has a spec. A floor dropped from the spec list stops
  //    being checked while its id still appears in the contract.
  const gap = floors.crk2FloorCoverageGap();
  assertGate(gap.length === 0, 'context_graph_v2_floor_not_evaluated', { missing: gap });
  assertGate(
    floors.CRK2_FLOOR_SPECS.length === types.CRK2_FLOOR_IDS.length,
    'context_graph_v2_floor_count_drift',
    { specs: floors.CRK2_FLOOR_SPECS.length, ids: types.CRK2_FLOOR_IDS.length }
  );

  // 2. Every floor is an equality against the value the ADR fixes. A floor given
  //    a tolerance, or turned into a `gte`, is a lowered threshold with a
  //    plausible comment attached.
  const REQUIRED = {
    provenance_coverage_exact: 1,
    protected_gate_recall_exact: 1,
    conflict_recall_exact: 1,
    determinism_zero_mismatch: 0,
    corrupt_input_rejection_exact: 1,
    forbidden_node_zero: 0,
    unsupported_language_exact_mislabel_zero: 0
  };
  for (const spec of floors.CRK2_FLOOR_SPECS) {
    assertGate(
      Object.prototype.hasOwnProperty.call(REQUIRED, spec.id),
      'context_graph_v2_unknown_floor',
      { id: spec.id }
    );
    assertGate(spec.required === REQUIRED[spec.id], 'context_graph_v2_floor_relaxed', {
      id: spec.id,
      required: spec.required,
      contract: REQUIRED[spec.id]
    });
    assertGate(spec.tolerance === undefined, 'context_graph_v2_floor_tolerance_added', { id: spec.id });
  }
  const sample = floors.evaluateCrk2Floors(
    {
      engineId: 'contract-probe',
      engineVersion: 'v2',
      provenanceCoverage: 1,
      protectedGateRecall: 1,
      conflictRecall: 1,
      determinismMismatches: 0,
      rejectionRate: 1,
      forbiddenViolations: 0,
      confidenceViolations: 0
    },
    []
  );
  for (const result of sample.results) {
    assertGate(result.comparison === 'eq', 'context_graph_v2_floor_comparison_widened', { id: result.id, comparison: result.comparison });
  }

  // 3. Every query category the corpus contract names still exists; a category
  //    deleted here is a measurement that silently stops being taken.
  assertGate(types.CRK2_QUERY_CATEGORIES.length === 24, 'context_graph_v2_category_drift', {
    count: types.CRK2_QUERY_CATEGORIES.length
  });
  for (const required of ['korean', 'jargon', 'acronym', 'basename', 'corrupt_input', 'determinism']) {
    assertGate(types.CRK2_QUERY_CATEGORIES.includes(required), 'context_graph_v2_category_missing', { required });
  }

  // 4. Every section is required; an optional one would be a silent-degradation path.
  const sections = Object.values(format.CONTEXT_INDEX_SECTION);
  assertGate(format.CONTEXT_INDEX_REQUIRED_SECTIONS.length === sections.length, 'context_graph_v2_optional_section', {
    required: format.CONTEXT_INDEX_REQUIRED_SECTIONS.length,
    declared: sections.length
  });

  // 5. Every failure code names exactly one repair command, and carries integers
  //    only. An advisory error is one a caller learns to ignore; a string in the
  //    detail is how an interned workspace string reaches a log.
  for (const [code, command] of Object.entries(readerErrors.CONTEXT_INDEX_ERROR_REPAIR)) {
    assertGate(String(command).startsWith('sks '), 'context_graph_v2_error_without_repair', { code });
  }
  for (const code of Object.keys(format.CONTEXT_INDEX_FORMAT_ERRORS)) {
    const error = new format.ContextIndexFormatError(code, {});
    assertGate(error.repairCommand.startsWith('sks '), 'context_graph_v2_format_error_without_repair', { code });
    const leaked = Object.values(error.detail).some((value) => typeof value !== 'number');
    assertGate(!leaked, 'context_graph_v2_error_detail_not_numeric', { code });
  }

  // 6. The four lanes and the phase sequence are contracts, not listings:
  //    reordering either silently reassigns telemetry and fusion weights.
  const order = (values) => JSON.stringify([...values]);
  assertGate(kernel.LANE_COUNT === 4, 'context_graph_v2_lane_count_drift', { count: kernel.LANE_COUNT });
  assertGate(
    order(kernel.RETRIEVAL_LANES) === order(['anchor', 'lexical', 'coarse', 'local_graph']),
    'context_graph_v2_lane_order_drift',
    { lanes: [...kernel.RETRIEVAL_LANES] }
  );
  assertGate(
    order(journal.CONTEXT_OPERATION_PHASES) === order(['prepared', 'extracted', 'merged', 'indexed', 'committed', 'cleaned']),
    'context_graph_v2_phase_order_drift',
    { phases: [...journal.CONTEXT_OPERATION_PHASES] }
  );

  emitGate(GATE_ID, {
    mode,
    floors: floors.CRK2_FLOOR_SPECS.length,
    categories: types.CRK2_QUERY_CATEGORIES.length,
    sections: sections.length,
    lanes: kernel.RETRIEVAL_LANES.length,
    phases: journal.CONTEXT_OPERATION_PHASES.length
  });
}

async function runQuality() {
  const fuzz = await importDist('core/triwiki/context-graph/benchmark/crk2-fuzz.js');
  const faults = await importDist('core/triwiki/context-graph/benchmark/crk2-fault-operations.js');
  const fuzzIndex = await importDist('core/triwiki/context-graph/benchmark/crk2-fuzz-index.js');
  const gap = await importDist('core/triwiki/context-graph/benchmark/crk2-metadata-gap.js');

  // 1. Corrupt-input rejection is an equality: 100%, with no untyped throw and no
  //    mutated file ever answered instead of refused.
  const campaign = fuzz.runContextIndexFuzz({ casesPerStrategy: 400 });
  assertGate(campaign.divergent === 0, 'context_graph_v2_corrupt_index_answered', {
    divergent: campaign.divergent,
    findings: campaign.findings.slice(0, 6)
  });
  assertGate(campaign.crashed === 0, 'context_graph_v2_reader_crashed', {
    crashed: campaign.crashed,
    findings: campaign.findings.slice(0, 6)
  });
  assertGate(campaign.rejectionRate === 1, 'context_graph_v2_rejection_below_floor', {
    rejectionRate: campaign.rejectionRate
  });
  assertGate(campaign.nonNumericDetails === 0, 'context_graph_v2_error_detail_leak', {
    count: campaign.nonNumericDetails
  });
  assertGate(campaign.missingRepairCommand === 0, 'context_graph_v2_refusal_without_repair', {
    count: campaign.missingRepairCommand
  });

  // 2. A compile killed at any journal phase is fail-closed and leaves the
  //    previous pointer byte-identical.
  const roots = [];
  const makeRoot = async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sks-cg2-gate-'));
    roots.push(dir);
    return dir;
  };
  const base = fuzzIndex.fuzzBaseSnapshot();
  const variant = (hash) => ({ ...base, snapshotHash: hash });
  let faultReport;
  try {
    faultReport = await faults.runCrk2OperationFaults(makeRoot, {
      base,
      next: variant('b0'.repeat(32)),
      recovery: variant('c0'.repeat(32))
    });
  } finally {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  }
  assertGate(faultReport.ok, 'context_graph_v2_operation_fault_not_fail_closed', {
    failures: faultReport.failures.slice(0, 8)
  });

  // 3. The metadata type gap is measured rather than remembered. The gate does
  //    not require the format fix — it requires the workaround to be complete,
  //    because the day it stops being complete the fix is no longer optional.
  const reachability = gap.measureProtectedGateFlagReachability();
  assertGate(reachability.totalCounterexamples === 0, 'context_graph_v2_protected_flag_reachability_changed', {
    flags: reachability.flags.map((entry) => ({ flag: entry.flag, counterexamples: entry.counterexamples.length }))
  });

  emitGate(GATE_ID, {
    mode,
    fuzz_cases: campaign.cases,
    fuzz_rejection_rate: campaign.rejectionRate,
    fuzz_rules_reached: Object.keys(campaign.refusedByCode).length,
    fuzz_peak_heap_growth_bytes: campaign.peakHeapGrowthBytes,
    fault_phases: faultReport.phases,
    protected_flag_sets: reachability.flags.map((entry) => `${entry.flag}:${entry.gateIds}`),
    protected_metadata_arm_unreachable: reachability.metadataArmUnreachable
  });
}

async function runPerformance() {
  const compiler = await importDist('core/triwiki/context-graph/compiler/index.js');
  const extractors = await importDist('core/triwiki/context-graph/extractors/index.js');
  const fixtures = await importDist('core/triwiki/context-graph/benchmark/fixtures/index.js');
  const writer = await importDist('core/triwiki/context-graph/runtime-index/writer.js');
  const ranking = await importDist('core/triwiki/context-graph/query/ranking-config.js');
  const runner = await importDist('core/triwiki/context-graph/benchmark/crk2-resource-runner.js');
  const report = await importDist('core/triwiki/context-graph/benchmark/crk2-report.js');
  const reader = await importDist('core/triwiki/context-graph/runtime-index/reader.js');

  // Hermetic by construction: the fixture is materialized into a temp directory
  // and removed. A gate that measured this workspace's own snapshot would pass
  // or fail on whether someone had run `sks align` recently.
  const outcome = await fixtures.withFixture('large-repo-incremental', async (handle) => {
    const compiled = await compiler.compileContextGraph({
      root: handle.root,
      extractors: extractors.contextGraphExtractors(),
      observedAt: '2026-01-01T00:00:00.000Z',
      persistArtifacts: false
    });
    assertGate(Boolean(compiled.snapshot), 'context_graph_v2_fixture_compile_failed', {
      blockers: (compiled.blockers || []).slice(0, 6)
    });

    const json = JSON.stringify(compiled.snapshot);
    const encoded = writer.encodeContextIndex({
      snapshot: compiled.snapshot,
      configHash: new Uint8Array(32).fill(0x22),
      schemaRevision: 1,
      lexicon: ranking.CONTEXT_GRAPH_LEXICON_CONFIG
    });
    // A zero here means the four dictionary sections are empty and the index can
    // only answer a pasted path. Every recall number downstream would be void.
    assertGate(encoded.lexicon && encoded.lexicon.termCount > 0, 'context_graph_v2_lexicon_empty', {
      lexicon: encoded.lexicon
    });

    // Both sides are sampled and compared at the median. A single sample of each
    // has the first call paying JIT warm-up, which on a fixture this size is
    // larger than the difference being measured — the run would then report a
    // regression that reruns do not reproduce.
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const REPEATS = 15;
    const WARMUPS = 3;
    for (let i = 0; i < WARMUPS; i += 1) {
      JSON.parse(json);
      reader.openContextIndex(encoded.bytes);
    }
    const heapBeforeParse = process.memoryUsage().heapUsed;
    const parses = [];
    const opens = [];
    for (let i = 0; i < REPEATS; i += 1) {
      let started = performance.now();
      JSON.parse(json);
      parses.push(performance.now() - started);
      started = performance.now();
      reader.openContextIndex(encoded.bytes);
      opens.push(performance.now() - started);
    }
    const parseMs = median(parses);
    const afterParse = process.memoryUsage();

    // Every query is answerable from this fixture's own content. A query naming
    // something the fixture does not contain would return nothing, and an empty
    // answer's latency is a recall finding rather than a performance number —
    // the assertion below refuses to publish a pass computed over one.
    const queries = [
      { id: 'exact-node-id', query: 'file:src/gen/entry.ts', profile: 'implementation' },
      { id: 'exact-path', query: 'src/gen/mod-7/index.ts', profile: 'implementation' },
      { id: 'basename', query: 'entry.ts', profile: 'implementation' },
      { id: 'lexical', query: 'entry value module', profile: 'implementation' },
      { id: 'coarse-dir', query: 'src/gen/mod-7', profile: 'planning' },
      { id: 'review-gate', query: 'large_repo_scan_budget gate', profile: 'review' }
    ];
    const resources = runner.runCrk2ResourceBenchmark(encoded.bytes, queries, { repeats: 16, warmups: 2 });
    return {
      built: report.buildCrk2Report({
        snapshot: {
          bytes: Buffer.byteLength(json),
          parseMs,
          heapDeltaBytes: Math.max(0, afterParse.heapUsed - heapBeforeParse),
          rssBytes: afterParse.rss,
          nodeCount: compiled.snapshot.nodes.length,
          edgeCount: compiled.snapshot.edges.length
        },
        resources,
        lexicon: {
          termCount: encoded.lexicon.termCount,
          postingCount: encoded.lexicon.postingCount,
          coarseTermCount: encoded.lexicon.coarseTermCount,
          coarsePostingCount: encoded.lexicon.coarsePostingCount
        },
        generatedAt: '2026-01-01T00:00:00.000Z'
      }),
      resources,
      parseMs,
      openMs: median(opens)
    };
  });

  const built = outcome.built;
  const bytesRow = built.beforeAfter.find((entry) => entry.metric === 'runtime store bytes');
  assertGate(bytesRow.after < bytesRow.before, 'context_graph_v2_index_larger_than_snapshot', {
    snapshot: bytesRow.before,
    index: bytesRow.after
  });
  assertGate(outcome.openMs <= outcome.parseMs, 'context_graph_v2_open_slower_than_parse', {
    parseMs: outcome.parseMs,
    openMs: outcome.openMs
  });

  // An empty answer is a recall finding, not a latency win. The gate refuses to
  // publish a performance pass computed over queries that returned nothing.
  assertGate(built.emptyAnswerQueries.length === 0, 'context_graph_v2_empty_answers', {
    queries: built.emptyAnswerQueries
  });

  emitGate(GATE_ID, {
    mode,
    snapshot_bytes: bytesRow.before,
    index_bytes: bytesRow.after,
    size_factor: Number(bytesRow.factor.toFixed(2)),
    parse_ms: Number(outcome.parseMs.toFixed(3)),
    open_ms: Number(outcome.openMs.toFixed(3)),
    open_speedup: Number((outcome.parseMs / outcome.openMs).toFixed(2)),
    lexicon_terms: built.lexicon.termCount,
    coarse_terms: built.lexicon.coarseTermCount,
    coarse_verdict: built.coarseVerdict,
    coarse_only_selected: built.coarseOnlySelected,
    queries_with_coarse_only: built.queriesWithCoarseOnly,
    notes: built.notes
  });
}

function runLegacyClosure() {
  // 1. No floor may acquire a tolerance field, a `gte` variant, or a widened
  //    snap constant. Comments are stripped first: both files necessarily
  //    *describe* the tolerance they forbid, and a rule that matched its own
  //    rationale would fail forever and be deleted rather than fixed.
  const floorFiles = [
    'src/core/triwiki/context-graph/benchmark/crk2-floors.ts',
    'src/core/triwiki/context-graph/benchmark/crk2-types.ts'
  ];
  const relaxations = [];
  for (const file of floorFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const [pattern, id] of [
      [/\btolerance\b\s*[?:]/, 'tolerance_field'],
      [/\bepsilon\b\s*[?:=]/, 'epsilon_field'],
      [/['"]gte['"]/, 'gte_comparison'],
      [/['"]lte['"]/, 'lte_comparison']
    ]) {
      if (pattern.test(source)) relaxations.push(`${file}:${id}`);
    }
  }
  assertGate(relaxations.length === 0, 'context_graph_v2_floor_tolerance_introduced', { relaxations });

  // The float snap is arithmetic noise, not measurement slack. Widening it is
  // the cheapest possible way to make a failing equality pass.
  const floorSource = fs.readFileSync(path.join(root, floorFiles[0]), 'utf8');
  const noise = /ARITHMETIC_NOISE\s*=\s*([0-9.e-]+)/.exec(floorSource);
  assertGate(noise !== null, 'context_graph_v2_floor_snap_constant_missing');
  assertGate(Number(noise[1]) <= 1e-9, 'context_graph_v2_floor_snap_widened', { value: noise[1] });

  // 2. The benchmark's adapters are measurement instruments. A production import
  //    of one would reattach the very text-search fallback the ADR deletes.
  const adapterImports = gitGrep(
    "from '.*benchmark/(adapters|crk2-)",
    ['src', ':!src/core/triwiki/context-graph/benchmark', ':!src/scripts/context-graph-v2-check.ts']
  );
  assertGate(adapterImports.length === 0, 'context_graph_v2_benchmark_reachable_from_production', {
    hits: adapterImports.slice(0, 6)
  });

  // 3. The comparison seam takes both engines as arguments. An environment read
  //    inside it would make the seam a runtime switch, and a switch is a fallback.
  const envReads = gitGrep(
    '(process\\.env|getenv)',
    [
      'src/core/triwiki/context-graph/benchmark/crk2-comparison.ts',
      'src/core/triwiki/context-graph/benchmark/crk2-floors.ts',
      'src/core/triwiki/context-graph/benchmark/crk2-fuzz.ts',
      'src/core/triwiki/context-graph/benchmark/crk2-resource-runner.ts'
    ]
  );
  assertGate(envReads.length === 0, 'context_graph_v2_seam_reachable_from_configuration', { hits: envReads.slice(0, 6) });

  // 4. The reader has no fallback branch. A `catch` that returns an empty answer
  //    instead of rethrowing is the silent downgrade §1 forbids.
  const readerFallbacks = gitGrep(
    '(catch\\s*\\{\\s*return (\\[\\]|null|undefined))',
    ['src/core/triwiki/context-graph/runtime-index']
  );
  assertGate(readerFallbacks.length === 0, 'context_graph_v2_reader_fallback', { hits: readerFallbacks.slice(0, 6) });

  const required = [
    'src/core/triwiki/context-graph/benchmark/crk2-fuzz.ts',
    'src/core/triwiki/context-graph/benchmark/crk2-fuzz-index.ts',
    'src/core/triwiki/context-graph/benchmark/crk2-fault-operations.ts',
    'src/core/triwiki/context-graph/benchmark/crk2-resource-runner.ts',
    'src/core/triwiki/context-graph/benchmark/crk2-report.ts',
    'src/core/triwiki/context-graph/benchmark/crk2-metadata-gap.ts'
  ];
  for (const file of required) {
    assertGate(fs.existsSync(path.join(root, file)), 'context_graph_v2_measurement_module_missing', { file });
  }

  emitGate(GATE_ID, { mode, checks: 4, measurement_modules: required.length });
}

if (mode === 'contract') await runContract();
else if (mode === 'quality') await runQuality();
else if (mode === 'performance') await runPerformance();
else runLegacyClosure();
