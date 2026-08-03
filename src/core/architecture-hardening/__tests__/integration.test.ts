import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareRouterExecutionIntent } from '../../../cli/router.js';
import { classifyPromptExecutionEffect } from '../../routes.js';
import { decideAuxiliaryOAuthRoute } from '../../codex-app/auxiliary-oauth-policy.js';
import { createSessionPin, sessionPinHash } from '../../codex-app/session-policy/session-pinning.js';
import {
  assertDesktopBridgeRequestPolicy,
} from '../../codex-lb/desktop-bridge/security.js';
import { buildUpstreamHeaders } from '../../codex-lb/desktop-bridge/header-policy.js';
import type { DesktopBridgeConfig } from '../../codex-lb/desktop-bridge/types.js';
import {
  defaultDesktopBridgeServiceSettings,
  desktopBridgeArchitecturePolicy,
} from '../../codex-lb/desktop-service.js';
import {
  buildProviderUpstreamHeaders,
  createNativeOpenAiTransportContract,
} from '../../codex-lb/native-openai-transport/transport.js';
import { classifyProviderRouteFailure } from '../../codex-lb/provider-routing/provider-router.js';
import { stageImageReference } from '../../commands/image-ux-review-command.js';
import { decideImageReferenceUse } from '../../image-ux-review/reference-policy/reference-policy.js';
import { withEvidenceWriterLock } from '../../triwiki/context-graph/store/evidence-write-lock.js';
import {
  inspectArchitectureMigration,
  applyArchitectureMigration,
} from '../migration/migration.js';
import { ArchitectureStateService } from '../state/state-service.js';

function managedBridgeConfig(): { config: DesktopBridgeConfig; sessionId: string } {
  const settings = defaultDesktopBridgeServiceSettings({
    listen_port: 55_000,
    provider_mode: 'codex-lb',
    allowed_models: ['gpt-5.6-codex'],
    require_session_pin: true,
  });
  const architecture = desktopBridgeArchitecturePolicy(settings);
  const session = createSessionPin({
    sessionId: 'session-1',
    policy: architecture.policy,
    model: 'gpt-5.6-codex',
    lbAffinityToken: 'opaque-affinity-fixture',
  });
  return {
    sessionId: session.session_id,
    config: {
      listenHost: '127.0.0.1',
      listenPort: 55_000,
      providerMode: 'codex-lb',
      allowedModels: settings.allowed_models,
      providerPolicy: architecture.policy,
      credentialReadiness: architecture.credential,
      childPolicy: architecture.child,
      sessionPins: [session],
      requireSessionPin: true,
      remoteBaseUrl: 'https://lb.example.test/backend-api/codex',
      gatewayKey: 'fixture-upstream-credential',
      gatewayAuthTransport: 'x-codex-lb-api-key',
      allowedPathPrefixes: ['/backend-api/codex/'],
      allowedOrigins: ['app://codex'],
      connectTimeoutMs: 2_000,
      idleTimeoutMs: 30_000,
    },
  };
}

test('managed native transport and proxy choke point enforce exclusive mode, session and child snapshots', () => {
  const transport = createNativeOpenAiTransportContract({
    nativeProviderId: 'openai',
    mode: 'codex-lb',
    listenOrigin: 'http://127.0.0.1:55000',
  });
  const nativeHeaders = buildProviderUpstreamHeaders(transport, {
    authorization: 'Bearer desktop-oauth',
    'x-native-metadata': 'preserved',
  }, 'fixture-upstream-credential');
  assert.equal(nativeHeaders.authorization, undefined);
  assert.equal(nativeHeaders['x-native-metadata'], 'preserved');

  const { config, sessionId } = managedBridgeConfig();
  const session = config.sessionPins?.[0];
  assert.ok(session);
  const headers = {
    'x-sks-provider-mode': 'codex-lb',
    'x-sks-session-id': sessionId,
    'x-sks-child-policy-hash': config.childPolicy?.policy_hash || '',
  };
  assert.doesNotThrow(() => assertDesktopBridgeRequestPolicy({ headers, config, model: 'gpt-5.6-codex' }));
  assert.throws(
    () => assertDesktopBridgeRequestPolicy({ headers: { ...headers, 'x-sks-provider-mode': 'openrouter' }, config, model: 'gpt-5.6-codex' }),
    /bridge_provider_route_cross_mode_forbidden/,
  );
  assert.throws(
    () => assertDesktopBridgeRequestPolicy({ headers: { ...headers, 'x-sks-session-id': 'unknown' }, config, model: 'gpt-5.6-codex' }),
    /bridge_session_pin_unknown/,
  );
  const childHeaders = {
    ...headers,
    'x-sks-child-request': '1',
    'x-sks-child-model': 'gpt-5.6-codex',
    'x-sks-parent-snapshot-hash': sessionPinHash(session),
  };
  assert.doesNotThrow(() => assertDesktopBridgeRequestPolicy({ headers: childHeaders, config, model: 'gpt-5.6-codex' }));
  assert.throws(
    () => assertDesktopBridgeRequestPolicy({ headers: { ...childHeaders, 'x-sks-parent-snapshot-hash': '0'.repeat(64) }, config, model: 'gpt-5.6-codex' }),
    /bridge_child_parent_snapshot_mismatch/,
  );

  const upstream = buildUpstreamHeaders({ ...headers, authorization: 'Bearer desktop-oauth' }, config, 'lb.example.test');
  assert.equal(upstream.authorization, undefined);
  assert.equal(upstream['x-sks-session-id'], undefined);
  assert.equal(upstream['x-codex-lb-api-key'], 'fixture-upstream-credential');
  assert.equal(classifyProviderRouteFailure(503).failover_allowed, false);
});

test('OAuth auxiliary routing is explicit and never changes the provider session mode', () => {
  const contract = { feature: 'voice', request_path: '/backend-api/voice', protocol_verified: true, proxy_supported: false };
  const denied = decideAuxiliaryOAuthRoute({ mode: 'codex-lb', contract, oauthConnected: true, userAllowed: false });
  assert.equal(denied.status, 'permission_required');
  const allowed = decideAuxiliaryOAuthRoute({ mode: 'codex-lb', contract, oauthConnected: true, userAllowed: true });
  assert.equal(allowed.status, 'auxiliary_oauth');
  assert.equal(allowed.session_mode_changed, false);
  assert.equal(allowed.session_mode, 'codex-lb');
});

test('router normalizes aliases before dispatch and reuses an inherited evidence/retry contract', () => {
  const parent = prepareRouterExecutionIntent(['image-ux-review'], {
    naturalLanguageEffect: 'Read the current image review state.',
    effect: 'read',
    evidenceState: 'valid',
    retryBudget: 2,
    modeSnapshot: 'codex-lb',
  });
  const alias = prepareRouterExecutionIntent(['visual-review'], { parentContract: parent.contract });
  assert.equal(alias.canonical_command, 'sks image-ux-review');
  assert.equal(alias.contract.contract_hash, parent.contract.contract_hash);
  assert.equal(alias.contract.retry_budget, 2);
  assert.equal(alias.contract.evidence_state, 'valid');
  assert.equal(classifyPromptExecutionEffect('Explain the deployment security policy.'), 'read');
  assert.equal(classifyPromptExecutionEffect('Deploy this build now.'), 'deploy');
});

test('state apply, migration, and image staging use the hardened transaction/reference paths', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-architecture-integration-'));
  try {
    const settings = defaultDesktopBridgeServiceSettings({
      listen_port: 55_001,
      provider_mode: 'codex-lb',
      allowed_models: ['gpt-5.6-codex'],
    });
    const architecture = desktopBridgeArchitecturePolicy(settings);
    const state = new ArchitectureStateService(path.join(root, 'state'));
    await state.stage({
      schema: 'sks.architecture-configuration.v1',
      policy: architecture.policy,
      credential: architecture.credential,
      catalog: null,
      features: [],
    });
    const applied = await state.commit({
      applyProxy: async () => undefined,
      refreshCatalog: async () => undefined,
      makeNewSessionReady: async () => undefined,
    }, () => new Date('2026-08-02T00:00:00.000Z'));
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.receipts.map((receipt) => receipt.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);

    const configPath = path.join(root, 'config.toml');
    const legacy = '[model_providers.legacy]\nbase_url = "https://legacy.example"\n';
    await fsp.writeFile(configPath, legacy, { mode: 0o600 });
    const plan = inspectArchitectureMigration({ configText: legacy, sessionMetadataPresent: true });
    const receipt = await applyArchitectureMigration({
      configPath,
      plan,
      targetMode: 'codex-lb',
      loopbackBaseUrl: 'http://127.0.0.1:55001/backend-api/codex',
      confirmedRemovablePaths: plan.removable_paths,
      explicitApply: true,
    });
    assert.equal(receipt.status, 'applied');
    assert.match(await fsp.readFile(configPath, 'utf8'), /model_provider = "openai"/);

    const imagePath = path.join(root, 'screen.png');
    const evidenceDir = path.join(root, 'evidence');
    await fsp.writeFile(imagePath, Buffer.from('png-fixture'));
    const staged = await stageImageReference(root, evidenceDir, 'screen.png', 'source-screens');
    assert.equal(staged, 'screen.png');
    assert.equal(await fsp.stat(imagePath).then((stat) => stat.isFile()), true);
    await assert.rejects(fsp.stat(path.join(evidenceDir, 'source-screens', 'screen.png')), /ENOENT/);
    const registry = JSON.parse(await fsp.readFile(path.join(evidenceDir, 'image-references.json'), 'utf8')) as { references: any[] };
    assert.equal(registry.references.length, 1);
    assert.equal(decideImageReferenceUse({ reference: registry.references[0], operation: 'local-review' }).allowed, true);

    const graphGate = await withEvidenceWriterLock({
      root,
      projectId: 'architecture-integration-project',
      run: async (lock) => {
        await fsp.writeFile(path.join(root, 'graph-staging.json'), JSON.stringify({ acquired: lock.acquired }), { mode: 0o600 });
        return lock;
      },
    });
    assert.equal(graphGate.acquired, true);
    assert.match(graphGate.project_id_hash, /^[a-f0-9]{64}$/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
