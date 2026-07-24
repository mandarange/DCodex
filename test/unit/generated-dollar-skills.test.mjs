import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installSkills } from '../../dist/core/init.js';
import { DOLLAR_SKILL_NAMES } from '../../dist/core/routes.js';

test('generated Codex App skills cover every dollar route skill name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-dollar-skills-'));
  const result = await installSkills(root);
  const installed = new Set(result.installed_skills);

  for (const retired of ['team', 'sks-team']) {
    assert.equal(installed.has(retired), false, `retired generated skill survived: ${retired}`);
    await assert.rejects(fs.access(path.join(root, '.agents', 'skills', retired)));
  }

  for (const name of installed) {
    assert.ok(name === 'sks' || name.startsWith('sks-'), `unprefixed SKS-generated picker skill: ${name}`);
  }

  for (const name of DOLLAR_SKILL_NAMES) {
    assert.ok(name === 'sks' || name.startsWith('sks-'), `unprefixed generated dollar skill: ${name}`);
    assert.ok(installed.has(name), `missing generated skill template for ${name}`);
    const skillPath = path.join(root, '.agents', 'skills', name, 'SKILL.md');
    const stat = await fs.stat(skillPath);
    assert.equal(stat.isFile(), true, `missing SKILL.md for ${name}`);
  }
});

test('generated imagegen skills preserve ChatGPT Images 2.0 evidence policy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-skills-'));
  const result = await installSkills(root);
  const installed = new Set(result.installed_skills);

  assert.ok(installed.has('sks-imagegen'));
  assert.ok(installed.has('sks-imagegen-source-scout'));

  const imagegen = await fs.readFile(path.join(root, '.agents', 'skills', 'sks-imagegen', 'SKILL.md'), 'utf8');
  assert.match(imagegen, /ChatGPT Images 2\.0 \/ GPT Image 2\.0 with gpt-image-2/);
  assert.match(imagegen, /Capability detection is not output proof/);
  assert.match(imagegen, /Direct OpenAI API fallback is non-Codex evidence/);
  assert.match(imagegen, /Official OpenAI\/Codex docs are authoritative/);
  assert.match(imagegen, /\$imagegen\b/, 'the official Codex App $imagegen command must remain visible');

  const scout = await fs.readFile(path.join(root, '.agents', 'skills', 'sks-imagegen-source-scout', 'SKILL.md'), 'utf8');
  assert.match(scout, /Source order: official OpenAI announcement/);
  assert.match(scout, /X\/social\/community search/);
  assert.match(scout, /prompt-quality heuristics only/);
  assert.match(scout, /Do not generate images itself/);
});

test('generated QA and Computer Use skills use Chrome Extension first for web verification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-web-verification-skills-'));
  await installSkills(root);

  const qaLoop = await fs.readFile(path.join(root, '.agents', 'skills', 'sks-qa-loop', 'SKILL.md'), 'utf8');
  assert.match(qaLoop, /Codex Chrome Extension-first web UI evidence/);
  assert.match(qaLoop, /rapidly halt/);
  assert.match(qaLoop, /Computer Use is reserved for native Mac\/non-web surfaces/);

  const cu = await fs.readFile(path.join(root, '.agents', 'skills', 'sks-cu', 'SKILL.md'), 'utf8');
  assert.match(cu, /native macOS, desktop-app, OS-settings, and non-web visual tasks/);
  assert.match(cu, /Web\/browser\/webapp verification must use Codex Chrome Extension first/);

  const ux = await fs.readFile(path.join(root, '.agents', 'skills', 'sks-ux-review', 'SKILL.md'), 'utf8');
  assert.match(ux, /web\/browser\/webapp capture must pass the Codex Chrome Extension readiness gate first/);
});

test('generated DB skill uses route-owned safety artifacts and never revives sks db', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-db-route-skill-'));
  await installSkills(root);

  const db = await fs.readFile(path.join(root, '.agents', 'skills', 'sks-db', 'SKILL.md'), 'utf8');
  assert.match(db, /automatically materializes db-safety-scan\.json and db-review\.json/);
  assert.match(db, /mission-local manual-migration\.sql/);
  assert.match(db, /rollback section that stays commented out/);
  assert.doesNotMatch(db, /sks db/i);
  assert.match(db, /sks mad-sks plan\|sql\|apply-migration/);
});

test('generated Naruto skill keeps official threads lightweight and TriWiki-bounded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-official-skill-'));
  await installSkills(root);

  const naruto = await fs.readFile(path.join(root, '.agents', 'skills', 'sks-naruto', 'SKILL.md'), 'utf8');
  assert.match(naruto, /Automatic targets begin at 4\/6\/8 by task size and may expand to 12/i);
  assert.match(naruto, /max_threads is a cap, never a target/i);
  assert.match(naruto, /later root-owned waves/i);
  assert.match(naruto, /historical Naruto process runtime is removed/i);
  assert.match(naruto, /custom scheduler, or worker pool/i);
  assert.match(naruto, /do not inject the full pack/);
});

test('generated pipeline skills reference the single core directive without legacy global instructions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-core-directive-skills-'));
  await installSkills(root);

  for (const name of ['sks-prompt-pipeline', 'sks-pipeline-runner']) {
    const content = await fs.readFile(path.join(root, '.agents', 'skills', name, 'SKILL.md'), 'utf8');
    assert.equal(content.match(/Core Engineering Directive/g)?.length, 1, name);
    assert.match(content, /from AGENTS\.md exactly/, name);
    assert.doesNotMatch(content, /lean_decision|sks\.lean-decision|sks-lean:/i, name);
  }
});

test('generated Research skill absorbs discovery behavior without a duplicate picker skill', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-research-official-skills-'));
  await installSkills(root);

  const content = await fs.readFile(path.join(root, '.agents', 'skills', 'sks-research', 'SKILL.md'), 'utf8');
  assert.match(content, /Frame the research criteria and map assumptions/i);
  assert.match(content, /three independent official .*research_reviewer/i);
  assert.match(content, /GPT-5\.6 Sol Max/i);
  assert.match(content, /one literal "Eureka!" idea/i);
  assert.match(content, /Do not overclaim genius, novelty, breakthrough, publication acceptance/i);
  assert.doesNotMatch(content, /Feynman Agent|Turing Agent|five-agent|effort=xhigh|repeat agent\/debate/i);
  await assert.rejects(fs.access(path.join(root, '.agents', 'skills', 'sks-research-discovery')));
});
