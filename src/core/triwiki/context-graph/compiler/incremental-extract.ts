/**
 * Running the source extractors the plan asked for, and refusing the answers it
 * did not ask for.
 *
 * An extractor is injected, time-boxed, and treated as untrusted about three
 * things, because each one would corrupt the manifest rather than merely produce
 * a bad fragment:
 *
 * - **Which sources it answered for.** A fragment for a path nobody requested
 *   would enter the manifest describing work that was never planned, and would
 *   then be reused on every later build.
 * - **What those sources contained.** The fragment's `sourceHash` has to equal
 *   the inventory hash the plan compared against. A fragment claiming a different
 *   hash was derived from bytes the plan never saw, so no later comparison could
 *   detect it going stale.
 * - **Which revision produced it.** A revision that disagrees with the injected
 *   extractor makes `extractor_revision_changed` unable to fire next time.
 *
 * A requested source that comes back with no fragment gets an empty one. That is
 * not a courtesy: the manifest has to be total, and a missing entry is
 * indistinguishable from a source nobody has ever looked at, which would make
 * that file re-extract on every build forever.
 */
import type { FragmentExtractionRequest } from './fragment-plan.js';
import {
  emptySourceFragment,
  type ContextGraphSourceExtractor,
  type ContextGraphSourceFragment,
} from './source-fragment.js';

export const DEFAULT_SOURCE_EXTRACTOR_TIMEOUT_MS = 60_000;

export interface RunSourceExtractorsInput {
  readonly root: string;
  readonly extractors: readonly ContextGraphSourceExtractor[];
  readonly requests: readonly FragmentExtractionRequest[];
  readonly inventory: ReadonlyMap<string, string>;
  readonly observedAt: string;
  readonly timeoutMs?: number | undefined;
}

export interface RunSourceExtractorsResult {
  readonly fragments: readonly ContextGraphSourceFragment[];
  /** Machine codes only: `source_extractor_timeout:<id>`, `source_extractor_failed:<id>`, … */
  readonly blockers: readonly string[];
  readonly extractedCount: number;
  readonly emptyCount: number;
}

type Settled<T> = { ok: true; value: T } | { ok: false };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch {
    return { ok: false };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T> | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(1, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    // `settle` absorbs the rejection first, so the loser of the race can never
    // surface as an unhandled rejection after the timeout wins.
    return await Promise.race([settle(promise), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface AcceptedFragments {
  readonly accepted: Map<string, ContextGraphSourceFragment>;
  readonly blockers: readonly string[];
}

function acceptFragments(
  extractor: ContextGraphSourceExtractor,
  returned: readonly ContextGraphSourceFragment[],
  requested: ReadonlySet<string>,
  inventory: ReadonlyMap<string, string>,
): AcceptedFragments {
  const accepted = new Map<string, ContextGraphSourceFragment>();
  const blockers: string[] = [];
  for (const fragment of returned) {
    if (fragment.extractor !== extractor.id || fragment.extractorRevision !== extractor.revision) {
      blockers.push(`source_extractor_identity_mismatch:${extractor.id}`);
      break;
    }
    if (!requested.has(fragment.sourcePath)) {
      blockers.push(`source_extractor_unrequested_source:${extractor.id}`);
      break;
    }
    if (fragment.sourceHash !== inventory.get(fragment.sourcePath)) {
      blockers.push(`source_extractor_source_hash_mismatch:${extractor.id}`);
      break;
    }
    if (accepted.has(fragment.sourcePath)) {
      blockers.push(`source_extractor_duplicate_source:${extractor.id}`);
      break;
    }
    accepted.set(fragment.sourcePath, fragment);
  }
  return { accepted, blockers };
}

export async function runSourceExtractors(input: RunSourceExtractorsInput): Promise<RunSourceExtractorsResult> {
  const byId = new Map(input.extractors.map((extractor) => [extractor.id, extractor]));
  const timeoutMs = input.timeoutMs ?? DEFAULT_SOURCE_EXTRACTOR_TIMEOUT_MS;
  const fragments: ContextGraphSourceFragment[] = [];
  const blockers: string[] = [];
  let extractedCount = 0;
  let emptyCount = 0;

  for (const request of input.requests) {
    const extractor = byId.get(request.extractor);
    if (!extractor) {
      blockers.push(`source_extractor_missing:${request.extractor}`);
      continue;
    }
    const outcome = await withTimeout(
      Promise.resolve(
        extractor.extractSources({
          root: input.root,
          sourcePaths: request.sourcePaths,
          observedAt: input.observedAt,
        }),
      ),
      timeoutMs,
    );
    if (outcome === 'timeout') {
      blockers.push(`source_extractor_timeout:${extractor.id}`);
      continue;
    }
    if (!outcome.ok || !Array.isArray(outcome.value)) {
      blockers.push(`source_extractor_failed:${extractor.id}`);
      continue;
    }

    const requested = new Set(request.sourcePaths);
    const checked = acceptFragments(extractor, outcome.value, requested, input.inventory);
    for (const blocker of checked.blockers) blockers.push(blocker);
    if (checked.blockers.length > 0) continue;
    for (const sourcePath of request.sourcePaths) {
      const fragment = checked.accepted.get(sourcePath);
      if (fragment) {
        fragments.push(fragment);
        extractedCount += 1;
        continue;
      }
      emptyCount += 1;
      fragments.push(
        emptySourceFragment(extractor.id, extractor.revision, sourcePath, input.inventory.get(sourcePath) as string),
      );
    }
  }

  return { fragments, blockers, extractedCount, emptyCount };
}
