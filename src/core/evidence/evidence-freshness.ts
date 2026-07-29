import fsp from 'node:fs/promises';

export async function fileFreshness(file: any, { staleAfter = null }: any = {}) {
  let stat = null;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { exists: false, freshness: 'unknown', mtime_ms: null, issues: ['path_missing'] };
  }
  if (!staleAfter) return { exists: true, freshness: 'fresh', mtime_ms: stat.mtimeMs, issues: [] };
  const cutoff = typeof staleAfter === 'number' ? staleAfter : Date.parse(staleAfter);
  if (Number.isFinite(cutoff) && stat.mtimeMs < cutoff) {
    return { exists: true, freshness: 'stale', mtime_ms: stat.mtimeMs, issues: ['stale'] };
  }
  return { exists: true, freshness: 'fresh', mtime_ms: stat.mtimeMs, issues: [] };
}

export async function lastJsonlEventTime(file: any) {
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let latest = null;
  for (const line of text.split(/\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (!eventInvalidatesProof(parsed)) continue;
      const ts = Date.parse(parsed.ts || parsed.time || parsed.created_at || '');
      if (Number.isFinite(ts) && (latest == null || ts > latest)) latest = ts;
    } catch {}
  }
  return latest;
}

export function eventInvalidatesProof(event: any = {}) {
  if (event?.proof_invalidating === false) return false;
  const type = String(event?.type || '').trim();
  if (/^triwiki\.agents_md_project(?:ed|_failed)$/.test(type)) return false;
  if (/^pipeline\.compliance_loop_guard(?:\..+)?$/.test(type)) return false;
  if (/^pipeline\.honest_mode\.loopback(?:_resolved)?$/.test(type)) return false;
  return true;
}
