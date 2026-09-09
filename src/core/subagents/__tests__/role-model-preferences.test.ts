import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareOfficialSubagentMission } from '../official-subagent-preparation.js';
import {
  readRoleModelPreferences,
  resetRoleModelPreference,
  roleModelPreferencesPath,
  roleModelPreferencesStatus,
  setRoleModelPreference
} from '../role-model-preferences.js';

test('role model preferences are owner-only, managed-role scoped, and validate profile syntax', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-role-models-'));
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const env = { HOME: path.join(temp, 'home'), SKS_HOME: path.join(temp, 'sks-home') } as NodeJS.ProcessEnv;

  const invalidProfile: any = await setRoleModelPreference({
    role: 'ui_implementer',
    model: 'gpt-5.6 sol',
    reasoning: 'very high',
    env
  });
  assert.equal(invalidProfile.ok, false);
  assert.ok(invalidProfile.blockers.includes('role_model_profile_invalid'));

  const invalidRole: any = await setRoleModelPreference({
    role: 'made_up_role',
    model: 'gpt-5.6-sol',
    reasoning: 'high',
    env
  });
  assert.equal(invalidRole.ok, false);
  assert.ok(invalidRole.blockers.includes('role_model_role_invalid'));

  const unmanagedProfile: any = await setRoleModelPreference({
    role: 'ui_implementer',
    model: 'gpt-5.6-sol-typo',
    reasoning: 'high',
    env
  });
  assert.equal(unmanagedProfile.ok, false);
  assert.ok(unmanagedProfile.blockers.includes('role_model_astra_required'));

  const set: any = await setRoleModelPreference({
    role: 'ui-implementer',
    model: 'gpt-6-astra',
    reasoning: 'max',
    env,
    now: () => '2026-07-22T00:00:00.000Z'
  });
  assert.equal(set.ok, true);
  assert.equal(set.role, 'ui_implementer');
  assert.equal(set.provider, 'openai');
  const filePath = roleModelPreferencesPath(env);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(filePath))).mode & 0o777, 0o700);

  const status = await roleModelPreferencesStatus({ env });
  const ui = status.roles.find((row) => row.role === 'ui_implementer');
  assert.equal(ui?.effective_provider, 'openai');
  assert.equal(ui?.effective_model, 'gpt-6-astra');
  assert.equal(ui?.effective_reasoning_effort, 'max');
  assert.equal(ui?.override?.provider, 'openai');
  assert.equal(ui?.override?.reasoning_effort, 'max');

  const reset = await resetRoleModelPreference({ role: 'ui_implementer', env });
  assert.equal(reset.ok, true);
  const read = await readRoleModelPreferences({ env });
  assert.equal(read.store.roles.ui_implementer, undefined);
});

test('v1 role model preference stores remain readable and migrate on the next write', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-role-models-v1-'));
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const env = { HOME: path.join(temp, 'home'), SKS_HOME: path.join(temp, 'sks-home') } as NodeJS.ProcessEnv;
  const filePath = roleModelPreferencesPath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({
    schema: 'sks.role-model-preferences.v1',
    version: 1,
    updated_at: '2026-07-20T00:00:00.000Z',
    roles: {
      ui_implementer: {
        model: 'gpt-5.6-sol',
        reasoning_effort: 'high',
        updated_at: '2026-07-20T00:00:00.000Z'
      }
    }
  }, null, 2)}\n`);

  const read = await readRoleModelPreferences({ env });
  assert.deepEqual(read.blockers, []);
  assert.equal(read.store.schema, 'sks.role-model-preferences.v2');
  assert.equal(read.store.version, 2);
  assert.deepEqual(read.store.roles.ui_implementer, {
    provider: 'openai',
    model: 'gpt-6-astra',
    reasoning_effort: 'high',
    updated_at: '2026-07-20T00:00:00.000Z'
  });

  const updated: any = await setRoleModelPreference({
    role: 'ui_implementer',
    model: 'gpt-6-astra',
    reasoning: 'max',
    env,
    now: () => '2026-07-23T00:00:00.000Z'
  });
  assert.equal(updated.ok, true);
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(persisted.schema, 'sks.role-model-preferences.v2');
  assert.equal(persisted.version, 2);
  assert.equal(persisted.roles.ui_implementer.provider, 'openai');
  assert.equal(persisted.roles.ui_implementer.reasoning_effort, 'max');
});

for (const version of [1, 2]) {
  test(`v${version} stored legacy and routed profiles migrate to Astra in memory without changing disk`, async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-role-model-migration-'));
    t.after(async () => fs.rm(temp, { recursive: true, force: true }));
    const env = { HOME: path.join(temp, 'home'), SKS_HOME: path.join(temp, 'sks-home') } as NodeJS.ProcessEnv;
    const filePath = roleModelPreferencesPath(env);
    const profiles = {
      ui_implementer: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
      expert: { provider: ' OpenAI ', model: 'gpt-5.6-sol', reasoning_effort: 'max' },
      explorer: { provider: 'openai', model: 'gpt-5.6-terra', reasoning_effort: 'max' },
      worker: { provider: 'openai', model: 'gpt-5.6-luna', reasoning_effort: 'max' },
      debugger: { provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'medium' },
      docs_maintainer: { provider: 'openai', model: 'gpt-5.6-terra', reasoning_effort: 'high' },
      security_reviewer: { provider: 'customer-gateway', model: 'gpt-5.6-sol', reasoning_effort: 'max' },
      research_reviewer: { provider: 'openrouter', model: 'openai/gpt-5.6-sol', reasoning_effort: 'max' },
      test_engineer: { provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'very high' }
    };
    const source = JSON.stringify({
      schema: `sks.role-model-preferences.v${version}`,
      version,
      updated_at: '2026-09-05T00:00:00.000Z',
      roles: profiles
    }, null, 2);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, source);
    const read = await readRoleModelPreferences({ env });
    assert.deepEqual(read.blockers, ['role_model_preference_invalid_profile:test_engineer']);
    assert.ok(read.store.roles.ui_implementer);
    assert.ok(read.store.roles.expert);
    assert.ok(read.store.roles.explorer);
    assert.deepEqual([read.store.roles.ui_implementer.model, read.store.roles.ui_implementer.reasoning_effort], ['gpt-6-astra', 'high']);
    assert.deepEqual([read.store.roles.expert.provider, read.store.roles.expert.model, read.store.roles.expert.reasoning_effort], ['openai', 'gpt-6-astra', 'max']);
    assert.deepEqual([read.store.roles.explorer.model, read.store.roles.explorer.reasoning_effort], ['gpt-6-astra', 'medium']);
    const migratedEfforts = { worker: 'low', debugger: 'max', docs_maintainer: 'medium', security_reviewer: 'max', research_reviewer: 'max' };
    for (const role of Object.keys(migratedEfforts) as (keyof typeof migratedEfforts)[]) {
      assert.deepEqual(read.store.roles[role], {
        provider: 'openai', model: 'gpt-6-astra', reasoning_effort: migratedEfforts[role], updated_at: '2026-09-05T00:00:00.000Z'
      });
    }
    assert.equal(read.store.roles.test_engineer, undefined);
    const status = await roleModelPreferencesStatus({ env });
    const explorer = status.roles.find((role) => role.role === 'explorer');
    assert.equal(explorer?.effective_model, 'gpt-6-astra');
    assert.equal(explorer?.effective_reasoning_effort, 'medium');
    assert.equal(await fs.readFile(filePath, 'utf8'), source);
  });
}

test('a routed parent catalog cannot offer or save non-Astra child models', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-role-models-catalog-'));
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const catalogPath = path.join(codexHome, 'opencodex-catalog.json');
  const env = { HOME: home, CODEX_HOME: codexHome, SKS_HOME: path.join(temp, 'sks-home') } as NodeJS.ProcessEnv;
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(catalogPath, JSON.stringify({
    models: [catalogModel('anthropic/claude-sonnet', 'Claude Sonnet', ['medium', 'high'], { provider: 'Anthropic' })]
  }), { mode: 0o600 });
  const parentConfig = [
    'model_provider = "sks-router"',
    'model = "anthropic/claude-sonnet"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    ''
  ].join('\n');
  await fs.writeFile(configPath, parentConfig);

  const rejected = await setRoleModelPreference({
    role: 'ui_implementer', provider: 'anthropic', model: 'anthropic/claude-sonnet', reasoning: 'high', env
  });
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.blockers, ['role_model_astra_required']);
  await assert.rejects(fs.access(roleModelPreferencesPath(env)), { code: 'ENOENT' });

  const status = await roleModelPreferencesStatus({ env });
  assert.equal(status.catalog.ok, true);
  assert.equal(status.routing.selected_model, 'anthropic/claude-sonnet');
  assert.equal(status.routing.active_main_model_inherited, false);
  assert.ok(status.supported_profiles.every((profile) => profile.model === 'gpt-6-astra' && profile.provider === 'openai'));
  assert.deepEqual(status.supported_profiles.map((profile) => profile.reasoning_effort).sort(), ['high', 'low', 'max', 'medium']);
  assert.ok(status.roles.every((role) => role.effective_model === 'gpt-6-astra'));

  const providerMismatch = await setRoleModelPreference({
    role: 'ui_implementer', provider: 'google', model: 'gpt-6-astra', reasoning: 'high', env
  });
  assert.deepEqual(providerMismatch.blockers, ['role_model_provider_mismatch']);
  const invalidProvider = await setRoleModelPreference({
    role: 'ui_implementer', provider: 'anthropic/router', model: 'gpt-6-astra', reasoning: 'high', env
  });
  assert.deepEqual(invalidProvider.blockers, ['role_model_provider_invalid']);
  const unsupportedEffort = await setRoleModelPreference({
    role: 'ui_implementer', model: 'gpt-6-astra', reasoning: 'xhigh', env
  });
  assert.deepEqual(unsupportedEffort.blockers, ['role_model_profile_not_managed']);
  const accepted = await setRoleModelPreference({ role: 'worker', model: 'gpt-6-astra', reasoning: 'low', env });
  assert.equal(accepted.ok, true);
  assert.equal(await fs.readFile(configPath, 'utf8'), parentConfig);
});

test('official subagent preparation normalizes legacy role overrides in the plan and spawn contract', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-role-model-plan-'));
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const dir = path.join(root, '.sneakoscope', 'missions', 'M-role-model');
  const env = { HOME: path.join(temp, 'home'), SKS_HOME: path.join(temp, 'sks-home') } as NodeJS.ProcessEnv;
  await fs.mkdir(dir, { recursive: true });
  const preferencePath = roleModelPreferencesPath(env);
  const legacySource = JSON.stringify({
    schema: 'sks.role-model-preferences.v2',
    version: 2,
    roles: { ui_implementer: { provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'max' } }
  });
  await fs.mkdir(path.dirname(preferencePath), { recursive: true });
  await fs.writeFile(preferencePath, legacySource);

  const prepared = await prepareOfficialSubagentMission({
    root,
    dir,
    missionId: 'M-role-model',
    goal: 'Implement the provider control center UI interaction',
    route: '$Naruto',
    mode: 'naruto',
    env,
    slices: [{
      id: 'ui',
      title: 'Provider UI',
      description: 'Implement provider page UI and accessibility behavior',
      kind: 'worker',
      agent: 'ui_implementer',
      paths: ['native/provider-ui']
    }]
  });
  const routed = prepared.plan.agents.ui_implementer;
  assert.equal(await fs.readFile(preferencePath, 'utf8'), legacySource);
  assert.equal(routed.routed_provider, 'openai');
  assert.equal(routed.routed_model, 'gpt-6-astra');
  assert.equal(routed.routed_model_reasoning_effort, 'high');
  assert.equal(routed.routed_model_policy, 'user_role_model_preference');
  assert.equal(routed.routing_dynamic, false);
  assert.equal(prepared.plan.role_model_preferences.overrides.ui_implementer.reasoning_effort, 'high');
  assert.match(prepared.delegationPrompt, /pass model="gpt-6-astra" and reasoning_effort="high" from the sealed role policy/);
  assert.match(prepared.delegationPrompt, /every child uses the exact model slug gpt-6-astra/);
  assert.match(prepared.delegationPrompt, /must use `fork_turns="none"` or a positive bounded turn count, with the complete bounded slice contract in `message`/);
});

test('app-session third-party parent stays selected while all children use Astra', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-role-model-main-inheritance-'));
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const dir = path.join(root, '.sneakoscope', 'missions', 'M-main-model');
  const home = path.join(temp, 'home');
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    SKS_HOME: path.join(temp, 'sks-home')
  } as NodeJS.ProcessEnv;
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(configPath, [
    'model_provider = "openrouter"',
    'model = "moonshotai/kimi-k3"',
    ''
  ].join('\n'));

  const status = await roleModelPreferencesStatus({ env, home, configPath });
  const ui = status.roles.find((row) => row.role === 'ui_implementer');
  assert.equal(status.routing.active_main_model_inherited, false);
  assert.equal(ui?.override, null);
  assert.equal(ui?.effective_provider, 'openai');
  assert.equal(ui?.effective_model, 'gpt-6-astra');
  assert.equal(ui?.effective_reasoning_effort, 'high');
  assert.equal(ui?.effective_source, 'managed-default');

  const prepared = await prepareOfficialSubagentMission({
    root,
    dir,
    missionId: 'M-main-model',
    goal: 'Implement the provider UI',
    route: '$Naruto',
    mode: 'naruto',
    sessionScope: 'codex-app-thread',
    env,
    slices: [{
      id: 'ui',
      title: 'Provider UI',
      description: 'Implement provider UI',
      kind: 'worker',
      agent: 'ui_implementer',
      paths: ['native/provider-ui']
    }]
  });
  const routed = prepared.plan.agents.ui_implementer;
  assert.equal(routed.routed_provider, 'openai');
  assert.equal(routed.routed_model, 'gpt-6-astra');
  assert.equal(routed.routed_model_reasoning_effort, 'high');
  assert.equal(routed.routed_model_policy, 'sol_high_implementation');
  assert.equal(routed.role_model_preference_source, 'managed-default');
  assert.equal(prepared.plan.role_model_preferences.routing.active_main_model_inherited, false);
  assert.match(prepared.delegationPrompt, /keep the current app-selected main model openrouter:moonshotai\/kimi-k3/);
  assert.match(prepared.delegationPrompt, /pass model="gpt-6-astra" and reasoning_effort="high" from the sealed role policy/);

  const parentRequiredDir = path.join(root, '.sneakoscope', 'missions', 'M-main-model-parent-required');
  await fs.mkdir(parentRequiredDir, { recursive: true });
  const parentRequired = await prepareOfficialSubagentMission({
    root,
    dir: parentRequiredDir,
    missionId: 'M-main-model-parent-required',
    goal: 'Implement the provider UI',
    route: '$Naruto',
    mode: 'naruto',
    sessionScope: 'codex-app-thread',
    env,
    slices: []
  });
  assert.equal(parentRequired.plan.decomposition_status, 'parent_required');
  assert.match(parentRequired.delegationPrompt, /every child uses the exact model slug gpt-6-astra/);
  assert.match(parentRequired.delegationPrompt, /keep the current app-selected main model openrouter:moonshotai\/kimi-k3/);
});

for (const mainModel of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
test(`${mainModel} app-session main keeps sealed Astra child role profiles`, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-role-model-sol-sealed-'));
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const dir = path.join(root, '.sneakoscope', 'missions', 'M-sol-main');
  const home = path.join(temp, 'home');
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    SKS_HOME: path.join(temp, 'sks-home')
  } as NodeJS.ProcessEnv;
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(configPath, [
    'model_provider = "openai"',
    `model = "${mainModel}"`,
    ''
  ].join('\n'));

  const status = await roleModelPreferencesStatus({ env, home, configPath });
  const explorer = status.roles.find((row) => row.role === 'explorer');
  const worker = status.roles.find((row) => row.role === 'worker');
  assert.equal(status.routing.active_main_model_inherited, false);
  assert.equal(explorer?.effective_model, 'gpt-6-astra');
  assert.equal(explorer?.effective_reasoning_effort, 'medium');
  assert.equal(explorer?.effective_source, 'managed-default');
  assert.equal(worker?.effective_model, 'gpt-6-astra');
  assert.equal(worker?.effective_reasoning_effort, 'low');

  const prepared = await prepareOfficialSubagentMission({
    root,
    dir,
    missionId: 'M-sol-main',
    goal: 'Search broadly then apply a tiny rename',
    route: '$Naruto',
    mode: 'naruto',
    sessionScope: 'codex-app-thread',
    env,
    slices: [
      {
        id: 'search',
        title: 'Repository search',
        description: 'Large repository-wide search for callers',
        kind: 'worker',
        agent: 'explorer',
        paths: ['src'],
        readOnly: true
      },
      {
        id: 'rename',
        title: 'Tiny rename',
        description: 'Exact one-line single-file rename',
        kind: 'worker',
        agent: 'worker',
        paths: ['src/a.ts']
      }
    ]
  });
  assert.equal(prepared.plan.agents.explorer.routed_model, 'gpt-6-astra');
  assert.equal(prepared.plan.agents.explorer.routed_model_reasoning_effort, 'medium');
  assert.equal(prepared.plan.agents.explorer.routed_model_policy, 'terra_max_context_tools');
  assert.equal(prepared.plan.agents.worker.routed_model, 'gpt-6-astra');
  assert.equal(prepared.plan.agents.worker.routed_model_reasoning_effort, 'low');
  assert.equal(prepared.plan.agents.worker.routed_model_policy, 'luna_max_mechanical');
  assert.equal(prepared.plan.role_model_preferences.routing.active_main_model_inherited, false);
  assert.match(prepared.delegationPrompt, /every child uses the exact model slug gpt-6-astra/);
  assert.equal(prepared.delegationPrompt.includes(`pass the exact active main model="${mainModel}"`), false);
});

}

test('unconfigured roles spawn with sealed role model policy instead of omitting overrides', () => {
  const prompt = (async () => {
    const { buildOfficialSubagentPrompt } = await import('../official-subagent-prompt.js');
    return buildOfficialSubagentPrompt({
      goal: 'Implement provider UI',
      maxThreads: 2,
      slices: [{
        id: 'ui',
        title: 'Provider UI',
        description: 'Implement provider UI',
        kind: 'worker',
        agent: 'ui_implementer',
        paths: ['native/provider-ui']
      }]
    });
  })();
  return prompt.then((value) => {
    assert.match(value, /pass model="gpt-6-astra" and reasoning_effort="high" from the sealed role policy/);
    assert.match(value, /every child uses the exact model slug gpt-6-astra/);
    assert.match(value, /must use `fork_turns="none"` or a positive bounded turn count, with the complete bounded slice contract in `message`/);
  });
});

function catalogModel(
  slug: string,
  displayName: string,
  efforts: string[],
  extra: Record<string, unknown> = {}
) {
  return {
    slug,
    display_name: displayName,
    description: `${displayName} routed model`,
    default_reasoning_level: efforts[0] || null,
    supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    base_instructions: 'Follow the active SKS role contract.',
    supports_reasoning_summaries: true,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    multi_agent_version: 'v2',
    ...extra
  };
}
