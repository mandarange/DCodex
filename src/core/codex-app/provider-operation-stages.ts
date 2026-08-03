export type ProviderOperationStageName = 'config_saved' | 'proxy_applied' | 'catalog_refreshed' | 'new_session_ready';
export type ProviderOperationStageStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ProviderOperationStage {
  readonly stage: ProviderOperationStageName;
  readonly status: ProviderOperationStageStatus;
  readonly reason: string | null;
}

const REQUIRED_STAGES: readonly ProviderOperationStageName[] = [
  'config_saved', 'proxy_applied', 'catalog_refreshed', 'new_session_ready'
];

export function providerOperationResult(input: {
  stages: readonly ProviderOperationStage[];
  existingSessionMode?: string | null;
  newSessionMode: string;
}) {
  const byName = new Map(input.stages.map((stage) => [stage.stage, stage]));
  const stages = REQUIRED_STAGES.map((name) => byName.get(name) || ({ stage: name, status: 'pending', reason: null } as const));
  const failed = stages.filter((stage) => stage.status === 'failed');
  const complete = stages.every((stage) => stage.status === 'succeeded');
  return {
    schema: 'sks.provider-operation-result.v1' as const,
    ok: complete,
    status: failed.length ? 'failed' as const : complete ? 'succeeded' as const : 'in_progress' as const,
    stages,
    applies_to: 'new_sessions_only' as const,
    existing_session_mode: input.existingSessionMode || null,
    new_session_mode: input.newSessionMode,
    existing_session_unchanged: true as const,
    blockers: failed.flatMap((stage) => stage.reason ? [`${stage.stage}:${stage.reason}`] : [`${stage.stage}:failed`])
  };
}
