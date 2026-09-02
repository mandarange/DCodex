import '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateHookPayload } from '../../hooks-runtime.js';
import { resetVerificationProfileCache } from '../../verification-profile.js';

async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-essential-hooks-'));
  await fsp.mkdir(path.join(root, '.sneakoscope', 'state'), { recursive: true });
  return root;
}

async function withProfile<T>(profile: 'essential' | 'strict', run: () => Promise<T>): Promise<T> {
  const prior = process.env.SKS_VERIFICATION_PROFILE;
  process.env.SKS_VERIFICATION_PROFILE = profile;
  resetVerificationProfileCache();
  try { return await run(); }
  finally {
    if (prior === undefined) delete process.env.SKS_VERIFICATION_PROFILE; else process.env.SKS_VERIFICATION_PROFILE = prior;
    resetVerificationProfileCache();
  }
}

function stopPayload(root: string, lastAssistantMessage: string) {
  return {
    cwd: root,
    hook_event_name: 'Stop',
    session_id: 'essential-profile-session',
    turn_id: 'turn-1',
    last_assistant_message: lastAssistantMessage,
    stop_hook_active: false,
  };
}

test('essential profile: a finished turn stops without any Honest Mode or completion-summary wording', async (t) => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const plainFinish = 'Renamed the helper and updated its two callers. Typecheck passes.';
  const essential: any = await withProfile('essential', () => evaluateHookPayload('stop', stopPayload(root, plainFinish), { root, state: {} }));
  assert.equal(essential.continue, true);
  assert.notEqual(essential.decision, 'block');
  assert.equal(essential.action, 'essential_profile_stop_accepted');

  // The same message under the legacy profile is still policed for wording.
  const strict: any = await withProfile('strict', () => evaluateHookPayload('stop', stopPayload(root, plainFinish), { root, state: {} }));
  assert.equal(strict.decision, 'block');
  assert.match(String(strict.reason), /Honest Mode|솔직모드/);
});

test('essential profile: an interrupted-tool-output prompt is advised, not refused', async (t) => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const payload = {
    cwd: root,
    hook_event_name: 'UserPromptSubmit',
    session_id: 'essential-profile-session-2',
    turn_id: 'turn-2',
    prompt: 'Please continue. [No tool output found for tool call call_abc123]',
  };
  const essential: any = await withProfile('essential', () => evaluateHookPayload('user-prompt-submit', payload, { root, state: {} }));
  assert.notEqual(essential.decision, 'block');
  assert.equal(essential.continue, true);
  assert.match(String(essential.additionalContext || ''), /call_abc123|tool output|fresh/i);

  const strict: any = await withProfile('strict', () => evaluateHookPayload('user-prompt-submit', payload, { root, state: {} }));
  assert.equal(strict.decision, 'block');
});
