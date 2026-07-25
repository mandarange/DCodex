#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { root, assertGate, emitGate, importDist, readText } from './gate-lib.js';

// Proves the heartbeat-timeout-as-blocker LOGIC hermetically (no real Zellij):
// a missing/empty heartbeat must yield a decisive timeout blocker so the
// real-session launch gate can fail directly instead of hanging.

const sp = await importDist('core/zellij/zellij-screen-proof.js');
const { waitForLaneHeartbeat, ZELLIJ_HEARTBEAT_TIMEOUT_BLOCKER } = sp;

assertGate(
  ZELLIJ_HEARTBEAT_TIMEOUT_BLOCKER === 'zellij_lane_heartbeat_timeout',
  'ZELLIJ_HEARTBEAT_TIMEOUT_BLOCKER mismatch',
  { actual: ZELLIJ_HEARTBEAT_TIMEOUT_BLOCKER }
);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-hb-'));

// Case PRESENT: a heartbeat file with a non-empty JSON line resolves ok fast.
const presentPath = path.join(tmp, 'present-heartbeat.jsonl');
await fs.writeFile(presentPath, `${JSON.stringify({ schema: 'sks.zellij-lane-render.v1', ok: true })}\n`);
const present = await waitForLaneHeartbeat(presentPath, { timeoutMs: 1000, intervalMs: 25 });
assertGate(present.ok === true, 'PRESENT heartbeat should be ok', { present });
assertGate(present.heartbeat_present === true, 'PRESENT heartbeat should be present', { present });
assertGate(present.blocker === null, 'PRESENT heartbeat should have no blocker', { present });
assertGate(present.waited_ms < 1000, 'PRESENT heartbeat should resolve before timeout', { present });

// Case MISSING: a nonexistent path times out into the blocker.
const missingPath = path.join(tmp, 'nope-heartbeat.jsonl');
const missing = await waitForLaneHeartbeat(missingPath, { timeoutMs: 200, intervalMs: 25 });
assertGate(missing.ok === false, 'MISSING heartbeat should not be ok', { missing });
assertGate(missing.heartbeat_present === false, 'MISSING heartbeat should not be present', { missing });
assertGate(
  missing.blocker === ZELLIJ_HEARTBEAT_TIMEOUT_BLOCKER,
  'MISSING heartbeat should yield timeout blocker',
  { missing }
);
assertGate(missing.waited_ms >= 150, 'MISSING heartbeat should wait the timeout window', { missing });

// Case EMPTY: a whitespace-only file is treated as no heartbeat.
const emptyPath = path.join(tmp, 'empty-heartbeat.jsonl');
await fs.writeFile(emptyPath, '\n  \n');
const empty = await waitForLaneHeartbeat(emptyPath, { timeoutMs: 200, intervalMs: 25 });
assertGate(empty.ok === false, 'EMPTY heartbeat should not be ok', { empty });
assertGate(
  empty.blocker === ZELLIJ_HEARTBEAT_TIMEOUT_BLOCKER,
  'EMPTY heartbeat should yield timeout blocker',
  { empty }
);

// Wiring: the real-session launch gate must consume the heartbeat blocker.
const launchGate = readText('src/scripts/zellij-real-session-launch-check.ts');
assertGate(
  launchGate.includes('waitForLaneHeartbeat'),
  'launch gate must call waitForLaneHeartbeat',
  {}
);
assertGate(
  launchGate.includes('heartbeat.blocker'),
  'launch gate must consume heartbeat.blocker',
  {}
);

const report = {
  schema: 'sks.zellij-real-session-heartbeat.v1',
  ok: true,
  present_ok: true,
  timeout_ok: true,
  cases: { present, missing, empty }
};
await fs.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
await fs.writeFile(
  path.join(root, '.sneakoscope', 'reports', 'zellij-real-session-heartbeat.json'),
  `${JSON.stringify(report, null, 2)}\n`
);

emitGate('zellij:real-session-heartbeat', { present_ok: true, timeout_ok: true });
