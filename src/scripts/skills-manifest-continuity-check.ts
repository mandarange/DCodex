#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { installGlobalSkills } from '../core/init/skills.js';

const root = process.cwd();
const manifestPath = path.join(root, 'dist', 'config', 'skills-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const ledger = JSON.parse(fs.readFileSync(
  path.join(root, 'config', 'skills-hash-ledger.v1.json'),
  'utf8'
));
assertGate(manifest.schema === 'sks.skills-manifest.v1', 'skills manifest schema mismatch', manifest);
assertGate(typeof manifest.package_version === 'string' && manifest.package_version, 'skills manifest must record package_version', manifest);
assertGate(Array.isArray(manifest.skills) && manifest.skills.length >= 50, 'skills manifest must include official skill set', { count: manifest.skills?.length });
const names = new Set<string>();
const ledgerByName = new Map<string, Set<string>>();
assertGate(
  ledger.schema === 'sks.skills-hash-ledger.v1' && Array.isArray(ledger.skills),
  'skills hash ledger schema mismatch',
  ledger
);
for (const row of ledger.skills) {
  assertGate(
    /^[a-z0-9-]+$/.test(row.canonical_name)
      && !ledgerByName.has(row.canonical_name)
      && Array.isArray(row.trusted_sha256)
      && row.trusted_sha256.length > 0
      && row.trusted_sha256.every((digest: unknown) => (
        typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
      )),
    `invalid skills hash ledger row:${row.canonical_name}`,
    row
  );
  ledgerByName.set(row.canonical_name, new Set(row.trusted_sha256));
}
for (const skill of manifest.skills) {
  assertGate(/^[a-z0-9-]+$/.test(skill.canonical_name), `invalid skill name:${skill.canonical_name}`, skill);
  assertGate(!names.has(skill.canonical_name), `duplicate skill name:${skill.canonical_name}`, skill);
  names.add(skill.canonical_name);
  assertGate(['core', 'official'].includes(skill.type), `invalid skill type:${skill.canonical_name}`, skill);
  assertGate(typeof skill.content_sha256 === 'string' && /^[a-f0-9]{64}$/.test(skill.content_sha256), `missing content hash:${skill.canonical_name}`, skill);
  assertGate(Array.isArray(skill.hash_history), `hash_history must be array:${skill.canonical_name}`, skill);
  const publishedDigests = new Set([skill.content_sha256, ...skill.hash_history]);
  assertGate(
    ledgerByName.get(skill.canonical_name)?.has(skill.content_sha256) === true,
    `skills hash ledger missing current digest:${skill.canonical_name}`,
    skill
  );
  assertGate(
    [...(ledgerByName.get(skill.canonical_name) || [])].every((digest) => publishedDigests.has(digest)),
    `packaged manifest dropped trusted digest history:${skill.canonical_name}`,
    skill
  );
  assertGate(Array.isArray(skill.deprecated_aliases), `deprecated_aliases must be array:${skill.canonical_name}`, skill);
}
for (const required of ['sks-naruto', 'sks-answer', 'sks-dfix', 'sks-fast-mode', 'sks-honest-mode']) {
  assertGate(names.has(required), `manifest missing required skill:${required}`, manifest);
}
assertGate([...names].every((name) => name === 'sks' || name.startsWith('sks-')), 'packaged manifest must expose only namespaced SKS skills', { names: [...names].filter((name) => name !== 'sks' && !name.startsWith('sks-')) });
assertGate(!Object.hasOwn(manifest, 'removed_skills'), 'current packaged manifest must not publish retired skill names', manifest);

const home = await makeTempRoot('skills-manifest-global-collision-');
await writeText(path.join(home, '.agents', 'skills', 'answer', 'SKILL.md'), '---\nname: answer\ndescription: user global answer\n---\n\nuser-owned global answer.\n');
const install = await installGlobalSkills(home);
const answerExists = fs.existsSync(path.join(home, '.agents', 'skills', 'sks-answer', 'SKILL.md'));
const quarantined = await findFiles(path.join(home, '.sneakoscope', 'quarantine', 'skills', 'answer'), 'SKILL.md');
assertGate(answerExists && quarantined.length === 1, 'global install must quarantine user official-name collision before writing official skill', install);

emitGate('skills:manifest-continuity', {
  skills: manifest.skills.length,
  trusted_digest_rows: ledgerByName.size,
  retired_names_published: 0
});

async function findFiles(dir: string, name: string): Promise<string[]> {
  const rows = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const row of rows) {
    const file = path.join(dir, row.name);
    if (row.isDirectory()) out.push(...await findFiles(file, name));
    else if (row.name === name) out.push(file);
  }
  return out;
}
