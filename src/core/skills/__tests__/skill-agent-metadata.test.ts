import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { installGlobalSkills } from '../../init/skills.js';
import { runSkillDream, skillDreamFixture } from '../../skill-forge.js';
import {
  EXPLICIT_ONLY_SKS_SKILL_NAMES,
  SKILL_DISCOVERY_DESCRIPTION_MAX_CHARS,
  compactSkillDiscoveryDescription,
  isSksGeneratedSkillAgentMetadata,
  renderSkillAgentMetadata,
  skillFrontmatterDescription,
  validateSkillAgentMetadata
} from '../skill-agent-metadata.js';

const UNSUPPORTED_LEGACY_KEYS = /^(?:name|model_reasoning_effort|routing|return_to_default_after_route):/m;

test('renderer emits only the current Codex skill interface schema', () => {
  const rendered = renderSkillAgentMetadata({
    skillName: 'sks-example',
    shortDescription: 'Example: a "quoted" description.'
  });
  const validation = validateSkillAgentMetadata(rendered, { expectedSkillName: 'sks-example' });

  assert.equal(validation.ok, true, validation.issues.join(','));
  assert.deepEqual(validation.metadata, {
    interface: {
      display_name: 'SKS Example',
      short_description: 'Example: a "quoted" description.',
      default_prompt: 'Use $sks-example.'
    },
    policy: {
      allow_implicit_invocation: true
    }
  });
  assert.doesNotMatch(rendered, UNSUPPORTED_LEGACY_KEYS);
  assert.doesNotMatch(rendered, /(?:^|\n)\s*products:/);
  assert.equal(isSksGeneratedSkillAgentMetadata(rendered, 'sks-example'), true);
  assert.deepEqual(
    rendered.split(/\r?\n/).filter((line) => line && !line.startsWith(' ')),
    ['interface:', 'policy:']
  );
});

test('validator accepts current optional metadata and rejects legacy generated metadata', () => {
  const withoutDefaultPrompt = [
    'interface:',
    '  display_name: "SKS Example"',
    '  short_description: "Example skill"',
    '  icon_small: "./assets/example.svg"',
    'dependencies:',
    '  tools:',
    '    - type: "mcp"',
    '      value: "openaiDeveloperDocs"',
    '      description: "Official docs"',
    '      transport: "streamable_http"',
    '      url: "https://developers.openai.com/mcp"',
    ''
  ].join('\n');
  const current = validateSkillAgentMetadata(withoutDefaultPrompt);
  assert.equal(current.ok, true, current.issues.join(','));
  assert.equal(current.metadata?.policy.allow_implicit_invocation, true);
  assert.equal(current.metadata?.dependencies?.tools[0]?.value, 'openaiDeveloperDocs');

  const legacy = [
    'name: sks-example',
    'model_reasoning_effort: high',
    'routing: temporary',
    'return_to_default_after_route: true',
    ''
  ].join('\n');
  assert.equal(validateSkillAgentMetadata(legacy, { expectedSkillName: 'sks-example' }).ok, false);
  assert.equal(isSksGeneratedSkillAgentMetadata(legacy, 'sks-example'), false);
  assert.equal(isSksGeneratedSkillAgentMetadata(legacy, 'sks-example', {
    allowLegacyOwnershipSignature: true
  }), true);
});

test('every installed SKS skill has current metadata and fits the initial-list budget', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-agent-metadata-install-'));
  const home = path.join(fixture, 'home');
  try {
    await fsp.mkdir(home, { recursive: true });
    const install = await installGlobalSkills(home);
    assert.equal(install.ok, true, JSON.stringify(install));
    assert.ok((install.installed_skills?.length || 0) > 0);

    const explicitOnly: string[] = [];
    const descriptionsByName = new Map<string, string>();
    let initialSkillListChars = 0;
    for (const name of install.installed_skills || []) {
      const skillDir = path.join(home, '.agents', 'skills', name);
      const skillText = await fsp.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
      const description = skillFrontmatterDescription(skillText);
      assert.ok(description, `missing frontmatter description:${name}`);
      descriptionsByName.set(name, description);
      assert.ok(
        Array.from(description).length <= SKILL_DISCOVERY_DESCRIPTION_MAX_CHARS,
        `frontmatter description too long:${name}:${Array.from(description).length}`
      );
      initialSkillListChars += Array.from(name).length;
      initialSkillListChars += Array.from(description).length;
      initialSkillListChars += Array.from(`.agents/skills/${name}/SKILL.md`).length;

      const metadataText = await fsp.readFile(path.join(skillDir, 'agents', 'openai.yaml'), 'utf8');
      const validation = validateSkillAgentMetadata(metadataText, { expectedSkillName: name });
      assert.equal(validation.ok, true, `${name}:${validation.issues.join(',')}`);
      assert.equal(validation.metadata?.interface.short_description, description);
      assert.equal(validation.metadata?.interface.default_prompt, `Use $${name}.`);
      assert.doesNotMatch(metadataText, UNSUPPORTED_LEGACY_KEYS);
      assert.deepEqual(
        metadataText.split(/\r?\n/).filter((line) => line && !line.startsWith(' ')),
        ['interface:', 'policy:'],
        name
      );
      if (validation.metadata?.policy.allow_implicit_invocation === false) explicitOnly.push(name);
    }

    assert.deepEqual(explicitOnly.sort(), [...EXPLICIT_ONLY_SKS_SKILL_NAMES].sort());
    assert.equal(
      descriptionsByName.get('sks-answer'),
      'Answer questions with research or docs; never implement.'
    );
    assert.equal(
      descriptionsByName.get('sks-plan'),
      'Write a plan artifact only; never edit product or source files.'
    );
    assert.equal(
      descriptionsByName.get('sks-design-system-builder'),
      'Create design.md only when Product Design is unavailable.'
    );
    assert.ok(
      initialSkillListChars <= 8_000,
      `initial skill list exceeded 8k chars:${initialSkillListChars}`
    );
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('discovery description compaction is deterministic and Unicode-bounded', () => {
  const source = 'Modernize SKS prompts, settings, skills, and commands for current GPT-5.6 and OpenAI guidance without retaining superseded compatibility controls.';
  const compacted = compactSkillDiscoveryDescription(source);
  assert.equal(compacted, compactSkillDiscoveryDescription(source));
  assert.ok(Array.from(compacted).length <= SKILL_DISCOVERY_DESCRIPTION_MAX_CHARS);
  assert.match(compacted, /^Modernize SKS prompts/);
  assert.match(compacted, /…$/);
});

test('skill forge fixtures emit current metadata while old metadata remains recognition-only', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-agent-metadata-forge-'));
  try {
    const result = await skillDreamFixture(fixture);
    assert.equal(result.passed, true);
    for (const name of ['used-generated', 'unused-generated']) {
      const metadataText = await fsp.readFile(
        path.join(fixture, '.agents', 'skills', name, 'agents', 'openai.yaml'),
        'utf8'
      );
      assert.equal(
        validateSkillAgentMetadata(metadataText, { expectedSkillName: name }).ok,
        true,
        name
      );
      assert.doesNotMatch(metadataText, UNSUPPORTED_LEGACY_KEYS);
    }
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('official metadata alone never claims ownership of a user-authored skill', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-agent-metadata-user-owned-'));
  const name = 'user-owned';
  const skillDir = path.join(fixture, '.agents', 'skills', name);
  try {
    await fsp.mkdir(path.join(skillDir, 'agents'), { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: user-owned\ndescription: User-authored skill.\n---\n\nKeep this content.\n',
      'utf8'
    );
    await fsp.writeFile(
      path.join(skillDir, 'agents', 'openai.yaml'),
      renderSkillAgentMetadata({
        skillName: name,
        shortDescription: 'User-authored skill.'
      }),
      'utf8'
    );

    const report: any = await runSkillDream(fixture, { force: true });
    assert.equal(report.inventory.total, 1);
    assert.equal(report.inventory.generated, 0);
    assert.equal(report.inventory.unknown_or_user, 1);
    assert.equal(report.prune_candidates.some((candidate: any) => candidate.name === name), false);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('a partial SKS marker cannot claim ownership of a user-authored skill', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-agent-metadata-marker-decoy-'));
  const name = 'user-marker-decoy';
  const skillDir = path.join(fixture, '.agents', 'skills', name);
  try {
    await fsp.mkdir(path.join(skillDir, 'agents'), { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        'description: User-authored marker example.',
        '---',
        '',
        '<!-- BEGIN SKS MANAGED SKILL copied as documentation only -->',
        '',
        'Keep this content.',
        ''
      ].join('\n'),
      'utf8'
    );
    await fsp.writeFile(
      path.join(skillDir, 'agents', 'openai.yaml'),
      renderSkillAgentMetadata({
        skillName: name,
        shortDescription: 'User-authored marker example.'
      }),
      'utf8'
    );

    const report: any = await runSkillDream(fixture, { force: true });
    assert.equal(report.inventory.generated, 0);
    assert.equal(report.inventory.unknown_or_user, 1);
    assert.equal(report.prune_candidates.some((candidate: any) => candidate.name === name), false);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});
