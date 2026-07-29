import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../../fsx.js';
import { stateFileForSession } from '../../mission.js';
import { remoteRuntimePaths } from '../audit-idempotency.js';
import { RemoteOwnerProofStore } from '../owner-proof.js';
import { RemoteWorker } from '../worker.js';
import type { RemoteCommandEnvelopeV1, RemoteMachineV1, RemoteOwnerProofV1, WorkerRequestV1 } from '../types.js';

async function setup(): Promise<{
  root: string;
  machine: RemoteMachineV1;
  owners: RemoteOwnerProofStore;
  owner: RemoteOwnerProofV1;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-remote-worker-'));
  await fsp.mkdir(path.join(root, '.sneakoscope', 'state', 'sessions'), { recursive: true });
  await writeJsonAtomic(stateFileForSession(root, 'session-1'), {
    _session_key: 'session-1',
    mission_id: 'M-fixture',
    route_command: '$Naruto',
    phase: 'IMPLEMENT',
    active_generation: 2,
    updated_at: new Date().toISOString()
  });
  const machine: RemoteMachineV1 = {
    id: 'mac', display_name: 'Mac', transport: 'ssh-stdio', ssh_alias: 'sks-mac', allowed_roots: [root], enabled: true
  };
  const owner: RemoteOwnerProofV1 = {
    schema: 'sks.remote-owner-proof.v1',
    session_id: 'session-1',
    project_id: 'project-1',
    project_root: root,
    pid: 999,
    process_start_time: 'Tue Jul 14 21:00:00 2026',
    expected_command: 'codex exec --session session-1',
    owner_nonce: 'owner-nonce-abcdefghijklmnopqrstuvwxyz',
    active_generation: 2,
    codex_thread_id: 'thread-1',
    active_turn_id: 'turn-1',
    registered_at: new Date().toISOString()
  };
  const owners = new RemoteOwnerProofStore(remoteRuntimePaths(root).owners);
  await owners.register(owner);
  return { root, machine, owners, owner };
}

function command(kind: RemoteCommandEnvelopeV1['kind'], overrides: Partial<RemoteCommandEnvelopeV1> = {}): RemoteCommandEnvelopeV1 {
  const now = Date.now();
  const risk = kind === 'read' ? 'R0' : kind === 'cancel' ? 'R2' : 'R1';
  return {
    schema: 'sks.remote-command.v2',
    command_id: `command-${kind}`,
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    actor: 'remote-owner',
    machine_id: 'mac',
    project_id: 'project-1',
    session_id: 'session-1',
    kind,
    risk,
    payload: {},
    idempotency_key: `idem-${kind}`,
    ...overrides
  };
}

function request(id: string, envelope: RemoteCommandEnvelopeV1): Extract<WorkerRequestV1, { type: 'command' }> {
  return { schema: 'sks.remote-worker.request.v1', id, type: 'command', envelope };
}

test('worker lists sessions and keeps terminal state distinct from completion proof', async () => {
  const fx = await setup();
  await writeJsonAtomic(path.join(fx.root, '.sneakoscope', 'remote', 'codex-session-bindings.json'), {
    schema: 'sks.remote-codex-session-bindings.v1',
    bindings: [{
      session_id: 'legacy-bridge-session',
      machine_id: fx.machine.id,
      project_id: 'project-1',
      project_root: fx.root,
      codex_thread_id: 'thread-from-retired-bridge',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]
  });
  const worker = new RemoteWorker({ root: fx.root, machine: fx.machine, projectId: 'project-1' });
  const listed = await worker.handle({ schema: 'sks.remote-worker.request.v1', id: 'list', type: 'list_sessions' });
  assert.equal(listed.ok, true);
  assert.deepEqual(
    (listed.data as { sessions: Array<{ session_id: string }> }).sessions.map((row) => row.session_id),
    ['session-1']
  );
  const snapshot = await worker.handle({ schema: 'sks.remote-worker.request.v1', id: 'read', type: 'read_snapshot', session_id: 'session-1' });
  assert.equal((snapshot.data as { completion_verified: boolean }).completion_verified, false);
  assert.equal((snapshot.data as { session_state: string }).session_state, 'active');
});

test('typed input uses the exact turn precondition and duplicate idempotency does not steer twice', async () => {
  const fx = await setup();
  const calls: Record<string, unknown>[] = [];
  let closes = 0;
  const worker = new RemoteWorker({
    root: fx.root,
    machine: fx.machine,
    projectId: 'project-1',
    codexClientFactory: async () => ({
      initialize: async () => undefined,
      steerTurn: async (params) => { calls.push(params); return { ok: true }; },
      close: async () => { closes += 1; }
    })
  });
  const envelope = command('input', { payload: { text: 'continue with focused tests' } });
  const first = await worker.handle(request('input-1', envelope));
  const duplicate = await worker.handle(request('input-2', envelope));
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(first.receipt?.side_effect_applied, true);
  assert.equal(duplicate.receipt?.side_effect_applied, true);
  assert.equal(calls.length, 1);
  assert.equal(closes, 1);
  assert.equal(calls[0]?.threadId, 'thread-1');
  assert.equal(calls[0]?.expectedTurnId, 'turn-1');
  assert.match(String(calls[0]?.clientUserMessageId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls[0]?.input, [{ type: 'text', text: 'continue with focused tests' }]);
  const audit = await fsp.readFile(remoteRuntimePaths(fx.root).audit, 'utf8');
  assert.equal(audit.includes('continue with focused tests'), false);
});

test('failed receipts distinguish not-dispatched from unknown side effects and replay the original failure', async () => {
  const beforeDispatch = await setup();
  const beforeDispatchWorker = new RemoteWorker({
    root: beforeDispatch.root,
    machine: beforeDispatch.machine,
    projectId: 'project-1',
    codexClientFactory: async () => {
      throw new Error('server unavailable before dispatch');
    }
  });
  const beforeDispatchEnvelope = command('input', {
    command_id: 'input-before-dispatch',
    idempotency_key: 'idem-before-dispatch',
    payload: { text: 'do not dispatch this turn' }
  });
  const notDispatched = await beforeDispatchWorker.handle(request('before-dispatch', beforeDispatchEnvelope));
  assert.equal(notDispatched.ok, false);
  assert.equal(notDispatched.error?.delivery, 'not_dispatched');
  assert.equal(notDispatched.receipt?.side_effect_applied, false);

  const afterDispatch = await setup();
  let dispatches = 0;
  const afterDispatchWorker = new RemoteWorker({
    root: afterDispatch.root,
    machine: afterDispatch.machine,
    projectId: 'project-1',
    codexClientFactory: async () => ({
      initialize: async () => undefined,
      steerTurn: async () => {
        dispatches += 1;
        throw new Error('transport failed after dispatch');
      },
      close: async () => undefined
    })
  });
  const afterDispatchEnvelope = command('input', {
    command_id: 'input-after-dispatch',
    idempotency_key: 'idem-after-dispatch',
    payload: { text: 'dispatch this turn once' }
  });
  const first = await afterDispatchWorker.handle(request('after-dispatch-1', afterDispatchEnvelope));
  const duplicate = await afterDispatchWorker.handle(request('after-dispatch-2', afterDispatchEnvelope));
  assert.equal(first.ok, false);
  assert.equal(first.error?.delivery, 'unknown');
  assert.equal(first.receipt?.side_effect_applied, 'unknown');
  assert.equal(duplicate.ok, false);
  assert.deepEqual(duplicate.receipt, first.receipt);
  assert.equal(dispatches, 1);

  const auditLines = (await fsp.readFile(remoteRuntimePaths(afterDispatch.root).audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event?: string; side_effect_applied?: unknown });
  const completedAudit = auditLines.find((entry) => entry.event === 'command_completed');
  assert.equal(completedAudit?.side_effect_applied, 'unknown');
  const eventJournal = JSON.parse(
    await fsp.readFile(remoteRuntimePaths(afterDispatch.root).events, 'utf8')
  ) as { events: Array<{ summary: { side_effect_applied?: unknown } }> };
  assert.equal(eventJournal.events[0]?.summary.side_effect_applied, 'unknown');
});

test('cancel requires owner proof and exact approval, and duplicate delivery never kills twice', async () => {
  const fx = await setup();
  let kills = 0;
  const worker = new RemoteWorker({
    root: fx.root,
    machine: fx.machine,
    projectId: 'project-1',
    owners: fx.owners,
    inspectProcess: async () => ({
      pid: fx.owner.pid,
      process_start_time: fx.owner.process_start_time,
      command: fx.owner.expected_command,
      project_root: fx.root
    }),
    killProcess: async () => { kills += 1; }
  });
  const now = Date.now();
  const envelope = command('cancel', {
    payload: {
      owner_nonce: fx.owner.owner_nonce,
      expected_pid: fx.owner.pid,
      expected_process_start_time: fx.owner.process_start_time,
      expected_command: fx.owner.expected_command,
      expected_project_root: fx.root,
      expected_generation: 2,
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
        command_id: 'command-cancel'
      }
    }
  });
  const first = await worker.handle(request('cancel-1', envelope));
  const duplicate = await worker.handle(request('cancel-2', envelope));
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(kills, 1);
  const watched = await worker.handle({ schema: 'sks.remote-worker.request.v1', id: 'watch', type: 'watch', after_seq: 0 });
  assert.equal(watched.ok, true);
  assert.equal((watched.data as { events: unknown[] }).events.length, 1);
});

test('prepare_cancel returns an owner-bound generation challenge and refuses stale bindings', async () => {
  const fx = await setup();
  const worker = new RemoteWorker({ root: fx.root, machine: fx.machine, projectId: 'project-1', owners: fx.owners });
  const prepared = await worker.handle({
    schema: 'sks.remote-worker.request.v1', id: 'prepare-1', type: 'prepare_cancel', session_id: 'session-1', command_id: 'command-cancel'
  });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.data, {
    schema: 'sks.remote-cancel-challenge.v1',
    command_id: 'command-cancel',
    session_id: 'session-1',
    owner_nonce: fx.owner.owner_nonce,
    expected_pid: fx.owner.pid,
    expected_process_start_time: fx.owner.process_start_time,
    expected_command: fx.owner.expected_command,
    expected_project_root: fx.root,
    expected_generation: 2
  });
  await fx.owners.register({ ...fx.owner, active_generation: 1 });
  const stale = await worker.handle({
    schema: 'sks.remote-worker.request.v1', id: 'prepare-2', type: 'prepare_cancel', session_id: 'session-1', command_id: 'command-cancel-2'
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'session_binding_generation_stale');
});

test('worker rejects unknown machine/project envelopes before claiming idempotency', async () => {
  const fx = await setup();
  const worker = new RemoteWorker({ root: fx.root, machine: fx.machine, projectId: 'project-1' });
  const machineMismatch = await worker.handle(request('bad-machine', command('read', { machine_id: 'other' })));
  const projectMismatch = await worker.handle(request('bad-project', command('read', { project_id: 'other', idempotency_key: 'other-key' })));
  assert.equal(machineMismatch.error?.code, 'command_machine_mismatch');
  assert.equal(projectMismatch.error?.code, 'command_project_mismatch');
});
