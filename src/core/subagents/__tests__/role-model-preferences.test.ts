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
  assert.ok(unmanagedProfile.blockers.includes('role_model_profile_not_managed'));

  const set: any = await setRoleModelPreference({
    role: 'ui-implementer',
    model: 'gpt-5.6-sol',
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
  assert.equal(ui?.effective_model, 'gpt-5.6-sol');
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
    model: 'gpt-5.6-sol',
    reasoning_effort: 'high',
    updated_at: '2026-07-20T00:00:00.000Z'
  });

  const updated: any = await setRoleModelPreference({
    role: 'ui_implementer',
    model: 'gpt-5.6-sol',
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

test('catalog-backed provider slugs accept advertised reasoning efforts and reject mismatches', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-role-models-catalog-'));
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const catalogPath = path.join(codexHome, 'opencodex-catalog.json');
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    SKS_HOME: path.join(temp, 'sks-home')
  } as NodeJS.ProcessEnv;
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(catalogPath, `${JSON.stringify({
    models: [catalogModel('anthropic/claude-sonnet', 'Claude Sonnet', ['medium', 'high'], {
      provider: 'Anthropic',
      supported_reasoning_levels: [
        { effort: 'medium', description: 'medium' },
        { effort: 'high', description: 'high' }
      ],
      default_reasoning_level: 'high'
    })]
  })}\n`, { mode: 0o600 });
  await fs.writeFile(configPath, [
    'model_provider = "sks-router"',
    'model = "anthropic/claude-sonnet"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    ''
  ].join('\n'));

  const accepted: any = await setRoleModelPreference({
    role: 'ui_implementer',
    provider: 'ANTHROPIC',
    model: 'anthropic/claude-sonnet',
    reasoning: 'HIGH',
    env,
    home,
    configPath
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.provider, 'anthropic');
  assert.equal(accepted.model, 'anthropic/claude-sonnet');
  assert.equal(accepted.reasoning_effort, 'high');
  assert.equal(accepted.catalog_verified, true);
  assert.equal(accepted.selected_model_provider, 'sks-router');
  assert.equal(accepted.multi_agent_version, 'v2');
  assert.equal(accepted.runtime_verified, false);

  const status = await roleModelPreferencesStatus({ env, home, configPath });
  assert.deepEqual(
    status.supported_profiles
      .filter((profile) => profile.model === 'anthropic/claude-sonnet')
      .map((profile) => [profile.provider, profile.reasoning_effort, profile.source]),
    [
      ['anthropic', 'medium', 'codex-model-catalog'],
      ['anthropic', 'high', 'codex-model-catalog']
    ]
  );
  const ui = status.roles.find((row) => row.role === 'ui_implementer');
  assert.equal(ui?.effective_provider, 'anthropic');
  assert.equal(ui?.effective_model, 'anthropic/claude-sonnet');
  assert.equal(ui?.effective_reasoning_effort, 'high');

  const providerMismatch: any = await setRoleModelPreference({
    role: 'ui_implementer',
    provider: 'google',
    model: 'anthropic/claude-sonnet',
    reasoning: 'high',
    env,
    home,
    configPath
  });
  assert.equal(providerMismatch.ok, false);
  assert.ok(providerMismatch.blockers.includes('role_model_provider_mismatch'));

  const missingSlug: any = await setRoleModelPreference({
    role: 'ui_implementer',
    model: 'google/gemini-pro',
    reasoning: 'high',
    env,
    home,
    configPath
  });
  assert.equal(missingSlug.ok, false);
  assert.ok(missingSlug.blockers.includes('role_model_not_in_active_catalog'));

  const unsupportedReasoning: any = await setRoleModelPreference({
    role: 'ui_implementer',
    provider: 'anthropic',
    model: 'anthropic/claude-sonnet',
    reasoning: 'low',
    env,
    home,
    configPath
  });
  assert.equal(unsupportedReasoning.ok, false);
  assert.ok(unsupportedReasoning.blockers.includes('role_model_reasoning_not_in_catalog'));

  const invalidProvider: any = await setRoleModelPreference({
    role: 'ui_implementer',
    provider: 'anthropic/router',
    model: 'anthropic/claude-sonnet',
    reasoning: 'high',
    env,
    home,
    configPath
  });
  assert.equal(invalidProvider.ok, false);
  assert.ok(invalidProvider.blockers.includes('role_model_provider_invalid'));

  await fs.writeFile(configPath, [
    'model_provider = "openai"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    ''
  ].join('\n'));
  const routerNotSelected: any = await setRoleModelPreference({
    role: 'ui_implementer',
    provider: 'anthropic',
    model: 'anthropic/claude-sonnet',
    reasoning: 'high',
    env,
    home,
    configPath
  });
  assert.equal(routerNotSelected.ok, false);
  assert.ok(routerNotSelected.blockers.includes('role_model_router_not_selected'));

  await fs.writeFile(catalogPath, `${JSON.stringify({
    models: [catalogModel('anthropic/claude-sonnet', 'Claude Sonnet', ['high'], {
      provider: 'anthropic',
      multi_agent_version: 'v1'
    })]
  })}\n`, { mode: 0o600 });
  await fs.writeFile(configPath, [
    'model_provider = "sks-router"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    ''
  ].join('\n'));
  const v1Blocked: any = await setRoleModelPreference({
    role: 'ui_implementer',
    provider: 'anthropic',
    model: 'anthropic/claude-sonnet',
    reasoning: 'high',
    env,
    home,
    configPath
  });
  assert.equal(v1Blocked.ok, false);
  assert.ok(v1Blocked.blockers.includes('role_model_multi_agent_v2_required'));
});

test('official subagent preparation applies role overrides to routed plan and explicit spawn contract', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-role-model-plan-'));
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const dir = path.join(root, '.sneakoscope', 'missions', 'M-role-model');
  const env = { HOME: path.join(temp, 'home'), SKS_HOME: path.join(temp, 'sks-home') } as NodeJS.ProcessEnv;
  await fs.mkdir(dir, { recursive: true });
  await setRoleModelPreference({
    role: 'ui_implementer',
    model: 'gpt-5.6-sol',
    reasoning: 'max',
    env
  });

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
  assert.equal(routed.routed_provider, 'openai');
  assert.equal(routed.routed_model, 'gpt-5.6-sol');
  assert.equal(routed.routed_model_reasoning_effort, 'max');
  assert.equal(routed.routed_model_policy, 'user_role_model_preference');
  assert.equal(routed.routing_dynamic, false);
  assert.equal(prepared.plan.role_model_preferences.overrides.ui_implementer.reasoning_effort, 'max');
  assert.match(prepared.delegationPrompt, /pass the exact catalog slug model="gpt-5\.6-sol" and reasoning_effort="max" when spawning this role/);
  assert.match(prepared.delegationPrompt, /logical provider="openai" is encoded by the active router\/catalog/);
  assert.match(prepared.delegationPrompt, /must use `fork_turns="none"` or a positive bounded turn count, with the complete bounded slice contract in `message`/);
});

test('app-session third-party main models inherit onto children unless a role override exists', async (t) => {
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
  assert.equal(status.routing.active_main_model_inherited, true);
  assert.equal(ui?.override, null);
  assert.equal(ui?.effective_provider, 'openrouter');
  assert.equal(ui?.effective_model, 'moonshotai/kimi-k3');
  assert.equal(ui?.effective_reasoning_effort, 'high');
  assert.equal(ui?.effective_source, 'selected-main-model');

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
  assert.equal(routed.routed_provider, 'openrouter');
  assert.equal(routed.routed_model, 'moonshotai/kimi-k3');
  assert.equal(routed.routed_model_reasoning_effort, 'high');
  assert.equal(routed.routed_model_policy, 'active_main_model');
  assert.equal(routed.role_model_preference_source, 'active-main-model');
  assert.equal(prepared.plan.role_model_preferences.routing.active_main_model_inherited, true);
  assert.match(prepared.delegationPrompt, /keep the current app-selected main model openrouter:moonshotai\/kimi-k3/);
  assert.match(prepared.delegationPrompt, /pass the exact active main model="moonshotai\/kimi-k3" and reasoning_effort="high"/);

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
  assert.match(parentRequired.delegationPrompt, /for every role without a user override, including slices created after parent decomposition, pass model="moonshotai\/kimi-k3"/);
  assert.match(parentRequired.delegationPrompt, /do not substitute a managed GPT model for the active main model openrouter:moonshotai\/kimi-k3/);
});

test('GPT-5.6 Sol app-session main keeps sealed Luna and Terra child role models', async (t) => {
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
    'model = "gpt-5.6-sol"',
    ''
  ].join('\n'));

  const status = await roleModelPreferencesStatus({ env, home, configPath });
  const explorer = status.roles.find((row) => row.role === 'explorer');
  const worker = status.roles.find((row) => row.role === 'worker');
  assert.equal(status.routing.active_main_model_inherited, false);
  assert.equal(explorer?.effective_model, 'gpt-5.6-terra');
  assert.equal(explorer?.effective_reasoning_effort, 'medium');
  assert.equal(explorer?.effective_source, 'managed-default');
  assert.equal(worker?.effective_model, 'gpt-5.6-luna');
  assert.equal(worker?.effective_reasoning_effort, 'max');

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
  assert.equal(prepared.plan.agents.explorer.routed_model, 'gpt-5.6-terra');
  assert.equal(prepared.plan.agents.explorer.routed_model_reasoning_effort, 'medium');
  assert.equal(prepared.plan.agents.explorer.routed_model_policy, 'terra_medium_context_tools');
  assert.equal(prepared.plan.agents.worker.routed_model, 'gpt-5.6-luna');
  assert.equal(prepared.plan.agents.worker.routed_model_reasoning_effort, 'max');
  assert.equal(prepared.plan.agents.worker.routed_model_policy, 'luna_max_mechanical');
  assert.equal(prepared.plan.role_model_preferences.routing.active_main_model_inherited, false);
  assert.match(prepared.delegationPrompt, /children must keep sealed Luna\/Terra\/Sol High\/Sol Max role profiles/);
  assert.doesNotMatch(prepared.delegationPrompt, /pass the exact active main model="gpt-5\.6-sol"/);
});

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
    assert.match(value, /pass model="gpt-5\.6-sol" and reasoning_effort="high" from the sealed role policy/);
    assert.match(value, /do not replace Luna\/Terra\/Sol High\/Sol Max with the parent active main model/);
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
