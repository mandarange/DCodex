// First import: hook evaluation consults the operator home (managed skill
// availability under $HOME/.agents/skills, guard ledgers under
// $HOME/.sneakoscope). Isolate the home, then seed the managed skills so the
// availability guard reflects a healthy install instead of the operator's.
import '../../dist/core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { reconcileSkills } = await import('../../dist/core/init/skills.js');
await reconcileSkills({ targetDir: path.join(os.homedir(), '.agents', 'skills'), scope: 'global', fix: true });

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-hook-update-check-'));
  await fs.mkdir(path.join(root, '.sneakoscope', 'state'), { recursive: true });
  return root;
}

async function evaluateUpdatePrompt(root, prompt, conversationId = 'update-check-control') {
  const { evaluateHookPayload } = await import('../../dist/core/hooks-runtime.js');
  return evaluateHookPayload('user-prompt-submit', {
    cwd: root,
    conversation_id: conversationId,
    prompt
  }, { root, state: {} });
}

async function updateStateExists(root) {
  try {
    await fs.access(path.join(root, '.sneakoscope', 'state', 'update-check.json'));
    return true;
  } catch {
    return false;
  }
}

async function missionEntries(root) {
  try {
    return await fs.readdir(path.join(root, '.sneakoscope', 'missions'));
  } catch {
    return [];
  }
}

async function withEnv(env, fn) {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Codex App hook does not inject an SKS update choice when npm has a newer version', async () => {
  await withEnv({
    SKS_INSTALLED_SKS_VERSION: '1.15.1',
    SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '9.9.9'
  }, async () => {
    const root = await makeRoot();
    const result = await evaluateUpdatePrompt(root, 'fix the project');
    const context = String(result.additionalContext || '');
    assert.doesNotMatch(context, /SKS update check/i);
    assert.doesNotMatch(context, /Update SKS now|Skip update for this conversation/i);
    assert.doesNotMatch(context, /Before any other work, ask the user to choose/i);
    assert.equal(await updateStateExists(root), false);
  });
});

test('legacy pending SKS update state is ignored by Codex App hooks', async () => {
  await withEnv({
    SKS_INSTALLED_SKS_VERSION: '1.15.1',
    SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: '9.9.9'
  }, async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, '.sneakoscope', 'state', 'update-check.json'), `${JSON.stringify({
      pending_offer: {
        conversation_id: 'update-check-control',
        latest: '9.9.9',
        offered_at: '2026-05-23T00:00:00.000Z'
      }
    }, null, 2)}\n`);
    const result = await evaluateUpdatePrompt(root, '잠깐 이거 복사 중이야');
    const context = String(result.additionalContext || '');
    assert.doesNotMatch(context, /copy-stable option/i);
    assert.doesNotMatch(context, /Update SKS now|Skip update for this conversation/i);
    assert.doesNotMatch(context, /do not start a pipeline route/i);
    assert.equal(result.decision, undefined);
    assert.equal(result.continue, true);
    assert.deepEqual(await missionEntries(root), []);
  });
});
