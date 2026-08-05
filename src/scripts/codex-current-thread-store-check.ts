#!/usr/bin/env node
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate } from './gate-lib.js';
import { readCodexThreadRegistry, recordCodexThread } from '../core/codex-control/codex-thread-registry.js';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-current-thread-store-'));
try {
  await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    await recordCodexThread(tmp, {
      backend: 'app-server-v2',
      thread_id: `thread-${index}`,
      sdk_thread_id: `thread-${index}`,
      session_id: 'session-a',
      work_item_id: `work-${index}`,
      parent_thread_id: index === 0 ? null : 'thread-0',
      recency_at: 1_782_172_800 + index,
      status: 'completed'
    });
  }));
  const registry = await readCodexThreadRegistry(tmp);
  const threads = Array.isArray(registry?.threads) ? registry.threads : [];
  const keys = new Set(threads.map((row: any) => String(row.registry_key || '')));
  const journal = await fsp.readFile(path.join(tmp, 'codex-thread-registry.events.jsonl'), 'utf8');
  const events = journal.trim().split(/\r?\n/).filter(Boolean);
  assertGate(registry?.thread_count === 100, 'thread registry must preserve 100 concurrent writes', registry);
  assertGate(keys.size === 100, 'thread registry keys must remain unique after concurrent writes', { keys: keys.size });
  assertGate(registry?.storage_mode === 'json-with-atomic-lock-and-journal', 'thread registry must use atomic lock storage mode', registry);
  assertGate(registry?.lock_strategy === 'atomic-mkdir', 'thread registry lock strategy must be explicit', registry);
  assertGate(events.length === 100, 'thread registry journal must record every write', { events: events.length });
  assertGate(!await exists(path.join(tmp, 'codex-thread-registry.lock')), 'thread registry lock directory must be released');

  await fsp.writeFile(path.join(tmp, 'codex-thread-registry.json'), '{broken', 'utf8');
  await recordCodexThread(tmp, { thread_id: 'after-corruption', session_id: 'session-b', work_item_id: 'work-corrupt' });
  const repaired = await readCodexThreadRegistry(tmp);
  assertGate(repaired?.corruption?.preserved_path, 'thread registry corruption must be preserved with evidence', repaired);

  emitGate('codex:current:thread-store', {
    concurrent_writes: 100,
    storage_mode: registry.storage_mode,
    corruption_preserved: true
  });
} finally {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}
