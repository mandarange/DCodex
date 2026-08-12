/**
 * The real v1 and v2 engines behind `compareRetrievalEngines`.
 *
 * Both implement the same `Crk2Engine` interface and are handed to the seam as
 * explicit arguments, so nothing here decides which engine runs — the caller
 * holds both references and the seam refuses a mismatched or self-paired set.
 *
 * These are deliberately NOT used by the metric tests. `crk2-stub-engine.ts`
 * stays the only exerciser of `crk2-metrics.ts` and `crk2-floors.ts`, because a
 * metric validated against a real engine cannot detect that engine being wrong:
 * the two would agree by construction. The stub proves the arithmetic; these
 * two produce the numbers the arithmetic is applied to.
 *
 * The compile is memoized per root. A benchmark that recompiled per iteration
 * would report compile time as query latency, which is the single easiest way
 * to make a retrieval comparison meaningless.
 */
import type { ContextGraphSnapshot } from '../contracts.js';
import { compileContextGraph } from '../compiler/index.js';
import { publishContextIndexGeneration } from '../compiler/publish-index.js';
import { computeSourceInventoryFingerprint } from '../compiler/fragment-manifest.js';
import { contextGraphExtractors } from '../extractors/index.js';
import {
  changedPathKernelSeeds,
  changedPathSnapshotSeeds,
  clearWorkspaceContextIndex,
  loadContextGraphIndex,
  openWorkspaceContextIndex,
  queryContextGraph,
  queryWorkspaceContext,
  workspaceContextFailureOf
} from '../query/index.js';
import { fixedKernelClock } from '../query/kernel.js';
import type { Crk2Conflict, Crk2Engine, Crk2EngineRequest, Crk2EngineResult } from './crk2-types.js';
import { detectWriteScopeConflicts } from './adapters/slice-conflicts.js';

/** Errors both engines report identically, so a code difference means a real behavioural difference. */
const COMPILE_FAILED = 'adapter_error:compile_failed';

/**
 * Gate node ids carry a `gate:` prefix; the corpus names gates by their bare
 * manifest id, which is what a caller reads in `release-gates.v2.json`. Aligning
 * here rather than in the gold keeps the corpus written in the vocabulary a
 * human uses, and a mismatch shows up as a protected-gate floor failure that
 * looks exactly like a missed gate — so it is normalized in one place.
 */
function bareGateId(nodeId: string): string {
  return nodeId.startsWith('gate:') ? nodeId.slice('gate:'.length) : nodeId;
}

function emptyResult(errorCode: string | null, latencyMs: number, cacheHit = false): Crk2EngineResult {
  return {
    ok: errorCode === null,
    errorCode,
    nodeIds: [],
    provenanceNodeIds: [],
    confidenceByNodeId: {},
    selectedGateIds: [],
    droppedGateIds: [],
    conflicts: [],
    tokenCost: 0,
    latencyMs,
    cacheHit
  };
}

/**
 * `changedPaths` enter as caller-supplied `file_path` seeds and are never promoted.
 *
 * Both engines build them from the one shared resolver in
 * `query/changed-path-seeds.ts`, so the two sides of the comparison cannot drift
 * apart on *which* paths become seeds. They drifted once already, in the worse
 * direction: v1 passed this field and v2 dropped it, so every recall figure
 * published before this fix compared two engines that had been asked different
 * questions.
 */

interface CompiledRoot {
  readonly snapshotHash: string;
  readonly sourceFingerprint: string;
}

/**
 * The sources the build considered, taken from the snapshot rather than from a
 * second directory walk.
 *
 * A walk would be a different inventory computed a moment later, and the
 * fingerprint's whole job is to say "this index describes *this* tree" — so it
 * has to be derived from the same bytes the snapshot was.
 */
function sourceInventoryOf(snapshot: ContextGraphSnapshot): ReadonlyMap<string, string> {
  const inventory = new Map<string, string>();
  for (const node of snapshot.nodes) {
    if (node.path !== undefined && node.contentHash !== undefined) inventory.set(node.path, node.contentHash);
  }
  return inventory;
}

/** Compile memo shared by both engines' bases; one instance per engine instance. */
abstract class CompilingEngine {
  private readonly compiled = new Map<string, CompiledRoot | null>();

  protected async ensureCompiled(request: Crk2EngineRequest): Promise<CompiledRoot | null> {
    // The fault workspace must never be compiled or published. Its whole purpose
    // is to be a root with no usable index, so building one on demand would turn
    // every rejection case into a successful answer and make the 100%
    // corrupt-input floor unmeasurable while reporting it as met.
    if (request.workspace === 'crk2-fault') return null;
    const found = this.compiled.get(request.root);
    if (found !== undefined) return found;
    const result = await compileContextGraph({
      root: request.root,
      extractors: contextGraphExtractors(),
      observedAt: request.now
    });
    if (!result.ok || !result.snapshot) {
      this.compiled.set(request.root, null);
      return null;
    }
    const sourceFingerprint = computeSourceInventoryFingerprint(sourceInventoryOf(result.snapshot));
    const entry: CompiledRoot = { snapshotHash: result.snapshot.snapshotHash, sourceFingerprint };
    await this.publish(request, result.snapshot, sourceFingerprint);
    this.compiled.set(request.root, entry);
    return entry;
  }

  protected abstract publish(
    request: Crk2EngineRequest,
    snapshot: ContextGraphSnapshot,
    sourceFingerprint: string
  ): Promise<void>;

  reset(): void {
    this.compiled.clear();
  }
}

/**
 * v1: the JSON snapshot path CRK2 replaces.
 *
 * Kept exactly as the shipped v1 query behaved, including its inability to
 * answer a query whose terms are not in the label or path tables. Its `korean`
 * and `jargon` results returning nothing quickly is the behaviour under
 * measurement, not a bug to patch here.
 */
export class Crk2V1Engine extends CompilingEngine implements Crk2Engine {
  readonly id = 'v1-json-snapshot';

  readonly version = 'v1' as const;

  protected override async publish(): Promise<void> {
    // v1 reads the JSON snapshot the compiler already wrote; nothing to publish.
  }

  async run(request: Crk2EngineRequest): Promise<Crk2EngineResult> {
    const startedAt = performance.now();
    const compiled = await this.ensureCompiled(request);
    if (!compiled) return emptyResult(COMPILE_FAILED, performance.now() - startedAt);

    const load = await loadContextGraphIndex(request.root, { status: { status: 'fresh' } });
    if (!load.ok || !load.index) {
      return emptyResult(load.errorCode ?? 'adapter_error:index_unavailable', performance.now() - startedAt);
    }
    const seeds = changedPathSnapshotSeeds(request.changedPaths);
    const result = await queryContextGraph(
      {
        root: request.root,
        query: request.query,
        profile: request.profile,
        tokenBudget: request.tokenBudget,
        risk: request.risk,
        focusPaths: [...request.focusPaths],
        now: request.now,
        ...(seeds.length === 0 ? {} : { seeds })
      },
      { index: load.index }
    );
    const latencyMs = performance.now() - startedAt;
    if (!result.ok) return emptyResult(result.errors[0] ?? 'adapter_error:query_failed', latencyMs, load.cacheHit);

    const nodeIds = result.selected.map((node) => node.nodeId);
    const confidenceByNodeId: Record<string, Crk2EngineResult['confidenceByNodeId'][string]> = {};
    const provenanceNodeIds: string[] = [];
    for (const node of result.selected) {
      if (node.seedConfidence) confidenceByNodeId[node.nodeId] = node.seedConfidence;
      if (node.provenance && node.provenance.length > 0) provenanceNodeIds.push(node.nodeId);
    }
    return {
      ok: true,
      errorCode: null,
      nodeIds,
      provenanceNodeIds,
      confidenceByNodeId,
      selectedGateIds: result.selected.filter((node) => node.kind === 'gate').map((node) => bareGateId(node.nodeId)),
      droppedGateIds: [],
      conflicts: [],
      tokenCost: result.tokenCost,
      latencyMs,
      cacheHit: load.cacheHit
    };
  }
}

export interface Crk2V2EngineOptions {
  /** Injected so conflict detection can be exercised; defaults to the production advisory. */
  readonly detectConflicts?: (root: string, reader: never, task: string) => Crk2Conflict[];
}

/**
 * v2: pointer → reader → kernel → selected-only hydration, through
 * `queryWorkspaceContext`.
 *
 * The generation is published once per root by the shared compile memo, so a
 * measured iteration opens an already-committed index and never compiles.
 */
export class Crk2V2Engine extends CompilingEngine implements Crk2Engine {
  readonly id = 'v2-binary-kernel';

  readonly version = 'v2' as const;

  protected override async publish(
    request: Crk2EngineRequest,
    snapshot: Parameters<typeof publishContextIndexGeneration>[0]['snapshot'],
    sourceFingerprint: string
  ): Promise<void> {
    // `publishContextIndexGeneration` always threads the lexicon config. An
    // index built without it has four empty dictionary sections and measures as
    // a search that can only answer a pasted path, so this path is the one that
    // must be used rather than a hand-rolled `encodeContextIndex`.
    await publishContextIndexGeneration({
      root: request.root,
      snapshot,
      sourceFingerprint,
      now: request.now
    });
  }

  async run(request: Crk2EngineRequest): Promise<Crk2EngineResult> {
    const startedAt = performance.now();
    const compiled = await this.ensureCompiled(request);
    const faultWorkspace = request.workspace === 'crk2-fault';
    // A fault root is queried without compiling, so the store's own refusal is
    // what reaches the report. Substituting a compile error here would satisfy
    // "did not answer" while hiding *why*, and the rejection cases assert the
    // exact ADR §5 code rather than merely that something failed.
    if (!compiled && !faultWorkspace) return emptyResult(COMPILE_FAILED, performance.now() - startedAt);

    try {
      const handle = await openWorkspaceContextIndex(request.root, {
        ...(compiled === null ? {} : { expectedSourceFingerprint: compiled.sourceFingerprint })
      });
      // The same `changedPaths` v1 receives. Dropping them here was not a v2
      // behaviour being measured but the harness asking two engines different
      // questions, which makes every recall delta it publishes unattributable.
      const seeds = changedPathKernelSeeds(request.changedPaths);
      const answer = await queryWorkspaceContext(
        request.root,
        {
          query: request.query,
          profile: request.profile,
          risk: request.risk,
          tokenBudget: request.tokenBudget,
          focusPaths: [...request.focusPaths],
          ...(seeds.length === 0 ? {} : { seeds })
        },
        { clock: fixedKernelClock(0), index: handle }
      );
      const latencyMs = performance.now() - startedAt;
      const hydrated = answer.hydration.nodes;
      const nodeIds = hydrated.map((node) => node.nodeId);
      const confidenceByNodeId: Record<string, Crk2EngineResult['confidenceByNodeId'][string]> = {};
      const provenanceNodeIds: string[] = [];
      let tokenCost = 0;
      for (const node of hydrated) {
        if (node.seedConfidence) confidenceByNodeId[node.nodeId] = node.seedConfidence;
        if (node.provenance.length > 0) provenanceNodeIds.push(node.nodeId);
        tokenCost += node.tokenCost;
      }
      return {
        ok: true,
        errorCode: null,
        nodeIds,
        provenanceNodeIds,
        confidenceByNodeId,
        selectedGateIds: hydrated.filter((node) => node.kind === 'gate').map((node) => bareGateId(node.nodeId)),
        droppedGateIds: [],
        // The production Naruto advisory over the same reader, not a
        // benchmark-local re-derivation — the conflict floor is only worth
        // anything if it measures what actually protects a parallel wave.
        conflicts: detectWriteScopeConflicts(request.root, handle.reader, request.query),
        tokenCost,
        latencyMs,
        cacheHit: answer.indexCacheHit
      };
    } catch (error: unknown) {
      // ADR §5 codes travel as themselves. A rejection case asserts the exact
      // code, so collapsing them into one adapter error would make the
      // corrupt-input floor unmeasurable.
      const failure = workspaceContextFailureOf(error);
      return emptyResult(failure?.code ?? 'adapter_error:query_failed', performance.now() - startedAt);
    }
  }

  override reset(): void {
    super.reset();
  }
}

export function createCrk2Engines(): { v1: Crk2Engine; v2: Crk2Engine } {
  return { v1: new Crk2V1Engine(), v2: new Crk2V2Engine() };
}

export { clearWorkspaceContextIndex, detectWriteScopeConflicts };
