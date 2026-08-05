import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectImagegenCapability } from '../../dist/core/imagegen/imagegen-capability.js';

test('imagegen capability records gpt-image-2 fidelity policy', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-fake-only-'));
  const capability = await detectImagegenCapability({
    fake: true,
    codexBin: path.join(home, 'missing-codex'),
    env: { HOME: home },
    configText: ''
  });
  assert.equal(capability.ok, true);
  assert.equal(capability.model, 'gpt-image-2');
  assert.equal(capability.input_fidelity_must_be_omitted, true);
  assert.equal(capability.gpt_image_2_input_fidelity_automatic, true);
  assert.equal(capability.fake_adapter.available, true);
  assert.equal(capability.fake_adapter.accepted_for_route_readiness, false);
  assert.equal(capability.core_feature, true);
  assert.equal(capability.core_ready, false);
  assert.equal(capability.codex_app_builtin_output_required, true);
  assert.equal(capability.capability_detection_is_not_output_proof, true);
  assert.deepEqual(capability.core_blockers, ['codex_app_builtin_imagegen_capability_missing']);
  assert.deepEqual(capability.route_generation_blockers, ['imagegen_capability_missing']);
  assert.deepEqual(capability.blockers, ['codex_app_builtin_imagegen_capability_missing', 'imagegen_capability_missing']);
});

test('imagegen capability reads the supported plain codex features list output', async () => {
  const codexBin = await writeFakeCodex(`
codex_git_commit                    stable             true
image_generation                    stable             true
remote_control                      stable             false
`);
  // The shebang starts a second Node process; under the parallel canonical
  // runner its cold start can exceed 1s. This fixture tests feature parsing,
  // so use the production probe budget instead of turning scheduler load into
  // a false missing-capability result.
  const capability = await withoutCodexImagegenEnv(() => detectImagegenCapability({ codexBin, timeoutMs: 5000 }));
  assert.equal(capability.codex_app.available, true);
  assert.equal(capability.codex_app.official_surface, '$imagegen');
  assert.equal(capability.codex_app.generated_output_required_for_full_verification, true);
  assert.equal(capability.core_ready, true);
  assert.equal(capability.real_generation_available, true);
  assert.equal(capability.real_output_verified_by_capability_check, false);
  assert.equal(capability.openai_images_api.official_codex_app_substitute, false);
  assert.equal(capability.api_fallback_satisfies_codex_app_evidence, false);
  assert.equal(capability.codex_app.detector, 'codex_features_list');
  assert.match(String(capability.codex_app.raw), /image_generation\s+stable\s+true/);
  assert.equal(capability.supported_workflows.ux_review_callouts, true);
});

test('imagegen capability plain feature reader respects disabled value', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-disabled-'));
  const codexBin = await writeFakeCodex(`
codex_git_commit                    stable             true
image_generation                    stable             false
remote_control                      stable             true
`);
  const capability = await withoutCodexImagegenEnv(() => detectImagegenCapability({
    codexBin,
    timeoutMs: 5000,
    env: { HOME: home },
    configText: ''
  }));
  assert.equal(capability.codex_app.available, false);
  assert.equal(capability.core_ready, false);
  assert.equal(capability.codex_app.blocker, 'codex_app_imagegen_not_detected');
});

test('imagegen capability fails closed when Desktop Bridge status is unavailable', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-bridge-unavailable-'));
  const capability = await withoutCodexImagegenEnv(() => detectImagegenCapability({
    codexBin: path.join(home, 'missing-codex'),
    timeoutMs: 100,
    env: { HOME: home },
    desktopBridgeStatusImpl: async () => null
  }));
  assert.equal(capability.codex_lb.available, false);
  assert.equal(capability.codex_lb.selected, false);
  assert.equal(capability.codex_lb.blocker, 'desktop_bridge_status_unavailable');
  assert.equal(capability.codex_lb.satisfies_codex_app_builtin_evidence, false);
  assert.equal(capability.codex_lb.accepted_for_core_readiness, false);
  assert.equal(capability.openai_images_api.available, false);
  assert.equal(capability.openai_images_api.auth_source, null);
  assert.equal(capability.openai_images_api.codex_lb_proxy?.accepted_for_core_readiness || false, false);
  assert.equal(capability.core_ready, false);
  assert.equal(capability.real_generation_available, false);
  assert.equal(capability.supported_workflows.ppt_slide_callouts, false);
  assert.deepEqual(capability.core_blockers, ['codex_app_builtin_imagegen_capability_missing']);
  assert.deepEqual(capability.route_generation_blockers, ['imagegen_capability_missing']);
  assert.deepEqual(capability.blockers, ['codex_app_builtin_imagegen_capability_missing', 'imagegen_capability_missing']);
});

test('verified Desktop Bridge provider capability does not substitute for Codex App imagegen evidence', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-desktop-bridge-'));
  const capability = await withoutCodexImagegenEnv(() => detectImagegenCapability({
    codexBin: path.join(home, 'missing-codex'),
    timeoutMs: 100,
    env: { HOME: home },
    desktopBridgeStatus: desktopBridgeImagegenStatus()
  }));
  assert.equal(capability.codex_lb.available, true);
  assert.equal(capability.codex_lb.selected, true);
  assert.equal(capability.codex_lb.routing_active, true);
  assert.equal(capability.codex_lb.blocker, null);
  assert.equal(capability.codex_lb.capability_evidence.state, 'verified');
  assert.equal(capability.openai_images_api.available, false);
  assert.equal(capability.openai_images_api.codex_lb_proxy.accepted_for_core_readiness, false);
  assert.equal(capability.core_ready, false);
  assert.deepEqual(capability.core_blockers, ['codex_app_builtin_imagegen_capability_missing']);
  assert.deepEqual(capability.route_generation_blockers, ['imagegen_capability_missing']);
  assert.deepEqual(capability.blockers, ['codex_app_builtin_imagegen_capability_missing', 'imagegen_capability_missing']);
});

test('imagegen capability records explicit OpenAI API fallback without satisfying core Codex App readiness', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-openai-api-'));
  const capability = await withoutCodexImagegenEnv(() => detectImagegenCapability({
    codexBin: path.join(home, 'missing-codex'),
    timeoutMs: 100,
    env: { HOME: home, OPENAI_API_KEY: 'sk-test' },
    configText: ''
  }));
  assert.equal(capability.openai_images_api.available, true);
  assert.equal(capability.openai_images_api.auth_source, 'OPENAI_API_KEY');
  assert.equal(capability.openai_images_api.official_codex_app_substitute, false);
  assert.equal(capability.core_ready, false);
  assert.equal(capability.real_generation_available, false);
  assert.equal(capability.supported_workflows.ux_review_callouts, false);
  assert.deepEqual(capability.core_blockers, ['codex_app_builtin_imagegen_capability_missing']);
  assert.deepEqual(capability.route_generation_blockers, ['imagegen_capability_missing']);
  assert.deepEqual(capability.blockers, ['codex_app_builtin_imagegen_capability_missing', 'imagegen_capability_missing']);
});

async function writeFakeCodex(featuresOutput) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-capability-'));
  const codexBin = path.join(dir, 'codex');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ') === 'features list --json') {
  console.error("error: unexpected argument '--json'");
  process.exit(2);
}
if (args.join(' ') === 'features list') {
  process.stdout.write(${JSON.stringify(featuresOutput.trimStart())});
  process.exit(0);
}
console.error('unexpected args: ' + args.join(' '));
process.exit(64);
`;
  await fsp.writeFile(codexBin, script, { mode: 0o755 });
  return codexBin;
}

function desktopBridgeImagegenStatus() {
  return {
    schema: 'sks.desktop-bridge-status.v3',
    checked_at: '2026-08-06T00:00:00.000Z',
    providers: {
      'codex-lb': {
        enabled: true,
        credential: { state: 'ready', source: 'user-secret-store', blockers: [] },
        endpoint: {
          configured: true,
          origin_redacted: 'https://lb.example.test',
          auth_transport: 'authorization-bearer'
        },
        capabilities: {
          capabilities: {
            image_generation: { state: 'verified', blockers: [] }
          }
        }
      }
    },
    routing: {
      policy: {
        default_provider_id: 'codex-lb',
        fallback: 'none',
        model_routes: {
          'gpt-image-2': { provider_id: 'codex-lb', upstream_model: 'gpt-image-2' }
        }
      }
    }
  };
}

async function withoutCodexImagegenEnv(fn) {
  const previous = process.env.SKS_CODEX_APP_IMAGEGEN_AVAILABLE;
  const previousFake = process.env.SKS_TEST_FAKE_IMAGEGEN;
  delete process.env.SKS_CODEX_APP_IMAGEGEN_AVAILABLE;
  delete process.env.SKS_TEST_FAKE_IMAGEGEN;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.SKS_CODEX_APP_IMAGEGEN_AVAILABLE;
    } else {
      process.env.SKS_CODEX_APP_IMAGEGEN_AVAILABLE = previous;
    }
    if (previousFake === undefined) {
      delete process.env.SKS_TEST_FAKE_IMAGEGEN;
    } else {
      process.env.SKS_TEST_FAKE_IMAGEGEN = previousFake;
    }
  }
}
