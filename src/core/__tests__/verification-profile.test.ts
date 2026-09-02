import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_VERIFICATION_PROFILE,
  hookDaemonEnabled,
  resetVerificationProfileCache,
  resolveVerificationProfile,
  verificationProfileSummary,
  writeVerificationProfile,
} from '../verification-profile.js';

const production = { HOME: '/nonexistent-home-for-profile-test' } as NodeJS.ProcessEnv;
const harness = { ...production, NODE_TEST_CONTEXT: 'child' } as NodeJS.ProcessEnv;

test('the product default is essential; the test harness default stays strict', () => {
  resetVerificationProfileCache();
  assert.equal(DEFAULT_VERIFICATION_PROFILE, 'essential');
  assert.equal(resolveVerificationProfile(null, production), 'essential');
  assert.equal(resolveVerificationProfile(null, harness), 'strict');
  assert.equal(resolveVerificationProfile(null, { ...production, SKS_TEST_ISOLATION: '1' }), 'strict');
});

test('SKS_VERIFICATION_PROFILE wins over every file and default; garbage is ignored', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-verification-profile-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  writeVerificationProfile('strict', { root, scope: 'project' }, production);
  assert.equal(resolveVerificationProfile(root, { ...production, SKS_VERIFICATION_PROFILE: 'essential' }), 'essential');
  assert.equal(resolveVerificationProfile(root, { ...harness, SKS_VERIFICATION_PROFILE: 'essential' }), 'essential');
  assert.equal(resolveVerificationProfile(root, { ...production, SKS_VERIFICATION_PROFILE: 'bogus' }), 'strict', 'invalid env falls through to the project file');
});

test('project file beats global file, global file beats the default, and the cache resets on write', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-verification-profile-root-'));
  const globalRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-verification-profile-global-'));
  t.after(async () => { await fsp.rm(root, { recursive: true, force: true }); await fsp.rm(globalRoot, { recursive: true, force: true }); });
  const env = { ...production, SKS_GLOBAL_ROOT: globalRoot } as NodeJS.ProcessEnv;
  resetVerificationProfileCache();
  assert.equal(resolveVerificationProfile(root, env), 'essential');
  assert.equal(verificationProfileSummary(root, env).source, 'default');

  writeVerificationProfile('strict', { scope: 'global' }, env);
  assert.equal(resolveVerificationProfile(root, env), 'strict');
  assert.equal(verificationProfileSummary(root, env).source, 'global_file');

  writeVerificationProfile('essential', { root, scope: 'project' }, env);
  assert.equal(resolveVerificationProfile(root, env), 'essential');
  const summary = verificationProfileSummary(root, env);
  assert.equal(summary.source, 'project_file');
  assert.equal(summary.stop_finalization_rituals, false);
  assert.equal(summary.post_tool_evidence, false);
  assert.equal(summary.manual_proof_routes_block_readiness, false);
  assert.equal(summary.managed_skill_digest_blocks, false);
});

test('the hook daemon is on by default, explicit env wins, and the harness never spawns one', () => {
  assert.equal(hookDaemonEnabled(production), true);
  assert.equal(hookDaemonEnabled(harness), false);
  assert.equal(hookDaemonEnabled({ ...harness, SKS_HOOK_DAEMON: '1' }), true);
  assert.equal(hookDaemonEnabled({ ...production, SKS_HOOK_DAEMON: '0' }), false);
});
