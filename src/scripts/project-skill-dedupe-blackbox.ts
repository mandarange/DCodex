#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertGate, emitGate, makeTempRoot, writeText, writeUserSkill } from './skill-fixture-check-lib.js';
import { dedupeProjectSkills } from '../core/codex-native/project-skill-dedupe.js';
import { syncCodexSksSkills, withSkillSyncLock } from '../core/codex-app/codex-skill-sync.js';
import { buildSkillRegistryLedger } from '../core/codex-native/skill-registry-ledger.js';

const removeFixture = fs.rm.bind(fs);

const root = await makeTempRoot('sks-skill-dedupe-blackbox-');
const home = await makeTempRoot('sks-skill-dedupe-home-');
process.env.HOME = home;
process.env.CODEX_HOME = path.join(home, '.codex');
await writeManagedFixture(home, '.agents/skills', 'managed-loop');
await writeManagedFixture(root, '.agents/skills', 'managed-loop');
await writeManagedFixture(root, '.codex/skills', 'managed-loop');
const scenarioA = await dedupeProjectSkills({ root, fix: true, yes: true });
await writeUserSkill(root, '.agents/skills', 'user-loop', 'fixture-loop');
await writeManagedFixture(root, '.codex/skills', 'managed-loop');
const scenarioB = await dedupeProjectSkills({ root, fix: true, yes: true });
await guardedRm(path.join(home, '.agents', 'skills', 'managed-loop'), path.join(home, '.agents', 'skills'));
await writeUserSkill(root, '.agents/skills', 'user-loop-a', 'Fixture Loop');
await writeUserSkill(root, '.codex/skills', 'user-loop-b', 'fixture_loop');
const scenarioC = await dedupeProjectSkills({ root, fix: true, yes: false });
const scenarioD = await dedupeProjectSkills({ root, fix: true, yes: true, quarantineUserDuplicates: true });
const staleRoot = await makeTempRoot('sks-skill-stale-lock-');
const lockPath = path.join(staleRoot, '.sneakoscope', 'locks', 'skill-sync.lock');
await fs.mkdir(lockPath, { recursive: true });
await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ schema: 'sks.skill-sync-lock.v1', pid: 999999, acquired_at: '1970-01-01T00:00:00.000Z', stale_after_ms: 1 }), 'utf8');
await withSkillSyncLock(staleRoot, async () => undefined);
const concurrentRoot = await makeTempRoot('sks-skill-concurrent-');
const concurrentHome = await makeTempRoot('sks-skill-concurrent-home-');
process.env.HOME = concurrentHome;
process.env.CODEX_HOME = path.join(concurrentHome, '.codex');
const skillsRoot = path.join(process.env.CODEX_HOME, 'skills');
await Promise.all(Array.from({ length: 20 }, () => syncCodexSksSkills({ root: concurrentRoot, apply: true, skillsRoot })));
const concurrentLedger = await buildSkillRegistryLedger({ root: concurrentRoot });
assertGate(scenarioA.actions.some((action) => action.action === 'quarantined'), 'scenario A must quarantine SKS-managed duplicate', scenarioA);
assertGate(scenarioB.actions.some((action) => action.reason.includes('user-authored skill preserved')), 'scenario B must preserve user-authored skill', scenarioB);
assertGate(scenarioC.blockers.some((blocker) => blocker.includes('user_duplicate_requires_confirmation')), 'scenario C must not auto-delete user-authored duplicates', scenarioC);
assertGate(scenarioD.active_unique_by_canonical_name === true, 'scenario D must quarantine confirmed user-authored duplicate', scenarioD);
assertGate(concurrentLedger.active_unique_by_canonical_name === true, 'scenario F must keep exactly one active canonical name after concurrent sync', concurrentLedger);
emitGate('skill:dedupe-blackbox');

async function writeManagedFixture(root: string, relRoot: string, dirName: string): Promise<void> {
  await writeText(path.join(root, relRoot, dirName, 'SKILL.md'), [
    '---',
    'name: fixture-loop',
    'description: managed fixture',
    '---',
    '',
    '<!-- BEGIN SKS MANAGED SKILL v-test name=fixture-loop -->',
    ''
  ].join('\n'));
}

async function guardedRm(target: string, allowedRoot: string): Promise<void> {
  const root = path.resolve(allowedRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('refusing_to_remove_unscoped_skill_fixture');
  }
  await removeFixture(resolved, { recursive: true, force: true });
}
