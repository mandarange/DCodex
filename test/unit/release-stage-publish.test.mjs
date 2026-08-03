import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { stagePublish } from '../../dist/core/release/stage-publish.js';

// A runner that records every command instead of executing one, so the tests
// assert on exactly which outward-facing actions the flow would take.
function recorder(responses = {}) {
  const calls = [];
  const run = (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    for (const [pattern, value] of Object.entries(responses)) {
      if (key.includes(pattern)) return { status: 0, stdout: '', stderr: '', ...value };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

const GREEN_PREFLIGHT = {
  'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'status --porcelain': { stdout: '' },
  'rev-parse HEAD': { stdout: 'a'.repeat(40) + '\n' },
  'npx --yes npm@11.15.0 --version': { stdout: '11.15.0\n' },
  'auth status': { status: 0 }
};

function options(overrides = {}) {
  const { calls, run } = overrides.recorder || recorder(GREEN_PREFLIGHT);
  return {
    calls,
    opts: {
      root: process.cwd(),
      version: '7.3.0',
      run,
      readJsonFile: () => ({ version: '7.3.0' }),
      env: {},
      ...overrides.opts
    }
  };
}

// The property that matters: a bare `sks release stage` must never push, never
// dispatch the workflow, and never reach the registry.
test('without --confirm nothing outward-facing runs', () => {
  const { calls, opts } = options();
  const report = stagePublish(opts);
  assert.equal(report.confirmed, false);
  assert.ok(!calls.some((call) => call.startsWith('git push')), calls.join('\n'));
  assert.ok(!calls.some((call) => call.includes('workflow run')), calls.join('\n'));
  assert.match(report.next_actions.join(' '), /--confirm/);
});

test('an unclean tree or a non-main branch blocks before any outward step', () => {
  for (const [pattern, value, blocker] of [
    ['rev-parse --abbrev-ref HEAD', { stdout: 'feature\n' }, 'stage_requires_main_branch'],
    ['status --porcelain', { stdout: ' M src/x.ts\n' }, 'stage_requires_clean_tree']
  ]) {
    const rec = recorder({ ...GREEN_PREFLIGHT, [pattern]: value });
    const { opts } = options({ recorder: rec, opts: { confirm: true } });
    const report = stagePublish(opts);
    assert.equal(report.ok, false);
    assert.ok(report.blockers.includes(blocker), `${blocker}: ${report.blockers.join(',')}`);
    assert.ok(!rec.calls.some((call) => call.startsWith('git push')), rec.calls.join('\n'));
  }
});

test('an invalid full release stamp blocks before main is pushed', () => {
  const rec = recorder({
    ...GREEN_PREFLIGHT,
    'release-check-stamp.js verify': { status: 1, stderr: 'release stamp is stale' }
  });
  const { opts } = options({ recorder: rec, opts: { confirm: true } });
  const report = stagePublish(opts);
  assert.equal(report.ok, false);
  assert.ok(report.blockers.includes('stage_release_stamp_invalid'), report.blockers.join(','));
  assert.ok(!rec.calls.some((call) => call.startsWith('git push')), rec.calls.join('\n'));
  assert.equal(report.steps.find((step) => step.id === 'release_stamp')?.detail, 'release stamp is stale');
});

test('the exact npm stage CLI must resolve before push or workflow dispatch', () => {
  for (const [value, blocker] of [
    [{ stdout: '11.14.0\n' }, 'stage_npm_cli_version_mismatch'],
    [{ status: 1, stderr: 'could not resolve npm@11.15.0' }, 'stage_npm_cli_unavailable']
  ]) {
    const rec = recorder({
      ...GREEN_PREFLIGHT,
      'npx --yes npm@11.15.0 --version': value
    });
    const { opts } = options({ recorder: rec, opts: { confirm: true } });
    const report = stagePublish(opts);
    assert.equal(report.ok, false);
    assert.ok(report.blockers.includes(blocker), `${blocker}: ${report.blockers.join(',')}`);
    assert.ok(!rec.calls.some((call) => call.startsWith('git push')), rec.calls.join('\n'));
    assert.ok(!rec.calls.some((call) => call.includes('workflow run')), rec.calls.join('\n'));
  }
});

test('CI or OIDC review environments block before push or workflow dispatch', () => {
  for (const [env, blocker] of [
    [{ CI: 'true' }, 'stage_ci_environment_not_allowed'],
    [{ ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }, 'stage_oidc_environment_not_allowed']
  ]) {
    const rec = recorder(GREEN_PREFLIGHT);
    const { opts } = options({ recorder: rec, opts: { confirm: true, env } });
    const report = stagePublish(opts);
    assert.equal(report.ok, false);
    assert.ok(report.blockers.includes(blocker), `${blocker}: ${report.blockers.join(',')}`);
    assert.ok(!rec.calls.some((call) => call.startsWith('git push')), rec.calls.join('\n'));
    assert.ok(!rec.calls.some((call) => call.includes('workflow run')), rec.calls.join('\n'));
  }
});

test('a failed push stops before the workflow is dispatched', () => {
  const rec = recorder({ ...GREEN_PREFLIGHT, 'git push': { status: 1, stderr: 'rejected' } });
  const { opts } = options({ recorder: rec, opts: { confirm: true } });
  const report = stagePublish(opts);
  assert.ok(report.blockers.includes('stage_push_failed'));
  assert.ok(!rec.calls.some((call) => call.includes('workflow run')), rec.calls.join('\n'));
});

// Automation must stop before approval: the command is printed, never executed.
test('the approval command is reported but never run', () => {
  const commit = 'a'.repeat(40);
  const artifactDir = '/tmp/sks-stage-fixture';
  const rec = recorder({
    ...GREEN_PREFLIGHT,
    'run list': { stdout: JSON.stringify([{ databaseId: 4242, headSha: commit, status: 'completed' }]) }
  });
  const { opts } = options({
    recorder: rec,
    opts: {
      confirm: true,
      artifactDir,
      readJsonFile: (file) => (file === path.join(artifactDir, 'stage-receipt.json')
        ? { stage_id: '11111111-2222-3333-4444-555555555555' }
        : { version: '7.3.0' })
    }
  });
  const report = stagePublish(opts);
  assert.equal(report.stage_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(report.approval_command, 'npm stage approve 11111111-2222-3333-4444-555555555555');
  assert.equal(report.approval_is_human_2fa_step, true);
  assert.ok(!rec.calls.some((call) => call.includes('stage approve')), rec.calls.join('\n'));
  assert.ok(!rec.calls.some((call) => call.includes('npm publish')), rec.calls.join('\n'));
});

test('multi-artifact downloads discover the nested receipt and verify the named handoff', () => {
  const commit = 'a'.repeat(40);
  const artifactDir = '/tmp/sks-stage-multi-artifact-fixture';
  const receiptPath = path.join(artifactDir, `npm-stage-receipt-${commit}`, 'stage-receipt.json');
  const handoffDir = path.join(artifactDir, `stage-input-${commit}`);
  const rec = recorder({
    ...GREEN_PREFLIGHT,
    'run list': { stdout: JSON.stringify([{ databaseId: 4242, headSha: commit, status: 'completed' }]) }
  });
  const { opts } = options({
    recorder: rec,
    opts: {
      confirm: true,
      artifactDir,
      readJsonFile: (file) => (file === receiptPath
        ? { stage_id: '11111111-2222-3333-4444-555555555555' }
        : null)
    }
  });

  const report = stagePublish(opts);

  assert.equal(report.stage_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(report.steps.find((entry) => entry.id === 'stage_receipt')?.detail, receiptPath);
  const download = rec.calls.find((call) => call.startsWith('gh run download')) || '';
  assert.match(download, new RegExp(`--name stage-input-${commit}(?: |$)`));
  assert.match(download, new RegExp(`--name npm-stage-receipt-${commit}(?: |$)`));
  const verify = rec.calls.find((call) => call.includes('npm-stage-tarball-verifier.js')) || '';
  assert.match(verify, new RegExp(`--local-receipt ${escapeRegex(path.join(handoffDir, 'pack-receipt.json'))}(?: |$)`));
  assert.match(verify, new RegExp(`--local-tarball ${escapeRegex(path.join(handoffDir, 'sneakoscope-7.3.0.tgz'))}(?: |$)`));
  assert.match(verify, new RegExp(`--stage-receipt ${escapeRegex(receiptPath)}(?: |$)`));
});

test('a stage id that is not a uuid is rejected rather than approved', () => {
  const commit = 'a'.repeat(40);
  const artifactDir = '/tmp/sks-stage-fixture';
  const rec = recorder({
    ...GREEN_PREFLIGHT,
    'run list': { stdout: JSON.stringify([{ databaseId: 7, headSha: commit, status: 'completed' }]) }
  });
  const { opts } = options({
    recorder: rec,
    opts: {
      confirm: true,
      artifactDir,
      readJsonFile: (file) => (file === path.join(artifactDir, 'stage-receipt.json')
        ? { stage_id: 'not-a-uuid' }
        : { version: '7.3.0' })
    }
  });
  const report = stagePublish(opts);
  assert.equal(report.stage_id, null);
  assert.equal(report.approval_command, null);
  assert.ok(report.blockers.includes('stage_id_uuid_invalid'));
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
