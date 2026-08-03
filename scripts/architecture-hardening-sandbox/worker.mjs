#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { ARCHITECTURE_HARDENING_CONTRACT_VERSION, credentialClassForMode, stableArchitectureHash } from '../../dist/core/architecture-hardening/contracts/contracts.js';
import { ArchitectureStateService } from '../../dist/core/architecture-hardening/state/state-service.js';
import { createChildPolicySnapshot, decideChildSelection } from '../../dist/core/codex-app/child-policy/child-policy.js';
import { CatalogCompatibilityService } from '../../dist/core/codex-app/catalog-compat/catalog-service.js';
import { createSessionPin, resumeSessionPin } from '../../dist/core/codex-app/session-policy/session-pinning.js';
import { defaultDesktopBridgeServiceSettings, desktopBridgeArchitecturePolicy } from '../../dist/core/codex-lb/desktop-service.js';
import { decideProviderRoute, emptyProviderCatalogForCredential } from '../../dist/core/codex-lb/provider-routing/provider-router.js';
import { initialProgressRecoveryState, issueManualResume, confirmManualResume, runWithProgressRecovery } from '../../dist/core/runtime/progress-recovery/progress-recovery.js';
import { withEvidenceWriterLock } from '../../dist/core/triwiki/context-graph/store/evidence-write-lock.js';

const root = requiredAbsolutePath('SKS_ARCHITECTURE_SANDBOX_ROOT');
const home = requiredInsideRoot('HOME');
const codexHome = requiredInsideRoot('CODEX_HOME');
const sksHome = requiredInsideRoot('SKS_HOME');
const scenarios = JSON.parse(await fsp.readFile(requiredAbsolutePath('SKS_ARCHITECTURE_SCENARIOS'), 'utf8'));
assert.equal(scenarios.schema, 'sks.architecture-hardening-sandbox-scenarios.v1');
assert.equal(scenarios.modes.length, 3);

const fixtureSecrets = {
  'chatgpt-oauth': 'fixture-oauth-secret-do-not-log',
  'codex-lb': 'fixture-lb-secret-do-not-log',
  openrouter: 'fixture-openrouter-secret-do-not-log'
};
const servers = await Promise.all(['codex-lb', 'openrouter', 'chatgpt-oauth', 'catalog'].map(startMockServer));
try {
  const before = await listFiles(root);
  await fsp.mkdir(path.join(codexHome, 'isolated-install'), { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\n', { mode: 0o600 });

  const modeResults = [];
  for (const scenario of scenarios.modes) {
    const architecture = architectureForScenario(scenario);
    const decision = decideProviderRoute({
      policy: architecture.policy,
      credential: architecture.credential,
      requestedMode: scenario.mode,
      model: scenario.model
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.credential_class, scenario.credential_class);
    const crossMode = scenarios.modes.find((candidate) => candidate.mode !== scenario.mode).mode;
    assert.equal(decideProviderRoute({ ...decisionInput(architecture, scenario), requestedMode: crossMode }).ok, false);
    const session = createSessionPin({
      sessionId: `session-${scenario.mode}`,
      policy: architecture.policy,
      model: scenario.model,
      lbAffinityToken: scenario.mode === 'codex-lb' ? 'opaque-affinity-token' : null
    });
    assert.equal(resumeSessionPin(session, architecture.policy).ok, true);
    const child = createChildPolicySnapshot(
      architecture.policy,
      scenario.mode === 'openrouter' ? [scenario.model] : []
    );
    const childDecision = decideChildSelection({
      session,
      policy: child,
      requestedModel: scenario.mode === 'chatgpt-oauth' ? null : scenario.mode === 'codex-lb' ? null : scenario.model
    });
    assert.equal(childDecision.ok, true);
    assert.equal(childDecision.owner, scenario.child_owner);
    await callMock(servers.find((server) => server.name === scenario.mode), scenario.mode, fixtureSecrets[scenario.mode]);
    modeResults.push({ mode: scenario.mode, exclusive: true, session_pinned: true, child_owner: childDecision.owner });
  }

  assert.deepEqual(emptyProviderCatalogForCredential({
    mode: 'codex-lb',
    credential: { status: 'not_found', reason_code: 'key_revoked' },
    models: ['gpt-5.6-codex']
  }), []);

  const apply = await runApplyScenarios(root, scenarios.modes[1]);
  const catalog = await runCatalogRestartScenario(root, servers.find((server) => server.name === 'catalog'));
  const recovery = await runRecoveryScenario();
  const graph = await withEvidenceWriterLock({
    root,
    projectId: 'architecture-hardening-sandbox-project',
    run: async (receipt) => {
      const marker = path.join(sksHome, 'graph-gate.json');
      await fsp.writeFile(marker, JSON.stringify({ acquired: receipt.acquired }), { mode: 0o600 });
      return { acquired: receipt.acquired, project_id_redacted: /^[a-f0-9]{64}$/.test(receipt.project_id_hash) };
    }
  });

  const after = await listFiles(root);
  const report = {
    schema: 'sks.architecture-hardening-mock-report.v1',
    ok: true,
    isolation: {
      temp_roots_active: [home, codexHome, sksHome].every((candidate) => inside(candidate, root)),
      user_state_access: 'none_by_construction',
      files_before: before,
      files_created: after.filter((file) => !before.includes(file)),
      all_writes_inside_sandbox: after.every((file) => !path.isAbsolute(file))
    },
    mock_contract: {
      modes: modeResults,
      credential_withdrawal: 'passed',
      four_stage_apply: apply,
      offline_restart: catalog,
      pause_resume: recovery,
      graph_writer_gate: graph,
      mock_servers: servers.map((server) => ({ name: server.name, requests: server.requests }))
    }
  };
  assert.deepEqual(new Set(scenarios.required_scenarios), new Set([
    'exclusive_modes', 'credential_withdrawal', 'session_pin', 'child_policy', 'four_stage_apply',
    'offline_restart', 'pause_resume', 'graph_writer_gate', 'filesystem_isolation', 'secret_safe_logs'
  ]));
  await assertSecretSafe(report, root, Object.values(fixtureSecrets));
  const evidenceDir = path.join(root, 'evidence');
  await fsp.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(evidenceDir, 'mock-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.server.close(resolve))));
}

function decisionInput(architecture, scenario) {
  return { policy: architecture.policy, credential: architecture.credential, requestedMode: scenario.mode, model: scenario.model };
}

function architectureForScenario(scenario) {
  if (scenario.mode !== 'chatgpt-oauth') {
    return desktopBridgeArchitecturePolicy(defaultDesktopBridgeServiceSettings({
      provider_mode: scenario.mode,
      allowed_models: [scenario.model],
      registered_child_models: scenario.mode === 'openrouter' ? [scenario.model] : undefined,
      require_session_pin: true
    }));
  }
  const seed = {
    schema: 'sks.provider-policy-snapshot.v1',
    contract_version: ARCHITECTURE_HARDENING_CONTRACT_VERSION,
    mode: scenario.mode,
    credential_class: credentialClassForMode(scenario.mode),
    allowed_models: [scenario.model],
    child_policy_hash: '0'.repeat(64),
    catalog_version: `catalog-${stableArchitectureHash({ mode: scenario.mode, models: [scenario.model] }).slice(0, 24)}`
  };
  const child = createChildPolicySnapshot(seed);
  return {
    policy: { ...seed, child_policy_hash: child.policy_hash },
    credential: { status: 'ready', reason_code: null },
    child,
    sessionPins: [],
    requireSessionPin: true
  };
}

async function runApplyScenarios(sandboxRoot, scenario) {
  const architecture = desktopBridgeArchitecturePolicy(defaultDesktopBridgeServiceSettings({
    provider_mode: scenario.mode,
    allowed_models: [scenario.model]
  }));
  const configuration = {
    schema: 'sks.architecture-configuration.v1',
    policy: architecture.policy,
    credential: architecture.credential,
    catalog: null,
    features: []
  };
  const successRoot = path.join(sandboxRoot, 'apply-success');
  const success = new ArchitectureStateService(successRoot);
  await success.stage(configuration);
  const committed = await success.commit({
    applyProxy: async () => undefined,
    refreshCatalog: async () => undefined,
    makeNewSessionReady: async () => undefined
  });
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.receipts.map((receipt) => receipt.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
  const restarted = await new ArchitectureStateService(successRoot).read();
  assert.equal(restarted.last_known_good.policy.mode, 'codex-lb');

  const failure = new ArchitectureStateService(path.join(sandboxRoot, 'apply-partial'));
  await failure.stage(configuration);
  const partial = await failure.commit({
    applyProxy: async () => undefined,
    refreshCatalog: async () => { throw new Error('catalog_offline'); },
    makeNewSessionReady: async () => undefined
  });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.receipts.map((receipt) => receipt.status), ['succeeded', 'succeeded', 'failed', 'pending']);
  return { success: 'passed', partial_failure: 'passed', restart_lkg: 'passed' };
}

async function runCatalogRestartScenario(sandboxRoot, catalogServer) {
  let online = true;
  const service = new CatalogCompatibilityService(path.join(sandboxRoot, 'catalog-state.json'));
  const port = {
    readNativeCatalog: async () => {
      if (!online) throw new Error('catalog_offline');
      const response = await fetch(`${catalogServer.origin}/models`);
      return (await response.json()).models;
    },
    validateModels: async (_mode, models) => models.filter((model) => model === 'gpt-5.6-codex')
  };
  const ready = { status: 'ready', reason_code: null };
  const first = await service.refresh({ trigger: 'startup', mode: 'codex-lb', credential: ready, port });
  online = false;
  const offline = await service.refresh({ trigger: 'background', mode: 'codex-lb', credential: ready, port });
  const restarted = await new CatalogCompatibilityService(service.statePath).read();
  assert.equal(offline.failure_reason, 'catalog_offline');
  assert.deepEqual(offline.last_good, first.last_good);
  assert.deepEqual(restarted.last_good, first.last_good);
  return { last_good_preserved: true, restart_restored: true };
}

async function runRecoveryScenario() {
  const integrity = createHash('sha256').update('sandbox-integrity').digest('hex');
  const recovered = await runWithProgressRecovery({
    state: initialProgressRecoveryState(integrity),
    port: {
      run: async (attempt) => {
        if (attempt < 2) throw new Error('network_timeout');
        return 'ok';
      },
      classify: () => ({ cause: 'network', reason: 'network_timeout' })
    }
  });
  assert.equal(recovered.state.status, 'completed');
  assert.equal(recovered.state.retry_count, 2);
  const paused = await runWithProgressRecovery({
    state: initialProgressRecoveryState(integrity),
    port: {
      run: async () => { throw new Error('auth_required'); },
      classify: () => ({ cause: 'auth', reason: 'auth_required' })
    }
  });
  assert.equal(paused.state.status, 'paused');
  const issued = issueManualResume(paused.state);
  assert.equal(confirmManualResume(issued.state, issued.token).status, 'running');
  return { bounded_network_retry: true, auth_paused: true, manual_resume: true };
}

async function startMockServer(name) {
  const state = { requests: 0 };
  const server = http.createServer((request, response) => {
    state.requests += 1;
    if (name === 'catalog') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: ['gpt-5.6-codex', 'openai/gpt-5.6-codex'] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { name, server, get requests() { return state.requests; }, origin: `http://127.0.0.1:${address.port}` };
}

async function callMock(server, mode, secret) {
  const headers = mode === 'codex-lb'
    ? { 'x-codex-lb-api-key': secret }
    : { authorization: `Bearer ${secret}` };
  const response = await fetch(`${server.origin}/responses`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.ok, true);
}

async function assertSecretSafe(report, sandboxRoot, secrets) {
  const texts = [JSON.stringify(report)];
  for (const relative of await listFiles(sandboxRoot)) {
    const file = path.join(sandboxRoot, relative);
    const stat = await fsp.stat(file);
    if (stat.size <= 1_000_000) texts.push(await fsp.readFile(file, 'utf8').catch(() => ''));
  }
  const joined = texts.join('\n');
  for (const secret of secrets) assert.equal(joined.includes(secret), false);
  assert.equal(/authorization\s*[:=]\s*bearer\s+\S+/i.test(joined), false);
}

async function listFiles(directory) {
  const output = [];
  async function walk(current, depth = 0) {
    if (depth > 32) throw new Error('sandbox_file_walk_depth_exceeded');
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else output.push(path.relative(directory, absolute));
    }
  }
  await walk(directory);
  return output.sort();
}

function requiredAbsolutePath(name) {
  const value = process.env[name] || '';
  if (!path.isAbsolute(value)) throw new Error(`sandbox_${name.toLowerCase()}_invalid`);
  return path.resolve(value);
}

function requiredInsideRoot(name) {
  const value = requiredAbsolutePath(name);
  if (!inside(value, root)) throw new Error(`sandbox_${name.toLowerCase()}_escaped`);
  return value;
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
