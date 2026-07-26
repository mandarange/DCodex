#!/usr/bin/env node
// @ts-nocheck
/**
 * One check implementation behind four gate ids, selected by `--mode`:
 *
 *   contract        the frozen contract, stable identity, path safety, schema parity, determinism
 *   quality         the locked benchmark's hard safety floors and retrieval floors
 *   performance     the locked benchmark's latency, token and cache floors
 *   legacy-closure  the replaced lexical paths are gone, with no alias or fallback left behind
 *
 * Adding one gate per new implementation file would multiply the release DAG for
 * no extra evidence, so the modes share this file and its dist entry point.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex >= 0 ? String(process.argv[modeIndex + 1] || '') : '';
const MODES = new Set(['contract', 'quality', 'performance', 'legacy-closure']);
assertGate(MODES.has(mode), 'context_graph_check_unknown_mode', { mode, modes: [...MODES] });

const GATE_ID = `context-graph:${mode}`;

function gitGrep(pattern, pathspecs) {
  const result = spawnSync('git', ['grep', '-n', '-I', '-E', pattern, '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8'
  });
  // git grep exits 1 when nothing matched, which is the passing case here.
  if (result.status !== 0 && result.status !== 1) {
    assertGate(false, 'context_graph_git_grep_failed', { pattern, stderr: (result.stderr || '').slice(0, 400) });
  }
  return String(result.stdout || '').split('\n').filter(Boolean);
}

async function runContract() {
  const contracts = await importDist('core/triwiki/context-graph/contracts.js');
  const ids = await importDist('core/triwiki/context-graph/ids.js');
  const paths = await importDist('core/triwiki/context-graph/paths.js');
  const profiles = await importDist('core/triwiki/context-graph/profiles.js');
  const extractors = await importDist('core/triwiki/context-graph/extractors/index.js');

  // 1. The published JSON schema and the TypeScript enumerations must agree, or a
  //    consumer validating against the schema would accept a graph the code rejects.
  const schemaPath = path.join(root, 'schemas', 'triwiki', 'context-graph.schema.json');
  assertGate(fs.existsSync(schemaPath), 'context_graph_schema_missing', { schemaPath: 'schemas/triwiki/context-graph.schema.json' });
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assertGate(schema.title === contracts.CONTEXT_GRAPH_SCHEMA, 'context_graph_schema_title_mismatch', { title: schema.title });
  const schemaKinds = schema.definitions.node.properties.kind.enum;
  const schemaEdges = schema.definitions.edge.properties.type.enum;
  assertGate(
    JSON.stringify(schemaKinds) === JSON.stringify([...contracts.CONTEXT_GRAPH_NODE_KINDS]),
    'context_graph_node_kind_drift',
    { schema: schemaKinds, code: [...contracts.CONTEXT_GRAPH_NODE_KINDS] }
  );
  assertGate(
    JSON.stringify(schemaEdges) === JSON.stringify([...contracts.CONTEXT_GRAPH_EDGE_TYPES]),
    'context_graph_edge_type_drift',
    { schema: schemaEdges, code: [...contracts.CONTEXT_GRAPH_EDGE_TYPES] }
  );

  // 2. Stable identity: same input, same id; no ordering or clock in the value.
  const first = ids.contextGraphNodeId({ kind: 'symbol', path: 'src/a.ts', symbolKind: 'function', name: 'run', startOffset: 7 });
  const second = ids.contextGraphNodeId({ kind: 'symbol', path: 'src/a.ts', symbolKind: 'function', name: 'run', startOffset: 7 });
  assertGate(first === second && first === 'symbol:src/a.ts#function:run@7', 'context_graph_unstable_node_id', { first, second });
  const edgeA = ids.contextGraphEdgeId({ from: 'file:a.ts', to: 'file:b.ts', type: 'imports' });
  const edgeB = ids.contextGraphEdgeId({ from: 'file:a.ts', to: 'file:b.ts', type: 'imports' });
  assertGate(edgeA === edgeB, 'context_graph_unstable_edge_id', { edgeA, edgeB });

  // 3. One comparator. Two orderings would let two machines hash identical input differently.
  // A call site, not a mention: the comment explaining why this comparator was
  // rejected must not itself trip the check.
  const comparatorSources = gitGrep('\\.localeCompare\\(', [
    'src/core/triwiki/context-graph/contracts.ts',
    'src/core/triwiki/context-graph/ids.ts',
    'src/core/triwiki/context-graph/compiler/serialize.ts'
  ]);
  assertGate(comparatorSources.length === 0, 'context_graph_locale_sensitive_ordering', { hits: comparatorSources });

  // 4. Path safety refuses absolute, escaping and empty paths.
  for (const bad of ['/etc/passwd', '../outside.ts', '']) {
    let threw = false;
    try { paths.normalizeGraphPath(root, bad); } catch { threw = true; }
    assertGate(threw, 'context_graph_path_escape_accepted', { candidate: bad });
  }
  assertGate(paths.normalizeGraphPath(root, path.join(root, 'package.json')) === 'package.json', 'context_graph_path_normalization_broken');

  // 5. Every profile traverses at least one edge, and every edge type a profile
  //    names is a real contract edge type.
  const edgeTypes = new Set(contracts.CONTEXT_GRAPH_EDGE_TYPES);
  const reachable = new Set();
  for (const name of profiles.CONTEXT_GRAPH_QUERY_PROFILE_NAMES) {
    const profile = profiles.contextGraphQueryProfile(name);
    assertGate(profile.edges.length > 0, 'context_graph_empty_profile', { profile: name });
    for (const edge of profile.edges) {
      assertGate(edgeTypes.has(edge), 'context_graph_profile_unknown_edge', { profile: name, edge });
      reachable.add(edge);
    }
    assertGate(profile.maxDepthHighRisk >= profile.maxDepth, 'context_graph_profile_depth_inverted', { profile: name });
  }

  // 6. Ranking numbers live in exactly one file.
  const strayWeights = gitGrep('(exact_seed_bonus|edge_profile_weight|trust_bonus|stale_penalty|redundancy_penalty|token_cost_penalty)\\s*[:=]\\s*[0-9]', [
    'src/core/triwiki/context-graph',
    ':!src/core/triwiki/context-graph/query/ranking-config.ts',
    ':!src/core/triwiki/context-graph/**/__tests__/**'
  ]);
  assertGate(strayWeights.length === 0, 'context_graph_ranking_constants_duplicated', { hits: strayWeights.slice(0, 10) });

  // 7. The registry is wired; a compiler with no extractors would produce an
  //    empty graph that still looked structurally valid.
  const registered = extractors.contextGraphExtractors();
  assertGate(registered.length >= 3, 'context_graph_extractor_registry_incomplete', { count: registered.length });
  const registeredIds = registered.map((extractor) => extractor.id).sort();
  assertGate(new Set(registeredIds).size === registeredIds.length, 'context_graph_extractor_id_collision', { registeredIds });

  emitGate(GATE_ID, {
    mode,
    node_kinds: schemaKinds.length,
    edge_types: schemaEdges.length,
    profiles: profiles.CONTEXT_GRAPH_QUERY_PROFILE_NAMES.length,
    traversable_edge_types: reachable.size,
    extractors: registeredIds
  });
}

async function runBenchmark() {
  const benchmark = await importDist('core/triwiki/context-graph/benchmark/index.js');
  const baseline = await importDist('core/triwiki/context-graph/benchmark/adapters/baseline-lexical.js');
  const candidate = await importDist('core/triwiki/context-graph/benchmark/adapters/candidate-graph.js');
  return benchmark.runContextGraphBenchmark(
    [baseline.createBaselineLexicalAdapter(), candidate.createCandidateGraphAdapter()],
    { root, writeReport: true }
  );
}

function summaryOf(report, kind) {
  return report.summaries.find((entry) => entry.adapterKind === kind) || null;
}

function failedFloors(report) {
  return report.floors.results.filter((floor) => !floor.passed).map((floor) => ({
    id: floor.id,
    adapter: floor.adapterId,
    observed: floor.observed,
    limit: floor.limit,
    detail: floor.detail.slice(0, 6)
  }));
}

async function runQuality() {
  const report = await runBenchmark();
  assertGate(report.integrity.ok, 'context_graph_benchmark_corpus_tampered', { integrity: report.integrity });
  assertGate(report.floors.ok, 'context_graph_hard_safety_floor_failed', { failed: failedFloors(report) });

  const candidate = summaryOf(report, 'candidate');
  assertGate(Boolean(candidate), 'context_graph_benchmark_missing_candidate');
  assertGate(candidate.provenanceCoverage >= 1, 'context_graph_provenance_coverage_below_floor', { observed: candidate.provenanceCoverage });
  assertGate(candidate.protectedGateRecall >= 1, 'context_graph_protected_gate_recall_below_floor', { observed: candidate.protectedGateRecall });
  assertGate(candidate.conflictRecall >= 1, 'context_graph_conflict_recall_below_floor', { observed: candidate.conflictRecall });
  assertGate(candidate.recallAtK >= 0.9, 'context_graph_recall_below_floor', { observed: candidate.recallAtK });
  assertGate(candidate.precisionAtK >= 0.5, 'context_graph_precision_below_floor', { observed: candidate.precisionAtK });
  assertGate(report.score !== null && report.score.passed, 'context_graph_composite_below_threshold', { score: report.score });

  emitGate(GATE_ID, {
    mode,
    recall_at_k: candidate.recallAtK,
    precision_at_k: candidate.precisionAtK,
    protected_gate_recall: candidate.protectedGateRecall,
    conflict_recall: candidate.conflictRecall,
    provenance_coverage: candidate.provenanceCoverage,
    composite_improvement: report.score.improvement,
    floors_evaluated: report.floors.evaluated
  });
}

async function runPerformance() {
  const report = await runBenchmark();
  assertGate(report.integrity.ok, 'context_graph_benchmark_corpus_tampered', { integrity: report.integrity });
  assertGate(report.floors.ok, 'context_graph_hard_safety_floor_failed', { failed: failedFloors(report) });

  const candidate = summaryOf(report, 'candidate');
  const baseline = summaryOf(report, 'baseline');
  assertGate(Boolean(candidate) && Boolean(baseline), 'context_graph_benchmark_missing_adapter');

  // Relative first: absolute milliseconds are a property of the CI machine, not
  // of the engine. The absolute ceiling is the escape hatch when the baseline is
  // already fast enough that a 30% cut is noise.
  const warmP95 = candidate.warmLatency.p95;
  const baselineWarmP95 = baseline.warmLatency.p95;
  const latencyOk = warmP95 <= 75 || (baselineWarmP95 > 0 && warmP95 <= baselineWarmP95 * 0.7);
  assertGate(latencyOk, 'context_graph_warm_latency_regression', { warmP95, baselineWarmP95 });

  const tokenOk = baseline.meanTokenCost === 0 || candidate.meanTokenCost <= baseline.meanTokenCost * 0.7;
  assertGate(tokenOk, 'context_graph_token_cost_regression', { candidate: candidate.meanTokenCost, baseline: baseline.meanTokenCost });
  assertGate(candidate.warmCacheHitRate >= 0.9, 'context_graph_cache_hit_below_floor', { observed: candidate.warmCacheHitRate });

  emitGate(GATE_ID, {
    mode,
    warm_p95_ms: warmP95,
    baseline_warm_p95_ms: baselineWarmP95,
    mean_token_cost: candidate.meanTokenCost,
    baseline_mean_token_cost: baseline.meanTokenCost,
    warm_cache_hit_rate: candidate.warmCacheHitRate
  });
}

function runLegacyClosure() {
  // Every pattern below named a production path the graph replaced. A surviving
  // reference means the old engine is still reachable — the exact "compatibility
  // fallback" the work order forbids.
  const excluded = [':!CHANGELOG.md', ':!docs/work-orders', ':!.sneakoscope'];
  const checks = [
    { id: 'triwiki_codepack_local', pattern: 'triwiki_codepack_local', pathspecs: ['.', ...excluded] },
    { id: 'simple_counts_comment', pattern: 'simple counts avoid needing a real dependency graph', pathspecs: ['.', ...excluded] },
    { id: 'scanCodebaseIndex', pattern: '\\bscanCodebaseIndex\\b', pathspecs: ['.', ...excluded] },
    { id: 'code_index_scanner_module', pattern: 'code-index-scanner', pathspecs: ['src', 'package.json', 'release-gates.v2.json', 'infra-harness-gates.json', 'runtime-required-scripts.json'] },
    {
      id: 'attentionRelevance',
      pattern: '\\battentionRelevance\\b',
      pathspecs: ['.', ...excluded, ':!src/core/subagents/__tests__']
    },
    {
      id: 'lexical_fallback_in_context_mode',
      pattern: '\\b(searchFilesJs|searchTextJs)\\b',
      pathspecs: ['src/core/search/context.ts']
    }
  ];
  const violations = [];
  for (const check of checks) {
    const hits = gitGrep(check.pattern, check.pathspecs);
    if (hits.length) violations.push({ id: check.id, hits: hits.slice(0, 6) });
  }
  assertGate(violations.length === 0, 'context_graph_legacy_path_survives', { violations });

  // The retired modules must be gone from the tree, not merely unreferenced.
  for (const retired of ['src/core/triwiki/code-index-scanner.ts']) {
    assertGate(!fs.existsSync(path.join(root, retired)), 'context_graph_retired_file_present', { path: retired });
  }
  // ... and must not have been parked under a compatibility alias instead.
  const parked = gitGrep('code-index-scanner', ['src', ':!src/core/triwiki/context-graph']);
  assertGate(parked.length === 0, 'context_graph_retired_file_parked', { hits: parked.slice(0, 6) });

  emitGate(GATE_ID, { mode, checks: checks.length, retired_modules: 1 });
}

if (mode === 'contract') await runContract();
else if (mode === 'quality') await runQuality();
else if (mode === 'performance') await runPerformance();
else runLegacyClosure();
