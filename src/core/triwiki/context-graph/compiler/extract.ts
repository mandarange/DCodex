/**
 * Extractor execution.
 *
 * Extractors are injected, never imported: the compiler must not know which
 * extractors exist, and it must never load workspace code to find out. Each
 * extractor is time-boxed and its fragment is content-hash cached, and a failing
 * extractor fails the whole compile — a graph missing a third of its edges is
 * worse than no graph, because consumers cannot tell the difference.
 */
import {
  CONTEXT_GRAPH_FRAGMENT_SCHEMA,
  lintWarning,
  type ContextGraphExtractionLimits,
  type ContextGraphExtractor,
  type ContextGraphFragment,
  type ContextGraphLintIssue
} from '../contracts.js';
import {
  fragmentCacheKey,
  pruneFragmentCache,
  readCachedFragment,
  writeCachedFragment
} from '../store/fragment-cache.js';

export const DEFAULT_CONTEXT_GRAPH_LIMITS: ContextGraphExtractionLimits = {
  maxFiles: 5000,
  maxFileBytes: 512 * 1024,
  maxNodes: 50_000,
  maxEdges: 200_000,
  timeoutMs: 60_000
};

export interface RunContextGraphExtractorsInput {
  root: string;
  extractors: readonly ContextGraphExtractor[];
  changedPaths: readonly string[] | null;
  limits: ContextGraphExtractionLimits;
  observedAt: string;
  cacheKey: string;
  useFragmentCache: boolean;
}

export interface RunContextGraphExtractorsResult {
  fragments: ContextGraphFragment[];
  issues: ContextGraphLintIssue[];
  cacheHits: string[];
  /** Machine codes such as `extractor_failed:<id>` or `extractor_timeout:<id>`. */
  blockers: string[];
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T> | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(1, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    // `settle` already absorbs the rejection, so the loser of the race can never
    // surface as an unhandled rejection after the timeout wins.
    return await Promise.race([settle(promise), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isFragment(value: unknown, extractorId: string): value is ContextGraphFragment {
  if (!value || typeof value !== 'object') return false;
  const fragment = value as Partial<ContextGraphFragment>;
  return (
    fragment.schema === CONTEXT_GRAPH_FRAGMENT_SCHEMA
    && fragment.extractor === extractorId
    && Array.isArray(fragment.nodes)
    && Array.isArray(fragment.edges)
  );
}

function sortExtractors(extractors: readonly ContextGraphExtractor[]): ContextGraphExtractor[] {
  return [...extractors].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export async function runContextGraphExtractors(
  input: RunContextGraphExtractorsInput
): Promise<RunContextGraphExtractorsResult> {
  const fragments: ContextGraphFragment[] = [];
  const issues: ContextGraphLintIssue[] = [];
  const cacheHits: string[] = [];
  const blockers: string[] = [];
  const seen = new Set<string>();

  for (const extractor of sortExtractors(input.extractors)) {
    if (seen.has(extractor.id)) {
      blockers.push(`extractor_duplicate_id:${extractor.id}`);
      continue;
    }
    seen.add(extractor.id);

    const key = fragmentCacheKey({
      extractorId: extractor.id,
      extractorRevision: extractor.revision,
      cacheKey: input.cacheKey,
      changedPaths: input.changedPaths
    });
    if (input.useFragmentCache) {
      const cached = await readCachedFragment(input.root, key, extractor.id);
      if (cached) {
        fragments.push(cached);
        cacheHits.push(extractor.id);
        continue;
      }
    }

    const outcome = await withTimeout(
      extractor.extract({
        root: input.root,
        changedPaths: input.changedPaths,
        limits: input.limits,
        observedAt: input.observedAt
      }),
      input.limits.timeoutMs
    );
    if (outcome === 'timeout') {
      blockers.push(`extractor_timeout:${extractor.id}`);
      continue;
    }
    if (!outcome.ok) {
      blockers.push(`extractor_failed:${extractor.id}`);
      continue;
    }
    if (!isFragment(outcome.value, extractor.id)) {
      blockers.push(`extractor_invalid_fragment:${extractor.id}`);
      continue;
    }
    fragments.push(outcome.value);
    if (outcome.value.skipped.length > 0) {
      issues.push(
        lintWarning(
          'extractor_skipped_input',
          `${extractor.id} skipped ${outcome.value.skipped.length} input(s)`,
          { extractor: extractor.id }
        )
      );
    }
    if (input.useFragmentCache) {
      try {
        await writeCachedFragment(input.root, key, outcome.value);
      } catch {
        // A cache write failure is never a compile failure; the next run just re-extracts.
      }
    }
  }

  if (input.useFragmentCache) await pruneFragmentCache(input.root);
  return { fragments, issues, cacheHits, blockers };
}
