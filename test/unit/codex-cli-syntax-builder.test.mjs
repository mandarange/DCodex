import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexExecArgs } from '../../dist/core/codex/codex-cli-syntax-builder.js';

test('codex exec args include official fast service tier config', () => {
  const args = buildCodexExecArgs({
    json: true,
    outputSchema: '/tmp/agent-result.schema.json',
    outputLastMessage: '/tmp/agent-result.json',
    ephemeral: true,
    skipGitRepoCheck: true,
    profile: 'agent-fast',
    ignoreRules: true,
    sandbox: 'workspace-write',
    serviceTier: 'fast',
    prompt: 'complete the worker task'
  });

  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), 'complete the worker task');
  assert.ok(args.includes('--json'));
  assert.equal(args[args.indexOf('--profile') + 1], 'agent-fast');
  assert.equal(args.includes('--ignore-user-config'), false);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('service_tier=fast'));
});

test('codex exec args reject unsupported mode combinations', () => {
  assert.throws(
    () => buildCodexExecArgs({ prompt: 'x', profile: 'p', ignoreUserConfig: true }),
    /cannot combine --profile/
  );
  assert.throws(
    () => buildCodexExecArgs({ prompt: 'x', danger: true }),
    /allowDanger=true/
  );
});

test('codex exec args keep the default path away from current unsafe automation flags', () => {
  const args = buildCodexExecArgs({ prompt: 'x', sandbox: 'workspace-write', serviceTier: 'fast' });
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
});

test('removed full-auto compatibility options are absent from the builder surface', () => {
  assert.doesNotMatch(String(buildCodexExecArgs), /fullAuto|--full-auto|allowFullAuto/);
});

test('codex exec args normalize desktop service tier aliases to SKS canonical tiers', () => {
  assert.ok(buildCodexExecArgs({ prompt: 'x', serviceTier: 'priority' }).includes('service_tier=fast'));
  assert.ok(buildCodexExecArgs({ prompt: 'x', serviceTier: 'default' }).includes('service_tier=standard'));
});
