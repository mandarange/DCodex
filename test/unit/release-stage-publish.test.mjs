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
      if (key.includes(pattern)) {
        const resolved = typeof value === 'function' ? value(key, calls) : value;
        return { status: 0, stdout: '', stderr: '', ...resolved };
      }
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
  'npx --yes npm@11.15.0 whoami': { stdout: 'cdw0424\n' },
  'npx --yes npm@11.15.0 view sneakoscope maintainers': { stdout: '[{"name":"cdw0424","email":"cdw0424@gmail.com"}]\n' },
  'npx --yes npm@11.15.0 stage list sneakoscope': { stdout: '[]\n' },
  'release-physical-gates-check.js': { stdout: '{"ok":true,"blockers":[]}\n' },
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
      readJsonFile: () => ({ name: 'sneakoscope', version: '7.3.0' }),
      env: {},
      ...overrides.opts
    }
  };
}

// The property that matters: a bare `sks release stage` may perform read-only
// authentication and visibility checks, but must never push, dispatch, stage,
// approve, or publish anything.
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

test('missing physical release receipts block before main is pushed', () => {
  const rec = recorder({
    ...GREEN_PREFLIGHT,
    'release-physical-gates-check.js': {
      status: 1,
      stdout: JSON.stringify({ ok: false, blockers: ['physical_receipt_gate_missing:telegram_cellular_e2e'] })
    }
  });
  const { opts } = options({ recorder: rec, opts: { confirm: true } });
  const report = stagePublish(opts);
  assert.equal(report.ok, false);
  assert.ok(report.blockers.includes('stage_physical_release_gates_invalid'));
  assert.match(report.steps.find((step) => step.id === 'physical_release_gates')?.detail || '', /telegram_cellular_e2e/);
  assert.ok(!rec.calls.some((call) => call.startsWith('git push')), rec.calls.join('\n'));
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

test('npm authentication and staged-version visibility must pass before push or dispatch', () => {
  for (const [pattern, value, blocker] of [
    ['npx --yes npm@11.15.0 whoami', { status: 1, stderr: 'E401' }, 'stage_npm_not_authenticated'],
    ['npx --yes npm@11.15.0 view sneakoscope maintainers', { stdout: '[{"name":"another-owner"}]' }, 'stage_npm_user_not_maintainer'],
    ['npx --yes npm@11.15.0 stage list sneakoscope', { status: 1, stderr: 'forbidden' }, 'stage_npm_stage_list_unavailable'],
    ['npx --yes npm@11.15.0 stage list sneakoscope', { stdout: JSON.stringify([{ id: '11111111-2222-3333-4444-555555555555', version: '7.3.0' }]) }, 'stage_version_already_staged']
  ]) {
    const rec = recorder({ ...GREEN_PREFLIGHT, [pattern]: value });
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
    'run list': runListSequence(commit, 4242)
  });
  const { opts } = options({
    recorder: rec,
    opts: {
      confirm: true,
      artifactDir,
      readJsonFile: (file) => (file === path.join(artifactDir, 'stage-receipt.json')
        ? { stage_id: '11111111-2222-3333-4444-555555555555' }
        : { name: 'sneakoscope', version: '7.3.0' })
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
    'run list': runListSequence(commit, 4242)
  });
  const { opts } = options({
    recorder: rec,
    opts: {
      confirm: true,
      artifactDir,
      readJsonFile: (file) => (file === receiptPath
        ? { stage_id: '11111111-2222-3333-4444-555555555555' }
        : { name: 'sneakoscope', version: '7.3.0' })
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
    'run list': runListSequence(commit, 7)
  });
  const { opts } = options({
    recorder: rec,
    opts: {
      confirm: true,
      artifactDir,
      readJsonFile: (file) => (file === path.join(artifactDir, 'stage-receipt.json')
        ? { stage_id: 'not-a-uuid' }
        : { name: 'sneakoscope', version: '7.3.0' })
    }
  });
  const report = stagePublish(opts);
  assert.equal(report.stage_id, null);
  assert.equal(report.approval_command, null);
  assert.ok(report.blockers.includes('stage_id_uuid_invalid'));
});

test('a prior workflow run for the same commit is never selected after dispatch', () => {
  const commit = 'a'.repeat(40);
  const prior = { databaseId: 101, headSha: commit, status: 'completed', event: 'workflow_dispatch' };
  const current = { databaseId: 202, headSha: commit, status: 'queued', event: 'workflow_dispatch' };
  let calls = 0;
  const rec = recorder({
    ...GREEN_PREFLIGHT,
    'run list': () => ({ stdout: JSON.stringify(calls++ === 0 ? [prior] : [current, prior]) })
  });
  const { opts } = options({ recorder: rec, opts: { confirm: true } });
  const report = stagePublish(opts);
  assert.equal(report.run_id, '202');
  assert.ok(rec.calls.some((call) => call === 'gh run watch 202 --exit-status'), rec.calls.join('\n'));
  assert.ok(!rec.calls.some((call) => call === 'gh run watch 101 --exit-status'), rec.calls.join('\n'));
});

function runListSequence(commit, databaseId) {
  let calls = 0;
  return () => ({
    stdout: JSON.stringify(calls++ === 0
      ? []
      : [{ databaseId, headSha: commit, status: 'completed', event: 'workflow_dispatch' }])
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
