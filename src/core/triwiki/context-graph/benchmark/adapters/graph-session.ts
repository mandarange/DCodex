/**
 * Cold/warm session management for the `candidate-graph` benchmark adapter.
 *
 * The benchmark's cold and warm numbers are only meaningful if the split is
 * mechanical, so it lives here rather than inside the adapter's answer code:
 *
 *  - cold  = this process has never compiled this fixture root. Compile it,
 *            optionally recompile it once to prove the snapshot is reproducible,
 *            then build the adjacency index. Reported as `cacheHit: false`.
 *  - warm  = the root is already compiled. Read the small meta file, take the
 *            index straight out of the in-process snapshot cache, and answer.
 *            No compile, no snapshot re-parse, no process spawn.
 *
 * The runner materializes a fresh fixture directory for every cold iteration and
 * reuses one directory for the warm iterations, so keying the session on the
 * absolute fixture root is what makes the two phases separate by construction.
 * Roots are absolute temp paths: they are used as map keys and are never copied
 * into a run record, a metric or a report.
 */
import type { ContextGraphExtractionLimits, ContextGraphExtractor, ContextGraphSnapshot } from '../../contracts.js';
import type { ContextGraphIndex } from '../../graph-index.js';
import { compileContextGraph } from '../../compiler/index.js';
import { contextGraphExtractors } from '../../extractors/index.js';
import { clearContextGraphSnapshotCache, loadContextGraphIndex } from '../../query/index.js';

/** Structural facts about the compiled snapshot, measured once per root. */
export interface ContextGraphSnapshotSafety {
  readonly snapshotHash: string;
  /** Hash of an independent recompile of the same tree; `null` when verification is off. */
  readonly determinismHash: string | null;
  readonly danglingEdges: number;
  readonly edgesWithoutProvenance: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface ContextGraphSession {
  readonly index: ContextGraphIndex;
  readonly safety: ContextGraphSnapshotSafety;
  /** True when the index came from the in-process snapshot cache instead of a parse. */
  readonly cacheHit: boolean;
  /** True when this call had to compile the graph. */
  readonly compiled: boolean;
}

export type ContextGraphSessionResult =
  | { readonly ok: true; readonly session: ContextGraphSession }
  | { readonly ok: false; readonly errorCode: string; readonly errors: readonly string[] };

export interface ContextGraphSessionOptions {
  /** Recompile each root once and compare hashes. Cold-path only; defaults to true. */
  readonly verifyDeterminism?: boolean;
  readonly limits?: Partial<ContextGraphExtractionLimits>;
  /** Injected registry, so a test can compile with a narrower extractor set. */
  readonly extractors?: () => readonly ContextGraphExtractor[];
}

/**
 * Count the two structural defects the safety floors care about. Linear in the
 * edge count and run once per compiled root, never on the warm answer path.
 */
export function measureSnapshotSafety(
  snapshot: ContextGraphSnapshot,
  determinismHash: string | null
): ContextGraphSnapshotSafety {
  const nodeIds = new Set<string>();
  for (const node of snapshot.nodes) nodeIds.add(node.id);
  let danglingEdges = 0;
  let edgesWithoutProvenance = 0;
  for (const edge of snapshot.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) danglingEdges += 1;
    const provenance = edge.provenance;
    if (!provenance || !provenance.path || !provenance.hash || !provenance.extractor) {
      edgesWithoutProvenance += 1;
    }
  }
  return {
    snapshotHash: snapshot.snapshotHash,
    determinismHash,
    danglingEdges,
    edgesWithoutProvenance,
    nodeCount: snapshot.nodeCount,
    edgeCount: snapshot.edgeCount
  };
}

interface SessionFailure {
  readonly ok: false;
  readonly errorCode: string;
  readonly errors: readonly string[];
}

function compileFailure(blockers: readonly string[], reason: string | null): SessionFailure {
  const code = blockers[0] ?? reason ?? 'failed';
  return { ok: false, errorCode: `adapter_error:compile_${code}`, errors: [...blockers] };
}

/**
 * Per-root compile memo. One instance is owned by one adapter instance; two
 * adapters never share compiled state, so a report can never credit one
 * adapter's warm cache to the other.
 */
export class ContextGraphSessionCache {
  private readonly safetyByRoot = new Map<string, ContextGraphSnapshotSafety>();

  private readonly options: ContextGraphSessionOptions;

  constructor(options: ContextGraphSessionOptions = {}) {
    this.options = options;
  }

  /** Roots compiled by this instance so far; used by tests to assert the cold/warm split. */
  compiledRoots(): number {
    return this.safetyByRoot.size;
  }

  /** Drop the memo and the shared in-process snapshot cache. */
  reset(): void {
    this.safetyByRoot.clear();
    clearContextGraphSnapshotCache();
  }

  async acquire(root: string, observedAt: string): Promise<ContextGraphSessionResult> {
    let safety = this.safetyByRoot.get(root);
    const compiled = safety === undefined;
    if (safety === undefined) {
      const built = await this.compile(root, observedAt);
      if (!built.ok) return built;
      safety = built.safety;
      this.safetyByRoot.set(root, safety);
    }

    // `status: fresh` is the caller's preflight verdict. The benchmark just
    // compiled this tree and nothing else writes to a hermetic fixture, so the
    // verdict is a fact here — and supplying it is what keeps the answer path
    // spawn-free while still refusing to guess at freshness.
    const load = await loadContextGraphIndex(root, { status: { status: 'fresh' } });
    if (!load.ok || !load.index) {
      return {
        ok: false,
        errorCode: load.errorCode ?? 'adapter_error:index_unavailable',
        errors: [...load.errors]
      };
    }
    return { ok: true, session: { index: load.index, safety, cacheHit: load.cacheHit, compiled } };
  }

  private extractors(): ContextGraphExtractor[] {
    const injected = this.options.extractors?.();
    return injected ? [...injected] : contextGraphExtractors();
  }

  private async compile(
    root: string,
    observedAt: string
  ): Promise<{ ok: true; safety: ContextGraphSnapshotSafety } | SessionFailure> {
    const limits = this.options.limits;
    const first = await compileContextGraph({
      root,
      extractors: this.extractors(),
      observedAt,
      ...(limits === undefined ? {} : { limits })
    });
    if (!first.ok || !first.snapshot) return compileFailure(first.blockers, first.reason);

    let determinismHash: string | null = null;
    if (this.options.verifyDeterminism !== false) {
      // `useFragmentCache: false` forces the extractors to run again instead of
      // replaying the fragments the first compile just wrote, so a matching
      // hash means the pipeline is reproducible rather than merely cached.
      const second = await compileContextGraph({
        root,
        extractors: this.extractors(),
        observedAt,
        useFragmentCache: false,
        ...(limits === undefined ? {} : { limits })
      });
      determinismHash = second.snapshot?.snapshotHash ?? null;
    }
    return { ok: true, safety: measureSnapshotSafety(first.snapshot, determinismHash) };
  }
}
