import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
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
