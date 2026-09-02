import assert from 'node:assert/strict';
import test from 'node:test';
import { managedHookEventNames, mergeManagedHooksJson } from '../init.js';
import { resetVerificationProfileCache } from '../verification-profile.js';

async function withProfile<T>(profile: 'essential' | 'strict', run: () => T | Promise<T>): Promise<T> {
  const prior = process.env.SKS_VERIFICATION_PROFILE;
  process.env.SKS_VERIFICATION_PROFILE = profile;
  resetVerificationProfileCache();
  try { return await run(); }
  finally {
    if (prior === undefined) delete process.env.SKS_VERIFICATION_PROFILE; else process.env.SKS_VERIFICATION_PROFILE = prior;
    resetVerificationProfileCache();
  }
}

test('essential installs no PostToolUse hook; strict keeps all ten events', async () => {
  const essential = await withProfile('essential', () => managedHookEventNames());
  assert.equal(essential.includes('PostToolUse'), false);
  assert.ok(essential.includes('PreToolUse'));
  assert.ok(essential.includes('Stop'));
  assert.ok(essential.includes('SubagentStart'), 'subagent lifecycle hooks only fire during fan-out and stay');
  const strict = await withProfile('strict', () => managedHookEventNames());
  assert.equal(strict.includes('PostToolUse'), true);
  assert.equal(strict.length, 10);
});

test('merging into a legacy hooks.json removes the SKS PostToolUse entry but keeps a user-authored one', async () => {
  const legacy = JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'sks hook post-tool', statusMessage: 'SKS recording tool evidence' }] },
        { matcher: 'Read', hooks: [{ type: 'command', command: 'my-own-audit-tool --log' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'sks hook stop', statusMessage: 'SKS checking done gate' }] }],
    },
  });
  const merged = JSON.parse(await withProfile('essential', () => mergeManagedHooksJson(legacy, 'sks')));
  const postTool = merged.hooks.PostToolUse;
  assert.equal(postTool.length, 1, 'only the user-authored PostToolUse entry survives');
  assert.equal(postTool[0].hooks[0].command, 'my-own-audit-tool --log');
  assert.ok(merged.hooks.PreToolUse.some((entry: any) => entry.hooks.some((hook: any) => hook.command === 'sks hook pre-tool')));
  assert.equal(merged.hooks.Stop.length, 1);

  // A legacy file with ONLY the SKS PostToolUse entry loses the event entirely.
  const sksOnly = JSON.stringify({ hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'sks hook post-tool' }] }] } });
  const cleaned = JSON.parse(await withProfile('essential', () => mergeManagedHooksJson(sksOnly, 'sks')));
  assert.equal('PostToolUse' in cleaned.hooks, false);

  const strictMerged = JSON.parse(await withProfile('strict', () => mergeManagedHooksJson(sksOnly, 'sks')));
  assert.equal(strictMerged.hooks.PostToolUse.some((entry: any) => entry.hooks.some((hook: any) => hook.command === 'sks hook post-tool')), true);
});
