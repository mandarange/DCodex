import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  ACTIVE_OFFICIAL_WORKFLOW_IDLE_MS,
  inspectActiveOfficialSubagentWorkflow,
  officialSubagentLifecycleCaptureBlockers,
  recordOfficialSubagentLifecycleCaptureFailure
} from '../official-subagent-lifecycle.js';

test('lifecycle capture failures persist as run-scoped completion blockers', async () => {
  const artifactDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'sks-subagent-lifecycle-capture-failure-')
  );
  const runId = 'naruto-test-run';
  const state = { official_subagent_run_id: runId };
  const payload = {
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-a1',
    workflow_run_id: runId
  };
  try {
    const blocker = await recordOfficialSubagentLifecycleCaptureFailure(
      artifactDir,
      state,
      payload,
      'SubagentStop'
    );
    assert.match(
      blocker,
      /^official_subagent_lifecycle_capture_failed:SubagentStop:[a-f0-9]{16}$/
    );
    assert.deepEqual(
      await officialSubagentLifecycleCaptureBlockers(artifactDir, runId),
      [blocker]
    );
    assert.deepEqual(
      await officialSubagentLifecycleCaptureBlockers(artifactDir, 'other-run'),
      []
    );
  } finally {
    await fsp.rm(artifactDir, { recursive: true, force: true });
  }
});

test('old workflow capture files do not consume the current run bound', async () => {
  const artifactDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'sks-subagent-lifecycle-capture-run-bound-')
  );
  const oldRunId = 'naruto-old-run';
  const currentRunId = 'naruto-current-run';
  try {
    for (let index = 0; index < 529; index += 1) {
      await recordOfficialSubagentLifecycleCaptureFailure(
        artifactDir,
        { official_subagent_run_id: oldRunId },
        {
          hook_event_name: 'SubagentStop',
          agent_id: `old-agent-${index}`,
          workflow_run_id: oldRunId
        },
        'SubagentStop'
      );
    }
    assert.deepEqual(
      await officialSubagentLifecycleCaptureBlockers(artifactDir, currentRunId),
      []
    );
    const oldRunBlockers = await officialSubagentLifecycleCaptureBlockers(
      artifactDir,
      oldRunId
    );
    assert.ok(
      oldRunBlockers.includes('official_subagent_lifecycle_capture_failure_overflow')
    );
  } finally {
    await fsp.rm(artifactDir, { recursive: true, force: true });
  }
});

async function writeInspectableWorkflow(root: string, input: {
  missionId: string;
  runId: string;
  createdAt: string;
  openThreads?: number;
  eventOccurredAt?: string;
}) {
  const dir = path.join(root, '.sneakoscope', 'missions', input.missionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
    schema: 'sks.subagent-plan.v1',
    workflow: 'official_codex_subagent',
    mission_id: input.missionId,
    workflow_run_id: input.runId,
    created_at: input.createdAt,
    wave_lifecycle: {
      schema: 'sks.subagent-wave-lifecycle.v1',
      owner: 'root_parent',
      workflow_run_id: input.runId,
      open_threads: input.openThreads || 0,
      updated_at: input.createdAt
    }
  }));
  if (input.eventOccurredAt) {
    await fsp.writeFile(path.join(dir, 'subagent-events.jsonl'), `${JSON.stringify({
      schema: 'sks.subagent-event.v1',
      event_name: 'SubagentStart',
      thread_id: 'idle-child',
      run_id: input.runId,
      occurred_at: input.eventOccurredAt
    })}\n`);
  }
}

test('inspect treats a never-started official workflow as inactive after idle silence', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-stale-never-started-'));
  const missionId = 'M-stale-never-started';
  const runId = 'naruto-stale-never-started';
  const createdAt = new Date(Date.now() - ACTIVE_OFFICIAL_WORKFLOW_IDLE_MS - 60_000).toISOString();
  try {
    await writeInspectableWorkflow(root, { missionId, runId, createdAt });
    const result = await inspectActiveOfficialSubagentWorkflow(root, {
      mission_id: missionId,
      official_subagent_run_id: runId
    }, 'session');
    assert.equal(result.status, 'inactive');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('inspect keeps a recently prepared official workflow active', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-fresh-never-started-'));
  const missionId = 'M-fresh-never-started';
  const runId = 'naruto-fresh-never-started';
  const createdAt = new Date().toISOString();
  try {
    await writeInspectableWorkflow(root, { missionId, runId, createdAt });
    const result = await inspectActiveOfficialSubagentWorkflow(root, {
      mission_id: missionId,
      official_subagent_run_id: runId
    }, 'session');
    assert.deepEqual(result, {
      status: 'active',
      missionId,
      workflowRunId: runId,
      openThreads: 0
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('inspect treats leftover open threads as inactive after idle silence', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-stale-open-threads-'));
  const missionId = 'M-stale-open-threads';
  const runId = 'naruto-stale-open-threads';
  const createdAt = new Date(Date.now() - ACTIVE_OFFICIAL_WORKFLOW_IDLE_MS - 60_000).toISOString();
  try {
    await writeInspectableWorkflow(root, {
      missionId,
      runId,
      createdAt,
      openThreads: 1,
      eventOccurredAt: createdAt
    });
    const result = await inspectActiveOfficialSubagentWorkflow(root, {
      mission_id: missionId,
      official_subagent_run_id: runId
    }, 'session');
    assert.equal(result.status, 'inactive');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
