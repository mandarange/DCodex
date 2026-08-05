#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_ALIASES_LITE,
  COMMAND_MANIFEST_BY_NAME
} from '../cli/command-manifest-lite.js';
import { normalizeCommand } from '../cli/router.js';
import {
  inspectHistoricalDesktopBridgeIntent,
  migrateDesktopBridgeConfig
} from '../core/codex-lb/desktop-bridge-migration.js';
import { rollbackDesktopBridgeUnificationReceipt } from '../core/codex-lb/migration-receipt.js';
import {
  configureProviderCredential,
  resolveAllProviderCredentials
} from '../core/codex-lb/provider-credentials.js';
import {
  buildStoredBridgeProviderRegistry,
  resolveBridgeProviderRegistry,
  serializeStoredBridgeProviderRegistry
} from '../core/codex-lb/provider-registry.js';
import {
  buildBridgeRoutingPolicy,
  readBridgeRoutingPolicy
} from '../core/codex-lb/provider-route-policy.js';
import { buildBridgeRouteIndex } from '../core/codex-lb/route-index.js';
import { openRouterSecretPaths } from '../core/providers/openrouter/openrouter-secret-store.js';
import { emitGate } from './gate-lib.js';

const bridgeBaseUrl = 'http://127.0.0.1:47821/backend-api/codex';
const codexLbEndpoint = 'https://lb.example.test/backend-api/codex';
const initialCodexLbKey = 'fixture-codex-lb-key-initial-123456789';
const initialOpenRouterKey = 'fixture-openrouter-key-initial-987654321';
const rotatedCodexLbKey = 'fixture-codex-lb-key-rotated-234567891';
const rotatedOpenRouterKey = 'fixture-openrouter-key-rotated-876543219';
const initialOauthAccess = 'fixture-oauth-access-initial';
const initialOauthRefresh = 'fixture-oauth-refresh-initial';
const rotatedOauthAccess = 'fixture-oauth-access-rotated';
const rotatedOauthRefresh = 'fixture-oauth-refresh-rotated';
const allFixtureSecrets = [
  initialCodexLbKey,
  initialOpenRouterKey,
  rotatedCodexLbKey,
  rotatedOpenRouterKey,
  initialOauthAccess,
  initialOauthRefresh,
  rotatedOauthAccess,
  rotatedOauthRefresh
];

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-bridge-unification-gate-'));
let failed: unknown = null;

try {
  const home = path.join(temporaryRoot, 'home');
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const authPath = path.join(codexHome, 'auth.json');
  const codexLbEnvPath = path.join(codexHome, 'sks-codex-lb.env');
  const openRouterPaths = openRouterSecretPaths({ HOME: home } as NodeJS.ProcessEnv);
  const routePolicyPath = path.join(codexHome, 'sks', 'sks-bridge-route-policy.json');
  const providerRegistryPath = path.join(codexHome, 'sks', 'sks-bridge-provider-registry.json');
  const combinedCatalogPath = path.join(codexHome, 'sks', 'sks-bridge-catalog.json');
  const historicalConfig = [
    '# sks-codex-lb-managed-provider-selection',
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${codexLbEndpoint}"`,
    'env_key = "CODEX_LB_API_KEY"',
    'requires_openai_auth = false',
    '',
    '[model_providers.openrouter]',
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'requires_openai_auth = false',
    ''
  ].join('\n');
  const initialAuth = authJson(initialOauthAccess, initialOauthRefresh);

  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, historicalConfig, { mode: 0o600 });
  await fs.writeFile(authPath, initialAuth, { mode: 0o600 });
  await configureProviderCredential({
    provider_id: 'codex-lb',
    api_key: initialCodexLbKey,
    host: codexLbEndpoint,
    home,
    processEnv: {}
  });
  await configureProviderCredential({
    provider_id: 'openrouter',
    api_key: initialOpenRouterKey,
    home,
    processEnv: { HOME: home },
    openRouterPaths
  });

  const initialCredentials = await resolveAllProviderCredentials({
    codexLb: {
      home,
      processEnv: {},
      validation: { state: 'ready', checked_at: '2026-08-06T00:00:00.000Z' }
    },
    openrouter: {
      processEnv: { HOME: home },
      openRouterPaths,
      validation: { state: 'ready', checked_at: '2026-08-06T00:00:00.000Z' }
    }
  });
  assert.equal(initialCredentials['codex-lb'].secret, initialCodexLbKey);
  assert.equal(initialCredentials.openrouter.secret, initialOpenRouterKey);
  assert.equal(initialCredentials['codex-lb'].state, 'ready');
  assert.equal(initialCredentials.openrouter.state, 'ready');

  const intent = inspectHistoricalDesktopBridgeIntent(historicalConfig);
  assert.deepEqual(intent.blockers, []);
  assert.equal(intent.default_provider_id, 'codex-lb');
  assert.equal(intent.providers['codex-lb'].enabled, true);
  assert.equal(intent.providers.openrouter.enabled, true);

  const storedRegistry = buildStoredBridgeProviderRegistry({
    credentials: initialCredentials,
    overrides: intent.providers
  });
  const registryText = serializeStoredBridgeProviderRegistry(storedRegistry);
  const registry = await resolveBridgeProviderRegistry({
    home,
    registryPath: providerRegistryPath,
    credentials: initialCredentials,
    storedRegistry
  });
  assert.equal(registry.profiles['codex-lb'].state, 'ready');
  assert.equal(registry.profiles.openrouter.state, 'ready');
  assertSecretFree(JSON.stringify({ credentials: initialCredentials, registry }), allFixtureSecrets);
  assertSecretFree(registryText, allFixtureSecrets);

  const routeIndex = buildBridgeRouteIndex({
    models: [],
    providers: {
      'codex-lb': {
        catalog_generation: 'fixture-codex-lb-catalog',
        credential_fingerprint: initialCredentials['codex-lb'].fingerprint,
        state: initialCredentials['codex-lb'].state
      },
      openrouter: {
        catalog_generation: 'fixture-openrouter-catalog',
        credential_fingerprint: initialCredentials.openrouter.fingerprint,
        state: initialCredentials.openrouter.state
      }
    },
    created_at: '2026-08-06T00:00:00.000Z'
  }).route_index;
  const routePolicy = buildBridgeRoutingPolicy({
    route_index: routeIndex,
    catalog_generation: 'fixture-combined-catalog',
    default_provider_id: intent.default_provider_id,
    changed_at: '2026-08-06T00:00:00.000Z'
  });
  const routePolicyText = `${JSON.stringify(routePolicy, null, 2)}\n`;
  assert.equal(routePolicy.fallback, 'none');
  assert.deepEqual(routePolicy.model_routes, {});

  const initialCodexLbBytes = await fs.readFile(codexLbEnvPath);
  const initialOpenRouterBytes = await fs.readFile(openRouterPaths.keyPath);
  const first = await migrateDesktopBridgeConfig({
    home,
    bridgeBaseUrl,
    combinedCatalogPath,
    metadataUpdates: [
      { kind: 'provider_registry', path: providerRegistryPath, text: registryText },
      { kind: 'route_policy', path: routePolicyPath, text: routePolicyText }
    ],
    now: new Date('2026-08-06T00:01:00.000Z')
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'migrated');
  assert.ok(first.receipt_path);
  assert.deepEqual(await fs.readFile(authPath), Buffer.from(initialAuth));
  assert.deepEqual(await fs.readFile(codexLbEnvPath), initialCodexLbBytes);
  assert.deepEqual(await fs.readFile(openRouterPaths.keyPath), initialOpenRouterBytes);
  const loadedPolicy = await readBridgeRoutingPolicy(routePolicyPath);
  assert.deepEqual(loadedPolicy.blockers, []);
  assert.equal(loadedPolicy.policy?.default_provider_id, 'codex-lb');
  assert.equal(loadedPolicy.policy?.fallback, 'none');
  assert.deepEqual(loadedPolicy.policy?.model_routes, {});

  const migratedConfig = await fs.readFile(configPath, 'utf8');
  const receiptText = await fs.readFile(first.receipt_path, 'utf8');
  const receiptEntries = (await fs.readdir(path.dirname(first.receipt_path))).sort();
  assertSecretFree(migratedConfig, allFixtureSecrets);
  assertSecretFree(await fs.readFile(routePolicyPath, 'utf8'), allFixtureSecrets);
  assertSecretFree(await fs.readFile(providerRegistryPath, 'utf8'), allFixtureSecrets);
  assertSecretFree(receiptText, allFixtureSecrets);

  const second = await migrateDesktopBridgeConfig({
    home,
    bridgeBaseUrl,
    combinedCatalogPath,
    metadataUpdates: [
      { kind: 'provider_registry', path: providerRegistryPath, text: registryText },
      { kind: 'route_policy', path: routePolicyPath, text: routePolicyText }
    ],
    now: new Date('2026-08-06T00:02:00.000Z')
  });
  assert.equal(second.ok, true);
  assert.equal(second.status, 'already_migrated');
  assert.equal(second.receipt_path, null);
  assert.equal(await fs.readFile(configPath, 'utf8'), migratedConfig);
  assert.deepEqual((await fs.readdir(path.dirname(first.receipt_path))).sort(), receiptEntries);

  const rotatedAuth = authJson(rotatedOauthAccess, rotatedOauthRefresh);
  await fs.writeFile(authPath, rotatedAuth, { mode: 0o600 });
  await configureProviderCredential({
    provider_id: 'codex-lb',
    api_key: rotatedCodexLbKey,
    host: codexLbEndpoint,
    home,
    processEnv: {}
  });
  await configureProviderCredential({
    provider_id: 'openrouter',
    api_key: rotatedOpenRouterKey,
    home,
    processEnv: { HOME: home },
    openRouterPaths
  });

  const rollback = await rollbackDesktopBridgeUnificationReceipt({ receiptPath: first.receipt_path });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.status, 'rolled_back');
  assert.equal(rollback.credentials_overwritten, false);
  assert.equal(rollback.auth_overwritten, false);
  assert.equal(await fs.readFile(configPath, 'utf8'), historicalConfig);
  await assert.rejects(fs.access(routePolicyPath));
  await assert.rejects(fs.access(providerRegistryPath));
  assert.equal(await fs.readFile(authPath, 'utf8'), rotatedAuth);

  const rotatedCredentials = await resolveAllProviderCredentials({
    codexLb: { home, processEnv: {} },
    openrouter: { processEnv: { HOME: home }, openRouterPaths }
  });
  assert.equal(rotatedCredentials['codex-lb'].secret, rotatedCodexLbKey);
  assert.equal(rotatedCredentials.openrouter.secret, rotatedOpenRouterKey);
  assertSecretFree(await fs.readFile(first.receipt_path, 'utf8'), allFixtureSecrets);

  const retiredCommand = normalizeCommand(['codex-lb', 'status']);
  assert.equal(retiredCommand.command, null);
  assert.equal(retiredCommand.aliasTarget, null);
  assert.equal(Object.hasOwn(COMMAND_ALIASES_LITE, 'codex-lb'), false);
  assert.equal(Object.hasOwn(COMMAND_MANIFEST_BY_NAME, 'codex-lb'), false);

  emitGate('desktop-bridge:unification', {
    evidence_kind: 'hermetic_fixture',
    fixture: true,
    real_execution: false,
    real_evidence_claimed: false,
    checks: {
      dual_credentials_coexist: true,
      serialized_metadata_secret_free: true,
      historical_config_migration_idempotent: true,
      rollback_preserves_rotated_credentials_and_oauth: true,
      retired_codex_lb_command_unknown_without_alias: true,
      fallback_route_absent: true
    },
    limitations: [
      'Temporary-home fixture evidence only; this does not prove a live Codex Desktop or provider execution.'
    ]
  });
} catch (error: unknown) {
  failed = error;
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

if (failed) {
  const message = failed instanceof Error ? failed.message : String(failed);
  console.error(JSON.stringify({
    schema: 'sks.release-gate.v1',
    ok: false,
    gate: 'desktop-bridge:unification',
    evidence_kind: 'hermetic_fixture',
    fixture: true,
    real_execution: false,
    real_evidence_claimed: false,
    blocker: message
  }, null, 2));
  process.exitCode = 1;
}

function authJson(accessToken: string, refreshToken: string): string {
  return `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'fixture-desktop-account',
    tokens: { access_token: accessToken, refresh_token: refreshToken }
  }, null, 2)}\n`;
}

function assertSecretFree(text: string, secrets: readonly string[]): void {
  assert.equal(text.includes('"secret"'), false);
  for (const secret of secrets) assert.equal(text.includes(secret), false);
}
