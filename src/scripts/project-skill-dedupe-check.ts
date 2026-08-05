#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot } from './skill-fixture-check-lib.js';
import { reconcileSkills } from '../core/init/skills.js';

const root = await makeTempRoot('sks-skill-dedupe-');
process.env.CODEX_HOME = path.join(root, 'codex-home');
// NC-38: sks-loop is removed; leave residue that reconcile --fix must delete.
async function writeRetiredResidue(relSkills: string, name: string) {
  const dir = path.join(root, relSkills, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: retired residue\n---\n\nretired.\n`);
}
await writeRetiredResidue('.agents/skills', 'sks-loop');
await writeRetiredResidue('.codex/skills', 'sks-loop');
await fs.mkdir(path.join(root, '.agents', 'skills', 'quarantine', 'sks-answer'), { recursive: true });
await fs.mkdir(path.join(root, '.agents', 'skills', 'sks-answer'), { recursive: true });
await fs.writeFile(path.join(root, '.agents', 'skills', 'sks-answer', 'SKILL.md'), '---\nname: sks-answer\ndescription: user collision\n---\n\nuser-owned answer.\n');
const report = await reconcileSkills({ targetDir: path.join(root, '.agents', 'skills'), scope: 'project', fix: true });
const agentsSkill = await fs.stat(path.join(root, '.agents', 'skills', 'sks-loop', 'SKILL.md')).then(() => true, () => false);
const codexSkill = await fs.stat(path.join(root, '.codex', 'skills', 'sks-loop', 'SKILL.md')).then(() => true, () => false);
const answerOriginal = await fs.stat(path.join(root, '.agents', 'skills', 'sks-answer', 'SKILL.md')).then(() => true, () => false);
const quarantinedAnswers = await findFiles(path.join(root, '.sneakoscope', 'quarantine', 'skills', 'sks-answer'), 'SKILL.md');
assertGate(report.removed.some((item) => item.endsWith('/sks-loop')), 'project official skill residue must be removed under reconcile --fix', report);
assertGate(!agentsSkill && !codexSkill, 'project official residue must be removed from .agents/skills and .codex/skills', { agentsSkill, codexSkill });
assertGate(!answerOriginal && quarantinedAnswers.length === 1, 'official-name user collision must move to unique quarantine outside skill root without data loss', { answerOriginal, quarantinedAnswers });
emitGate('skill:dedupe', { removed: report.removed.length });

async function findFiles(dir: string, name: string): Promise<string[]> {
  const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const row of rows) {
    const file = path.join(dir, row.name);
    if (row.isDirectory()) out.push(...await findFiles(file, name));
    else if (row.name === name) out.push(file);
  }
  return out;
}
