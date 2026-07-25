#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText, writeUserSkill } from './skill-fixture-check-lib.js';
import { syncCoreSkillsIntegrity } from '../core/codex-native/core-skill-integrity.js';
import { buildSksCoreSkillManifest, renderCoreSkillTemplate } from '../core/codex-native/core-skill-manifest.js';
import { sha256 } from '../core/fsx.js';

const root = await makeTempRoot('sks-core-no-drift-');
const skillsRoot = path.join(root, '.agents', 'skills');
const manifest = buildSksCoreSkillManifest('1970-01-01T00:00:00.000Z');
await syncCoreSkillsIntegrity({ root, apply: true, skillsRoot });
for (const skill of manifest.skills) {
  const text = await fs.readFile(path.join(skillsRoot, skill.canonical_name, 'SKILL.md'), 'utf8');
  assertGate(sha256(text) === skill.content_sha256, `rendered core skill drifted: ${skill.canonical_name}`, skill);
}
await writeText(path.join(skillsRoot, 'sks-qa-loop', 'SKILL.md'), `${renderCoreSkillTemplate('qa-loop')}\n# drift\n`);
const restored = await syncCoreSkillsIntegrity({ root, apply: true, skillsRoot });
assertGate(restored.restored.length === 1, 'managed drift must be restored', restored);
const userRoot = path.join(root, 'user-skills');
await writeUserSkill(root, 'user-skills', 'sks-loop', 'sks-loop');
const user = await syncCoreSkillsIntegrity({ root, apply: true, skillsRoot: userRoot });
assertGate(user.skipped_user_authored.length === 1, 'user-authored same-name core skill must be preserved', user);
emitGate('core-skill:no-drift', { skills: manifest.skills.length });
