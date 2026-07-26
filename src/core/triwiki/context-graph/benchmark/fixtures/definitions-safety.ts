/**
 * Safety, freshness and robustness fixture repositories.
 *
 * The redaction fixture composes its secret-shaped and absolute-path-shaped
 * strings from fragments at build time on purpose: a literal credential or a
 * literal home path in committed source would itself be the failure this fixture
 * is supposed to detect.
 */
import { jsonFile, lines, type FixtureDefinition, type FixtureFile } from './kinds.js';

const GATES_SCHEMA = 'sks.fixture-gates.v1';

function gates(entries: ReadonlyArray<Record<string, unknown>>): string {
  return jsonFile({ schema: GATES_SCHEMA, gates: entries });
}

const PROOF_INVALIDATION: FixtureDefinition = {
  family: 'proof-invalidation',
  description: 'a proof invalidation change reaching the affected graph and the release cache; one retired claim must stay out',
  files: [
    {
      path: 'src/core/proof/proof-invalidation.ts',
      content: lines('export interface Invalidation { proofId: string; reason: string }', 'export function invalidate(proofId: string): Invalidation {', "  return { proofId, reason: 'source_changed' };", '}')
    },
    {
      path: 'src/core/triwiki/triwiki-affected-graph.ts',
      content: lines("import { invalidate } from '../proof/proof-invalidation.js';", 'export function affected(proofId: string): string[] { return [invalidate(proofId).reason]; }')
    },
    {
      path: 'src/core/release/release-cache.ts',
      content: lines("import { invalidate } from '../proof/proof-invalidation.js';", 'export function dropCache(proofId: string): string { return invalidate(proofId).proofId; }')
    },
    {
      path: 'src/core/proof/retired-claim.ts',
      content: lines('// superseded by proof-invalidation.ts; the proof index marks it invalidated', 'export const RETIRED_PROOF = 1;')
    },
    {
      path: 'src/core/proof/__tests__/proof-invalidation.test.ts',
      content: lines("import { invalidate } from '../proof-invalidation.js';", "export function run(): boolean { return invalidate('p').proofId === 'p'; }")
    },
    {
      path: '.sneakoscope/wiki/proof-index.json',
      content: jsonFile({
        schema: 'sks.fixture-proof-index.v1',
        proofs: [
          { id: 'P-affected-graph', invalidated: false, sources: ['src/core/triwiki/triwiki-affected-graph.ts'] },
          { id: 'P-retired-claim', invalidated: true, sources: ['src/core/proof/retired-claim.ts'] }
        ]
      })
    },
    {
      path: 'config/gates.json',
      content: gates([
        { id: 'proof_bank_integrity', protected: true, inputs: ['src/core/proof/proof-invalidation.ts'], tests: ['src/core/proof/__tests__/proof-invalidation.test.ts'] },
        { id: 'release_cache_parity', protected: false, inputs: ['src/core/release/release-cache.ts'], tests: ['src/core/proof/__tests__/proof-invalidation.test.ts'] }
      ])
    }
  ]
};

const STALE_WIKI_CLAIM: FixtureDefinition = {
  family: 'stale-wiki-claim',
  description: 'a wiki claim whose cited source hash no longer matches the file it cites',
  files: [
    {
      path: 'src/core/config/limits.ts',
      content: lines('export const MAX_PARALLEL = 8;', 'export function maxParallel(): number { return MAX_PARALLEL; }')
    },
    {
      path: 'src/core/config/__tests__/limits.test.ts',
      content: lines("import { maxParallel } from '../limits.js';", 'export function run(): boolean { return maxParallel() === 8; }')
    },
    {
      path: '.sneakoscope/wiki/claims/max-parallel.md',
      content: lines('# Max parallel', '', 'MAX_PARALLEL is 4.', '', 'Source: src/core/config/limits.ts')
    },
    {
      path: '.sneakoscope/wiki/claims/max-parallel.meta.json',
      content: jsonFile({
        schema: 'sks.fixture-wiki-claim.v1',
        claim: 'max-parallel',
        source: 'src/core/config/limits.ts',
        sourceHash: '0000000000000000000000000000000000000000000000000000000000000000',
        freshness: 'stale'
      })
    },
    {
      path: 'config/gates.json',
      content: gates([
        { id: 'wiki_claim_freshness', protected: false, inputs: ['src/core/config/limits.ts'], tests: ['src/core/config/__tests__/limits.test.ts'] }
      ])
    }
  ]
};

const PARALLEL_WRITE_CONFLICT: FixtureDefinition = {
  family: 'parallel-write-conflict',
  description: 'two Naruto slices whose declared write scopes overlap on one shared registry file',
  files: [
    {
      path: 'src/core/shared/registry.ts',
      content: lines('export const REGISTRY: Record<string, string> = {};', 'export function register(key: string, value: string): void { REGISTRY[key] = value; }')
    },
    {
      path: 'src/core/naruto/slice-a.ts',
      content: lines("import { register } from '../shared/registry.js';", "export function applyA(): void { register('a', 'a'); }")
    },
    {
      path: 'src/core/naruto/slice-b.ts',
      content: lines("import { register } from '../shared/registry.js';", "export function applyB(): void { register('b', 'b'); }")
    },
    {
      path: '.sneakoscope/naruto/slice-plan.json',
      content: jsonFile({
        schema: 'sks.fixture-slice-plan.v1',
        slices: [
          { id: 'slice-a', writeScope: ['src/core/naruto/slice-a.ts', 'src/core/shared/registry.ts'] },
          { id: 'slice-b', writeScope: ['src/core/naruto/slice-b.ts', 'src/core/shared/registry.ts'] }
        ]
      })
    },
    {
      path: 'config/gates.json',
      content: gates([
        { id: 'naruto_write_scope', protected: true, inputs: ['.sneakoscope/naruto/slice-plan.json'], tests: [] }
      ])
    }
  ]
};

// Composed from fragments so no literal credential or home path is committed.
const FAKE_TOKEN = ['AKIA', 'BENCHMARK', 'FIXTURE', 'NOTREAL01'].join('');
const FAKE_HOME_PATH = ['', 'Users', 'benchmark-fixture', 'secret-notes.txt'].join('/');

const SECRET_AND_PATH_REDACTION: FixtureDefinition = {
  family: 'secret-and-path-redaction',
  description: 'protected security and release paths next to a notes file carrying a secret-shaped token and an absolute path',
  files: [
    {
      path: 'src/core/security/token-guard.ts',
      content: lines('export function redactToken(value: string): string {', "  return value.replace(/[A-Z0-9]{16,}/g, '[redacted]');", '}')
    },
    {
      path: 'src/core/release/publish-driver.ts',
      content: lines("import { redactToken } from '../security/token-guard.js';", 'export function publishLog(line: string): string { return redactToken(line); }')
    },
    {
      path: 'src/core/security/__tests__/token-guard.test.ts',
      content: lines("import { redactToken } from '../token-guard.js';", "export function run(): boolean { return redactToken('X').length === 1; }")
    },
    {
      path: 'notes/leaky-notes.md',
      content: lines('# Operator notes', '', `token: ${FAKE_TOKEN}`, `path: ${FAKE_HOME_PATH}`, '', 'Nothing may copy these two values into a graph artifact or a report.')
    },
    {
      path: 'config/gates.json',
      content: gates([
        { id: 'security_protected_paths', protected: true, inputs: ['src/core/security/token-guard.ts'], tests: ['src/core/security/__tests__/token-guard.test.ts'] },
        { id: 'release_publish_guard', protected: true, inputs: ['src/core/release/publish-driver.ts'], tests: ['src/core/security/__tests__/token-guard.test.ts'] }
      ])
    }
  ]
};

export const FIXTURE_SECRET_TOKEN = FAKE_TOKEN;
export const FIXTURE_ABSOLUTE_PATH = FAKE_HOME_PATH;

const DIRTY_AND_UNTRACKED: FixtureDefinition = {
  family: 'dirty-and-untracked',
  description: 'a committed tree with one dirty tracked file and one untracked file, for cache-key and freshness probes',
  files: [
    { path: 'src/core/a.ts', content: lines("export const A = 'a';") },
    { path: 'src/core/b.ts', content: lines("import { A } from './a.js';", 'export const B = A;') },
    { path: 'config/gates.json', content: gates([{ id: 'dirty_state_probe', protected: false, inputs: ['src/core/a.ts'], tests: [] }]) }
  ],
  git: {
    dirtyAppend: [{ path: 'src/core/a.ts', content: lines('', '// uncommitted local edit') }],
    untracked: [{ path: 'src/core/c.ts', content: lines("export const C = 'c';") }]
  }
};

const LARGE_REPO_MODULES = 400;

const LARGE_REPO_INCREMENTAL: FixtureDefinition = {
  family: 'large-repo-incremental',
  description: 'a generated module chain large enough that an unbounded hot-path scan is observable',
  files: [
    { path: 'src/gen/entry.ts', content: lines("import { value0 } from './mod-0/index.js';", 'export const ENTRY = value0;') },
    { path: 'config/gates.json', content: gates([{ id: 'large_repo_scan_budget', protected: false, inputs: ['src/gen/entry.ts'], tests: [] }]) }
  ],
  generatedCount: LARGE_REPO_MODULES,
  generated: (index: number): readonly FixtureFile[] => {
    const next = index + 1;
    const body = next < LARGE_REPO_MODULES
      ? lines(`import { value${next} } from '../mod-${next}/index.js';`, `export const value${index} = value${next} + 1;`)
      : lines(`export const value${index} = 0;`);
    return [{ path: `src/gen/mod-${index}/index.ts`, content: body }];
  }
};

const MALFORMED_MANIFEST: FixtureDefinition = {
  family: 'malformed-manifest',
  description: 'a gate manifest that is not valid JSON; extraction must skip it rather than crash or claim an exact relation',
  files: [
    { path: 'src/core/x.ts', content: lines("export const X = 'x';") },
    { path: 'src/core/y.ts', content: lines("import { X } from './x.js';", 'export const Y = X;') },
    { path: 'config/gates.json', content: '{ "schema": "sks.fixture-gates.v1", "gates": [ { "id": "broken",\n' },
    { path: 'notes/manifest.txt', content: lines('The gate manifest above is deliberately truncated.') }
  ]
};

const SYMLINK_ESCAPE: FixtureDefinition = {
  family: 'symlink-escape',
  description: 'a symlink whose target resolves outside the workspace root; it must be skipped, never followed',
  files: [
    { path: 'src/core/real.ts', content: lines("export const REAL = 'real';") },
    { path: 'config/gates.json', content: gates([{ id: 'symlink_escape_probe', protected: false, inputs: ['src/core/real.ts'], tests: [] }]) }
  ],
  symlinks: [{ path: 'src/core/outside-link', target: '@outside', escapesWorkspace: true }]
};

export const SAFETY_FIXTURE_DEFINITIONS: readonly FixtureDefinition[] = [
  PROOF_INVALIDATION,
  STALE_WIKI_CLAIM,
  PARALLEL_WRITE_CONFLICT,
  SECRET_AND_PATH_REDACTION,
  DIRTY_AND_UNTRACKED,
  LARGE_REPO_INCREMENTAL,
  MALFORMED_MANIFEST,
  SYMLINK_ESCAPE
];
