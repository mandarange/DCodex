import '../../core/__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexLbStatus } from '../../cli/install-helpers.js';
import { loadCodexLbEnv } from '../../core/codex-lb/codex-lb-env.js';
import { codexLbDesktopStatusV2 } from '../../core/codex-lb/desktop-controller.js';
import {
  codexLbRoutingTruthForStatus,
  doctorArgWarnings,
  inspectDoctorCodexLbSecretResolution
} from '../doctor.js';

const BASE_URL = 'https://lb.example.test/backend-api/codex';
const API_KEY = 'sk-clb-doctor-fixture-not-real';

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-codex-lb-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const binDir = path.join(home, 'bin');
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json');
  const stampPath = path.join(codexHome, 'sks-codex-lb-keychain-migration.json');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.mkdir(binDir, { recursive: true });
  return {
    home,
    codexHome,
    binDir,
    envPath,
    metadataPath,
    stampPath,
    processEnv: { HOME: home, USER: 'doctor-fixture', PATH: binDir }
  };
}

async function writeMetadata(file: string, apiKey: string) {
  await fsp.writeFile(file, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: BASE_URL,
    api_key: {
      redacted: true,
      sha256: createHash('sha256').update(apiKey).digest('hex')
    }
  })}\n`, { mode: 0o600 });
}

test('plain Doctor reports one-time prompt risk using only an attribute probe', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.envPath, `export CODEX_LB_BASE_URL='${BASE_URL}'\n`, { mode: 0o600 });
  const calls: string[][] = [];
  const before = await fsp.readFile(setup.envPath, 'utf8');

  const result = await inspectDoctorCodexLbSecretResolution({
    home: setup.home,
    processEnv: setup.processEnv,
    fix: false,
    migrationOptions: {
      platform: 'darwin',
      account: 'doctor-fixture',
      securityBin: path.join(setup.binDir, 'security'),
      runProcessImpl: async (_bin: string, args: string[], options: any) => {
        calls.push([...args]);
        assert.equal(options.env?.HOME, setup.home);
        assert.equal(options.env?.PATH, setup.binDir);
        assert.equal(options.env?.CODEX_LB_API_KEY, undefined);
        return { code: 0, stdout: 'fixture attributes only', stderr: '' } as any;
      }
    }
  });

  assert.deepEqual(result.secret_resolution, {
    source: 'missing',
    path: null,
    prompt_risk: 'one_time_on_repair'
  });
  assert.equal(result.legacy_keychain_migration.mode, 'inspect');
  assert.equal(result.legacy_keychain_migration.keychain_item_present, true);
  assert.deepEqual(calls, [[
    'find-generic-password',
    '-a',
    'doctor-fixture',
    '-s',
    'sks-codex-lb'
  ]]);
  assert.ok(!calls.flat().includes('-w'));
  assert.equal(await fsp.readFile(setup.envPath, 'utf8'), before);
  await assert.rejects(fsp.access(setup.stampPath), { code: 'ENOENT' });
});

test('Doctor fix repairs a 0644 canonical env file, then re-resolves without a secret read', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(
    setup.envPath,
    `export CODEX_LB_BASE_URL='${BASE_URL}'\nexport CODEX_LB_API_KEY='${API_KEY}'\n`,
    { mode: 0o644 }
  );
  await writeMetadata(setup.metadataPath, API_KEY);
  const calls: string[][] = [];

  const result = await inspectDoctorCodexLbSecretResolution({
    home: setup.home,
    processEnv: setup.processEnv,
    fix: true,
    baseUrl: BASE_URL,
    migrationOptions: {
      platform: 'darwin',
      account: 'doctor-fixture',
      securityBin: path.join(setup.binDir, 'security'),
      runProcessImpl: async (_bin: string, args: string[], options: any) => {
        calls.push([...args]);
        assert.equal(options.env?.HOME, setup.home);
        return args[0] === 'delete-generic-password'
          ? { code: 0, stdout: '', stderr: '' } as any
          : { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any;
      }
    }
  });

  assert.equal((await fsp.stat(setup.envPath)).mode & 0o777, 0o600);
  assert.deepEqual(result.secret_resolution, {
    source: 'env-file',
    path: setup.envPath,
    prompt_risk: 'none'
  });
  assert.equal(result.legacy_keychain_migration.status, 'legacy_keychain_removed');
  assert.equal(result.legacy_keychain_migration.keychain_deleted, true);
  assert.ok(calls.some((args) => args[0] === 'delete-generic-password'));
  assert.ok(!calls.flat().includes('-w'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
});

test('Doctor forwards explicit migration retry and recognizes its additive flag', async () => {
  let repairOptions: any = null;
  const result = await inspectDoctorCodexLbSecretResolution({
    home: '/fixture/home',
    processEnv: { HOME: '/fixture/home' },
    fix: true,
    forceRetry: true,
    baseUrl: BASE_URL
  }, {
    repairImpl: async (options: any) => {
      repairOptions = options;
      return {
        schema: 'sks.codex-lb-legacy-keychain-reconciliation.v1',
        ok: true,
        status: 'legacy_keychain_absent',
        mode: 'repair',
        env_key_valid: false,
        keychain_item_present: false,
        prompt_risk: 'none',
        attempted: false,
        stamp_path: '/fixture/stamp',
        stamp_outcome: null,
        keychain_deleted: false,
        keychain_cleared: [],
        blockers: []
      };
    },
    loadEnvImpl: async () => ({ source: 'missing', env_paths: ['/fixture/env'], blockers: [] })
  });

  assert.equal(repairOptions.forceRetry, true);
  assert.equal(repairOptions.baseUrl, BASE_URL);
  assert.equal(result.secret_resolution.prompt_risk, 'none');
  assert.deepEqual(doctorArgWarnings(['--fix', '--retry-codex-lb-keychain-migration']), []);
});

test('Doctor probe, status, and load sequence never executes PATH-shadowed security', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(
    setup.envPath,
    `export CODEX_LB_BASE_URL='${BASE_URL}'\nexport CODEX_LB_API_KEY='${API_KEY}'\n`,
    { mode: 0o600 }
  );
  await writeMetadata(setup.metadataPath, API_KEY);
  const invoked = path.join(setup.home, 'path-security-invoked');
  await fsp.writeFile(
    path.join(setup.binDir, 'security'),
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(invoked)}\nexit 1\n`,
    { mode: 0o755 }
  );

  const doctorProbe = await inspectDoctorCodexLbSecretResolution({
    home: setup.home,
    processEnv: setup.processEnv,
    fix: false,
    migrationOptions: {
      platform: 'darwin',
      securityBin: '/usr/bin/false',
      account: 'doctor-fixture'
    }
  });
  const status = await codexLbStatus({
    home: setup.home,
    processEnv: setup.processEnv,
    env: setup.processEnv,
    platform: 'linux',
    launchctlBin: '/usr/bin/false',
    probeToolOutputRecovery: false
  });
  const loaded = await loadCodexLbEnv({
    home: setup.home,
    processEnv: setup.processEnv
  });

  assert.equal(doctorProbe.secret_resolution.source, 'env-file');
  assert.equal(status.secret_resolution.source, 'env-file');
  assert.equal(loaded.source, 'env-file');
  await assert.rejects(fsp.access(invoked), { code: 'ENOENT' });
});

test('fast JSON Doctor source includes the same report-only payload wiring', async () => {
  const source = await fsp.readFile(path.join(process.cwd(), 'src', 'commands', 'doctor.ts'), 'utf8');
  const dispatcher = await fsp.readFile(path.join(process.cwd(), 'src', 'bin', 'sks-dispatch.ts'), 'utf8');
  const inline = await fsp.readFile(path.join(process.cwd(), 'src', 'bin', 'fast-inline.ts'), 'utf8');
  const fastPath = source.slice(
    source.indexOf('async function runDoctorJsonFastPath'),
    source.indexOf('async function runDoctor(', source.indexOf('async function runDoctorJsonFastPath'))
  );
  assert.match(fastPath, /inspectDoctorCodexLbSecretResolution\(\{ processEnv: process\.env, fix: false \}\)/);
  assert.match(fastPath, /secret_resolution: codexLbSecretProbe\.secret_resolution/);
  assert.match(fastPath, /legacy_keychain_migration: codexLbSecretProbe\.legacy_keychain_migration/);
  assert.match(dispatcher, /await doctorJsonFastInline\(\)/);
  assert.match(dispatcher, /!args\.includes\('--profile'\)/);
  assert.match(inline, /codex_lb:\s*\{\s*secret_resolution: secretResolution/);
});

test('default Doctor routing probe performs one authenticated measurement and writes a private durable receipt', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(
    setup.envPath,
    `export CODEX_LB_BASE_URL='${BASE_URL}'\nexport CODEX_LB_API_KEY='${API_KEY}'\n`,
    { mode: 0o600 }
  );
  await writeMetadata(setup.metadataPath, API_KEY);
  const configPath = path.join(setup.codexHome, 'config.toml');
  await fsp.writeFile(configPath, [
    '# sks-codex-lb-managed-provider-selection',
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${BASE_URL}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));
  const receiptPath = path.join(setup.codexHome, 'routing-truth.json');
  const requests: Array<{ url: string; authorization: string | null; gatewayKey: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      gatewayKey: new Headers(init?.headers).get('x-codex-lb-api-key')
    });
    return new Response('{"data":[]}', { status: 200 });
  };

  const truth = await codexLbRoutingTruthForStatus({
    selected: true,
    env_path: setup.envPath,
    base_url: BASE_URL
  }, { fetchImpl, receiptPath });

  assert.ok(truth);
  assert.equal(truth.ok, true);
  assert.equal(truth.status, 'verified');
  assert.equal(truth.selected, true);
  assert.equal(truth.measured, true);
  assert.equal(truth.fresh, true);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.match(request.url, /\/backend-api\/codex\/models$/);
  assert.equal(request.authorization, `Bearer ${API_KEY}`);
  assert.equal(request.gatewayKey, null);
  const receiptText = await fsp.readFile(receiptPath, 'utf8');
  assert.doesNotMatch(receiptText, new RegExp(API_KEY));
  assert.equal((await fsp.stat(receiptPath)).mode & 0o777, 0o600);

  const statusSurface = await codexLbDesktopStatusV2({
    home: setup.home,
    configPath,
    envPath: setup.envPath,
    metadataPath: setup.metadataPath,
    routingTruthReceiptPath: receiptPath,
    platform: 'linux',
    networkProbes: false
  });
  const statusTruth = statusSurface.routing_truth as Record<string, unknown>;
  assert.equal(statusTruth.checked_at, truth.checked_at);
  assert.equal(statusTruth.actual_host, truth.actual_host);
  assert.equal(statusTruth.auth_transport, truth.auth_transport);
});

test('Doctor routing truth writes to the injected home when a status fixture omits env_path', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(
    setup.envPath,
    `export CODEX_LB_BASE_URL='${BASE_URL}'\nexport CODEX_LB_API_KEY='${API_KEY}'\n`,
    { mode: 0o600 }
  );
  await writeMetadata(setup.metadataPath, API_KEY);
  const defaultReceiptPath = path.join(
    process.env.HOME || os.homedir(),
    '.codex',
    'sks-codex-lb-routing-truth.json'
  );
  const defaultReceiptBefore = await fsp.readFile(defaultReceiptPath).catch(() => null);

  const truth = await codexLbRoutingTruthForStatus({
    selected: false,
    base_url: BASE_URL
  }, { home: setup.home });

  assert.equal(truth?.status, 'ready_unselected');
  await fsp.access(path.join(setup.codexHome, 'sks-codex-lb-routing-truth.json'));
  const defaultReceiptAfter = await fsp.readFile(defaultReceiptPath).catch(() => null);
  assert.deepEqual(defaultReceiptAfter, defaultReceiptBefore);
});
