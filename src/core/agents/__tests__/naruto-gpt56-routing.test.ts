import test from 'node:test';
import assert from 'node:assert/strict';
import { routeNarutoGpt56Model } from '../../provider/model-router.js';
import { narutoWorkerBackendBlocker, resolveWorkerModelRouting } from '../native-worker-backend-router.js';
import type { CodexTaskInput } from '../../codex-control/codex-control-plane.js';
import { buildCodexExecutionPolicy, buildCodexSdkConfig } from '../../codex-control/codex-sdk-config-policy.js';
import { normalizeCodexModelEffortCatalogPayload } from '../../codex-lb/codex-lb-env.js';

const models = ['gpt-5.6-luna', 'gpt-6-astra'];
const modelEfforts = {
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
};

test('Naruto Luna/Astra policy maps all four sealed profiles', () => {
  const available = { availableModels: models, availableModelEfforts: modelEfforts };
  assert.deepEqual(routeNarutoGpt56Model({ ...available, taskText: 'implementation code_modification' }), {
    model: 'gpt-6-astra', reasoning: 'high', serviceTier: 'fast'
  });
  assert.deepEqual(routeNarutoGpt56Model({ ...available, taskText: 'exact one-line single-file rename' }), {
    model: 'gpt-5.6-luna', reasoning: 'max', serviceTier: 'fast'
  });
  assert.deepEqual(routeNarutoGpt56Model({ ...available, taskText: 'implementation', riskText: 'critical security migration' }), {
    model: 'gpt-6-astra', reasoning: 'max', serviceTier: 'fast'
  });
  assert.deepEqual(routeNarutoGpt56Model({ ...available, taskText: 'refactor architecture integration_support browser' }), {
    model: 'gpt-6-astra', reasoning: 'max', serviceTier: 'fast'
  });
  assert.deepEqual(routeNarutoGpt56Model({ ...available, taskText: 'conflict_resolution patch_rebase' }), {
    model: 'gpt-6-astra', reasoning: 'max', serviceTier: 'fast'
  });
  assert.deepEqual(routeNarutoGpt56Model({ ...available, taskText: 'test_execution browser' }), {
    model: 'gpt-6-astra', reasoning: 'medium', serviceTier: 'fast'
  });
  assert.deepEqual(routeNarutoGpt56Model({ ...available, taskText: 'test_execution GUI', riskText: 'forensic cross-app failure' }), {
    model: 'gpt-6-astra', reasoning: 'max', serviceTier: 'fast'
  });
});

test('native worker routing propagates simple EN/KO Luna, Astra Medium, High, and Max choices', async () => {
  const catalog = { ok: true, models, model_efforts: modelEfforts, blockers: [] };
  const cases = [
    ['Simple coding change: update one constant', 'gpt-5.6-luna', 'max'],
    ['간단한 설정 변경으로 플래그만 켜줘', 'gpt-5.6-luna', 'max'],
    ['간단한 셋업으로 한 줄만 추가해줘', 'gpt-5.6-luna', 'max'],
    ['Rapid large-scale first-draft code processing across many files', 'gpt-6-astra', 'medium'],
    ['장기 메모리를 정리하고 통합해줘', 'gpt-6-astra', 'medium'],
    ['Implement the ordinary parser logic', 'gpt-6-astra', 'high'],
    ['Debug the release security failure', 'gpt-6-astra', 'max']
  ] as const;
  for (const [description, model, effort] of cases) {
    const routing = await resolveWorkerModelRouting({
      agent: { id: 'naruto_dynamic', role: 'executor' },
      slice: { id: 'W-dynamic', kind: 'task', title: description, description },
      intake: { route: '$Naruto' },
      fastModePolicy: { fast_mode: true, service_tier: 'fast' }
    }, { lbCatalog: catalog, lbHealth: { ok: true, degraded_models: [] }, env: {} });
    assert.equal(routing.blockers.length, 0, description);
    assert.equal(routing.choice.model, model, description);
    assert.equal(routing.choice.reasoning, effort, description);
  }
});

test('Naruto Luna/Astra policy fails closed for missing model or unadvertised effort', () => {
  assert.equal(routeNarutoGpt56Model({
    taskText: 'exact one-line single-file rename',
    availableModels: ['gpt-6-astra'],
    availableModelEfforts: modelEfforts
  }).model, '');
  assert.equal(routeNarutoGpt56Model({
    taskText: 'refactor strategy',
    availableModels: models,
    availableModelEfforts: { ...modelEfforts, 'gpt-6-astra': ['xhigh'] }
  }).model, '');
});

test('native Naruto worker routing passes the exact selected model and effort into SDK config', async () => {
  const catalog = { ok: true, models, model_efforts: modelEfforts, blockers: [] };
  const routing = await resolveWorkerModelRouting({
    agent: { id: 'naruto_1', role: 'integrator', naruto_role: 'integrator' },
    slice: { id: 'W1', kind: 'refactor', title: 'Refactor architecture', parent_prompt: 'release integration' },
    intake: { route: '$Naruto' },
    fastModePolicy: { fast_mode: true, service_tier: 'fast' }
  }, { lbCatalog: catalog, lbHealth: { ok: true, degraded_models: [] }, env: {} });
  assert.equal(routing.blockers.length, 0);
  assert.equal(routing.choice.model, 'gpt-6-astra');
  assert.equal(routing.choice.reasoning, 'max');
  const task: CodexTaskInput = {
    route: '$Naruto',
    tier: 'worker',
    missionId: 'M-test',
    cwd: process.cwd(),
    prompt: 'refactor',
    outputSchemaId: 'test.schema.v1',
    outputSchema: { type: 'object' },
    sandboxPolicy: 'read-only',
    requestedScopeContract: { route: '$Naruto', read_only: true },
    mutationLedgerRoot: process.cwd(),
    model: routing.choice.model,
    reasoningEffort: routing.choice.reasoning,
    modelReasoningEffort: routing.choice.reasoning,
    serviceTier: routing.choice.serviceTier
  };
  const config = buildCodexSdkConfig(task);
  assert.equal(config.model, 'gpt-6-astra');
  assert.equal(config.model_reasoning_effort, 'max');
  assert.equal(buildCodexExecutionPolicy(task).sandbox, 'read-only');
  assert.equal(buildCodexExecutionPolicy({
    ...task,
    sandboxPolicy: 'workspace-write',
    requestedScopeContract: { route: '$Naruto', read_only: false, allowed_paths: ['src/core'], write_paths: ['src/core'] }
  }).sandbox, 'workspace-write');
});

test('internal Naruto worker routing blocks non-family explicit overrides', async () => {
  const routing = await resolveWorkerModelRouting({
    agent: { id: 'naruto_1', role: 'implementer', naruto_role: 'implementer' },
    slice: { id: 'W1', kind: 'implementation', title: 'Implement feature' },
    intake: { route: '$Naruto' },
    fastModePolicy: { fast_mode: true, service_tier: 'fast' }
  }, {
    lbCatalog: { ok: true, models, model_efforts: modelEfforts, blockers: [] },
    lbHealth: { ok: true, degraded_models: [] },
    env: { SKS_WORKER_MODEL: 'gpt-5.4' }
  });
  assert.ok(routing.blockers.includes('naruto_worker_model_outside_gpt_5_6_family'));
});

test('Naruto rejects the process backend and conflicting effort/tier overrides', async () => {
  assert.equal(narutoWorkerBackendBlocker('process'), 'naruto_gpt_5_6_family_only_process_backend_forbidden');
  assert.equal(narutoWorkerBackendBlocker('codex-sdk'), null);
  const routing = await resolveWorkerModelRouting({
    agent: { id: 'naruto_1', role: 'implementer', naruto_role: 'implementer' },
    slice: { id: 'W1', kind: 'implementation', title: 'Implement feature' },
    intake: { route: '$Naruto' },
    fastModePolicy: { fast_mode: true, service_tier: 'fast' }
  }, {
    lbCatalog: { ok: true, models, model_efforts: modelEfforts, blockers: [] },
    lbHealth: { ok: true, degraded_models: [] },
    env: { SKS_WORKER_REASONING: 'low', SKS_WORKER_SERVICE_TIER: 'standard' }
  });
  assert.ok(routing.blockers.includes('naruto_reasoning_override_conflicts_with_policy'));
  assert.ok(routing.blockers.includes('naruto_service_tier_override_conflicts_with_policy'));
});

test('Naruto rejects invalid explicit effort and service-tier overrides', async () => {
  const routing = await resolveWorkerModelRouting({
    agent: { id: 'naruto_1', role: 'implementer', naruto_role: 'implementer' },
    slice: { id: 'W1', kind: 'implementation', title: 'Implement feature' },
    intake: { route: '$Naruto' },
    fastModePolicy: { fast_mode: true, service_tier: 'fast' }
  }, {
    lbCatalog: { ok: true, models, model_efforts: modelEfforts, blockers: [] },
    lbHealth: { ok: true, degraded_models: [] },
    env: { SKS_WORKER_REASONING: 'bogus', SKS_WORKER_SERVICE_TIER: 'bogus' }
  });
  assert.ok(routing.blockers.includes('naruto_reasoning_override_invalid'));
  assert.ok(routing.blockers.includes('naruto_service_tier_override_invalid'));
});

test('Codex App and cache effort catalog shapes normalize to the same model contract', () => {
  assert.deepEqual(normalizeCodexModelEffortCatalogPayload({ data: [{
    id: 'gpt-5.6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }]
  }] }), { 'gpt-5.6-sol': ['xhigh', 'max'] });
  assert.deepEqual(normalizeCodexModelEffortCatalogPayload({ models: [{
    slug: 'gpt-5.6-luna', supported_reasoning_levels: [{ effort: 'xhigh' }, { effort: 'max' }]
  }] }), { 'gpt-5.6-luna': ['xhigh', 'max'] });
  assert.deepEqual(normalizeCodexModelEffortCatalogPayload({ models: [{
    slug: 'gpt-5.6-terra', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }]
  }] }), { 'gpt-5.6-terra': ['medium', 'high'] });
});
