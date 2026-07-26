/**
 * Locked benchmark corpus loading and integrity.
 *
 * The corpus is the measurement contract. Deleting a case, softening a gold set,
 * or re-weighting the score changes the canonical serialization and therefore
 * changes `corpus_hash`, which the runner reports as an integrity failure rather
 * than silently scoring against a weaker bar.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTEXT_GRAPH_BENCHMARK_CORPUS_FILE,
  CONTEXT_GRAPH_BENCHMARK_CORPUS_SCHEMA,
  isContextGraphBenchmarkFixtureFamily,
  isContextGraphBenchmarkFloorId,
  type ContextGraphBenchmarkCase,
  type ContextGraphBenchmarkConflict,
  type ContextGraphBenchmarkCorpus,
  type ContextGraphBenchmarkGold,
  type ContextGraphBenchmarkSafetyProbe,
  type ContextGraphBenchmarkScoreWeights
} from './types.js';
import { isContextGraphQueryProfileName, type ContextGraphQueryProfileName } from '../profiles.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';

export const CONTEXT_GRAPH_BENCHMARK_CORPUS_HASH_FIELD = 'corpus_hash' as const;

export class ContextGraphBenchmarkCorpusError extends Error {
  readonly code: 'unreadable' | 'invalid_schema' | 'invalid_case' | 'integrity';

  constructor(code: ContextGraphBenchmarkCorpusError['code'], message: string) {
    super(message);
    this.name = 'ContextGraphBenchmarkCorpusError';
    this.code = code;
  }
}

/**
 * Deterministic JSON: object keys sorted, no whitespace, no `undefined`.
 * Two structurally identical corpora always serialize to the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ContextGraphBenchmarkCorpusError('invalid_schema', 'corpus contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new ContextGraphBenchmarkCorpusError('invalid_schema', `corpus contains an unserializable value of type ${typeof value}`);
}

/** sha256 over the canonical serialization of the raw corpus with `corpus_hash` removed. */
export function computeCorpusHash(raw: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...raw };
  delete copy[CONTEXT_GRAPH_BENCHMARK_CORPUS_HASH_FIELD];
  return crypto.createHash('sha256').update(canonicalJson(copy)).digest('hex');
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContextGraphBenchmarkCorpusError('invalid_schema', `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, what: string, requirePaths = false): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what} must be an array`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item) {
      throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what} must contain non-empty strings`);
    }
    if (requirePaths && !isWorkspaceRelativePosixPath(item)) {
      throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what} must contain workspace-relative POSIX paths`);
    }
    out.push(item);
  }
  return out;
}

function numberField(value: unknown, what: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what} must be a finite number`);
  }
  return value;
}

function parseConflicts(value: unknown, what: string): ContextGraphBenchmarkConflict[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what} must be an array`);
  return value.map((raw, index) => {
    const item = asRecord(raw, `${what}[${index}]`);
    const conflictPath = item.path;
    if (typeof conflictPath !== 'string' || !isWorkspaceRelativePosixPath(conflictPath)) {
      throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what}[${index}].path must be workspace-relative`);
    }
    const slices = stringList(item.slices, `${what}[${index}].slices`);
    if (slices.length < 2) {
      throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what}[${index}].slices needs at least two slices`);
    }
    return { path: conflictPath, slices: [...slices].sort() };
  });
}

function parseGold(value: unknown, what: string): ContextGraphBenchmarkGold {
  const gold = asRecord(value, what);
  const paths = stringList(gold.paths, `${what}.paths`, true);
  const protectedGateIds = stringList(gold.protected_gate_ids, `${what}.protected_gate_ids`);
  const gateIds = stringList(gold.gate_ids, `${what}.gate_ids`);
  for (const id of protectedGateIds) {
    if (!gateIds.includes(id)) {
      throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what}.protected_gate_ids must be a subset of gate_ids`);
    }
  }
  if (!paths.length && !gateIds.length && !stringList(gold.test_paths, `${what}.test_paths`, true).length) {
    throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what} has no verifiable expectation`);
  }
  return {
    paths,
    nodeIds: stringList(gold.node_ids, `${what}.node_ids`),
    gateIds,
    protectedGateIds,
    testPaths: stringList(gold.test_paths, `${what}.test_paths`, true),
    conflicts: parseConflicts(gold.conflicts, `${what}.conflicts`),
    mustExcludePaths: stringList(gold.must_exclude_paths, `${what}.must_exclude_paths`, true),
    stalePaths: stringList(gold.stale_paths, `${what}.stale_paths`, true),
    invalidatedPaths: stringList(gold.invalidated_paths, `${what}.invalidated_paths`, true),
    exactSeedPaths: stringList(gold.exact_seed_paths, `${what}.exact_seed_paths`, true)
  };
}

function parseCase(raw: unknown, index: number, defaultK: number): ContextGraphBenchmarkCase {
  const what = `cases[${index}]`;
  const item = asRecord(raw, what);
  const id = item.id;
  if (typeof id !== 'string' || !id) throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what}.id is required`);
  if (!isContextGraphBenchmarkFixtureFamily(item.fixture)) {
    throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what}.fixture is not a known fixture family`);
  }
  if (!isContextGraphQueryProfileName(item.profile)) {
    throw new ContextGraphBenchmarkCorpusError('invalid_case', `${what}.profile is not a known query profile`);
  }
  const risk = item.risk === 'high' ? 'high' : 'normal';
  const k = Math.max(1, Math.trunc(numberField(item.k, `${what}.k`, defaultK)));
  return {
    id,
    title: typeof item.title === 'string' && item.title ? item.title : id,
    query: typeof item.query === 'string' && item.query ? item.query : id,
    profile: item.profile as ContextGraphQueryProfileName,
    fixture: item.fixture,
    changedPaths: stringList(item.changed_paths, `${what}.changed_paths`, true),
    focusPaths: stringList(item.focus_paths, `${what}.focus_paths`, true),
    tokenBudget: Math.max(1, Math.trunc(numberField(item.token_budget, `${what}.token_budget`, 6000))),
    risk,
    k,
    gold: parseGold(item.gold, `${what}.gold`)
  };
}

function parseSafetyProbes(value: unknown): ContextGraphBenchmarkSafetyProbe[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ContextGraphBenchmarkCorpusError('invalid_schema', 'safety_probes must be an array');
  return value.map((raw, index) => {
    const what = `safety_probes[${index}]`;
    const item = asRecord(raw, what);
    if (typeof item.id !== 'string' || !item.id) throw new ContextGraphBenchmarkCorpusError('invalid_schema', `${what}.id is required`);
    if (!isContextGraphBenchmarkFixtureFamily(item.fixture)) {
      throw new ContextGraphBenchmarkCorpusError('invalid_schema', `${what}.fixture is not a known fixture family`);
    }
    if (!isContextGraphBenchmarkFloorId(item.floor)) {
      throw new ContextGraphBenchmarkCorpusError('invalid_schema', `${what}.floor is not a known floor id`);
    }
    return {
      id: item.id,
      fixture: item.fixture,
      floor: item.floor,
      expectation: typeof item.expectation === 'string' ? item.expectation : ''
    };
  });
}

function parseWeights(value: unknown): ContextGraphBenchmarkScoreWeights {
  const weights = asRecord(value, 'score_weights');
  const parsed: ContextGraphBenchmarkScoreWeights = {
    taskContextSuccess: numberField(weights.task_context_success, 'score_weights.task_context_success'),
    retrievalRecall: numberField(weights.retrieval_recall, 'score_weights.retrieval_recall'),
    precision: numberField(weights.precision, 'score_weights.precision'),
    evidencePerKiloToken: numberField(weights.evidence_per_kilo_token, 'score_weights.evidence_per_kilo_token'),
    latencyImprovement: numberField(weights.latency_improvement, 'score_weights.latency_improvement'),
    tokenImprovement: numberField(weights.token_improvement, 'score_weights.token_improvement')
  };
  const total = Object.values(parsed).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new ContextGraphBenchmarkCorpusError('invalid_schema', `score_weights must sum to 1, got ${total}`);
  }
  return parsed;
}

export interface ParsedContextGraphBenchmarkCorpus {
  readonly corpus: ContextGraphBenchmarkCorpus;
  /** Hash recomputed from the file contents; compare with `corpus.corpusHash`. */
  readonly computedHash: string;
  readonly hashOk: boolean;
}

export function parseContextGraphBenchmarkCorpus(raw: unknown): ParsedContextGraphBenchmarkCorpus {
  const source = asRecord(raw, 'corpus');
  if (source.schema !== CONTEXT_GRAPH_BENCHMARK_CORPUS_SCHEMA) {
    throw new ContextGraphBenchmarkCorpusError('invalid_schema', `corpus schema must be ${CONTEXT_GRAPH_BENCHMARK_CORPUS_SCHEMA}`);
  }
  if (source.hash_algorithm !== 'sha256') {
    throw new ContextGraphBenchmarkCorpusError('invalid_schema', 'corpus hash_algorithm must be sha256');
  }
  const declaredHash = typeof source[CONTEXT_GRAPH_BENCHMARK_CORPUS_HASH_FIELD] === 'string'
    ? String(source[CONTEXT_GRAPH_BENCHMARK_CORPUS_HASH_FIELD])
    : '';
  const defaultK = Math.max(1, Math.trunc(numberField(source.default_k, 'default_k', 8)));
  const rawCases = Array.isArray(source.cases) ? source.cases : null;
  if (!rawCases || !rawCases.length) throw new ContextGraphBenchmarkCorpusError('invalid_schema', 'corpus must declare cases');
  const cases = rawCases.map((item, index) => parseCase(item, index, defaultK));
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) throw new ContextGraphBenchmarkCorpusError('invalid_case', `duplicate case id ${item.id}`);
    seen.add(item.id);
  }
  const corpus: ContextGraphBenchmarkCorpus = {
    schema: CONTEXT_GRAPH_BENCHMARK_CORPUS_SCHEMA,
    corpusRevision: typeof source.corpus_revision === 'string' ? source.corpus_revision : '0',
    corpusHash: declaredHash,
    hashAlgorithm: 'sha256',
    improvementThreshold: numberField(source.improvement_threshold, 'improvement_threshold', 0.05),
    defaultK,
    scoreWeights: parseWeights(source.score_weights),
    cases,
    safetyProbes: parseSafetyProbes(source.safety_probes)
  };
  const computedHash = computeCorpusHash(source);
  return { corpus, computedHash, hashOk: declaredHash === computedHash };
}

/** Repository root that owns `config/context-graph-benchmark.json`, derived from this module's location. */
export function defaultCorpusPath(moduleDir: string): string {
  // dist/core/triwiki/context-graph/benchmark -> repository root
  const root = path.resolve(moduleDir, '..', '..', '..', '..', '..');
  return path.join(root, ...CONTEXT_GRAPH_BENCHMARK_CORPUS_FILE.split('/'));
}

export function loadContextGraphBenchmarkCorpus(corpusPath: string): ParsedContextGraphBenchmarkCorpus {
  let text: string;
  try {
    text = fs.readFileSync(corpusPath, 'utf8');
  } catch {
    throw new ContextGraphBenchmarkCorpusError('unreadable', `benchmark corpus is not readable at ${CONTEXT_GRAPH_BENCHMARK_CORPUS_FILE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ContextGraphBenchmarkCorpusError('invalid_schema', `benchmark corpus at ${CONTEXT_GRAPH_BENCHMARK_CORPUS_FILE} is not valid JSON`);
  }
  return parseContextGraphBenchmarkCorpus(parsed);
}
