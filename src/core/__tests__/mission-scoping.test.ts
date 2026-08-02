import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  closeRouteState,
  createMission,
  findLatestMission,
  loadOwnedRouteState,
  missionDir,
  sessionStateKey,
  setCurrent,
  stateFile,
  stateFileForSession
} from '../mission.js';

async function makeRoot(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('findLatestMission(root) with no options returns the single newest mission unfiltered', async () => {
  const root = await makeRoot('sks-mission-scoping-baseline-');
  const first = await createMission(root, { mode: 'ppt', prompt: 'first' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await createMission(root, { mode: 'naruto', prompt: 'second' });
  const latest = await findLatestMission(root);
  assert.equal(latest, second.id);
  assert.notEqual(latest, first.id);
});

test('findLatestMission(root) with no missions dir returns null', async () => {
  const root = await makeRoot('sks-mission-scoping-empty-');
  const latest = await findLatestMission(root);
  assert.equal(latest, null);
});

test('findLatestMission(root, { mode }) returns only the mission matching that mode, not the overall latest', async () => {
  const root = await makeRoot('sks-mission-scoping-mode-');
  const loopMission = await createMission(root, { mode: 'loop', prompt: 'loop one' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Created after the loop mission, so it would win an unscoped "latest" lookup.
  const pptMission = await createMission(root, { mode: 'ppt', prompt: 'ppt one' });

  const latestLoop = await findLatestMission(root, { mode: 'loop' });
  assert.equal(latestLoop, loopMission.id);
  assert.notEqual(latestLoop, pptMission.id);

  const latestPpt = await findLatestMission(root, { mode: 'ppt' });
  assert.equal(latestPpt, pptMission.id);

  const latestUnscoped = await findLatestMission(root);
  assert.equal(latestUnscoped, pptMission.id);
});

test('findLatestMission(root, { mode }) returns the newest among multiple missions sharing that mode', async () => {
  const root = await makeRoot('sks-mission-scoping-mode-multi-');
  const first = await createMission(root, { mode: 'naruto', prompt: 'naruto one' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await createMission(root, { mode: 'ppt', prompt: 'unrelated ppt' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await createMission(root, { mode: 'naruto', prompt: 'naruto two' });

  const latestNaruto = await findLatestMission(root, { mode: 'naruto' });
  assert.equal(latestNaruto, second.id);
  assert.notEqual(latestNaruto, first.id);
});

test('findLatestMission(root, { mode }) returns null when no candidate matches that mode', async () => {
  const root = await makeRoot('sks-mission-scoping-mode-miss-');
  await createMission(root, { mode: 'ppt', prompt: 'ppt only' });
  const latest = await findLatestMission(root, { mode: 'mad-sks' });
  assert.equal(latest, null);
});

test('findLatestMission(root, { route, gateFile }) skips missions missing the named gate artifact', async () => {
  const root = await makeRoot('sks-mission-scoping-gate-');
  const withoutGate = await createMission(root, { mode: 'mad-sks', prompt: 'no gate yet' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const withGate = await createMission(root, { mode: 'mad-sks', prompt: 'has gate' });
  await fsp.writeFile(
    path.join(missionDir(root, withGate.id), 'mad-sks-gate.json'),
    JSON.stringify({ schema: 'sks.mad-sks-gate.v1', route: '$MAD-SKS' }, null, 2)
  );

  const latest = await findLatestMission(root, { mode: 'mad-sks', route: '$MAD-SKS', gateFile: 'mad-sks-gate.json' });
  assert.equal(latest, withGate.id);
  assert.notEqual(latest, withoutGate.id);
});

test('findLatestMission(root, { route, gateFile }) rejects a gate whose route field disagrees', async () => {
  const root = await makeRoot('sks-mission-scoping-gate-route-mismatch-');
  const wrongRoute = await createMission(root, { mode: 'image-ux-review', prompt: 'wrong route' });
  await fsp.writeFile(
    path.join(missionDir(root, wrongRoute.id), 'image-ux-review-gate.json'),
    JSON.stringify({ schema: 'sks.image-ux-review-gate.v2', route: '$PPT' }, null, 2)
  );

  const latest = await findLatestMission(root, {
    mode: 'image-ux-review',
    route: '$Image-UX-Review',
    gateFile: 'image-ux-review-gate.json'
  });
  assert.equal(latest, null);
});

test('closeRouteState closes the matching session mirror when closing by mission id', async () => {
  const root = await makeRoot('sks-mission-close-session-');
  const sessionKey = 'qa-lane-session';
  const mission = await createMission(root, { mode: 'naruto', prompt: 'qa lane', sessionKey });
  await setCurrent(root, {
    mission_id: mission.id,
    mode: 'NARUTO',
    route: 'Naruto',
    route_command: '$Naruto',
    phase: 'NARUTO_READY',
    implementation_allowed: true
  }, { sessionKey });

  const closed = await closeRouteState(root, { missionId: mission.id });
  assert.equal(closed.ok, true);

  const current = JSON.parse(await fsp.readFile(stateFile(root), 'utf8'));
  const session = JSON.parse(await fsp.readFile(stateFileForSession(root, sessionKey), 'utf8'));
  assert.equal(current.route_closed, true);
  assert.equal(session.route_closed, true);
  assert.equal(current.phase, 'NARUTO_READY_CLOSED');
  assert.equal(session.phase, 'NARUTO_READY_CLOSED');
});

test('loadOwnedRouteState never borrows a foreign session global mirror', async () => {
  const root = await makeRoot('sks-route-state-foreign-session-');
  const ownerSession = 'chat-owner';
  await fsp.mkdir(path.dirname(stateFile(root)), { recursive: true });
  await fsp.writeFile(stateFile(root), JSON.stringify({
    mission_id: 'M-owner',
    mode: 'NARUTO',
    phase: 'NARUTO_READY',
    session_scope: ownerSession,
    _session_key: sessionStateKey(ownerSession)
  }));

  assert.deepEqual(await loadOwnedRouteState(root, 'chat-other'), {});
  assert.deepEqual(await loadOwnedRouteState(root), {});
});

test('loadOwnedRouteState preserves same-session and unowned legacy gates', async () => {
  const root = await makeRoot('sks-route-state-owned-session-');
  const sessionKey = 'chat-owner';
  await fsp.mkdir(path.dirname(stateFile(root)), { recursive: true });
  await fsp.writeFile(stateFile(root), JSON.stringify({
    mission_id: 'M-owner',
    mode: 'NARUTO',
    phase: 'NARUTO_READY',
    session_scope: sessionKey,
    _session_key: sessionStateKey(sessionKey)
  }));

  const sameSession = await loadOwnedRouteState(root, sessionKey);
  assert.equal(sameSession.mission_id, 'M-owner');
  assert.equal(sameSession._session_key, sessionStateKey(sessionKey));

  await fsp.writeFile(stateFile(root), JSON.stringify({
    mission_id: 'M-standalone',
    mode: 'MADSKS',
    phase: 'MADSKS_ZELLIJ_PERMISSION_ACTIVE'
  }));
  const standalone = await loadOwnedRouteState(root);
  assert.equal(standalone.mission_id, 'M-standalone');
  assert.deepEqual(await loadOwnedRouteState(root, 'chat-new'), {});
});
