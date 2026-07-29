import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileFreshness, lastJsonlEventTime } from '../../dist/core/evidence/evidence-freshness.js';

test('evidence freshness marks files older than the last route event as stale', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-evidence-freshness-'));
  const file = path.join(root, 'artifact.json');
  const events = path.join(root, 'events.jsonl');
  await fs.writeFile(file, '{}\n');
  await fs.utimes(file, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  await fs.writeFile(events, `${JSON.stringify({ ts: '2026-01-02T00:00:00Z', type: 'route.event' })}\n`);
  const cutoff = await lastJsonlEventTime(events);
  const result = await fileFreshness(file, { staleAfter: cutoff });
  assert.equal(result.freshness, 'stale');
  assert.ok(result.issues.includes('stale'));
});

test('proof freshness ignores stop-hook diagnostics and project-memory projection events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-evidence-stop-events-'));
  const events = path.join(root, 'events.jsonl');
  await fs.writeFile(events, [
    { ts: '2026-01-02T00:00:00Z', type: 'route.event' },
    { ts: '2026-01-02T00:01:00Z', type: 'triwiki.agents_md_projected' },
    { ts: '2026-01-02T00:02:00Z', type: 'pipeline.compliance_loop_guard' },
    { ts: '2026-01-02T00:03:00Z', type: 'pipeline.honest_mode.loopback' },
    { ts: '2026-01-02T00:04:00Z', type: 'diagnostic.custom', proof_invalidating: false }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');

  assert.equal(await lastJsonlEventTime(events), Date.parse('2026-01-02T00:00:00Z'));
});
