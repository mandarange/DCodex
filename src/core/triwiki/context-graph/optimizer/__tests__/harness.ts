/**
 * Test doubles for the optimizer loop.
 *
 * The loop is driven through an injected benchmark runner so the experiments in
 * these tests cost no fixture materialization and no snapshot compile: what is
 * under test is the decision logic, the guard and the artifacts, not the
 * benchmark, which has its own suite.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_GRAPH_BENCHMARK_REPORT_SCHEMA,
  type ContextGraphBenchmarkAdapter,
  type ContextGraphBenchmarkAdapterKind,
  type ContextGraphBenchmarkFloorId,
  type ContextGraphBenchmarkReport,
  type ContextGraphBenchmarkScoreComponents,
  type ContextGraphBenchmarkSideScore
} from '../../benchmark/types.js';
import { CONTEXT_GRAPH_TUNABLE_FILES, CONTEXT_GRAPH_MEASUREMENT_FILES } from '../allowlist.js';

export const CORPUS_REVISION = 'test-corpus-1';
export const CORPUS_HASH = 'a'.repeat(64);
export const SCORING_HASH = 'b'.repeat(64);

function components(value: number): ContextGraphBenchmarkScoreComponents {
  return {
    taskContextSuccess: value,
    retrievalRecall: value,
    precision: value,
    evidencePerKiloToken: value,
    latencyImprovement: value,
    tokenImprovement: value
  };
}

function side(adapterId: string, kind: ContextGraphBenchmarkAdapterKind, composite: number): ContextGraphBenchmarkSideScore {
  return { adapterId, adapterKind: kind, components: components(composite), weighted: components(composite), composite };
}

export interface FakeReportInput {
  readonly composite: number;
  readonly baselineComposite?: number;
  readonly floorsOk?: boolean;
  readonly failedFloor?: ContextGraphBenchmarkFloorId;
  readonly integrityOk?: boolean;
  readonly passed?: boolean;
  readonly improvement?: number;
}

/** Minimal but structurally complete benchmark report. */
export function fakeReport(input: FakeReportInput): ContextGraphBenchmarkReport {
  const floorsOk = input.floorsOk !== false;
  const integrityOk = input.integrityOk !== false;
  const passed = input.passed !== false;
  const failedFloor: ContextGraphBenchmarkFloorId = input.failedFloor ?? 'protected_gate_recall_full';
  const baselineComposite = input.baselineComposite ?? 0.4;
  const scored = floorsOk && integrityOk;
  return {
    schema: CONTEXT_GRAPH_BENCHMARK_REPORT_SCHEMA,
    ok: scored && passed,
    generatedAt: '2026-01-01T00:00:00.000Z',
    corpusRevision: CORPUS_REVISION,
    integrity: {
      corpusHash: CORPUS_HASH,
      expectedCorpusHash: integrityOk ? CORPUS_HASH : 'c'.repeat(64),
      corpusHashOk: integrityOk,
      scoringCodeHash: SCORING_HASH,
      expectedScoringCodeHash: SCORING_HASH,
      scoringCodeHashOk: true,
      reportLeakRules: [],
      ok: integrityOk
    },
    environment: {
      gitSha: null,
      gitBranch: null,
      gitState: 'unknown',
      dirtyFingerprint: 'd'.repeat(64),
      dirtyEntryCount: 0,
      machine: { platform: 'test', arch: 'test', cpuCount: 1, cpuModel: 'test', totalMemoryMb: 1, nodeMajor: 22 }
    },
    capabilities: {
      adapters: ['baseline-lexical', 'candidate-graph'],
      gitAvailable: false,
      symlinkSupported: true,
      fixtureFamilies: [],
      coldIterations: 1,
      warmIterations: 1
    },
    adapters: [
      { id: 'baseline-lexical', kind: 'baseline' },
      { id: 'candidate-graph', kind: 'candidate' }
    ],
    cases: [],
    summaries: [],
    floors: {
      ok: floorsOk,
      evaluated: 1,
      failed: floorsOk ? 0 : 1,
      results: [
        {
          id: failedFloor,
          label: 'test floor',
          appliesTo: 'candidate',
          adapterId: 'candidate-graph',
          adapterKind: 'candidate',
          passed: floorsOk,
          observed: floorsOk ? 1 : 0,
          limit: 1,
          comparison: 'gte',
          detail: floorsOk ? [] : ['case-1:protected_gate_missed']
        }
      ]
    },
    score: scored
      ? {
          weights: {
            taskContextSuccess: 1,
            retrievalRecall: 1,
            precision: 1,
            evidencePerKiloToken: 1,
            latencyImprovement: 1,
            tokenImprovement: 1
          },
          baseline: side('baseline-lexical', 'baseline', baselineComposite),
          candidate: side('candidate-graph', 'candidate', input.composite),
          improvement: input.improvement ?? 0.2,
          threshold: 0.05,
          passed,
          latencyImprovementRatio: 0.5,
          tokenImprovementRatio: 0.5
        }
      : null,
    warnings: [],
    notes: [],
    durationMs: 1
  };
}

export function inertAdapters(): readonly ContextGraphBenchmarkAdapter[] {
  const make = (id: string, kind: ContextGraphBenchmarkAdapterKind): ContextGraphBenchmarkAdapter => ({
    id,
    kind,
    run: async () => {
      throw new Error('the injected runner answers instead of the adapter');
    }
  });
  return [make('baseline-lexical', 'baseline'), make('candidate-graph', 'candidate')];
}

export function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sks-cg-opt-'));
}

/** Materializes the guarded files inside a hermetic root so the guard has something to hash. */
export function seedGuardedSurface(root: string): void {
  for (const relative of [...CONTEXT_GRAPH_TUNABLE_FILES, ...CONTEXT_GRAPH_MEASUREMENT_FILES]) {
    const absolute = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `// seeded ${relative}\n`, 'utf8');
  }
}

/** Every file under `root`, workspace-relative and sorted. */
export function listFiles(root: string, relative = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, next));
    else if (entry.isFile()) out.push(next);
  }
  return out.sort();
}
