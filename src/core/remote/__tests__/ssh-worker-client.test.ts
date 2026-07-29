import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  buildSshWorkerArgs,
  RemoteSshClientError,
  RemoteSshWorkerClient,
  validateSshHostKeyPolicy
} from '../ssh-worker-client.js';
import type { RemoteCommandEnvelopeV1, RemoteMachineV1, WorkerRequestV1, WorkerResponseV1 } from '../types.js';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('close', 0, null));
    return true;
  }
}

const machine: RemoteMachineV1 = {
  id: 'mac',
  display_name: 'Mac',
  transport: 'ssh-stdio',
  ssh_alias: 'sks-mac',
  allowed_roots: ['/work/repos'],
  enabled: true
};

const validSshConfig = [
  'hostname mac.internal',
  'stricthostkeychecking ask',
  'userknownhostsfile /Users/example/.ssh/known_hosts',
  'globalknownhostsfile /etc/ssh/ssh_known_hosts'
].join('\n');

function asChild(child: FakeChild): ChildProcessWithoutNullStreams {
  return child as unknown as ChildProcessWithoutNullStreams;
}

function respond(child: FakeChild, options: { closeOnCommand?: boolean } = {}): void {
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const request = JSON.parse(line) as WorkerRequestV1;
      if (request.type === 'command' && options.closeOnCommand) {
        queueMicrotask(() => child.emit('close', 255, null));
        continue;
      }
      const data = request.type === 'list_sessions'
        ? { sessions: [{ session_id: 'session-1', session_state: 'active' }] }
        : { protocol: 'jsonl-stdio' };
      const response: WorkerResponseV1 = {
        schema: 'sks.remote-worker.response.v1',
        id: request.id,
        type: request.type,
        ok: true,
        data
      };
      child.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}

function clientWith(children: FakeChild[]): { client: RemoteSshWorkerClient; spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    spawned,
    client: new RemoteSshWorkerClient({
      machine,
      projectRoot: '/work/repos/project',
      projectId: 'project-1',
      reconnectAttempts: 2,
      reconnectBaseMs: 1,
      reconnectMaxMs: 2,
      sleep: async () => undefined,
      loadSshConfig: async () => validSshConfig,
      spawnProcess: (_command, args) => {
        spawned.push([...args]);
        const child = children.shift();
        if (!child) throw new Error('no_fake_child');
        return asChild(child);
      }
    })
  };
}

function inputEnvelope(): RemoteCommandEnvelopeV1 {
  const now = Date.now();
  return {
    schema: 'sks.remote-command.v2',
    command_id: 'command-1',
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    actor: 'remote-owner',
    machine_id: 'mac',
    project_id: 'project-1',
    session_id: 'session-1',
    kind: 'input',
    risk: 'R1',
    payload: { text: 'continue' },
    idempotency_key: 'idem-1'
  };
}

test('host-key policy allows ask/yes/accept-new with known_hosts and rejects disabled verification', () => {
  assert.equal(validateSshHostKeyPolicy(validSshConfig).ok, true);
  const disabled = validateSshHostKeyPolicy([
    'stricthostkeychecking no',
    'userknownhostsfile /dev/null',
    'globalknownhostsfile none'
  ].join('\n'));
  assert.equal(disabled.ok, false);
  assert.ok(disabled.issues.includes('strict_host_key_checking_disabled'));
  assert.ok(disabled.issues.includes('known_hosts_storage_disabled'));
});

test('SSH worker launch is a bounded argument vector using only the registered alias', () => {
  const args = buildSshWorkerArgs(machine, '/work/repos/project', 'project-1');
  assert.deepEqual(args, [
    '-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '--', 'sks-mac',
    'sks', 'remote', 'worker', '--stdio', '--machine', 'mac',
    '--project-root', '/work/repos/project', '--project-id', 'project-1'
  ]);
  assert.throws(() => buildSshWorkerArgs({ ...machine, ssh_alias: 'user@host' }, '/work/repos/project', 'project-1'), /ssh_alias_invalid/);
});

test('SSH worker launch rejects project roots that can change the remote shell command', () => {
  const unsafeRoots = [
    '/work/repos/project name',
    '/work/repos/project;touch',
    '/work/repos/project$(touch)',
    '/work/repos/project`touch`',
    "/work/repos/project'quoted",
    '/work/repos/project"quoted',
    '/work/repos/project\nnext-command',
    '/work/repos/project/*',
    '/work/repos/project>redirect'
  ];

  for (const root of unsafeRoots) {
    assert.throws(
      () => buildSshWorkerArgs(machine, root, 'project-1'),
      (err: unknown) => err instanceof RemoteSshClientError
        && err.code === 'project_root_ssh_unsafe'
        && err.delivery === 'not_dispatched'
        && !err.retryable,
      root
    );
  }

  const safeRoot = '/work/repos/SKS_6.3-release.safe_path';
  assert.equal(buildSshWorkerArgs(machine, safeRoot, 'project-1').includes(safeRoot), true);
});

test('unsafe project roots are rejected before SSH config probing or process spawn', async () => {
  const unsafeRoots = [
    '/work/repos/project name',
    '/work/repos/project;touch',
    '/work/repos/project$(touch)',
    '/work/repos/project`touch`',
    "/work/repos/project'quoted",
    '/work/repos/project"quoted',
    '/work/repos/project\nnext-command',
    '/work/repos/project/*',
    '/work/repos/project>redirect'
  ];
  let configProbeCount = 0;
  let spawnCount = 0;

  for (const projectRoot of unsafeRoots) {
    const client = new RemoteSshWorkerClient({
      machine,
      projectRoot,
      projectId: 'project-1',
      loadSshConfig: async () => {
        configProbeCount += 1;
        return validSshConfig;
      },
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error('unsafe_root_must_not_spawn');
      }
    });
    await assert.rejects(
      client.connect(),
      (err: unknown) => err instanceof RemoteSshClientError
        && err.code === 'project_root_ssh_unsafe'
        && err.delivery === 'not_dispatched'
        && !err.retryable
    );
  }

  assert.equal(configProbeCount, 0);
  assert.equal(spawnCount, 0);
});

test('disconnect before dispatch is safe-to-retry and distinct from session state', async () => {
  const child = new FakeChild();
  respond(child);
  const { client } = clientWith([child]);
  await client.connect();
  child.stdin.destroy();
  await assert.rejects(
    client.request({ schema: 'sks.remote-worker.request.v1', id: 'list-1', type: 'list_sessions' }),
    (err: unknown) => err instanceof RemoteSshClientError && err.delivery === 'not_dispatched' && err.retryable
  );
  assert.equal(client.status().session_state, 'unknown');
  await client.close();
});

test('disconnect after command dispatch returns delivery_unknown and never auto-replays', async () => {
  const child = new FakeChild();
  respond(child, { closeOnCommand: true });
  const { client, spawned } = clientWith([child]);
  const envelope = inputEnvelope();
  await assert.rejects(
    client.request({ schema: 'sks.remote-worker.request.v1', id: 'command-request', type: 'command', envelope }),
    (err: unknown) => err instanceof RemoteSshClientError && err.code === 'delivery_unknown' && err.delivery === 'unknown' && !err.retryable
  );
  assert.equal(spawned.length, 1);
  assert.equal(client.status().connection_state, 'disconnected');
});

test('a command acknowledgement without a side-effect receipt is delivery_unknown', async () => {
  const child = new FakeChild();
  respond(child);
  const { client } = clientWith([child]);
  await assert.rejects(
    client.request({ schema: 'sks.remote-worker.request.v1', id: 'command-no-receipt', type: 'command', envelope: inputEnvelope() }),
    (err: unknown) => err instanceof RemoteSshClientError && err.code === 'side_effect_receipt_missing' && err.delivery === 'unknown'
  );
  assert.equal(client.status().connection_state, 'disconnected');
});

test('a crashed worker reconnects with bounded backoff on the next safe request', async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  respond(first);
  respond(second);
  const { client, spawned } = clientWith([first, second]);
  await client.connect();
  first.emit('close', 255, null);
  const response = await client.request({ schema: 'sks.remote-worker.request.v1', id: 'list-2', type: 'list_sessions' });
  assert.equal(response.ok, true);
  assert.equal(spawned.length, 2);
  assert.equal(client.status().connection_state, 'connected');
  assert.equal(client.status().session_state, 'active');
  await client.close();
});

test('command requests use a long-turn timeout independent from short control requests', async () => {
  const child = new FakeChild();
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const request = JSON.parse(line) as WorkerRequestV1;
      if (request.type === 'hello') {
        child.stdout.write(`${JSON.stringify({
          schema: 'sks.remote-worker.response.v1',
          id: request.id,
          type: request.type,
          ok: true,
          data: { protocol: 'jsonl-stdio' }
        })}\n`);
        continue;
      }
      if (request.type === 'command') {
        setTimeout(() => {
          child.stdout.write(`${JSON.stringify({
            schema: 'sks.remote-worker.response.v1',
            id: request.id,
            type: request.type,
            ok: true,
            data: { accepted: true },
            receipt: {
              schema: 'sks.remote-command-receipt.v1',
              command_id: request.envelope.command_id,
              idempotency_key: request.envelope.idempotency_key,
              machine_id: request.envelope.machine_id,
              project_id: request.envelope.project_id,
              session_id: request.envelope.session_id,
              kind: request.envelope.kind,
              status: 'completed',
              side_effect_applied: true,
              completed_at: new Date().toISOString(),
              result: { accepted: true }
            }
          })}\n`);
        }, 1_100);
      }
    }
  });
  const client = new RemoteSshWorkerClient({
    machine,
    projectRoot: '/work/repos/project',
    projectId: 'project-1',
    requestTimeoutMs: 1_000,
    commandRequestTimeoutMs: 2_000,
    loadSshConfig: async () => validSshConfig,
    spawnProcess: () => asChild(child)
  });

  const response = await client.request({
    schema: 'sks.remote-worker.request.v1',
    id: 'long-command',
    type: 'command',
    envelope: inputEnvelope()
  });

  assert.equal(response.ok, true);
  assert.equal(response.receipt?.status, 'completed');
  await client.close();
});
