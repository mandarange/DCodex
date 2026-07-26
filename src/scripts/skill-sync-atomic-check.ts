#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertGate, emitGate, makeTempRoot } from './skill-fixture-check-lib.js';
import { syncCodexSksSkills, withSkillSyncLock } from '../core/codex-app/codex-skill-sync.js';
import { buildSkillRegistryLedger } from '../core/codex-native/skill-registry-ledger.js';

const root = await makeTempRoot('sks-skill-atomic-');
process.env.CODEX_HOME = path.join(root, 'codex-home');
const skillsRoot = path.join(process.env.CODEX_HOME, 'skills');
const lockPath = path.join(root, '.sneakoscope', 'locks', 'skill-sync.lock');
await fs.mkdir(lockPath, { recursive: true });
await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ schema: 'sks.skill-sync-lock.v1', pid: 999999, acquired_at: '1970-01-01T00:00:00.000Z', stale_after_ms: 1 }), 'utf8');
await withSkillSyncLock(root, async () => undefined);
await fs.mkdir(lockPath, { recursive: true });
await fs.writeFile(path.join(lockPath, 'owner.json'), 'not-json', 'utf8');
const staleTime = new Date(Date.now() - 60_000);
await fs.utimes(lockPath, staleTime, staleTime);
await withSkillSyncLock(root, async () => undefined);
const releaseProbe = { released: false };
try {
  await withSkillSyncLock(root, async () => {
    throw new Error('fixture lock body failure');
  });
} catch {
  await withSkillSyncLock(root, async () => {
    releaseProbe.released = true;
  });
}
await Promise.all(Array.from({ length: 20 }, () => syncCodexSksSkills({ root, apply: true, skillsRoot })));
const ledger = await buildSkillRegistryLedger({ root });
assertGate(releaseProbe.released === true, 'lock must be released after callback throws');
assertGate(ledger.active_unique_by_canonical_name === true, 'concurrent sync must not create duplicate active skill names', ledger);
emitGate('skill:sync-atomic', { entries: ledger.entries.length });
