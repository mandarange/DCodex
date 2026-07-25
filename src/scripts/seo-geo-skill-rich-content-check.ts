#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-seo-geo-skills-'));
const init = await importDist('core/init.js');
await init.installSkills(root);

assertGate(!fs.existsSync(path.join(root, '.agents', 'skills', 'seo-geo', 'SKILL.md')), 'generated skills must not recreate legacy seo-geo alias');

for (const name of ['sks-search-visibility-core', 'sks-seo-geo-optimizer']) {
  const file = path.join(root, '.agents', 'skills', name, 'SKILL.md');
  assertGate(fs.existsSync(file), `generated skill missing: ${name}`);
  const text = fs.readFileSync(file, 'utf8');
  assertGate(/^---\nname:/m.test(text) && /description:/.test(text), `skill frontmatter missing: ${name}`, text);
  for (const token of ['Purpose:', 'Use when', 'Workflow:', 'Safety:', 'Evidence/artifacts:', 'Failure/recovery:']) {
    assertGate(text.includes(token), `skill missing rich token ${token}: ${name}`, text);
  }
  assertGate(/CLI entrypoint:/i.test(text), `skill missing CLI entrypoint: ${name}`, text);
  assertGate(/ranking|citation|traffic|guarantee|보장/i.test(text), `skill must name forbidden guarantee boundary: ${name}`, text);
}

const optimizer = fs.readFileSync(path.join(root, '.agents', 'skills', 'sks-seo-geo-optimizer', 'SKILL.md'), 'utf8');
for (const token of [
  'SEO intent map',
  'canonical URL map',
  'JSON-LD summary',
  'sitemap coverage summary',
  'internal link plan',
  'unsupported claims ledger',
  'llms.txt',
  'Search Console',
  'STOREFRONT_PATH',
  'buildSeoMetadata'
]) {
  assertGate(optimizer.includes(token), `seo-geo-optimizer skill missing CELIMAX architecture token: ${token}`, optimizer);
}

emitGate('seo-geo:skill-rich-content', { skills_checked: 2 });
