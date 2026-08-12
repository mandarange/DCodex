/**
 * Scripted engines for the CRK2 metric tests.
 *
 * The query kernel does not exist yet, and these tests are about the harness
 * anyway: a metric that only works against one engine proves nothing about the
 * engine it was tuned on. `perfectEngine` answers exactly what the gold set asks
 * for, so each test can break one property and watch the corresponding metric or
 * floor move, instead of asserting numbers copied from a real run.
 */
import { CRK2_RETRIEVAL_FILES } from '../crk2-corpus.js';
import type {
  Crk2Case,
  Crk2Conflict,
  Crk2Engine,
  Crk2EngineRequest,
  Crk2EngineResult,
  Crk2GoldMatcher
} from '../crk2-types.js';
import type { ContextGraphSeedConfidence } from '../../query-types.js';

/** A node id that satisfies a matcher, built the way the compiler would build it. */
export function nodeIdForMatcher(matcher: Crk2GoldMatcher): string {
  if (matcher.kind === 'symbol') return `symbol:${matcher.path}#function:${matcher.name}@0`;
  if (matcher.kind === 'id_prefix') return `${matcher.prefix}0f0f0f0f0f0f0f0f`;
  const first = CRK2_RETRIEVAL_FILES.find((item) => item.startsWith(matcher.prefix));
  return `file:${first ?? matcher.prefix}`;
}

export interface Crk2StubPlan {
  readonly ok?: boolean;
  readonly errorCode?: string | null;
  readonly nodeIds?: readonly string[];
  readonly provenanceNodeIds?: readonly string[];
  readonly confidenceByNodeId?: Readonly<Record<string, ContextGraphSeedConfidence>>;
  readonly selectedGateIds?: readonly string[];
  readonly droppedGateIds?: readonly string[];
  readonly conflicts?: readonly Crk2Conflict[];
  readonly tokenCost?: number;
  readonly latencyMs?: number;
  /** Appends a junk node from this iteration onward, so a determinism check has something to catch. */
  readonly driftFromIteration?: number;
}

export function perfectPlanFor(testCase: Crk2Case): Crk2StubPlan {
  const gold = testCase.gold;
  if (gold.expectedErrorCode) {
    return { ok: false, errorCode: gold.expectedErrorCode, nodeIds: [], tokenCost: 0, latencyMs: 1 };
  }
  const nodeIds = [
    ...gold.mustIncludeNodeIds,
    ...gold.mustIncludeMatchers.map(nodeIdForMatcher),
    ...gold.relevantNodeIds
  ].slice(0, testCase.k);
  const confidenceByNodeId: Record<string, ContextGraphSeedConfidence> = {};
  for (const nodeId of nodeIds) {
    confidenceByNodeId[nodeId] = gold.requiredConfidence?.[nodeId] ?? gold.confidenceCeiling ?? 'text_candidate';
  }
  return {
    ok: true,
    errorCode: null,
    nodeIds,
    provenanceNodeIds: nodeIds,
    confidenceByNodeId,
    selectedGateIds: gold.gateIds,
    droppedGateIds: [],
    conflicts: gold.conflicts,
    tokenCost: Math.min(gold.maxTokenCost ?? testCase.tokenBudget, testCase.tokenBudget),
    latencyMs: 4
  };
}

function materialize(plan: Crk2StubPlan, request: Crk2EngineRequest): Crk2EngineResult {
  const drift = plan.driftFromIteration !== undefined && request.iteration >= plan.driftFromIteration;
  const nodeIds = drift ? [...(plan.nodeIds ?? []), `file:drift-${request.iteration}.ts`] : [...(plan.nodeIds ?? [])];
  return {
    ok: plan.ok ?? true,
    errorCode: plan.errorCode ?? null,
    nodeIds,
    provenanceNodeIds: plan.provenanceNodeIds ?? nodeIds,
    confidenceByNodeId: plan.confidenceByNodeId ?? {},
    selectedGateIds: plan.selectedGateIds ?? [],
    droppedGateIds: plan.droppedGateIds ?? [],
    conflicts: plan.conflicts ?? [],
    tokenCost: plan.tokenCost ?? 0,
    latencyMs: plan.latencyMs ?? 4,
    cacheHit: request.iteration > 0
  };
}

export function stubEngine(
  id: string,
  version: 'v1' | 'v2',
  plans: ReadonlyMap<string, Crk2StubPlan>
): Crk2Engine {
  return {
    id,
    version,
    run(request: Crk2EngineRequest): Promise<Crk2EngineResult> {
      const plan = plans.get(request.caseId) ?? { nodeIds: [], tokenCost: 0, latencyMs: 1 };
      return Promise.resolve(materialize(plan, request));
    }
  };
}

/** An engine that returns exactly the gold set for every case. */
export function perfectEngine(id: string, version: 'v1' | 'v2', cases: readonly Crk2Case[]): Crk2Engine {
  return stubEngine(id, version, new Map(cases.map((item) => [item.id, perfectPlanFor(item)])));
}

/** Applies `mutate` to one case's plan and leaves every other case perfect. */
export function engineWithMutatedCase(
  id: string,
  version: 'v1' | 'v2',
  cases: readonly Crk2Case[],
  caseId: string,
  mutate: (plan: Crk2StubPlan) => Crk2StubPlan
): Crk2Engine {
  const plans = new Map(cases.map((item) => [item.id, perfectPlanFor(item)]));
  const target = plans.get(caseId);
  if (!target) throw new Error(`unknown case id ${caseId}`);
  plans.set(caseId, mutate(target));
  return stubEngine(id, version, plans);
}
