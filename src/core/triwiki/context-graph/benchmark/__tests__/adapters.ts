/**
 * Deterministic stub adapters for the benchmark's own tests.
 *
 * These answer straight from the corpus gold set with a configurable amount of
 * damage, so a test can describe "a baseline that finds half the files and no
 * gates" without needing a real retrieval engine.
 */
import { emptyBenchmarkSafety } from '../types.js';
import type {
  ContextGraphBenchmarkAdapter,
  ContextGraphBenchmarkAdapterKind,
  ContextGraphBenchmarkCase,
  ContextGraphBenchmarkQuery,
  ContextGraphBenchmarkRun,
  ContextGraphBenchmarkSafety
} from '../types.js';

export interface StubBehaviour {
  /** Fraction of the gold paths the adapter manages to return. */
  readonly pathFraction: number;
  readonly includeGates: boolean;
  readonly includeTests: boolean;
  readonly includeConflicts: boolean;
  readonly includeExactSeeds: boolean;
  readonly includeMustExclude: boolean;
  readonly includeStale: boolean;
  readonly tokenCost: number;
  readonly coldLatencyMs: number;
  readonly warmLatencyMs: number;
  /** Non-gold filler paths appended after the real hits, to depress precision. */
  readonly noise: number;
  readonly provenanceCoverage: number;
  readonly safety: Partial<ContextGraphBenchmarkSafety>;
  /** Makes every answer differ per iteration so the determinism floor trips. */
  readonly unstable: boolean;
  readonly throwOnRun: boolean;
}

export const STRONG_CANDIDATE: StubBehaviour = {
  pathFraction: 1,
  includeGates: true,
  includeTests: true,
  includeConflicts: true,
  includeExactSeeds: true,
  includeMustExclude: false,
  includeStale: false,
  tokenCost: 1200,
  coldLatencyMs: 120,
  warmLatencyMs: 30,
  noise: 0,
  provenanceCoverage: 1,
  safety: {},
  unstable: false,
  throwOnRun: false
};

export const WEAK_BASELINE: StubBehaviour = {
  pathFraction: 0.5,
  includeGates: false,
  includeTests: false,
  includeConflicts: false,
  includeExactSeeds: true,
  includeMustExclude: true,
  includeStale: false,
  tokenCost: 4200,
  coldLatencyMs: 480,
  warmLatencyMs: 410,
  noise: 4,
  provenanceCoverage: 0,
  safety: {},
  unstable: false,
  throwOnRun: false
};

export function behaviour(overrides: Partial<StubBehaviour> = {}, base: StubBehaviour = STRONG_CANDIDATE): StubBehaviour {
  return { ...base, ...overrides };
}

function take<T>(values: readonly T[], fraction: number): T[] {
  if (fraction >= 1) return [...values];
  if (fraction <= 0) return [];
  return values.slice(0, Math.max(1, Math.round(values.length * fraction)));
}

function noisePaths(caseId: string, count: number, suffix: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) out.push(`src/noise/${caseId}/filler-${index}${suffix}.ts`);
  return out;
}

export function stubAdapter(
  id: string,
  kind: ContextGraphBenchmarkAdapterKind,
  cases: readonly ContextGraphBenchmarkCase[],
  config: StubBehaviour
): ContextGraphBenchmarkAdapter {
  const byId = new Map(cases.map((item) => [item.id, item] as const));
  return {
    id,
    kind,
    async run(query: ContextGraphBenchmarkQuery): Promise<ContextGraphBenchmarkRun> {
      if (config.throwOnRun) throw new Error('stub adapter failure');
      const testCase = byId.get(query.caseId);
      const gold = testCase?.gold;
      const suffix = config.unstable ? `-${query.mode}-${query.iteration}` : '';
      const matchedPaths = [
        ...take(gold?.paths ?? [], config.pathFraction),
        ...(config.includeMustExclude ? (gold?.mustExcludePaths ?? []) : []),
        ...(config.includeStale ? (gold?.stalePaths ?? []) : []),
        ...noisePaths(query.caseId, config.noise, suffix)
      ];
      return {
        caseId: query.caseId,
        adapterId: id,
        mode: query.mode,
        iteration: query.iteration,
        ok: true,
        errorCode: null,
        matchedPaths,
        matchedNodeIds: matchedPaths.map((item) => `file:${item}`),
        selectedGateIds: config.includeGates ? [...(gold?.gateIds ?? [])] : [],
        selectedTestPaths: config.includeTests ? [...(gold?.testPaths ?? [])] : [],
        writeScopeConflicts: config.includeConflicts ? [...(gold?.conflicts ?? [])] : [],
        tokenCost: config.tokenCost,
        latencyMs: query.mode === 'cold' ? config.coldLatencyMs : config.warmLatencyMs,
        cacheHit: query.mode === 'warm',
        provenanceCoverage: config.provenanceCoverage,
        staleIncluded: config.includeStale ? [...(gold?.stalePaths ?? [])] : [],
        invalidatedIncluded: [],
        exactSeedsPreserved: config.includeExactSeeds ? [...(gold?.exactSeedPaths ?? [])] : [],
        safety: emptyBenchmarkSafety({
          snapshotHash: `snapshot-${query.caseId}${suffix}`,
          determinismHash: `snapshot-${query.caseId}${suffix}`,
          scanBudget: 10000,
          scannedFiles: 12,
          ...config.safety
        })
      };
    }
  };
}
