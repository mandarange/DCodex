// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/daemon/sksd-client.js');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-sksd-daemon-check-'));
try {
  const state = mod.runSksdClient(fixtureRoot, 'status');
  const start = mod.runSksdClient(fixtureRoot, 'start');
  assertGate(state.schema === 'sks.sksd-state.v1', 'sksd status schema mismatch', state);
  assertGate(start.protocol_ok === true && start.status === 'running', 'sksd start must record protocol-ready state', start);
  assertGate(start.build_proof_ready === false, 'hermetic sksd protocol fixture must not build or mutate the source checkout', start);
  emitGate('sksd:daemon', { status: start.status, hermetic_fixture: true, build_started: false });
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
