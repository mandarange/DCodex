// First import: machine-feedback cases spawn real npm, which writes
// $HOME/.npm logs and the update-notifier stamp when home leaks through.
import '../../dist/core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemoryAgentPatchQueue } from '../../dist/core/agents/agent-patch-queue.js';
import { PersistentAgentPatchQueueStore } from '../../dist/core/agents/agent-patch-queue-store.js';
import { runMachineFeedback, selectTests } from '../../dist/core/verification/machine-feedback.js';
import { runProcess } from '../../dist/core/fsx.js';

test('agent patch queue records transitions and ownership ledger', () => {
  const queue = new InMemoryAgentPatchQueue();
  const entry = queue.enqueue({
    agent_id: 'agent-a',
    session_id: 'session-a',
    slot_id: 'slot-a',
    generation_index: 1,
    lease_id: 'lease-a',
    rollback_hint: { node_id: 'rollback-a' },
    operations: [{ op: 'write', path: 'a.txt', content: 'a' }]
  }, { mission_id: 'M-test', route: '$Fixture' });
  queue.markApplying(entry.id);
  queue.markApplied(entry.id);
  const json = queue.toJSON();
  assert.equal(json.events.length, 3);
  assert.equal(json.ownership_ledger[0].lease_id, 'lease-a');
  assert.equal(json.ownership_ledger[0].mission_id, 'M-test');
  assert.equal(json.ownership_ledger[0].slot_id, 'slot-a');
  assert.deepEqual(json.ownership_ledger[0].write_paths, ['a.txt']);
});

test('persistent agent patch queue writes queue, events, and ownership artifacts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-patch-queue-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, 'artifacts');
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"private":true}\n');
  const store = new PersistentAgentPatchQueueStore(artifactDir);
  const entry = await store.enqueue({
    agent_id: 'agent-a',
    session_id: 'session-a',
    slot_id: 'slot-a',
    generation_index: 2,
    lease_proof: { lease_id: 'lease-a', allowed_paths: ['a.txt'] },
    rollback_hint: { node_id: 'rollback-a' },
    operations: [{ op: 'write', path: 'a.txt', content: 'a' }]
  }, { mission_id: 'M-test', route: '$Fixture', root: projectRoot });
  await store.markApplied(entry.id);
  const queue = JSON.parse(await fs.readFile(path.join(artifactDir, 'agent-patch-queue.json'), 'utf8'));
  const events = await fs.readFile(path.join(artifactDir, 'agent-patch-queue-events.jsonl'), 'utf8');
  const ledger = JSON.parse(await fs.readFile(path.join(artifactDir, 'agent-patch-ownership-ledger.json'), 'utf8'));
  assert.equal(queue.entries[0].mission_id, 'M-test');
  assert.equal(queue.entries[0].generation_index, 2);
  assert.match(events, /"event_type":"enqueue"/);
  assert.equal(ledger.entries[0].status, 'applied');
});

test('machine feedback excludes recursive worktrees, managed caches, and the executing test', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-machine-feedback-select-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidates = [
    'test/widget.test.mjs',
    'test/credible/widget.test.mjs',
    '.claude/worktrees/copy/test/widget.test.mjs',
    '.codex/worktrees/copy/test/widget.test.mjs',
    '.codex/cache/widget.test.mjs',
    '.opensks/runtime/worktrees/copy/test/widget.test.mjs',
    '.sneakoscope/cache/widget.test.mjs',
    '.sneakoscope/tmp/widget.test.mjs'
  ];
  await Promise.all(candidates.map(async (file) => {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "import '../../src/widget.js';\n");
  }));
  const originalEntrypoint = process.argv[1];
  process.argv[1] = path.join(root, 'test/widget.test.mjs');
  try {
    assert.deepEqual(await selectTests(root, ['src/widget.ts']), ['test/credible/widget.test.mjs']);
  } finally {
    process.argv[1] = originalEntrypoint;
  }
});

/**
 * The cut has to come after runnability, not before it.
 *
 * `selectTests` caps at 20 and `runSelectedTests` only then filters to files it
 * can execute. While the cap was alphabetical that ordering was not a neutral
 * sample: runnable tests live under a top-level `test/` tree and unrunnable ones
 * under per-module `__tests__` directories inside `src/`, and 'src/' sorts before
 * 'test/', so the cut deterministically kept the ones that cannot run — the
 * alphabetical order and the runnability split are the same split. Measured on a real four-file
 * change: 27 related tests, 7 runnable, and the call returned 20 selected and 0
 * runnable — so `tests.ok` was true having executed nothing, and the patch
 * queue accepted the patch.
 *
 * This fixture reproduces the shape rather than the scale: 20 unrunnable .ts
 * tests that sort first, and one runnable .mjs that sorts last.
 */
test('related test selection keeps the runnable tests when it has to cut', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-machine-feedback-cut-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const unrunnable = Array.from({ length: 20 }, (_, index) => `src/aaa${String(index).padStart(2, '0')}/__tests__/widget.test.ts`);
  const runnable = 'test/zzz/widget.test.mjs';
  await Promise.all([...unrunnable, runnable].map(async (file) => {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "import '../../src/widget.js';\n");
  }));

  const selected = await selectTests(root, ['src/widget.ts']);
  assert.equal(selected.length, 20, 'the cap still applies');
  assert.ok(selected.includes(runnable), 'the one runnable test must survive the cut');
  assert.equal(selected[0], runnable, 'runnable tests come first, so the cut can never drop them all');
  // Control: within a group the order is still deterministic, not arbitrary.
  const rest = selected.slice(1);
  assert.deepEqual(rest, [...rest].sort(), 'unrunnable tests stay alphabetically ordered');
});

test('machine feedback never falls back to a broad npm test command', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-machine-feedback-bounded-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    scripts: { test: "node -e \"require('node:fs').writeFileSync('broad-test-ran','yes')\"" }
  }));
  await fs.writeFile(path.join(root, 'test/widget.test.ts'), "import '../src/widget.js';\n");
  const feedback = await runMachineFeedback(root, ['src/widget.js'], { timeoutMs: 5_000 });
  assert.equal(feedback.tests.ok, true);
  assert.deepEqual(feedback.tests.selected, []);
  assert.equal(feedback.tests.skipped_reason, 'no_directly_runnable_tests');
  await assert.rejects(fs.access(path.join(root, 'broad-test-ran')));
});

test('machine feedback treats timed-out typecheck, lint, and selected tests as failures', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-machine-feedback-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'test'), { recursive: true });
  const wait = "node -e \"setInterval(() => {}, 1000)\"";
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    scripts: { typecheck: wait, lint: wait }
  }));
  await fs.writeFile(path.join(root, 'test/widget.test.mjs'), "setInterval(() => {}, 1000);\n");
  const feedback = await runMachineFeedback(root, ['src/widget.ts'], { timeoutMs: 5_000 });
  assert.equal(feedback.ok, false);
  assert.deepEqual(feedback.typecheck.errors, ['typecheck_timeout']);
  assert.equal(feedback.lint.errors[0], 'lint_timeout');
  assert.match(feedback.tests.failed[0] || '', /widget\.test\.mjs: timeout/);
});

test('runProcess timeout terminates its POSIX descendant process group', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-run-process-tree-'));
  const pidFile = path.join(root, 'descendant.pid');
  let descendantPid = 0;
  t.after(async () => {
    if (descendantPid && processAlive(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const descendant = 'trap "" TERM; while :; do sleep 1; done';
  const parent = `trap "" TERM; /bin/sh -c '${descendant}' & printf '%s' "$!" > "$1"; while :; do sleep 1; done`;
  const result = await runProcess('/bin/sh', ['-c', parent, 'sks-run-process-tree', pidFile], { timeoutMs: 1_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  descendantPid = Number(await fs.readFile(pidFile, 'utf8'));
  // Under full-suite load, SIGKILL/group reap can lag a few hundred ms after timeout.
  const deadline = Date.now() + 3000;
  while (processAlive(descendantPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processAlive(descendantPid), false);
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
