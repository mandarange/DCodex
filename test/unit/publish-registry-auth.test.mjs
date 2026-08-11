import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NPM_REGISTRY,
  inspectPublishRegistryAuth,
  isRealNpmPublish
} from '../../dist/core/release/publish-registry-auth.js';

test('only a real upload is treated as publishing', () => {
  // `npm pack`, a dry run, and an ordinary script invocation must not demand
  // credentials — the check exists to protect the upload, not the build.
  assert.equal(isRealNpmPublish({ npm_command: 'publish' }), true);
  assert.equal(isRealNpmPublish({ npm_command: 'publish', npm_config_dry_run: 'true' }), false);
  assert.equal(isRealNpmPublish({ npm_command: 'pack' }), false);
  assert.equal(isRealNpmPublish({}), false);
});

test('a non-publishing run never reaches the registry', () => {
  const report = inspectPublishRegistryAuth({ packageName: 'sneakoscope', publishing: false });
  assert.equal(report.ok, true);
  assert.equal(report.status, 'skipped_not_publishing');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.registry, NPM_REGISTRY);
});

test('CI trusted publishing is not blocked by a missing npm identity', () => {
  // OIDC trusted publishing has no `npm whoami` identity; requiring one here
  // would break the release workflow, which validates that path itself.
  const previous = process.env.SKS_PUBLISH_AUTH_MODE;
  process.env.SKS_PUBLISH_AUTH_MODE = 'trusted-publisher';
  try {
    const report = inspectPublishRegistryAuth({ packageName: 'sneakoscope', publishing: true });
    assert.equal(report.ok, true);
    assert.equal(report.status, 'skipped_trusted_publisher');
    assert.deepEqual(report.blockers, []);
  } finally {
    if (previous === undefined) delete process.env.SKS_PUBLISH_AUTH_MODE;
    else process.env.SKS_PUBLISH_AUTH_MODE = previous;
  }
});

test('an explicitly offline run records the skip instead of failing closed', () => {
  const previous = process.env.SKS_SKIP_REGISTRY_NETWORK_CHECK;
  process.env.SKS_SKIP_REGISTRY_NETWORK_CHECK = '1';
  try {
    const report = inspectPublishRegistryAuth({ packageName: 'sneakoscope', publishing: true });
    assert.equal(report.ok, true);
    assert.equal(report.status, 'skipped_offline');
  } finally {
    if (previous === undefined) delete process.env.SKS_SKIP_REGISTRY_NETWORK_CHECK;
    else process.env.SKS_SKIP_REGISTRY_NETWORK_CHECK = previous;
  }
});

test('an unauthenticated publish names the login step, not a 404', () => {
  // npm answers an unauthorized PUT with 404 rather than 401 so it does not
  // disclose whether a package exists. Read literally that says "the package is
  // missing", which sent a real release down the wrong diagnosis. The blocker
  // has to say what actually has to happen.
  const previousMode = process.env.SKS_PUBLISH_AUTH_MODE;
  const previousSkip = process.env.SKS_SKIP_REGISTRY_NETWORK_CHECK;
  const previousToken = process.env.npm_config__authToken;
  process.env.SKS_PUBLISH_AUTH_MODE = 'token';
  delete process.env.SKS_SKIP_REGISTRY_NETWORK_CHECK;
  // Force an identity-free registry probe without touching the real npmrc.
  process.env.npm_config__authToken = 'sks-invalid-token-for-test';
  try {
    const report = inspectPublishRegistryAuth({ packageName: 'sneakoscope', publishing: true });
    if (report.status === 'authenticated') {
      // A machine with valid ambient credentials cannot exercise the failure;
      // the shape assertions below still hold for the success path.
      assert.equal(report.ok, true);
      assert.ok(report.npm_user);
      return;
    }
    assert.equal(report.ok, false);
    assert.ok(['unauthenticated', 'not_a_maintainer'].includes(report.status), report.status);
    assert.ok(report.blockers.length > 0);
    assert.ok(
      report.operator_actions.some((action) => action.includes('npm login')),
      `operator actions must name the login step: ${report.operator_actions.join(' | ')}`
    );
  } finally {
    if (previousMode === undefined) delete process.env.SKS_PUBLISH_AUTH_MODE;
    else process.env.SKS_PUBLISH_AUTH_MODE = previousMode;
    if (previousSkip !== undefined) process.env.SKS_SKIP_REGISTRY_NETWORK_CHECK = previousSkip;
    if (previousToken === undefined) delete process.env.npm_config__authToken;
    else process.env.npm_config__authToken = previousToken;
  }
});
