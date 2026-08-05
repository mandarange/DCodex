import path from 'node:path';
import { exists, readJson } from '../fsx.js';
import { inspectCodePackHeadFreshness } from '../triwiki/code-pack-head-freshness.js';

/** Returns a bounded, non-blocking stale-code-pack note for user-prompt-submit.
 * It stays silent when no pack exists or freshness is inconclusive, never regenerates
 * the pack, and treats metadata-only follow-up commits as fresh. */
export async function codePackFreshnessNote(root: string, opts: { budgetMs?: number } = {}): Promise<string | null> {
  const budgetMs = Math.max(1, opts.budgetMs ?? 750);
  const gitTimeoutMs = Math.max(1, budgetMs - 50);
  return raceWithTimeout(computeNote(root, gitTimeoutMs), budgetMs).catch(() => null);
}

async function computeNote(root: string, gitTimeoutMs: number): Promise<string | null> {
  const packPath = path.join(root, '.sneakoscope', 'wiki', 'code-pack.json');
  if (!(await exists(packPath))) return null;
  const pack = await readJson<any>(packPath, null).catch(() => null);
  const packSha = pack?.git_head_sha || null;
  // A pack with no recorded sha (non-git build) can't be compared; stay silent
  // rather than nag with a comparison we can't actually make.
  if (!packSha) return null;
  const freshness = await inspectCodePackHeadFreshness(root, packSha, {
    timeoutMs: gitTimeoutMs,
    advisoryCache: true,
  });
  if (!freshness.conclusive || !freshness.current_sha || freshness.fresh) return null;
  return 'SKS note: the codebase code pack is stale (HEAD moved since it was built). Run `sks align run` to refresh source-cited code context.';
}

async function raceWithTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
