import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cancelOwnedSession,
  parseRemoteCancelPayload,
  RemoteOwnerProofStore
} from '../owner-proof.js';
import type {
  RemoteCancelPayloadV1,
  RemoteCommandEnvelopeV1,
  RemoteOwnerProofV1,
  RemoteProcessIdentityV1
} from '../types.js';

async function fixture(): Promise<{
  root: string;
  project: string;
  store: RemoteOwnerProofStore;
  owner: RemoteOwnerProofV1;
  envelope: RemoteCommandEnvelopeV1;
  payload: RemoteCancelPayloadV1;
  live: RemoteProcessIdentityV1;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-remote-owner-'));
  const project = path.join(root, 'repo');
  await fsp.mkdir(project);
  const now = Date.now();
  const owner: RemoteOwnerProofV1 = {
    schema: 'sks.remote-owner-proof.v1',
    session_id: 'session-1',
    project_id: 'project-1',
    project_root: project,
    pid: 4242,
    process_start_time: 'Tue Jul 14 21:00:00 2026',
    expected_command: 'codex exec --session session-1',
    owner_nonce: 'owner-nonce-abcdefghijklmnopqrstuvwxyz',
    active_generation: 3,
    codex_thread_id: 'thread-1',
    active_turn_id: 'turn-1',
    registered_at: new Date(now - 1_000).toISOString()
  };
  const envelope: RemoteCommandEnvelopeV1 = {
    schema: 'sks.remote-command.v2',
    command_id: 'command-1',
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    actor: 'remote-owner',
    machine_id: 'mac',
    project_id: 'project-1',
    session_id: 'session-1',
    kind: 'cancel',
    risk: 'R2',
    payload: {},
    idempotency_key: 'idem-1'
  };
  const payload: RemoteCancelPayloadV1 = {
    owner_nonce: owner.owner_nonce,
    expected_pid: owner.pid,
    expected_process_start_time: owner.process_start_time,
    expected_command: owner.expected_command,
    expected_project_root: project,
    expected_generation: owner.active_generation,
    approval: {
      schema: 'sks.remote-r2-approval.v2',
      approval_id: 'approval-1',
      approved_by: 'remote-owner',
      approved_at: new Date(now - 1_000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      machine_id: 'mac',
      project_id: 'project-1',
      session_id: 'session-1',
      kind: 'cancel',
      command_id: 'command-1'
    }
  };
  const live: RemoteProcessIdentityV1 = {
    pid: owner.pid,
    process_start_time: owner.process_start_time,
    command: owner.expected_command,
    project_root: project
  };
  const store = new RemoteOwnerProofStore(path.join(root, 'owners'));
  await store.register(owner);
  return { root, project, store, owner, envelope, payload, live };
}

test('owner-proof cancel requires every identity field and kills only the exact process', async () => {
  const fx = await fixture();
  const killed: number[] = [];
  const result = await cancelOwnedSession({
    root: fx.root,
    envelope: fx.envelope,
    payload: fx.payload,
    store: fx.store,
    currentGeneration: 3,
    inspectProcess: async () => fx.live,
    killProcess: async (pid) => { killed.push(pid); }
  });
  assert.deepEqual(result, { pid: 4242, signal: 'SIGTERM', owner_proof: 'verified' });
  assert.deepEqual(killed, [4242]);
  const stat = await fsp.stat(fx.store.pathFor('session-1'));
  assert.equal(stat.mode & 0o077, 0);
});

test('PID reuse and foreign command/root identities are refused without signaling', async () => {
  const fx = await fixture();
  let kills = 0;
  const base = {
    root: fx.root,
    envelope: fx.envelope,
    payload: fx.payload,
    store: fx.store,
    currentGeneration: 3,
    killProcess: async () => { kills += 1; }
  };
  await assert.rejects(
    cancelOwnedSession({ ...base, inspectProcess: async () => ({ ...fx.live, process_start_time: 'Tue Jul 14 22:00:00 2026' }) }),
    /process_start_time_mismatch/
  );
  await assert.rejects(
    cancelOwnedSession({ ...base, inspectProcess: async () => ({ ...fx.live, command: 'sleep 999' }) }),
    /foreign_process_command_refused/
  );
  const foreign = path.join(fx.root, 'foreign');
  await fsp.mkdir(foreign);
  await assert.rejects(
    cancelOwnedSession({ ...base, inspectProcess: async () => ({ ...fx.live, project_root: foreign }) }),
    /foreign_process_project_root_refused/
  );
  assert.equal(kills, 0);
});

test('stale generation, nonce, or exact R2 approval scope is denied', async () => {
  const fx = await fixture();
  await assert.rejects(cancelOwnedSession({
    root: fx.root,
    envelope: fx.envelope,
    payload: fx.payload,
    store: fx.store,
    currentGeneration: 4,
    inspectProcess: async () => fx.live,
    killProcess: async () => undefined
  }), /active_generation_mismatch/);
  await assert.rejects(cancelOwnedSession({
    root: fx.root,
    envelope: fx.envelope,
    payload: { ...fx.payload, owner_nonce: 'wrong-owner-nonce-abcdefghijklmnopqrstuvwxyz' },
    store: fx.store,
    currentGeneration: 3,
    inspectProcess: async () => fx.live,
    killProcess: async () => undefined
  }), /owner_nonce_mismatch/);
  await assert.rejects(cancelOwnedSession({
    root: fx.root,
    envelope: fx.envelope,
    payload: { ...fx.payload, approval: { ...fx.payload.approval, session_id: 'session-2' } },
    store: fx.store,
    currentGeneration: 3,
    inspectProcess: async () => fx.live,
    killProcess: async () => undefined
  }), /approval_session_mismatch/);
});

test('cancel payload parser rejects missing or untyped approval data', () => {
  assert.throws(() => parseRemoteCancelPayload({ owner_nonce: 'x' }), /expected_pid_invalid/);
});
