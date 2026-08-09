#!/usr/bin/env node
/**
 * One check behind six gate ids (`architecture-map:<mode>`):
 * contract | quality | performance | regression-fixtures | legacy-closure | freshness
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertGate, emitGate, exists, importDist, readJson, readText, root } from './gate-lib.js';

const MODES = [
  'contract',
  'quality',
  'performance',
  'regression-fixtures',
  'legacy-closure',
  'freshness'
] as const;
type Mode = (typeof MODES)[number];

const modeArg = process.argv.indexOf('--mode') >= 0 ? String(process.argv[process.argv.indexOf('--mode') + 1] || '') : '';
assertGate((MODES as readonly string[]).includes(modeArg), 'architecture_map_check_unknown_mode', {
  mode: modeArg,
  modes: [...MODES]
});
const mode = modeArg as Mode;
const GATE_ID = `architecture-map:${mode}`;
const SELF = 'src/scripts/architecture-map-check.ts';
const POLICY_FILE = 'config/architecture-map-policy.v1.json';
const MAP_DIR = '.sneakoscope/wiki/architecture-map';
const SERIALIZER_TEST = 'test/architecture-map/serializer.test.mjs';
const PROJECTION_TEST =
  'dist/core/triwiki/context-graph/projections/mermaid/__tests__/mermaid-projection.test.js';

function gitGrep(pattern: string, pathspecs: string[]): string[] {
  const result = spawnSync('git', ['grep', '-n', '-I', '-E', pattern, '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0 && result.status !== 1) {
    assertGate(false, 'architecture_map_git_grep_failed', {
      pattern,
      stderr: String(result.stderr || '').slice(0, 400)
    });
  }
  return String(result.stdout || '')
    .split('\n')
    .filter(Boolean);
}

function walkTs(relDir: string): string[] {
  const abs = path.join(root, relDir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(file);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) out.push(file);
    }
  };
  walk(abs);
  return out;
}

function mermaidImportHits(): string[] {
  const re = /(?:from\s+|import\s*\(\s*)['"]mermaid['"]/;
  return walkTs('src/core/triwiki/context-graph/architecture')
    .concat(walkTs('src/core/triwiki/context-graph/projections/mermaid'))
    .filter((file) => re.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(root, file).split(path.sep).join('/'));
}

function runNodeTest(testRel: string, failCode: string): void {
  const absolute = path.join(root, testRel);
  assertGate(fs.existsSync(absolute), 'architecture_map_test_missing', {
    path: testRel,
    hint: 'run npm run build first when targeting dist/'
  });
  const result = spawnSync(process.execPath, ['--test', absolute], {
    cwd: root,
    encoding: 'utf8',
    env: process.env
  });
  assertGate(result.status === 0, failCode, {
    path: testRel,
    status: result.status,
    stdout: String(result.stdout || '').slice(-1200),
    stderr: String(result.stderr || '').slice(-1200)
  });
}

function minimalSnapshot(): unknown {
  const module = (id: string, modulePath: string) => ({
    id,
    kind: 'module',
    label: modulePath,
    trust: 0.9,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 8,
    metadata: {},
    path: modulePath
  });
  return {
    schema: 'sks.context-graph.v1',
    schemaRevision: '1.0.0',
    snapshotHash: 'a'.repeat(64),
    nodes: [module('module:src/core/triwiki', 'src/core/triwiki'), module('module:src/core/errors', 'src/core/errors')],
    edges: [
      {
        id: 'edge:module:src/core/triwiki->module:src/core/errors:imports',
        from: 'module:src/core/triwiki',
        to: 'module:src/core/errors',
        type: 'imports',
        confidence: 'exact',
        provenance: { path: 'src/core/triwiki/x.ts', hash: 'abcd', extractor: 'test' },
        observedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    cycles: [],
    extractors: [],
    nodeCount: 2,
    edgeCount: 1
  };
}

async function loadCore() {
  const policyMod = await importDist('core/triwiki/context-graph/architecture/policy.js');
  const contracts = await importDist('core/triwiki/context-graph/architecture/contracts.js');
  const mermaid = await importDist('core/triwiki/context-graph/projections/mermaid/index.js');
  return { policyMod, contracts, mermaid };
}

async function runContract(): Promise<void> {
  const { policyMod, contracts } = await loadCore();
  const allowlist = await importDist('core/triwiki/context-graph/optimizer/allowlist.js');
  const align = await importDist('core/align/align-route.js');
  const store = await importDist('core/triwiki/context-graph/store/architecture-map-store.js');

  let policy: { schema: string; layers: unknown[] };
  try {
    policy = policyMod.loadArchitectureMapPolicy(root);
  } catch (error: unknown) {
    assertGate(false, 'architecture_map_policy_load_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    throw new Error('unreachable');
  }

  assertGate(policy.schema === contracts.ARCHITECTURE_MAP_POLICY_SCHEMA, 'architecture_map_policy_schema_mismatch');
  assertGate(policy.layers.length > 0, 'architecture_map_policy_empty_layers');
  assertGate(contracts.ARCHITECTURE_MAP_POLICY_FILE === POLICY_FILE, 'architecture_map_policy_file_path_drift');
  for (const schemaRel of [
    'schemas/architecture-map-policy.v1.schema.json',
    'schemas/architecture-map-manifest.v1.schema.json',
    'schemas/architecture-baseline.v1.schema.json',
    'schemas/architecture-review.v1.schema.json',
    'schemas/mermaid-projection.v1.schema.json'
  ]) {
    assertGate(exists(schemaRel), 'architecture_map_schema_missing', { path: schemaRel });
  }

  const classification = allowlist.classifyContextGraphPatchTarget(POLICY_FILE);
  assertGate(classification === 'forbidden', 'architecture_map_policy_patch_target_not_forbidden', {
    path: POLICY_FILE,
    classification
  });
  assertGate(
    readText('src/scripts/check-architecture.ts').includes('imports 5+ unrelated route domains'),
    'architecture_map_check_architecture_missing_domain_fan_in'
  );
  assertGate(mermaidImportHits().length === 0, 'architecture_map_mermaid_runtime_import', {
    hits: mermaidImportHits()
  });

  const pkg = readJson('package.json') as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assertGate(!pkg.dependencies?.mermaid, 'architecture_map_mermaid_in_runtime_deps');
  assertGate(Boolean(pkg.devDependencies?.mermaid), 'architecture_map_mermaid_devdependency_missing');

  for (const rel of store.ARCHITECTURE_MAP_ARTIFACT_RELS) {
    assertGate(align.ALIGN_OUTPUT_ARTIFACTS.includes(rel), 'architecture_map_align_output_list_parity', {
      missing: rel
    });
  }
  assertGate(store.ARCHITECTURE_MAP_DIR_REL === MAP_DIR, 'architecture_map_dir_drift');
  assertGate(contracts.GLOBAL_ARCHITECTURE_MAP_VIEW_IDS.length === 7, 'architecture_map_global_view_count');

  emitGate(GATE_ID, {
    mode,
    policy_file: POLICY_FILE,
    layers: policy.layers.length,
    patch_target: classification,
    align_artifacts: store.ARCHITECTURE_MAP_ARTIFACT_RELS.length
  });
}

async function runQuality(): Promise<void> {
  const { policyMod, contracts, mermaid } = await loadCore();
  const policy = policyMod.loadArchitectureMapPolicy(root);
  const built = mermaid.buildArchitectureMapViews(minimalSnapshot(), policy, { rootId: 'fixture' });
  assertGate(
    built.views.length === contracts.GLOBAL_ARCHITECTURE_MAP_VIEW_IDS.length,
    'architecture_map_quality_view_count',
    { observed: built.views.length }
  );
  assertGate(
    built.manifest.schema === contracts.ARCHITECTURE_MAP_MANIFEST_SCHEMA,
    'architecture_map_quality_manifest_schema'
  );
  const absPathHits: string[] = [];
  for (const view of built.views) {
    assertGate(view.text.startsWith('%% GENERATED BY SKS'), 'architecture_map_quality_missing_header', {
      viewId: view.viewId
    });
    assertGate(/\bflowchart (TD|LR)\b/.test(view.text), 'architecture_map_quality_missing_flowchart', {
      viewId: view.viewId
    });
    if (/\/Users\/|\/home\/|C:\\\\/.test(view.text)) absPathHits.push(view.viewId);
  }
  assertGate(absPathHits.length === 0, 'architecture_map_quality_absolute_path_leak', { hits: absPathHits });
  const runs = Math.max(1, policy.accuracyFloors.deterministicHashRuns);
  const hashes = new Set<string>();
  for (let index = 0; index < runs; index += 1) {
    hashes.add(
      mermaid.buildArchitectureMapViews(minimalSnapshot(), policy, { rootId: 'fixture' }).manifest.canonicalHash
    );
  }
  assertGate(hashes.size === 1, 'architecture_map_quality_nondeterministic', { hashes: [...hashes] });
  emitGate(GATE_ID, {
    mode,
    views: built.views.length,
    findings: built.findings.length,
    deterministic_hash_runs: runs,
    canonical_hash: built.manifest.canonicalHash
  });
}

async function runPerformance(): Promise<void> {
  const { policyMod, mermaid } = await loadCore();
  const policy = policyMod.loadArchitectureMapPolicy(root);
  const snapshot = minimalSnapshot();
  const coldStart = performance.now();
  const first = mermaid.buildArchitectureMapViews(snapshot, policy, { rootId: 'fixture' });
  const coldMs = performance.now() - coldStart;
  const warmStart = performance.now();
  const second = mermaid.buildArchitectureMapViews(snapshot, policy, { rootId: 'fixture' });
  const warmMs = performance.now() - warmStart;
  const totalBytes = first.views.reduce(
    (sum: number, view: { projection: { byteLength: number } }) => sum + view.projection.byteLength,
    0
  );
  assertGate(coldMs <= 1500, 'architecture_map_performance_cold_over_budget', { coldMs });
  assertGate(warmMs <= 1500, 'architecture_map_performance_warm_over_budget', { warmMs });
  assertGate(totalBytes <= policy.globalAtlasMaxBytes, 'architecture_map_performance_bytes_over_budget', {
    totalBytes,
    limit: policy.globalAtlasMaxBytes
  });
  assertGate(
    first.manifest.canonicalHash === second.manifest.canonicalHash,
    'architecture_map_performance_hash_drift'
  );
  emitGate(GATE_ID, {
    mode,
    cold_ms: Math.round(coldMs * 1000) / 1000,
    warm_ms: Math.round(warmMs * 1000) / 1000,
    total_bytes: totalBytes,
    budget_bytes: policy.globalAtlasMaxBytes
  });
}

function runRegressionFixtures(): void {
  const suites = ['serializer'];
  runNodeTest(SERIALIZER_TEST, 'architecture_map_regression_serializer_failed');
  if (fs.existsSync(path.join(root, PROJECTION_TEST))) {
    runNodeTest(PROJECTION_TEST, 'architecture_map_regression_projection_failed');
    suites.push('mermaid-projection');
  }
  emitGate(GATE_ID, { mode, suites });
}

function runLegacyClosure(): void {
  const excluded = [':!CHANGELOG.md', ':!docs/work-orders', ':!docs/architecture', ':!.sneakoscope', `:!${SELF}`];
  assertGate(!exists('src/scripts/atlas-check.ts'), 'architecture_map_legacy_atlas_check_present');
  assertGate(!exists('config/architecture-atlas.v1.json'), 'architecture_map_legacy_atlas_policy_present');
  assertGate(!exists('src/core/architecture-atlas-review.ts'), 'architecture_map_legacy_atlas_review_present');
  assertGate(!exists('sks.architecture.json'), 'architecture_map_legacy_root_policy_present');
  const production = walkTs('src/core/triwiki/atlas');
  assertGate(production.length === 0, 'architecture_map_legacy_atlas_sources_present', {
    hits: production.slice(0, 8).map((file) => path.relative(root, file).split(path.sep).join('/'))
  });
  assertGate(gitGrep('"id":\\s*"atlas:', ['release-gates.v2.json']).length === 0, 'architecture_map_legacy_atlas_gate_ids_present');
  assertGate(
    gitGrep("'atlas:", ['src/core/release/release-gate-contract.ts', 'src/scripts/release-metadata-check.ts'])
      .length === 0,
    'architecture_map_legacy_atlas_contract_ids_present'
  );
  assertGate(
    gitGrep('\\batlas-(build|repair|refresh)\\b', ['src', ...excluded]).length === 0,
    'architecture_map_legacy_write_cli_present'
  );
  assertGate(
    gitGrep('\\.sneakoscope/wiki/architecture-atlas/', ['src', ...excluded]).length === 0,
    'architecture_map_legacy_wiki_path_survives'
  );
  emitGate(GATE_ID, { mode, checks: ['atlas_sources', 'atlas_check', 'atlas_gates', 'write_cli', 'wiki_path'] });
}

async function runFreshness(): Promise<void> {
  const { contracts } = await loadCore();
  const manifestRel = `${MAP_DIR}/manifest.json`;
  assertGate(exists(manifestRel), 'architecture_map_freshness_missing', {
    path: manifestRel,
    next_action: 'sks align run'
  });
  const manifest = readJson(manifestRel) as {
    schema?: string;
    graphHash?: string;
    sourceBinding?: { graphHash?: string };
  };
  assertGate(manifest.schema === contracts.ARCHITECTURE_MAP_MANIFEST_SCHEMA, 'architecture_map_freshness_schema');
  const graphRel = '.sneakoscope/wiki/context-graph.json';
  assertGate(exists(graphRel), 'architecture_map_freshness_graph_missing', {
    path: graphRel,
    next_action: 'sks align run'
  });
  const graph = readJson(graphRel) as { snapshotHash?: string };
  const expected = String(graph.snapshotHash || '');
  const observed = String(manifest.graphHash || manifest.sourceBinding?.graphHash || '');
  assertGate(Boolean(expected) && expected === observed, 'architecture_map_freshness_stale', {
    expected,
    observed,
    next_action: 'sks align run'
  });
  emitGate(GATE_ID, { mode, graph_hash: observed.slice(0, 16), next_action: null });
}

if (mode === 'contract') await runContract();
else if (mode === 'quality') await runQuality();
else if (mode === 'performance') await runPerformance();
else if (mode === 'regression-fixtures') runRegressionFixtures();
else if (mode === 'legacy-closure') runLegacyClosure();
else await runFreshness();
