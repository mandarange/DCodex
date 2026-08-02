import {
  officialSubagentArtifactDir,
  recordAndRefreshSubagentEvidence,
  recordOfficialSubagentLifecycleCaptureFailure
} from './official-subagent-lifecycle.js';
import { clearSubagentSkillAvailabilityGuards } from './subagent-skill-availability.js';

export async function handleSubagentStop(
  root: string,
  state: any,
  payload: any = {},
  sessionKey: any = null
) {
  const artifactDir = officialSubagentArtifactDir(root, state, sessionKey);
  let lifecycleFailure: string | null = null;
  let capturedEvent: any = null;
  try {
    capturedEvent = await recordAndRefreshSubagentEvidence(root, state, payload, 'SubagentStop', sessionKey);
  } catch {
    lifecycleFailure = await recordOfficialSubagentLifecycleCaptureFailure(
      artifactDir,
      state,
      payload,
      'SubagentStop'
    ).catch(() => 'official_subagent_lifecycle_capture_failure_unpersisted');
  }
  const activeRunId = String(state?.official_subagent_run_id || '').trim();
  const explicitRunId = String(payload?.workflow_run_id || payload?.run_id || '').trim();
  const hasTurnBoundEvidence = Boolean(String(payload?.turn_id || '').trim());
  const cleanupRunId = explicitRunId || (hasTurnBoundEvidence ? String(capturedEvent?.run_id || '').trim() : '');
  if (activeRunId && cleanupRunId === activeRunId) {
    await clearSubagentSkillAvailabilityGuards(root, {
      ...payload,
      workflow_run_id: cleanupRunId
    }, artifactDir, {
      missionId: state?.mission_id,
      workflowRunId: activeRunId
    }).catch(() => null);
  }
  // SubagentStop is evidence collection only. It must never reuse the parent
  // Stop hook's route gate or block a child thread from returning its result.
  return lifecycleFailure
    ? {
        continue: true,
        systemMessage: `SKS: ${lifecycleFailure}; parent completion remains blocked until lifecycle evidence is recovered.`
      }
    : { continue: true, silent: true };
}
