import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installSkills } from '../../dist/core/init.js';
import {
  DOLLAR_COMMANDS,
  DOLLAR_COMMAND_ALIASES,
  DOLLAR_SKILL_NAMES,
  explicitManagedSkillNames,
  routeByDollarCommand
} from '../../dist/core/routes.js';
import {
  DOLLAR_COMMANDS_LITE,
  DOLLAR_COMMAND_ALIASES_LITE
} from '../../dist/core/routes/dollar-manifest-lite.js';

const RETIRED_PICKER_ALIASES = [
  'sks-ux-review',
  'sks-visual-review',
  'sks-ui-ux-review'
];

test('Image UX Review installs one picker skill and keeps retired aliases as internal routes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-image-ux-skill-consolidation-'));
  try {
    for (const name of RETIRED_PICKER_ALIASES) {
      const dir = path.join(root, '.agents', 'skills', name);
      await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        'description: $Image-UX-Review/$UX-Review imagegen/gpt-image-2 annotated UI/UX review loop.',
        '---',
        '',
        '<!-- BEGIN SKS MANAGED SKILL v7.3.0 name=' + name + ' -->',
        ''
      ].join('\n'));
      await fs.writeFile(path.join(dir, 'agents', 'openai.yaml'), `name: ${name}\n`);
    }

    const result = await installSkills(root);
    const installed = new Set(result.installed_skills);

    assert.ok(installed.has('sks-image-ux-review'));
    assert.ok(DOLLAR_SKILL_NAMES.includes('sks-image-ux-review'));
    for (const name of RETIRED_PICKER_ALIASES) {
      assert.equal(installed.has(name), false, name);
      assert.equal(DOLLAR_SKILL_NAMES.includes(name), false, name);
      await assert.rejects(fs.access(path.join(root, '.agents', 'skills', name)));
    }

    for (const alias of ['ux-review', 'sks-ux-review', 'visual-review', 'sks-visual-review', 'ui-ux-review', 'sks-ui-ux-review']) {
      assert.equal(routeByDollarCommand(alias)?.id, 'ImageUXReview', alias);
      assert.deepEqual(explicitManagedSkillNames(`$${alias} inspect this screen`), ['sks-image-ux-review'], alias);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the lite manifest and dollar-commands output expose only the canonical UX Review picker', () => {
  const fullCommands = DOLLAR_COMMANDS.map((entry) => entry.command);
  const fullAliases = DOLLAR_COMMAND_ALIASES.map((entry) => entry.app_skill);
  const commands = DOLLAR_COMMANDS_LITE.map((entry) => entry.command);
  const aliases = DOLLAR_COMMAND_ALIASES_LITE.map((entry) => entry.app_skill);
  assert.ok(fullCommands.includes('$sks-image-ux-review'));
  assert.ok(fullAliases.includes('$sks-image-ux-review'));
  assert.ok(commands.includes('$sks-image-ux-review'));
  assert.ok(aliases.includes('$sks-image-ux-review'));
  for (const retired of ['$sks-ux-review', '$sks-visual-review', '$sks-ui-ux-review']) {
    assert.equal(fullCommands.includes(retired), false, retired);
    assert.equal(fullAliases.includes(retired), false, retired);
    assert.equal(commands.includes(retired), false, retired);
    assert.equal(aliases.includes(retired), false, retired);
  }

  const run = spawnSync(process.execPath, ['dist/bin/sks.js', 'dollar-commands', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  const serialized = JSON.stringify(output);
  assert.match(serialized, /\$sks-image-ux-review/);
  assert.doesNotMatch(serialized, /\$sks-(?:ux-review|visual-review|ui-ux-review)"/);
});

test('retired alias cleanup preserves markerless user-owned skill content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-image-ux-user-alias-'));
  const aliasDir = path.join(root, '.agents', 'skills', 'sks-ux-review');
  const skillText = '---\nname: sks-ux-review\n---\n\nUser-authored workflow; keep this content.\n';
  try {
    await fs.mkdir(aliasDir, { recursive: true });
    await fs.writeFile(path.join(aliasDir, 'SKILL.md'), skillText);
    await fs.writeFile(path.join(aliasDir, 'USER-NOTES.md'), 'keep these notes\n');
    await installSkills(root);
    assert.equal(await fs.readFile(path.join(aliasDir, 'SKILL.md'), 'utf8'), skillText);
    assert.equal(await fs.readFile(path.join(aliasDir, 'USER-NOTES.md'), 'utf8'), 'keep these notes\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
