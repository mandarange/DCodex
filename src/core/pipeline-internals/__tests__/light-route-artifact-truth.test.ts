import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stateFileForSession } from '../../mission.js';
import { resetVerificationProfileCache } from '../../verification-profile.js';
import { prepareRoute } from '../runtime-core.js';

async function withProfile<T>(profile: 'essential' | 'strict', run: () => Promise<T>): Promise<T> {
  const previous = process.env.SKS_VERIFICATION_PROFILE;
  process.env.SKS_VERIFICATION_PROFILE = profile;
  resetVerificationProfileCache();
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SKS_VERIFICATION_PROFILE;
    else process.env.SKS_VERIFICATION_PROFILE = previous;
    resetVerificationProfileCache();
  }
}

test('essential lightweight route persists every artifact it advertises and declares no route-level finalization gate', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-light-route-truth-'));
  const sessionKey = 'light-route-artifact-truth';
  try {
    await withProfile('essential', async () => {
      const prepared: any = await prepareRoute(root, '$SKS explain the current behavior', {}, { sessionKey });
      const missionId = String(prepared.mission_id || '');
      const dir = path.join(root, '.sneakoscope', 'missions', missionId);
      const [routeContext, plan, state] = await Promise.all([
        fsp.readFile(path.join(dir, 'route-context.json'), 'utf8').then(JSON.parse),
        fsp.readFile(path.join(dir, 'pipeline-plan.json'), 'utf8').then(JSON.parse),
        fsp.readFile(stateFileForSession(root, sessionKey), 'utf8').then(JSON.parse)
      ]);

      assert.equal(routeContext.stop_gate, 'none');
      assert.equal(plan.route.stop_gate, 'none');
      assert.equal(plan.request_intake.status, 'not_attached');
      assert.equal(state.pipeline_plan_ready, true);
      assert.equal(state.pipeline_plan_path, 'pipeline-plan.json');
      assert.equal(state.stop_gate, 'none');
      assert.equal(state.reflection_required, false);
      assert.equal(state.reasoning_temporary, false);
      assert.equal(state.reasoning_advisory, true);
      assert.equal(await fsp.access(path.join(dir, 'request-intake.json')).then(() => true, () => false), false);
      assert.match(prepared.additionalContext, /Request intake: not materialized for this lightweight route/);
      assert.match(prepared.additionalContext, /Stop gate: none/);
      assert.match(prepared.additionalContext, /Reflection: not required for this route/);
      assert.match(prepared.additionalContext, /finish directly/);
      assert.doesNotMatch(prepared.additionalContext, /Stop gate: honest_mode/);
      assert.match(prepared.additionalContext, /preserve the user-selected model, effort, and service tier/);
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('strict lightweight route retains its explicit Honest Mode stop gate', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-light-route-strict-'));
  try {
    await withProfile('strict', async () => {
      const prepared: any = await prepareRoute(root, '$SKS explain the current behavior', {}, { sessionKey: 'strict-light-route' });
      const dir = path.join(root, '.sneakoscope', 'missions', prepared.mission_id);
      const [routeContext, plan] = await Promise.all([
        fsp.readFile(path.join(dir, 'route-context.json'), 'utf8').then(JSON.parse),
        fsp.readFile(path.join(dir, 'pipeline-plan.json'), 'utf8').then(JSON.parse)
      ]);
      assert.equal(routeContext.stop_gate, 'honest_mode');
      assert.equal(plan.route.stop_gate, 'honest_mode');
      assert.match(prepared.additionalContext, /finish with Honest Mode/);
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
