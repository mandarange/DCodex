/**
 * Code-shaped fixture repositories: the resolution problems a real extractor has
 * to survive (path aliases, re-export chains, dynamic import literals, module
 * cycles) plus the command and test bindings the retrieval cases score against.
 *
 * Every fixture also carries a lexical decoy — a file that mentions the query
 * words but has no mechanical relation — so a text-search baseline cannot win by
 * matching prose.
 */
import { jsonFile, lines, type FixtureDefinition } from './kinds.js';

const GATES_SCHEMA = 'sks.release-gates.v2';

/**
 * Fixtures declare gates in the real `release-gates.v2.json` shape so the
 * topology extractor reads them exactly as it reads this repository's own
 * manifest. A fixture-only schema would have measured nothing: the extractor
 * ignores unknown manifests, so every gate recall would be 0 for every adapter.
 */
function gates(entries: ReadonlyArray<Record<string, unknown>>): string {
  return jsonFile({
    schema: GATES_SCHEMA,
    gates: entries.map((entry) => {
      const tests = Array.isArray(entry.tests) ? (entry.tests as string[]) : [];
      const inputs = Array.isArray(entry.inputs) ? (entry.inputs as string[]) : [];
      return {
        id: entry.id,
        command: tests.length ? `node ./${tests[0]}` : `node ./dist/scripts/${String(entry.id)}-check.js`,
        deps: Array.isArray(entry.deps) ? entry.deps : [],
        protected: entry.protected === true,
        resource: ['cpu-light', 'fs-read'],
        side_effect: 'hermetic',
        timeout_ms: 120000,
        cache: { enabled: true, inputs: [...inputs, ...tests] },
        preset: ['release'],
        output_contract: 'sks.gate-result.v1'
      };
    })
  });
}

const TS_PATH_ALIAS: FixtureDefinition = {
  family: 'ts-path-alias',
  description: 'code pack module reached through a tsconfig path alias; freshness preflight and wiki validate hang off it',
  files: [
    {
      path: 'tsconfig.json',
      content: jsonFile({
        compilerOptions: { baseUrl: '.', paths: { '@core/*': ['src/core/*'] }, module: 'NodeNext' },
        include: ['src/**/*.ts']
      })
    },
    {
      path: 'src/core/triwiki/code-pack.ts',
      content: lines('export interface CodePack { id: string; files: string[] }', 'export function buildCodePack(id: string): CodePack {', '  return { id, files: [] };', '}')
    },
    {
      path: 'src/core/triwiki/code-pack-head-freshness.ts',
      content: lines("import { buildCodePack } from '@core/triwiki/code-pack.js';", 'export function codePackIsFresh(id: string): boolean {', '  return buildCodePack(id).files.length === 0;', '}')
    },
    {
      path: 'src/core/wiki/freshness-preflight.ts',
      content: lines("import { codePackIsFresh } from '@core/triwiki/code-pack-head-freshness.js';", 'export function freshnessPreflight(id: string): boolean {', '  return codePackIsFresh(id);', '}')
    },
    {
      path: 'src/core/wiki/wiki-validate.ts',
      content: lines("import { buildCodePack } from '@core/triwiki/code-pack.js';", 'export function wikiValidate(id: string): boolean {', '  return buildCodePack(id).id === id;', '}')
    },
    {
      path: 'src/core/triwiki/__tests__/code-pack.test.ts',
      content: lines("import { buildCodePack } from '../code-pack.js';", "export const covers = ['buildCodePack'];", 'export function run(): boolean { return buildCodePack("a").id === "a"; }')
    },
    {
      path: 'src/core/unrelated/formatter.ts',
      content: lines('// mentions code pack and freshness in prose only; no mechanical relation', 'export function formatLine(value: string): string { return value.trim(); }')
    },
    {
      path: 'release-gates.v2.json',
      content: gates([
        { id: 'wiki_freshness_preflight', protected: false, inputs: ['src/core/wiki/freshness-preflight.ts'], tests: ['src/core/triwiki/__tests__/code-pack.test.ts'] },
        { id: 'wiki_validate', protected: false, inputs: ['src/core/wiki/wiki-validate.ts'], tests: ['src/core/triwiki/__tests__/code-pack.test.ts'] }
      ])
    }
  ]
};

const REEXPORT_CHAIN: FixtureDefinition = {
  family: 'reexport-chain',
  description: 'TriWiki attention reached only through a barrel re-export; Naruto planning and wiki validation both consume it',
  files: [
    {
      path: 'src/core/triwiki/attention.ts',
      content: lines('export interface AttentionSlice { id: string; weight: number }', 'export function resolveAttention(id: string): AttentionSlice {', '  return { id, weight: 1 };', '}')
    },
    {
      path: 'src/core/triwiki/index.ts',
      content: lines("export { resolveAttention } from './attention.js';", "export type { AttentionSlice } from './attention.js';")
    },
    {
      path: 'src/core/naruto/slice-planner.ts',
      content: lines("import { resolveAttention } from '../triwiki/index.js';", 'export function planSlices(ids: string[]): number {', '  return ids.map((id) => resolveAttention(id).weight).length;', '}')
    },
    {
      path: 'src/core/wiki/validation.ts',
      content: lines("import { resolveAttention } from '../triwiki/index.js';", 'export function validateAttention(id: string): boolean {', '  return resolveAttention(id).weight > 0;', '}')
    },
    {
      path: 'src/core/naruto/__tests__/slice-planner.test.ts',
      content: lines("import { planSlices } from '../slice-planner.js';", 'export function run(): boolean { return planSlices(["a"]) === 1; }')
    },
    {
      path: 'src/core/wiki/__tests__/validation.test.ts',
      content: lines("import { validateAttention } from '../validation.js';", 'export function run(): boolean { return validateAttention("a"); }')
    },
    {
      path: 'docs/attention-notes.md',
      content: lines('# Attention notes', '', 'Prose about attention, slices and validation. No import edge points here.')
    },
    {
      path: 'release-gates.v2.json',
      content: gates([
        { id: 'naruto_fanout_sanity', protected: false, inputs: ['src/core/naruto/slice-planner.ts'], tests: ['src/core/naruto/__tests__/slice-planner.test.ts'] },
        { id: 'wiki_validation', protected: false, inputs: ['src/core/wiki/validation.ts'], tests: ['src/core/wiki/__tests__/validation.test.ts'] }
      ])
    }
  ]
};

const DYNAMIC_IMPORT_LITERAL: FixtureDefinition = {
  family: 'dynamic-import-literal',
  description: 'command module reached only through a dynamic import with a string literal specifier',
  files: [
    {
      path: 'src/cli/registry.ts',
      content: lines('export async function loadCommand(name: string): Promise<unknown> {', "  if (name === 'wiki-refresh') return import('./commands/wiki-refresh.js');", '  return null;', '}')
    },
    {
      path: 'src/cli/commands/wiki-refresh.ts',
      content: lines("export function usage(): string { return 'wiki refresh [--code]'; }", 'export async function handler(): Promise<number> { return 0; }')
    },
    {
      path: 'src/cli/manifest.ts',
      content: lines("import { usage } from './commands/wiki-refresh.js';", "export const MANIFEST = [{ name: 'wiki-refresh', usage: usage() }];")
    },
    {
      path: 'src/cli/__tests__/registry.test.ts',
      content: lines("import { loadCommand } from '../registry.js';", "export function run(): Promise<unknown> { return loadCommand('wiki-refresh'); }")
    },
    {
      path: 'docs/cli-help.md',
      content: lines('# CLI help', '', 'Describes wiki refresh usage text in prose. Not a code relation.')
    },
    {
      path: 'release-gates.v2.json',
      content: gates([
        { id: 'cli_registry_consistency', protected: false, inputs: ['src/cli/registry.ts'], tests: ['src/cli/__tests__/registry.test.ts'] },
        { id: 'command_manifest_parity', protected: false, inputs: ['src/cli/manifest.ts'], tests: ['src/cli/__tests__/registry.test.ts'] },
        { id: 'usage_text_parity', protected: false, inputs: ['src/cli/commands/wiki-refresh.ts'], tests: ['src/cli/__tests__/registry.test.ts'] }
      ])
    }
  ]
};

const CYCLIC_MODULES: FixtureDefinition = {
  family: 'cyclic-modules',
  description: 'release gate input inside a two-module import cycle; the reverse gate closure must terminate and stay complete',
  files: [
    {
      path: 'src/core/release/gate-inputs.ts',
      content: lines("import type { GateRun } from './gate-runner.js';", 'export interface GateInput { id: string }', 'export function inputsFor(run: GateRun): GateInput[] { return [{ id: run.id }]; }')
    },
    {
      path: 'src/core/release/gate-runner.ts',
      content: lines("import { inputsFor } from './gate-inputs.js';", 'export interface GateRun { id: string }', 'export function runGate(run: GateRun): number { return inputsFor(run).length; }')
    },
    {
      path: 'src/core/release/gate-report.ts',
      content: lines("import { runGate, type GateRun } from './gate-runner.js';", 'export function report(run: GateRun): string { return `${run.id}:${runGate(run)}`; }')
    },
    {
      path: 'src/core/release/__tests__/gate-runner.test.ts',
      content: lines("import { runGate } from '../gate-runner.js';", "export function run(): boolean { return runGate({ id: 'g' }) === 1; }")
    },
    {
      path: 'src/core/release/legacy-notes.ts',
      content: lines('// legacy prose about gate inputs and gate reports; unreferenced', 'export const LEGACY_NOTE = 1;')
    },
    {
      path: 'release-gates.v2.json',
      content: gates([
        { id: 'release_gate_inputs', protected: true, inputs: ['src/core/release/gate-inputs.ts'], tests: ['src/core/release/__tests__/gate-runner.test.ts'] },
        { id: 'release_gate_runner', protected: false, inputs: ['src/core/release/gate-runner.ts'], tests: ['src/core/release/__tests__/gate-runner.test.ts'] },
        { id: 'release_gate_report', protected: false, inputs: ['src/core/release/gate-report.ts'], tests: ['src/core/release/__tests__/gate-runner.test.ts'] }
      ])
    }
  ]
};

const COMMAND_ROUTE_PIPELINE_GATE: FixtureDefinition = {
  family: 'command-route-pipeline-gate',
  description: 'one command wired through a route, a pipeline and two gates, with two lexical decoys',
  files: [
    {
      path: 'src/cli/commands/search.ts',
      content: lines("import { searchPipeline } from '../../core/pipeline/search-pipeline.js';", "export function usage(): string { return 'search <query>'; }", 'export async function handler(query: string): Promise<number> { return searchPipeline(query).length; }')
    },
    {
      path: 'src/cli/routes/search-route.ts',
      content: lines("import { handler } from '../commands/search.js';", "export const ROUTE = { name: 'search', handler };")
    },
    {
      path: 'src/core/pipeline/search-pipeline.ts',
      content: lines('export function searchPipeline(query: string): string[] {', '  return query ? [query] : [];', '}')
    },
    {
      path: 'src/cli/command-registry.json',
      content: jsonFile({ schema: 'sks.fixture-command-registry.v1', commands: [{ name: 'search', route: 'src/cli/routes/search-route.ts', handler: 'src/cli/commands/search.ts' }] })
    },
    {
      path: 'src/cli/__tests__/search-command.test.ts',
      content: lines("import { handler } from '../commands/search.js';", "export function run(): Promise<number> { return handler('q'); }")
    },
    { path: 'docs/search.md', content: lines('# Search', '', 'Prose about the search command, its route and its pipeline.') },
    {
      path: 'src/core/legacy/search-old.ts',
      content: lines('// retired search pipeline kept for reference; nothing imports it', 'export function searchPipelineOld(): string[] { return []; }')
    },
    {
      path: 'release-gates.v2.json',
      content: gates([
        { id: 'search_command_contract', protected: false, inputs: ['src/cli/commands/search.ts', 'src/cli/command-registry.json'], tests: ['src/cli/__tests__/search-command.test.ts'] },
        { id: 'search_pipeline_budget', protected: false, inputs: ['src/core/pipeline/search-pipeline.ts'], tests: ['src/cli/__tests__/search-command.test.ts'] }
      ])
    }
  ]
};

const TEST_PRODUCTION_BINDING: FixtureDefinition = {
  family: 'test-production-binding',
  description: 'search context module with the tests and gates that a change to it must pull in',
  files: [
    {
      path: 'src/core/search/context.ts',
      content: lines('export interface SearchContext { root: string; budget: number }', 'export function buildContext(root: string): SearchContext {', '  return { root, budget: 6000 };', '}')
    },
    {
      path: 'src/core/search/provider.ts',
      content: lines("import { buildContext, type SearchContext } from './context.js';", 'export function provide(root: string): SearchContext { return buildContext(root); }')
    },
    {
      path: 'src/core/search/__tests__/context.test.ts',
      content: lines("import { buildContext } from '../context.js';", "export function run(): boolean { return buildContext('r').budget === 6000; }")
    },
    {
      path: 'src/core/search/__tests__/provider.test.ts',
      content: lines("import { provide } from '../provider.js';", "export function run(): boolean { return provide('r').root === 'r'; }")
    },
    { path: 'src/core/search/README.md', content: lines('# Search core', '', 'Prose describing the search context and provider budget.') },
    {
      path: 'release-gates.v2.json',
      content: gates([
        { id: 'search_context_contract', protected: false, inputs: ['src/core/search/context.ts'], tests: ['src/core/search/__tests__/context.test.ts'] },
        { id: 'search_provider_budget', protected: false, inputs: ['src/core/search/provider.ts'], tests: ['src/core/search/__tests__/provider.test.ts'] }
      ])
    }
  ]
};

export const CODE_FIXTURE_DEFINITIONS: readonly FixtureDefinition[] = [
  TS_PATH_ALIAS,
  REEXPORT_CHAIN,
  DYNAMIC_IMPORT_LITERAL,
  CYCLIC_MODULES,
  COMMAND_ROUTE_PIPELINE_GATE,
  TEST_PRODUCTION_BINDING
];
