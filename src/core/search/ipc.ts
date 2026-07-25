import { findRustAccelerator, rustAcceleratorProbeForSearch } from './rust-bridge.js';
import { runProcess } from '../fsx.js';
import {
  SEARCH_PROVIDER_SCHEMA,
  SEARCH_SCHEMA_VERSION,
  type SearchBatchRequest,
  type SearchBatchResponse,
  type SearchRequest,
  type SearchResponse
} from './types.js';

export async function tryRustSearch(req: SearchRequest): Promise<SearchResponse | null> {
  const probe = await rustAcceleratorProbeForSearch();
  if (!probe.bin || !probe.compatible) return null;
  const result = await runProcess(probe.bin, ['search', req.mode, '--json'], {
    cwd: req.root,
    input: JSON.stringify(req),
    timeoutMs: req.limits?.timeoutMs ?? 30_000,
    maxOutputBytes: 8 * 1024 * 1024
  }).catch((err: Error) => ({ code: 1, stdout: '', stderr: err.message, timedOut: false, truncated: false }));

  if (result.timedOut) return null;
  if (result.code !== 0 && !result.stdout.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as SearchResponse;
    if (parsed?.schemaVersion !== SEARCH_SCHEMA_VERSION) return null;
    return {
      ...parsed,
      provider: 'sks-rs',
      processSpawns: 1,
      schema: SEARCH_PROVIDER_SCHEMA
    };
  } catch {
    return null;
  }
}

export async function tryRustSearchBatch(batch: SearchBatchRequest): Promise<SearchBatchResponse | null> {
  const probe = await rustAcceleratorProbeForSearch();
  if (!probe.bin || !probe.compatible) return null;
  const result = await runProcess(probe.bin, ['search', 'batch', '--json'], {
    cwd: batch.root,
    input: JSON.stringify(batch),
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1024 * 1024
  }).catch((err: Error) => ({ code: 1, stdout: '', stderr: err.message }));
  if (result.code !== 0 && !String(result.stdout || '').trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout) as SearchBatchResponse;
    if (parsed?.schemaVersion !== SEARCH_SCHEMA_VERSION) return null;
    return { ...parsed, provider: 'sks-rs', processSpawns: 1 };
  } catch {
    return null;
  }
}

export async function rustSearchStatus(): Promise<{ available: boolean; bin: string | null; version: string | null }> {
  const probe = await rustAcceleratorProbeForSearch();
  return {
    available: Boolean(probe.bin && probe.compatible),
    bin: probe.bin,
    version: probe.version || null
  };
}

// Re-export finder for tests
export { findRustAccelerator };
