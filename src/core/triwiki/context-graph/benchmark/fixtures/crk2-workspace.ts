/**
 * Materializes the `crk2-retrieval` and `crk2-fault` workspaces.
 *
 * The corpus declares its inventory in `crk2-corpus-workspace.ts` and
 * `validateCrk2Corpus` refuses any gold id outside it. This module writes that
 * same list to disk, so the fixture cannot drift from the gold set: the file
 * list is imported, never restated. A path added here without being added there
 * is a file no case can reference, and a path added there without content here
 * shows up as a missing file rather than as a quietly failing case.
 *
 * Content is authored to realize specific gold ids — `compileContextIndex` is a
 * real exported symbol because a case anchors on it, `BM25F` appears in a
 * filename because a case queries the acronym, the Korean claim carries actual
 * Korean because a case queries in Korean. Anything the extractors do not
 * realize is reported by `crk2GoldRealization()` rather than assumed.
 *
 * These families are deliberately NOT added to
 * `CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES`: `corpus.test.ts` requires every
 * family in that list to be referenced by the sealed
 * `config/context-graph-benchmark.json`, which this lane does not own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CRK2_GATE_IDS,
  CRK2_PROTECTED_GATE_IDS,
  CRK2_RETRIEVAL_FILES
} from '../crk2-corpus-workspace.js';
import type { Crk2Workspace } from '../crk2-types.js';

const GATES_SCHEMA = 'sks.release-gates.v2';

function lines(...values: readonly string[]): string {
  return `${values.join('\n')}\n`;
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gateManifest(): string {
  return jsonFile({
    schema: GATES_SCHEMA,
    gates: CRK2_GATE_IDS.map((id) => ({
      id,
      command: `node ./tools/${id}-check.js`,
      deps: [],
      protected: CRK2_PROTECTED_GATE_IDS.includes(id),
      resource: ['cpu-light', 'fs-read'],
      side_effect: 'hermetic',
      timeout_ms: 120000,
      cache: { enabled: true, inputs: ['release-gates.v2.json'] },
      preset: ['release'],
      output_contract: 'sks.gate-result.v2'
    }))
  });
}

/**
 * Content for the paths a gold target depends on.
 *
 * Every entry here exists because a case names it. The identifiers are not
 * decorative: `readSectionDescriptor`, `compileContextIndex` and `hydrateNode`
 * are anchored by exact-symbol cases, and the camelCase/snake_case pair
 * (`frontierBudget` / `max_frontier_budget`) is anchored by two cases that must
 * not disagree with each other.
 */
const AUTHORED: Readonly<Record<string, string>> = {
  'src/core/triwiki/context-graph/runtime-index/format.ts': lines(
    'export interface SectionDescriptor { kind: number; offset: number; length: number }',
    'export function readSectionDescriptor(bytes: Uint8Array, at: number): SectionDescriptor {',
    '  return { kind: bytes[at] ?? 0, offset: at, length: bytes.length };',
    '}',
    'export function formatRevision(): number { return 1; }'
  ),
  'src/core/triwiki/context-graph/runtime-index/reader.ts': lines(
    "import { readSectionDescriptor } from './format.js';",
    "import { csrNeighbours } from './csr-builder.js';",
    'export function hydrateNode(bytes: Uint8Array, node: number): { node: number; kind: number } {',
    '  return { node, kind: readSectionDescriptor(bytes, node).kind };',
    '}',
    'export function incoming(node: number): readonly number[] { return csrNeighbours(node); }'
  ),
  'src/core/triwiki/context-graph/runtime-index/lexicon.ts': lines(
    "import { computeBm25fFieldScore } from './bm25f-scorer.js';",
    '/** Posting cap per term; the snake_case config key names the same bound. */',
    'export function lexicalPostings(term: string, postingCapPerTerm: number): readonly string[] {',
    '  return term ? [term].slice(0, postingCapPerTerm) : [];',
    '}',
    'export function scoreTerm(term: string): number { return computeBm25fFieldScore(term, 1); }'
  ),
  'src/core/triwiki/context-graph/runtime-index/bm25f-scorer.ts': lines(
    '/** BM25F field scoring. BM25F is the ranking function the lexical lane uses. */',
    'export const BM25F_FIELD_WEIGHTS = { label: 3, path: 2, body: 1 };',
    'export function computeBm25fFieldScore(term: string, frequency: number): number {',
    '  return term.length * frequency * BM25F_FIELD_WEIGHTS.body;',
    '}'
  ),
  'src/core/triwiki/context-graph/runtime-index/csr-builder.ts': lines(
    '/** CSR adjacency: compressed sparse row offsets and edge targets. */',
    'export function csrNeighbours(node: number): readonly number[] { return [node]; }',
    'export function csrOffsets(count: number): Uint32Array { return new Uint32Array(count + 1); }'
  ),
  'src/core/triwiki/context-graph/query/kernel.ts': lines(
    "import { lexicalPostings } from '../runtime-index/lexicon.js';",
    "import { readerCache } from './cache.js';",
    '/** frontierBudget bounds the traversal; config names it max_frontier_budget. */',
    'export function runKernel(query: string, frontierBudget: number): readonly string[] {',
    '  return lexicalPostings(query, frontierBudget).concat(readerCache(query));',
    '}'
  ),
  'src/core/triwiki/context-graph/query/cache.ts': lines(
    'export function readerCache(key: string): readonly string[] { return key ? [] : []; }'
  ),
  'src/core/triwiki/context-graph/compiler/generation.ts': lines(
    "import { readSectionDescriptor } from '../runtime-index/format.js';",
    "import { writeGeneration } from '../store/generation-store.js';",
    'export function compileContextIndex(bytes: Uint8Array): number {',
    '  writeGeneration(bytes);',
    '  return readSectionDescriptor(bytes, 0).length;',
    '}'
  ),
  'src/core/triwiki/context-graph/compiler/fragment-manifest.ts': lines(
    'export function fragmentManifestHash(parts: readonly string[]): string { return parts.join(\'|\'); }'
  ),
  'src/core/triwiki/context-graph/store/generation-store.ts': lines(
    "import { appendOperation } from './operation-journal.js';",
    'export function writeGeneration(bytes: Uint8Array): number {',
    '  appendOperation(\'stage\');',
    '  return bytes.length;',
    '}'
  ),
  'src/core/triwiki/context-graph/store/operation-journal.ts': lines(
    'export function appendOperation(phase: string): string { return phase; }'
  ),
  'src/core/legacy/json-runtime-store.ts': lines(
    '// Retired JSON runtime store. Nothing in the query path may read this.',
    'export function readJsonRuntimeStore(): null { return null; }'
  ),
  'src/core/naruto/fanout-planner.ts': lines(
    '/** Naruto fanout ceiling for a parallel wave. */',
    'export const NARUTO_FANOUT_CEILING = 12;',
    'export function planFanout(targets: number): number { return Math.min(targets, NARUTO_FANOUT_CEILING); }'
  ),
  'src/core/naruto/slice-writer-a.ts': lines(
    "import { sharedRegistry } from '../shared/registry.js';",
    'export function sliceA(): number { return sharedRegistry().length; }'
  ),
  'src/core/naruto/slice-writer-b.ts': lines(
    "import { sharedRegistry } from '../shared/registry.js';",
    'export function sliceB(): number { return sharedRegistry().length + 1; }'
  ),
  // Deliberately does NOT import the shared registry. The advisory closes write
  // scopes over the import graph, so an import here would pull `registry.ts`
  // into slice C's closure and turn the corpus's two-way collision into a
  // three-way one — a fixture detail silently rewriting a gold set.
  'src/core/naruto/slice-writer-c.ts': lines(
    "import { runKernel } from '../triwiki/context-graph/query/kernel.js';",
    "export function sliceC(): number { return runKernel('c', 1).length; }"
  ),
  'src/core/shared/registry.ts': lines(
    'export function sharedRegistry(): readonly string[] { return []; }'
  ),
  'src/core/triwiki/align-runner.ts': lines(
    '/** `sks align run` rebuilds the index; every repair message names this command. */',
    "import { compileContextIndex } from './context-graph/compiler/generation.js';",
    'export function alignRun(bytes: Uint8Array): number { return compileContextIndex(bytes); }'
  ),
  'src/core/security/redaction-guard.ts': lines(
    'export function redact(value: string): string { return value.replace(/secret/gi, \'[redacted]\'); }'
  ),
  'src/cli/commands/search-context.ts': lines(
    "import { contextRetrievalPipeline } from '../../core/pipeline/context-retrieval-pipeline.js';",
    "export function usage(): string { return 'search context <query>'; }",
    'export function handler(query: string): readonly string[] { return contextRetrievalPipeline(query); }'
  ),
  'src/cli/routes/search-context-route.ts': lines(
    "import { handler } from '../commands/search-context.js';",
    "export const ROUTE = { name: 'search-context', handler };"
  ),
  'src/core/pipeline/context-retrieval-pipeline.ts': lines(
    "import { runKernel } from '../triwiki/context-graph/query/kernel.js';",
    'export function contextRetrievalPipeline(query: string): readonly string[] {',
    '  return runKernel(query, 512);',
    '}'
  ),
  'src/cli/command-registry.json': jsonFile({
    schema: 'sks.fixture-command-registry.v1',
    commands: [
      {
        name: 'search-context',
        route: 'src/cli/routes/search-context-route.ts',
        handler: 'src/cli/commands/search-context.ts',
        pipeline: 'src/core/pipeline/context-retrieval-pipeline.ts'
      }
    ]
  }),
  'config/context-graph.json': jsonFile({
    schema: 'sks.context-graph-config.v1',
    max_frontier_budget: 512,
    posting_cap_per_term: 256,
    token_budget: 6000
  }),
  'tools/context_graph_smoke.py': lines(
    '"""context_graph_smoke - unsupported language, reachable only by path."""',
    'def context_graph_smoke(root):',
    '    return root'
  ),
  'docs/architecture/context-retrieval-kernel-v2.md': lines(
    '# Context Retrieval Kernel v2 (CRK2)',
    '',
    'CRK2 replaces the JSON runtime store with a compact binary index.',
    'No vectors, no LLM, no fallback, no daemon.'
  ),
  '.sneakoscope/wiki/claims/context-budget-ko.md': lines(
    '# 컨텍스트 검색 예산',
    '',
    '컨텍스트 검색 예산은 config/context-graph.json 에서 정한다.',
    'max_frontier_budget 값이 탐색 한계를 결정한다. 현재 값은 512 이다.'
  ),
  '.sneakoscope/wiki/claims/context-budget-legacy.md': lines(
    '# Context budget (superseded)',
    '',
    'The frontier budget is 128. This claim is superseded by the current config.'
  ),
  '.sneakoscope/wiki/proof-index.json': jsonFile({
    schema: 'sks.proof-index.v1',
    proofs: [
      {
        id: 'context-retrieval-baseline',
        claim: 'the kernel meets its latency floor',
        sources: ['src/core/triwiki/context-graph/query/kernel.ts'],
        status: 'invalidated'
      }
    ]
  }),
  '.sneakoscope/naruto/slice-plan.json': jsonFile({
    schema: 'sks.naruto-slice-plan.v1',
    slices: [
      { id: 'slice-writer-a', writeScope: ['src/core/naruto/slice-writer-a.ts', 'src/core/shared/registry.ts'] },
      { id: 'slice-writer-b', writeScope: ['src/core/naruto/slice-writer-b.ts', 'src/core/shared/registry.ts'] },
      {
        id: 'slice-writer-c',
        writeScope: ['src/core/naruto/slice-writer-c.ts', 'src/core/triwiki/context-graph/query/index.ts']
      }
    ]
  }),
  'release-gates.v2.json': gateManifest()
};

/** Barrels and tests get a shape derived from their path, so the inventory stays the only list. */
function derivedContent(relativePath: string): string {
  if (relativePath.endsWith('/index.ts')) {
    const siblings = CRK2_RETRIEVAL_FILES.filter(
      (item) =>
        item !== relativePath &&
        item.endsWith('.ts') &&
        item.startsWith(relativePath.slice(0, -'index.ts'.length)) &&
        !item.slice(relativePath.slice(0, -'index.ts'.length).length).includes('/')
    );
    const exports = siblings.map((item) => `export * from './${path.posix.basename(item, '.ts')}.js';`);
    return exports.length ? lines(...exports) : lines('export const BARREL = true;');
  }
  if (relativePath.includes('/__tests__/')) {
    const target = path.posix.basename(relativePath).replace('.test.ts', '');
    return lines(
      `// covers ${target}`,
      `export function run(): boolean { return true; }`
    );
  }
  const symbol = path.posix
    .basename(relativePath, '.ts')
    .replace(/[^A-Za-z0-9]+(.)/g, (_, chr: string) => chr.toUpperCase());
  return lines(`export function ${symbol || 'module'}(): boolean { return true; }`);
}

export function crk2WorkspaceFileContent(relativePath: string): string {
  return AUTHORED[relativePath] ?? derivedContent(relativePath);
}

export interface Crk2WorkspaceHandle {
  readonly workspace: Crk2Workspace;
  /** Absolute temp path. Used as a key and never copied into a run record or a report. */
  readonly root: string;
  readonly fileCount: number;
  dispose(): void;
}

export interface MaterializeCrk2WorkspaceOptions {
  readonly tmpDir?: string;
  readonly prefix?: string;
}

/**
 * Write the workspace to a fresh temp directory.
 *
 * `crk2-fault` gets the same tree with **no published index**, which is the
 * honest starting point for a rejection case: `context_index_missing` is a real
 * state a real workspace reaches. The other ADR §5 codes need a published
 * generation that is then damaged, and that injection belongs to the fault-
 * operations module rather than here — a materializer that also corrupted its
 * own output would make it impossible to tell a fixture bug from an injected one.
 */
export function materializeCrk2Workspace(
  workspace: Crk2Workspace,
  options: MaterializeCrk2WorkspaceOptions = {}
): Crk2WorkspaceHandle {
  const base = options.tmpDir ?? os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, `${options.prefix ?? 'sks-crk2-'}${workspace}-`));
  let fileCount = 0;
  for (const relativePath of CRK2_RETRIEVAL_FILES) {
    const absolute = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, crk2WorkspaceFileContent(relativePath), 'utf8');
    fileCount += 1;
  }

  let disposed = false;
  return {
    workspace,
    root,
    fileCount,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

export async function withCrk2Workspace<T>(
  workspace: Crk2Workspace,
  fn: (handle: Crk2WorkspaceHandle) => Promise<T> | T,
  options: MaterializeCrk2WorkspaceOptions = {}
): Promise<T> {
  const handle = materializeCrk2Workspace(workspace, options);
  try {
    return await fn(handle);
  } finally {
    handle.dispose();
  }
}
