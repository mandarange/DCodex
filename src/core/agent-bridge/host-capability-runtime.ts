import { sha256 } from '../fsx.js';
import {
  HOST_CAPABILITY_DESCRIPTORS,
  hostCapabilityDigest,
  type HostCapabilityDescriptor
} from './agent-manifest.js';
import {
  HOST_CAPABILITY_MCP_SERVER,
  HOST_CAPABILITY_RUNTIME_SCHEMA,
  hostCapabilityRuntimeDigest,
  type HostCapabilityRequest,
  type HostCapabilityRuntime,
  type HostCapabilityRuntimeEntry,
  type HostCapabilityWorkflow
} from './host-capability-policy.js';
export {
  HOST_CAPABILITY_MCP_SERVER,
  HOST_CAPABILITY_RUNTIME_SCHEMA,
  hostCapabilityCodexConfigArgs,
  inspectHostCapabilityRuntime,
  requestHostCapabilities,
  type HostCapabilityRequest,
  type HostCapabilityRuntime,
  type HostCapabilityRuntimeDependencies,
  type HostCapabilityRuntimeEntry,
  type HostCapabilityState,
  type HostCapabilityWorkflow
} from './host-capability-policy.js';

export const HOST_CAPABILITY_EVIDENCE_SCHEMA = 'sks.host-capability-evidence.v1' as const;
export const HOST_CAPABILITY_HOOK_RUNTIME_SCHEMA = 'sks.host-capability-hook-runtime.v1' as const;
export const HOST_CAPABILITY_HOOK_PENDING_RUNTIME_SCHEMA = 'sks.host-capability-hook-pending-runtime.v1' as const;
export const HOST_CAPABILITY_HOOK_OBSERVATIONS_SCHEMA = 'sks.host-capability-hook-observations.v1' as const;
export const HOST_CAPABILITY_HOOK_RUNTIME_FILENAME = 'host-capability-runtime.json';
export const HOST_CAPABILITY_HOOK_PENDING_RUNTIME_FILENAME = 'host-capability-runtime-pending.json';
export const HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME = 'host-capability-hook-observations.json';
export const HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME = 'host-capability-evidence.json';

const MAX_HOST_TOOL_STRUCTURED_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 5 * 1024 * 1024;
const MAX_EVENT_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_MCP_TOOL_CALLS = 1024;
const MAX_PRE_TOOL_OBSERVATIONS = 2048;
const MAX_RECEIPT_JSON_STRING_BYTES = 64 * 1024;
const MAX_ARTIFACT_RECEIPTS = 64;
const MAX_ARTIFACT_PATH_CHARS = 512;
const MAX_SEMANTIC_RECEIPT_ITEMS = 10_000;
const MAX_DATASOURCE_QUERY_RESERVATIONS = 4;
const MAX_SPREADSHEET_UPDATE_RESERVATIONS = 3;
const SHA256_RECEIPT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EXPLICIT_DENIAL_PATTERN = /(?:^|[_.:-])(?:slack|center|tenant|lease|connector|outbox|message|upload|send|post)(?:$|[_.:-])/i;

export interface HostCapabilityUseReceipt {
  id: string;
  status: 'passed' | 'failed';
  tool_names: string[];
  receipt_sha256: string;
}

export interface HostArtifactReceipt {
  path: string;
  kind: string;
  media_type: string;
  sha256: string;
  bytes: number;
  role: 'deliverable' | 'scratch' | 'temp' | 'log';
}

export interface HostArtifactSourceReceipt {
  path: string;
  source_tool: string;
  source_event_sha256: string;
}

export interface HostToolCallReceipt {
  server: string;
  tool: string;
  status: 'passed' | 'failed';
  event_sha256: string;
}

interface InternalHostToolCallReceipt extends HostToolCallReceipt {
  index: number;
  raw_hash: string;
  resource_key: string | null;
  semantic_receipt: HostToolSemanticReceipt | null;
}

type HostToolSemanticReceipt =
  | {
      kind: 'datasource_schema';
      datasource_sha256: string;
      schema_snapshot_sha256: string;
    }
  | {
      kind: 'datasource_query';
      datasource_sha256: string;
      schema_snapshot_sha256: string;
      query_sha256: string;
      row_count: number;
      column_count: number;
      truncated: boolean;
      status: 'passed';
    }
  | {
      kind: 'spreadsheet_inspection';
      sheet_names_sha256: string;
      sheet_count: number;
      row_count: number;
      formula_count: number;
      error_cell_count: 0;
    };

interface ObservedHostArtifactReceipt extends HostArtifactReceipt {
  source_tool: string;
  source_hash: string;
  source_index: number;
}

export interface HostCapabilityExecutionEvidence {
  schema: typeof HOST_CAPABILITY_EVIDENCE_SCHEMA;
  ok: boolean;
  runtime: HostCapabilityRuntime;
  tool_calls: HostToolCallReceipt[];
  capabilities_used: HostCapabilityUseReceipt[];
  artifacts: HostArtifactReceipt[];
  artifact_sources: HostArtifactSourceReceipt[];
  blockers: string[];
}

export interface HostCapabilityHookRuntimeBinding {
  schema: typeof HOST_CAPABILITY_HOOK_RUNTIME_SCHEMA;
  mission_id: string;
  workflow_run_id: string;
  session_scope: string;
  runtime: HostCapabilityRuntime;
}

export interface HostCapabilityHookPendingRuntime {
  schema: typeof HOST_CAPABILITY_HOOK_PENDING_RUNTIME_SCHEMA;
  mission_id: string;
  workflow_run_id: string;
  launch_nonce_sha256: string;
  runtime: HostCapabilityRuntime;
}

export interface HostCapabilityPreToolObservation {
  tool_use_id_sha256: string;
  tool: string;
  resource_key: string | null;
  datasource_sha256: string | null;
  schema_snapshot_sha256: string | null;
  decision: 'allowed' | 'denied';
  reservation_status: 'pending' | 'completed' | 'failed' | 'denied';
  blocker: string | null;
}

export interface HostCapabilityPreToolAuthorizationResult {
  observations: HostCapabilityHookObservations;
  observation: HostCapabilityPreToolObservation;
  decision: 'allowed' | 'denied';
  blocker: string | null;
}

export interface HostCapabilityPostToolObservation {
  sequence: number;
  tool_use_id_sha256: string;
  tool: string;
  status: 'passed' | 'failed';
  event_sha256: string;
  resource_key: string | null;
  semantic_receipt: HostToolSemanticReceipt | null;
  validation_blocker: string | null;
  artifacts: HostArtifactReceipt[];
}

export interface HostCapabilityHookObservations {
  schema: typeof HOST_CAPABILITY_HOOK_OBSERVATIONS_SCHEMA;
  mission_id: string;
  workflow_run_id: string;
  session_scope: string;
  allowlist_digest: string;
  pre_tool_uses: HostCapabilityPreToolObservation[];
  tool_calls: HostCapabilityPostToolObservation[];
  blockers: string[];
}

export function createHostCapabilityHookPendingRuntime(input: {
  missionId: unknown;
  workflowRunId: unknown;
  launchNonce: unknown;
  runtime: HostCapabilityRuntime;
}): HostCapabilityHookPendingRuntime {
  const missionId = boundedIdentity(input.missionId);
  const workflowRunId = boundedIdentity(input.workflowRunId);
  const launchNonce = boundedIdentity(input.launchNonce);
  if (!missionId || !workflowRunId || !launchNonce || !isHostCapabilityRuntime(input.runtime)) {
    throw new Error('host_capability_hook_pending_runtime_invalid');
  }
  return {
    schema: HOST_CAPABILITY_HOOK_PENDING_RUNTIME_SCHEMA,
    mission_id: missionId,
    workflow_run_id: workflowRunId,
    launch_nonce_sha256: `sha256:${sha256(launchNonce)}`,
    runtime: input.runtime
  };
}

export function resolveHostCapabilityHookPendingRuntime(
  value: unknown,
  input: {
    missionId: unknown;
    workflowRunId: unknown;
    launchNonce: unknown;
    request?: HostCapabilityRequest;
  }
): { pending: HostCapabilityHookPendingRuntime | null; blocker: string } {
  if (!value) return { pending: null, blocker: 'host_capability_hook_pending_runtime_missing' };
  if (!isRecord(value)
    || value.schema !== HOST_CAPABILITY_HOOK_PENDING_RUNTIME_SCHEMA
    || !boundedIdentity(value.mission_id)
    || !boundedIdentity(value.workflow_run_id)
    || !SHA256_RECEIPT_PATTERN.test(String(value.launch_nonce_sha256 || ''))
    || !isHostCapabilityRuntime(value.runtime)) {
    return { pending: null, blocker: 'host_capability_hook_pending_runtime_invalid' };
  }
  const pending = value as unknown as HostCapabilityHookPendingRuntime;
  const launchNonce = boundedIdentity(input.launchNonce);
  if (pending.mission_id !== boundedIdentity(input.missionId)
    || pending.workflow_run_id !== boundedIdentity(input.workflowRunId)
    || !launchNonce
    || pending.launch_nonce_sha256 !== `sha256:${sha256(launchNonce)}`) {
    return { pending: null, blocker: 'host_capability_hook_pending_runtime_scope_mismatch' };
  }
  if (input.request && !hostCapabilityRuntimeMatchesRequest(pending.runtime, input.request)) {
    return { pending: null, blocker: 'host_capability_hook_pending_runtime_request_scope_mismatch' };
  }
  return { pending, blocker: '' };
}

export function createHostCapabilityHookRuntimeBinding(input: {
  missionId: unknown;
  workflowRunId: unknown;
  sessionScope: unknown;
  runtime: HostCapabilityRuntime;
}): HostCapabilityHookRuntimeBinding {
  const missionId = boundedIdentity(input.missionId);
  const workflowRunId = boundedIdentity(input.workflowRunId);
  const sessionScope = boundedIdentity(input.sessionScope);
  if (!missionId || !workflowRunId || !sessionScope) {
    throw new Error('host_capability_hook_runtime_identity_missing');
  }
  return {
    schema: HOST_CAPABILITY_HOOK_RUNTIME_SCHEMA,
    mission_id: missionId,
    workflow_run_id: workflowRunId,
    session_scope: sessionScope,
    runtime: input.runtime
  };
}

export function normalizeHostCapabilityHookRuntimeBinding(value: unknown): HostCapabilityHookRuntimeBinding | null {
  if (!isRecord(value)
    || value.schema !== HOST_CAPABILITY_HOOK_RUNTIME_SCHEMA
    || !boundedIdentity(value.mission_id)
    || !boundedIdentity(value.workflow_run_id)
    || !boundedIdentity(value.session_scope)
    || !isHostCapabilityRuntime(value.runtime)) return null;
  return value as unknown as HostCapabilityHookRuntimeBinding;
}

export function hostCapabilityHookBindingMatches(
  binding: HostCapabilityHookRuntimeBinding,
  input: { missionId: unknown; workflowRunId: unknown; sessionScope: unknown }
): boolean {
  return binding.mission_id === boundedIdentity(input.missionId)
    && binding.workflow_run_id === boundedIdentity(input.workflowRunId)
    && binding.session_scope === boundedIdentity(input.sessionScope);
}

export function resolveHostCapabilityHookRuntimeBinding(
  value: unknown,
  input: {
    missionId: unknown;
    workflowRunId: unknown;
    sessionScope: unknown;
    request?: HostCapabilityRequest;
  }
): { binding: HostCapabilityHookRuntimeBinding | null; blocker: string } {
  if (!value) return { binding: null, blocker: 'host_capability_hook_runtime_missing' };
  const binding = normalizeHostCapabilityHookRuntimeBinding(value);
  if (!binding) return { binding: null, blocker: 'host_capability_hook_runtime_invalid' };
  if (!hostCapabilityHookBindingMatches(binding, input)) {
    return { binding: null, blocker: 'host_capability_hook_runtime_scope_mismatch' };
  }
  if (input.request && !hostCapabilityRuntimeMatchesRequest(binding.runtime, input.request)) {
    return { binding: null, blocker: 'host_capability_hook_runtime_request_scope_mismatch' };
  }
  return { binding, blocker: '' };
}

export function acasHostToolName(value: unknown): string | null {
  const toolName = String(value || '').trim();
  if (!toolName || toolName.length > 256 || /[\r\n\0]/.test(toolName)) return null;
  const match = toolName.match(/^mcp__(?:acas-tools|acas_tools)__([A-Za-z][A-Za-z0-9_.:-]{0,127})$/);
  return match?.[1] || null;
}

export function explicitlyDeniedHostCapabilityTool(value: unknown): boolean {
  return EXPLICIT_DENIAL_PATTERN.test(String(value || ''));
}

export function sanitizeHostCapabilityPreToolUse(
  runtime: HostCapabilityRuntime,
  payload: unknown
): HostCapabilityPreToolObservation | null {
  if (!isRecord(payload)) return null;
  const tool = acasHostToolName(payload.tool_name);
  const toolUseId = boundedIdentity(payload.tool_use_id);
  if (!tool || !toolUseId) return null;
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const documentRender = tool === 'html_to_pdf' || tool === 'html_to_screenshot';
  const documentSourcePath = documentRender ? normalizeDocumentSourcePath(toolInput.source_path) : null;
  const documentSourceBlocker = documentRender
    && (Object.prototype.hasOwnProperty.call(toolInput, 'html') || !documentSourcePath)
    ? 'host_capability_document_source_path_required'
    : null;
  const resourceKey = documentRender
    ? documentSourcePath && workspaceResourceKey(documentSourcePath)
    : extractToolResourceKey({ arguments: payload.tool_input });
  const datasource = tool === 'datasource_schema_context' || tool === 'datasource_query_readonly'
    ? boundedIdentity(toolInput.datasource)
    : null;
  const schemaSnapshotId = tool === 'datasource_query_readonly'
    ? boundedIdentity(toolInput.schema_snapshot_id)
    : null;
  const allowed = runtime.ok
    && runtime.allowed_tool_names.includes(tool)
    && !explicitlyDeniedHostCapabilityTool(tool)
    && !documentSourceBlocker;
  const blocker = !runtime.ok
    ? 'host_capability_runtime_unavailable'
    : explicitlyDeniedHostCapabilityTool(tool)
      ? `host_tool_call_explicitly_denied:${tool}`
      : !runtime.allowed_tool_names.includes(tool)
        ? `host_tool_call_not_allowed:${tool}`
        : documentSourceBlocker;
  return {
    tool_use_id_sha256: `sha256:${sha256(toolUseId)}`,
    tool,
    resource_key: resourceKey,
    datasource_sha256: datasource ? `sha256:${sha256(datasource)}` : null,
    schema_snapshot_sha256: schemaSnapshotId ? `sha256:${sha256(schemaSnapshotId)}` : null,
    decision: allowed ? 'allowed' : 'denied',
    reservation_status: allowed ? 'pending' : 'denied',
    blocker
  };
}

export function sanitizeHostCapabilityPostToolUse(payload: unknown): HostCapabilityPostToolObservation | null {
  if (!isRecord(payload)) return null;
  const tool = acasHostToolName(payload.tool_name);
  const toolUseId = boundedIdentity(payload.tool_use_id);
  if (!tool || !toolUseId) return null;
  const response = structuredHostToolResponse(payload.tool_response);
  const malformed = !response || Object.keys(response).length === 0;
  const semantic = malformed
    ? { receipt: null, blocker: `host_tool_response_malformed:${tool}` }
    : normalizeHostToolSemanticReceipt(tool, payload.tool_input, response);
  const status = hostToolResponseFailed(payload.tool_response)
    || hostToolResponseFailed(response)
    || malformed
    || Boolean(semantic.blocker)
    ? 'failed'
    : 'passed';
  const artifacts = status === 'passed'
    ? extractArtifactReceipts(response)
    : [];
  const resourceKey = extractHostToolResourceKey(tool, {
    arguments: payload.tool_input,
    result: payload.tool_response
  });
  const toolUseIdSha256 = `sha256:${sha256(toolUseId)}`;
  const eventSha256 = `sha256:${sha256(JSON.stringify({
    server: HOST_CAPABILITY_MCP_SERVER,
    tool,
    status,
    tool_use_id_sha256: toolUseIdSha256,
    resource_key: resourceKey,
    semantic_receipt: semantic.receipt,
    validation_blocker: semantic.blocker,
    artifacts
  }))}`;
  return {
    sequence: 0,
    tool_use_id_sha256: toolUseIdSha256,
    tool,
    status,
    event_sha256: eventSha256,
    resource_key: resourceKey,
    semantic_receipt: semantic.receipt,
    validation_blocker: semantic.blocker,
    artifacts
  };
}

export function mergeHostCapabilityPreToolObservation(input: {
  binding: HostCapabilityHookRuntimeBinding;
  current?: unknown;
  observation: HostCapabilityPreToolObservation;
}): HostCapabilityHookObservations {
  return authorizeAndMergeHostCapabilityPreToolObservation(input).observations;
}

export function authorizeAndMergeHostCapabilityPreToolObservation(input: {
  binding: HostCapabilityHookRuntimeBinding;
  current?: unknown;
  observation: HostCapabilityPreToolObservation;
}): HostCapabilityPreToolAuthorizationResult {
  const current = normalizeHostCapabilityHookObservations(input.current, input.binding)
    || emptyHookObservations(input.binding);
  const existing = current.pre_tool_uses.find((row) => row.tool_use_id_sha256 === input.observation.tool_use_id_sha256);
  if (existing) {
    if (preToolReservationIdentityMatches(existing, input.observation)) {
      if (existing.decision !== 'allowed' || existing.reservation_status !== 'pending') {
        const observation = denyPreToolReservation(
          input.observation,
          `host_tool_reservation_replay_${existing.reservation_status}`
        );
        return { observations: current, observation, decision: 'denied', blocker: observation.blocker };
      }
      return {
        observations: current,
        observation: existing,
        decision: 'allowed',
        blocker: null
      };
    }
    const observation = denyPreToolReservation(input.observation, 'host_tool_reservation_identity_mismatch');
    return { observations: current, observation, decision: 'denied', blocker: observation.blocker };
  }
  if (current.pre_tool_uses.length >= MAX_PRE_TOOL_OBSERVATIONS) {
    const observation = denyPreToolReservation(input.observation, 'host_pre_tool_observations_too_many');
    return { observations: current, observation, decision: 'denied', blocker: observation.blocker };
  }

  const observation = authorizePreToolReservation(input.binding.runtime, current, input.observation);
  const observations = {
    ...current,
    pre_tool_uses: [...current.pre_tool_uses, observation]
  };
  return {
    observations,
    observation,
    decision: observation.decision,
    blocker: observation.blocker
  };
}

function authorizePreToolReservation(
  runtime: HostCapabilityRuntime,
  current: HostCapabilityHookObservations,
  observation: HostCapabilityPreToolObservation
): HostCapabilityPreToolObservation {
  if (observation.decision === 'denied') return denyPreToolReservation(observation, observation.blocker);

  if (observation.tool === 'datasource_query_readonly') {
    if (hasPendingToolReservation(current, observation.tool)) {
      return denyPreToolReservation(observation, 'host_capability_readonly_query_already_reserved');
    }
    if (countNonDeniedToolReservations(current, observation.tool) >= MAX_DATASOURCE_QUERY_RESERVATIONS) {
      return denyPreToolReservation(observation, 'host_capability_readonly_query_limit_exceeded');
    }
    const schemaReceipts = completedPassedToolCalls(current, 'datasource_schema_context')
      .map((call) => call.semantic_receipt?.kind === 'datasource_schema' ? call.semantic_receipt : null)
      .filter(Boolean) as Extract<HostToolSemanticReceipt, { kind: 'datasource_schema' }>[];
    if (schemaReceipts.length === 0) {
      return denyPreToolReservation(observation, 'host_capability_readonly_query_schema_not_completed');
    }
    const matchingDatasource = observation.datasource_sha256
      ? schemaReceipts.filter((receipt) => receipt.datasource_sha256 === observation.datasource_sha256)
      : [];
    if (matchingDatasource.length === 0) {
      return denyPreToolReservation(observation, 'host_capability_readonly_query_datasource_mismatch');
    }
    if (!observation.schema_snapshot_sha256
      || !matchingDatasource.some((receipt) => (
        receipt.schema_snapshot_sha256 === observation.schema_snapshot_sha256
      ))) {
      return denyPreToolReservation(observation, 'host_capability_readonly_query_schema_mismatch');
    }
  }

  if (observation.tool === 'spreadsheet_create'
    && hasReservedOrObservedToolCall(current, observation.tool)) {
    return denyPreToolReservation(observation, 'host_capability_spreadsheet_create_already_reserved');
  }

  if (observation.tool === 'spreadsheet_update') {
    if (hasPendingToolReservation(current, observation.tool)) {
      return denyPreToolReservation(observation, 'host_capability_spreadsheet_update_already_reserved');
    }
    if (countNonDeniedToolReservations(current, observation.tool) >= MAX_SPREADSHEET_UPDATE_RESERVATIONS) {
      return denyPreToolReservation(observation, 'host_capability_spreadsheet_update_limit_exceeded');
    }
    let lastMutationSequence: number | null = null;
    if (runtime.task_workflows.includes('spreadsheet_create')) {
      const completedCreates = completedPassedToolCalls(current, 'spreadsheet_create');
      if (completedCreates.length === 0) {
        return denyPreToolReservation(observation, 'host_capability_spreadsheet_update_create_not_completed');
      }
      const matchingCreates = observation.resource_key
        ? completedCreates.filter((call) => call.resource_key === observation.resource_key)
        : [];
      if (matchingCreates.length === 0) {
        return denyPreToolReservation(observation, 'host_capability_spreadsheet_update_resource_mismatch');
      }
      lastMutationSequence = Math.max(...matchingCreates.map((call) => call.sequence));
    }
    const completedUpdates = completedPassedToolCalls(current, 'spreadsheet_update');
    const matchingUpdates = observation.resource_key
      ? completedUpdates.filter((call) => call.resource_key === observation.resource_key)
      : completedUpdates;
    if (matchingUpdates.length > 0) {
      const lastUpdateSequence = Math.max(...matchingUpdates.map((call) => call.sequence));
      lastMutationSequence = lastMutationSequence === null
        ? lastUpdateSequence
        : Math.max(lastMutationSequence, lastUpdateSequence);
    }
    const completedInspections = completedPassedToolCalls(current, 'spreadsheet_inspect');
    if (completedInspections.length === 0) {
      return denyPreToolReservation(observation, 'host_capability_spreadsheet_update_inspection_not_completed');
    }
    const matchingInspections = observation.resource_key
      ? completedInspections.filter((call) => call.resource_key === observation.resource_key)
      : [];
    if (matchingInspections.length === 0) {
      return denyPreToolReservation(observation, 'host_capability_spreadsheet_update_resource_mismatch');
    }
    if (lastMutationSequence !== null
      && !matchingInspections.some((call) => call.sequence > lastMutationSequence)) {
      return denyPreToolReservation(observation, 'host_capability_spreadsheet_update_inspection_not_completed');
    }
  }

  if (observation.tool === 'html_to_pdf' || observation.tool === 'html_to_screenshot') {
    const completedSourceWrites = [
      ...completedPassedToolCalls(current, 'write_file'),
      ...completedPassedToolCalls(current, 'edit_file')
    ];
    if (completedSourceWrites.length === 0) {
      return denyPreToolReservation(observation, 'host_capability_document_source_sequence_invalid');
    }
    if (!observation.resource_key
      || !completedSourceWrites.some((call) => call.resource_key === observation.resource_key)) {
      return denyPreToolReservation(observation, 'host_capability_document_source_resource_mismatch');
    }
  }

  return {
    ...observation,
    decision: 'allowed',
    reservation_status: 'pending',
    blocker: null
  };
}

function hasReservedOrObservedToolCall(observations: HostCapabilityHookObservations, tool: string): boolean {
  return countNonDeniedToolReservations(observations, tool) > 0;
}

function hasPendingToolReservation(observations: HostCapabilityHookObservations, tool: string): boolean {
  return observations.pre_tool_uses.some((row) => (
    row.tool === tool && row.reservation_status === 'pending'
  ));
}

function countNonDeniedToolReservations(observations: HostCapabilityHookObservations, tool: string): number {
  const reservedIds = new Set(
    observations.pre_tool_uses
      .filter((row) => row.tool === tool && row.reservation_status !== 'denied')
      .map((row) => row.tool_use_id_sha256)
  );
  for (const row of observations.tool_calls) {
    if (row.tool !== tool) continue;
    reservedIds.add(row.tool_use_id_sha256);
  }
  return reservedIds.size;
}

function preToolReservationIdentityMatches(
  left: HostCapabilityPreToolObservation,
  right: HostCapabilityPreToolObservation
): boolean {
  return left.tool === right.tool
    && left.resource_key === right.resource_key
    && left.datasource_sha256 === right.datasource_sha256
    && left.schema_snapshot_sha256 === right.schema_snapshot_sha256;
}

function denyPreToolReservation(
  observation: HostCapabilityPreToolObservation,
  blocker: string | null
): HostCapabilityPreToolObservation {
  return {
    ...observation,
    decision: 'denied',
    reservation_status: 'denied',
    blocker: blocker || 'host_tool_reservation_denied'
  };
}

function completedPassedToolCalls(
  observations: HostCapabilityHookObservations,
  tool: string
): HostCapabilityPostToolObservation[] {
  return observations.tool_calls.filter((call) => {
    if (call.tool !== tool || call.status !== 'passed') return false;
    const reservation = observations.pre_tool_uses.find((row) => (
      row.tool_use_id_sha256 === call.tool_use_id_sha256
      && row.tool === call.tool
      && row.resource_key === call.resource_key
    ));
    return reservation?.reservation_status === 'completed';
  });
}

export function mergeHostCapabilityPostToolObservation(input: {
  binding: HostCapabilityHookRuntimeBinding;
  current?: unknown;
  observation: HostCapabilityPostToolObservation;
}): HostCapabilityHookObservations {
  const current = normalizeHostCapabilityHookObservations(input.current, input.binding)
    || emptyHookObservations(input.binding);
  if (current.tool_calls.some((row) => row.tool_use_id_sha256 === input.observation.tool_use_id_sha256)) {
    return {
      ...current,
      blockers: uniqueStrings([
        ...current.blockers,
        `host_tool_call_post_replay:${input.observation.tool}`
      ])
    };
  }
  if (current.tool_calls.length >= MAX_MCP_TOOL_CALLS) {
    return { ...current, blockers: uniqueStrings([...current.blockers, 'host_tool_call_receipts_too_many']) };
  }
  const existingArtifactCount = current.tool_calls.reduce((sum, row) => sum + row.artifacts.length, 0);
  const remainingArtifactSlots = Math.max(0, MAX_ARTIFACT_RECEIPTS - existingArtifactCount);
  const sequence = current.tool_calls.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;
  const observation = {
    ...input.observation,
    sequence,
    artifacts: input.observation.artifacts.slice(0, remainingArtifactSlots)
  };
  const reservationById = current.pre_tool_uses.find((row) => (
    row.tool_use_id_sha256 === observation.tool_use_id_sha256
  ));
  const matchingReservation = reservationById
    && reservationById.tool === observation.tool
    && reservationById.resource_key === observation.resource_key
    && semanticReceiptMatchesReservation(reservationById, observation)
    ? reservationById
    : null;
  const preToolUses = matchingReservation && matchingReservation.decision === 'allowed'
    ? current.pre_tool_uses.map((row) => row === matchingReservation
        ? {
            ...row,
            reservation_status: observation.status === 'passed' ? 'completed' as const : 'failed' as const
          }
        : row)
    : current.pre_tool_uses;
  const reservationBlocker = reservationById && !matchingReservation
    ? `host_tool_call_pre_use_identity_mismatch:${observation.tool}`
    : matchingReservation?.decision === 'denied'
    ? `host_tool_call_pre_use_denied:${observation.tool}`
    : matchingReservation
      ? null
      : `host_tool_call_pre_use_missing:${observation.tool}`;
  return {
    ...current,
    pre_tool_uses: preToolUses,
    tool_calls: [...current.tool_calls, observation],
    blockers: uniqueStrings([
      ...current.blockers,
      ...(input.observation.artifacts.length > remainingArtifactSlots ? ['host_artifact_receipts_too_many'] : []),
      ...(reservationBlocker ? [reservationBlocker] : [])
    ])
  };
}

function semanticReceiptMatchesReservation(
  reservation: HostCapabilityPreToolObservation,
  observation: HostCapabilityPostToolObservation
): boolean {
  if (observation.status !== 'passed') return true;
  if (observation.tool === 'datasource_schema_context') {
    return observation.semantic_receipt?.kind === 'datasource_schema'
      && (!reservation.datasource_sha256
        || observation.semantic_receipt.datasource_sha256 === reservation.datasource_sha256);
  }
  if (observation.tool === 'datasource_query_readonly') {
    return observation.semantic_receipt?.kind === 'datasource_query'
      && observation.semantic_receipt.datasource_sha256 === reservation.datasource_sha256
      && observation.semantic_receipt.schema_snapshot_sha256 === reservation.schema_snapshot_sha256;
  }
  return true;
}

export function normalizeHostCapabilityHookObservations(
  value: unknown,
  binding: HostCapabilityHookRuntimeBinding
): HostCapabilityHookObservations | null {
  if (!isRecord(value)
    || value.schema !== HOST_CAPABILITY_HOOK_OBSERVATIONS_SCHEMA
    || value.mission_id !== binding.mission_id
    || value.workflow_run_id !== binding.workflow_run_id
    || value.session_scope !== binding.session_scope
    || value.allowlist_digest !== binding.runtime.allowlist_digest
    || !Array.isArray(value.pre_tool_uses)
    || !Array.isArray(value.tool_calls)
    || !Array.isArray(value.blockers)
    || value.pre_tool_uses.length > MAX_PRE_TOOL_OBSERVATIONS
    || value.tool_calls.length > MAX_MCP_TOOL_CALLS
    || value.blockers.length > 16
    || value.blockers.some((blocker) => typeof blocker !== 'string' || blocker.length > 128)) return null;
  let preToolUses = value.pre_tool_uses.map(normalizePreToolObservation).filter(Boolean) as HostCapabilityPreToolObservation[];
  const toolCalls = value.tool_calls.map(normalizePostToolObservation).filter(Boolean) as HostCapabilityPostToolObservation[];
  if (preToolUses.length !== value.pre_tool_uses.length || toolCalls.length !== value.tool_calls.length) return null;
  if (toolCalls.reduce((sum, row) => sum + row.artifacts.length, 0) > MAX_ARTIFACT_RECEIPTS) return null;
  preToolUses = preToolUses.map((row) => {
    if (row.decision !== 'allowed') return row;
    const call = toolCalls.find((candidate) => (
      candidate.tool_use_id_sha256 === row.tool_use_id_sha256
      && candidate.tool === row.tool
      && candidate.resource_key === row.resource_key
    ));
    return call && semanticReceiptMatchesReservation(row, call)
      ? { ...row, reservation_status: call.status === 'passed' ? 'completed' as const : 'failed' as const }
      : row;
  });
  return {
    schema: HOST_CAPABILITY_HOOK_OBSERVATIONS_SCHEMA,
    mission_id: binding.mission_id,
    workflow_run_id: binding.workflow_run_id,
    session_scope: binding.session_scope,
    allowlist_digest: binding.runtime.allowlist_digest,
    pre_tool_uses: preToolUses,
    tool_calls: [...toolCalls].sort((left, right) => left.sequence - right.sequence),
    blockers: uniqueStrings(value.blockers)
  };
}

export function buildHostCapabilityEvidenceFromHookObservations(input: {
  binding: HostCapabilityHookRuntimeBinding;
  observations?: unknown;
}): HostCapabilityExecutionEvidence {
  const observations = normalizeHostCapabilityHookObservations(input.observations, input.binding)
    || emptyHookObservations(input.binding);
  const observationBlockers = [...observations.blockers];
  const preToolUses = new Map(observations.pre_tool_uses.map((row) => [
    `${row.tool_use_id_sha256}:${row.tool}`,
    row
  ]));
  for (const row of observations.tool_calls) {
    const preToolUse = preToolUses.get(`${row.tool_use_id_sha256}:${row.tool}`);
    if (!preToolUse) observationBlockers.push(`host_tool_call_pre_use_missing:${row.tool}`);
    else if (preToolUse.decision !== 'allowed') observationBlockers.push(`host_tool_call_pre_use_denied:${row.tool}`);
    else if (preToolUse.resource_key !== row.resource_key) observationBlockers.push(`host_tool_call_pre_use_identity_mismatch:${row.tool}`);
    if (row.validation_blocker) observationBlockers.push(row.validation_blocker);
  }
  for (const row of observations.pre_tool_uses) {
    if (row.blocker) observationBlockers.push(row.blocker);
    if (row.reservation_status === 'pending') observationBlockers.push(`host_tool_reservation_pending:${row.tool}`);
  }
  const calls: InternalHostToolCallReceipt[] = observations.tool_calls.map((row) => ({
    server: HOST_CAPABILITY_MCP_SERVER,
    tool: row.tool,
    status: row.status,
    event_sha256: row.event_sha256,
    raw_hash: row.event_sha256,
    index: row.sequence,
    resource_key: row.resource_key,
    semantic_receipt: row.semantic_receipt
  }));
  const artifacts: ObservedHostArtifactReceipt[] = observations.tool_calls.flatMap((row) => row.artifacts.map((artifact) => ({
    ...artifact,
    source_tool: row.tool,
    source_hash: row.event_sha256,
    source_index: row.sequence
  })));
  return buildExecutionEvidence(input.binding.runtime, calls, artifacts, observationBlockers);
}
export function createHostCapabilityEventCollector(runtime: HostCapabilityRuntime): {
  push(chunk: string): void;
  finish(fallbackOutput?: string): HostCapabilityExecutionEvidence;
} {
  let buffer = '';
  let parsedEvents = 0;
  let callIndex = 0;
  const internalCalls: InternalHostToolCallReceipt[] = [];
  const observedArtifacts: ObservedHostArtifactReceipt[] = [];
  const blockers: string[] = [];

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_EVENT_LINE_BYTES) {
      blockers.push('host_tool_event_line_too_large');
      return;
    }
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    parsedEvents += 1;
    const item = event?.type === 'item.completed' ? event.item : null;
    if (!item || item.type !== 'mcp_tool_call') return;
    if (internalCalls.length >= MAX_MCP_TOOL_CALLS) {
      blockers.push('host_tool_call_receipts_too_many');
      return;
    }
    const server = String(item.server || '').trim();
    const tool = String(item.tool || '').trim();
    const declaredStatus = item.status === 'completed' ? 'passed' : item.status === 'failed' ? 'failed' : null;
    const response = structuredHostToolResponse(item.result);
    const malformed = !response || Object.keys(response).length === 0;
    const semantic = malformed
      ? { receipt: null, blocker: `host_tool_response_malformed:${tool}` }
      : normalizeHostToolSemanticReceipt(tool, item.arguments, response);
    const status = declaredStatus === 'passed' && (malformed || semantic.blocker)
      ? 'failed'
      : declaredStatus;
    if (!server || !tool || !status) return;
    callIndex += 1;
    if (server !== runtime.server) return;
    const rawHash = `sha256:${sha256(trimmed)}`;
    internalCalls.push({
      server,
      tool,
      status,
      event_sha256: rawHash,
      raw_hash: rawHash,
      index: callIndex,
      resource_key: extractHostToolResourceKey(tool, item),
      semantic_receipt: semantic.receipt
    });
    if (semantic.blocker) blockers.push(semantic.blocker);
    if (status === 'passed') {
      for (const artifact of extractArtifactReceipts(response)) {
        observedArtifacts.push({ ...artifact, source_tool: tool, source_hash: rawHash, source_index: callIndex });
      }
    }
  };

  const push = (chunk: string) => {
    buffer += String(chunk || '');
    if (Buffer.byteLength(buffer, 'utf8') > MAX_EVENT_BUFFER_BYTES && !buffer.includes('\n')) {
      blockers.push('host_tool_event_buffer_too_large');
      buffer = '';
      return;
    }
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) parseLine(line);
  };

  const finish = (fallbackOutput = '') => {
    if (parsedEvents === 0 && fallbackOutput) push(fallbackOutput);
    if (buffer.trim()) parseLine(buffer);
    buffer = '';
    return buildExecutionEvidence(runtime, internalCalls, observedArtifacts, blockers);
  };

  return { push, finish };
}

export function bindParentSummaryToHostCapabilityEvidence(value: unknown, evidence: HostCapabilityExecutionEvidence): {
  value: unknown;
  blockers: string[];
} {
  const parsed = parseJsonObject(value);
  const hostEvidenceRequired = evidence.runtime.requested_capability_ids.length > 0
    || evidence.tool_calls.length > 0
    || evidence.artifacts.length > 0;
  if (!parsed) {
    return {
      value,
      blockers: hostEvidenceRequired ? ['host_capability_parent_summary_not_structured'] : []
    };
  }
  const blockers: string[] = [...evidence.blockers];
  if (parsed.capabilities_used !== undefined
    && JSON.stringify(parsed.capabilities_used) !== JSON.stringify(evidence.capabilities_used)) {
    blockers.push('host_capability_parent_receipts_mismatch');
  }
  if (parsed.artifacts !== undefined
    && JSON.stringify(parsed.artifacts) !== JSON.stringify(evidence.artifacts)) {
    blockers.push('host_artifact_parent_receipts_mismatch');
  }
  const bindReceipts = hostEvidenceRequired
    || parsed.capabilities_used !== undefined
    || parsed.artifacts !== undefined;
  const mergedBlockers = uniqueStrings([
    ...arrayStrings(parsed.blockers),
    ...blockers
  ]);
  const next = {
    ...parsed,
    ...(bindReceipts ? {
      capabilities_used: evidence.capabilities_used,
      artifacts: evidence.artifacts
    } : {}),
    ...(mergedBlockers.length > 0 ? { blockers: mergedBlockers } : {}),
    ...(parsed.status === 'completed' && mergedBlockers.length > 0 ? { status: 'blocked' } : {})
  };
  return { value: next, blockers: uniqueStrings(blockers) };
}

function buildExecutionEvidence(
  runtime: HostCapabilityRuntime,
  calls: InternalHostToolCallReceipt[],
  artifactRows: ObservedHostArtifactReceipt[],
  initialBlockers: string[]
): HostCapabilityExecutionEvidence {
  const blockers = [...runtime.blockers, ...initialBlockers];
  const requested = new Set(runtime.requested_capability_ids);
  for (const call of calls) {
    if (!runtime.allowed_tool_names.includes(call.tool)) blockers.push(`host_tool_call_not_allowed:${call.tool}`);
    if (EXPLICIT_DENIAL_PATTERN.test(call.tool)) blockers.push(`host_tool_call_explicitly_denied:${call.tool}`);
    if (call.status === 'failed') blockers.push(`host_tool_call_failed:${call.tool}`);
  }
  const dedupedArtifactRows = dedupeObservedArtifacts(artifactRows);
  if (dedupedArtifactRows.length > MAX_ARTIFACT_RECEIPTS) blockers.push('host_artifact_receipts_too_many');
  const receiptArtifactRows = dedupedArtifactRows.slice(0, MAX_ARTIFACT_RECEIPTS);
  const artifacts = receiptArtifactRows.map(projectArtifactReceipt);
  const artifactSources = receiptArtifactRows.map(projectArtifactSourceReceipt);
  if (requested.size === 0 && calls.length > 0) {
    for (const call of calls) blockers.push(`host_tool_call_not_requested:${call.tool}`);
  }
  const capabilitiesUsed: HostCapabilityUseReceipt[] = [];
  for (const descriptor of HOST_CAPABILITY_DESCRIPTORS) {
    if (!requested.has(descriptor.id)) continue;
    const relevantCalls = calls.filter((call) => descriptor.tool_names.includes(call.tool));
    const capabilityBlockers = validateCapabilityWorkflow(runtime, descriptor, relevantCalls, calls, artifactRows);
    blockers.push(...capabilityBlockers);
    const status = capabilityBlockers.length === 0 && relevantCalls.every((call) => call.status === 'passed')
      ? 'passed'
      : 'failed';
    const capabilityArtifactSources = descriptor.executable === false
      ? artifactSources
      : [];
    const toolNames = uniqueStrings([
      ...relevantCalls.map((call) => call.tool),
      ...capabilityArtifactSources.map((source) => source.source_tool)
    ]);
    const receiptSha256 = `sha256:${sha256(JSON.stringify({
      id: descriptor.id,
      calls: relevantCalls.map((call) => call.raw_hash),
      artifacts: capabilityArtifactSources.map((source) => source.source_event_sha256)
    }))}`;
    capabilitiesUsed.push({ id: descriptor.id, status, tool_names: toolNames, receipt_sha256: receiptSha256 });
  }
  const uniqueBlockersValue = uniqueStrings(blockers);
  return {
    schema: HOST_CAPABILITY_EVIDENCE_SCHEMA,
    ok: uniqueBlockersValue.length === 0 && capabilitiesUsed.every((receipt) => receipt.status === 'passed'),
    runtime,
    tool_calls: calls.map(({ server, tool, status, event_sha256 }) => ({ server, tool, status, event_sha256 })),
    capabilities_used: capabilitiesUsed,
    artifacts,
    artifact_sources: artifactSources,
    blockers: uniqueBlockersValue
  };
}

function validateCapabilityWorkflow(
  runtime: HostCapabilityRuntime,
  descriptor: HostCapabilityDescriptor,
  calls: InternalHostToolCallReceipt[],
  allCalls: InternalHostToolCallReceipt[],
  artifacts: ObservedHostArtifactReceipt[]
): string[] {
  const blockers: string[] = [];
  const passed = (tool: string) => calls.filter((call) => call.tool === tool && call.status === 'passed');
  if (descriptor.executable !== false && calls.length === 0) blockers.push(`host_capability_call_missing:${descriptor.id}`);
  if (calls.some((call) => call.status !== 'passed')) blockers.push(`host_capability_call_failed:${descriptor.id}`);
  if (descriptor.id === 'host.datasource.schema.v1' && passed('datasource_schema_context').length === 0) {
    blockers.push('host_capability_schema_call_missing');
  }
  if (descriptor.id === 'host.datasource.query.readonly.v1') {
    const schemaCalls = allCalls.filter((call) => (
      call.tool === 'datasource_schema_context' && call.status === 'passed'
    ));
    const queryCalls = passed('datasource_query_readonly');
    if (queryCalls.length === 0) blockers.push('host_capability_readonly_query_call_missing');
    if (runtime.task_workflows.includes('datasource_query')
      && (queryCalls.length < 1 || queryCalls.length > MAX_DATASOURCE_QUERY_RESERVATIONS)) {
      blockers.push('host_capability_readonly_query_count_invalid');
    }
    for (const queryCall of queryCalls) {
      const precedingSchemaCalls = schemaCalls.filter((call) => call.index < queryCall.index);
      const sequenceInvalid = runtime.task_workflows.includes('datasource_query')
        && precedingSchemaCalls.length === 0;
      if (sequenceInvalid) blockers.push('host_capability_datasource_sequence_invalid');
      const precedingSchemaReceipts = precedingSchemaCalls
        .map((call) => call.semantic_receipt?.kind === 'datasource_schema' ? call.semantic_receipt : null);
      const validSchemaReceipts = precedingSchemaReceipts.filter(Boolean) as Extract<
        HostToolSemanticReceipt,
        { kind: 'datasource_schema' }
      >[];
      const queryReceipt = queryCall.semantic_receipt?.kind === 'datasource_query'
        ? queryCall.semantic_receipt
        : null;
      if (!queryReceipt) blockers.push('host_capability_readonly_query_receipt_invalid');
      if (precedingSchemaCalls.length > 0 && validSchemaReceipts.length === 0) {
        blockers.push('host_capability_schema_receipt_invalid');
      }
      if (!queryReceipt || sequenceInvalid || validSchemaReceipts.length === 0) continue;
      const matchingSchemaCall = [...precedingSchemaCalls]
        .sort((left, right) => right.index - left.index)
        .find((call) => (
          call.semantic_receipt?.kind === 'datasource_schema'
          && call.semantic_receipt.datasource_sha256 === queryReceipt.datasource_sha256
          && call.semantic_receipt.schema_snapshot_sha256 === queryReceipt.schema_snapshot_sha256
        ));
      if (matchingSchemaCall) continue;
      const matchingDatasourceReceipts = validSchemaReceipts.filter((receipt) => (
        receipt.datasource_sha256 === queryReceipt.datasource_sha256
      ));
      if (matchingDatasourceReceipts.length === 0) {
        blockers.push('host_capability_readonly_query_datasource_mismatch');
      } else {
        blockers.push('host_capability_readonly_query_schema_mismatch');
      }
    }
  }
  if (descriptor.id === 'host.spreadsheet.workbook.v1') {
    const creates = passed('spreadsheet_create');
    const updates = passed('spreadsheet_update');
    const inspections = passed('spreadsheet_inspect');
    const create = creates[0]?.index ?? -1;
    const updateIndexes = updates.map((call) => call.index);
    const inspectionIndexes = inspections.map((call) => call.index);
    const hasInspectBetween = (afterIndex: number, beforeIndex: number) => (
      inspectionIndexes.some((index) => index > afterIndex && index < beforeIndex)
    );
    const hasInspectAfter = (afterIndex: number) => (
      inspectionIndexes.some((index) => index > afterIndex)
    );
    if (runtime.task_workflows.includes('spreadsheet_create')) {
      if (creates.length !== 1) blockers.push('host_capability_spreadsheet_create_sequence_invalid');
      if (updates.length > MAX_SPREADSHEET_UPDATE_RESERVATIONS) {
        blockers.push('host_capability_spreadsheet_create_update_count_invalid');
      }
      let createSequenceInvalid = create < 0;
      if (updateIndexes.length === 0) {
        if (!hasInspectAfter(create)) createSequenceInvalid = true;
      } else {
        if (!hasInspectBetween(create, updateIndexes[0]!)) createSequenceInvalid = true;
        for (let index = 0; index < updateIndexes.length; index += 1) {
          const updateIndex = updateIndexes[index]!;
          if (updateIndex <= create) createSequenceInvalid = true;
          const nextBound = updateIndexes[index + 1] ?? Number.POSITIVE_INFINITY;
          if (nextBound === Number.POSITIVE_INFINITY
            ? !hasInspectAfter(updateIndex)
            : !hasInspectBetween(updateIndex, nextBound)) {
            createSequenceInvalid = true;
          }
        }
      }
      if (createSequenceInvalid) blockers.push('host_capability_spreadsheet_create_sequence_invalid');
    }
    if (runtime.task_workflows.includes('spreadsheet_edit')) {
      if (updates.length < 1 || updates.length > MAX_SPREADSHEET_UPDATE_RESERVATIONS) {
        blockers.push('host_capability_spreadsheet_edit_update_count_invalid');
      }
      let editSequenceInvalid = updateIndexes.length === 0;
      if (updateIndexes.length > 0) {
        if (!inspectionIndexes.some((index) => index < updateIndexes[0]!)) editSequenceInvalid = true;
        for (let index = 0; index < updateIndexes.length; index += 1) {
          const updateIndex = updateIndexes[index]!;
          const nextBound = updateIndexes[index + 1] ?? Number.POSITIVE_INFINITY;
          if (nextBound === Number.POSITIVE_INFINITY
            ? !hasInspectAfter(updateIndex)
            : !hasInspectBetween(updateIndex, nextBound)) {
            editSequenceInvalid = true;
          }
        }
      }
      if (editSequenceInvalid) blockers.push('host_capability_spreadsheet_edit_sequence_invalid');
    }
    if (runtime.task_workflows.includes('spreadsheet_create') || runtime.task_workflows.includes('spreadsheet_edit')) {
      if (inspections.some((call) => call.semantic_receipt?.kind !== 'spreadsheet_inspection')) {
        blockers.push('host_capability_spreadsheet_inspection_receipt_invalid');
      }
      const passedSpreadsheetCalls = calls.filter((call) => call.status === 'passed');
      const resourceKeys = uniqueStrings(passedSpreadsheetCalls.map((call) => call.resource_key));
      const lastMutation = [...creates, ...updates].sort((left, right) => right.index - left.index)[0] || null;
      if (passedSpreadsheetCalls.some((call) => !call.resource_key)) {
        blockers.push('host_capability_spreadsheet_resource_missing');
      }
      if (resourceKeys.length > 1) blockers.push('host_capability_spreadsheet_resource_mismatch');
      const finalMutationArtifacts = lastMutation
        ? artifacts.filter((artifact) => (
            artifact.source_index === lastMutation.index
            && artifact.source_tool === lastMutation.tool
          ))
        : [];
      if (lastMutation && finalMutationArtifacts.some((artifact) => (
        isSpreadsheetDeliverable(artifact)
        && !artifactMatchesResource(artifact, lastMutation.resource_key)
      ))) {
        blockers.push('host_capability_spreadsheet_resource_mismatch');
      }
      if (!lastMutation || !finalMutationArtifacts.some((artifact) => (
        isSpreadsheetDeliverable(artifact)
        && artifactMatchesResource(artifact, lastMutation.resource_key)
      ))) {
        blockers.push('host_capability_spreadsheet_final_artifact_missing');
      }
    }
  }
  if (descriptor.id === 'host.document.render.v1' && runtime.task_workflows.includes('document_render')) {
    const renderCalls = [...passed('html_to_pdf'), ...passed('html_to_screenshot')].sort((left, right) => left.index - right.index);
    if (renderCalls.length === 0) {
      blockers.push('host_capability_document_render_call_missing');
    } else {
      const firstRender = renderCalls[0]!;
      const precedingSourceWrites = allCalls.filter((call) => (
        call.status === 'passed'
        && (call.tool === 'write_file' || call.tool === 'edit_file')
        && call.index < firstRender.index
      ));
      if (precedingSourceWrites.length === 0) {
        blockers.push('host_capability_document_source_sequence_invalid');
      } else if (!firstRender.resource_key
        || !precedingSourceWrites.some((call) => call.resource_key === firstRender.resource_key)) {
        blockers.push('host_capability_document_source_resource_mismatch');
      }
      const finalRender = renderCalls.at(-1)!;
      if (!artifacts.some((artifact) => (
        artifact.source_tool === finalRender.tool
        && artifact.source_index === finalRender.index
        && isDocumentRenderDeliverable(artifact, finalRender.tool)
      ))) {
        blockers.push('host_capability_document_render_artifact_missing');
      }
    }
  }
  if (descriptor.id === 'host.web.capture.v1'
    && runtime.task_workflows.includes('web_capture')
    && passed('capture_url_screenshot').length === 0) {
    blockers.push('host_capability_web_capture_call_missing');
  }
  if (descriptor.id === 'host.artifact.receipt.v1') {
    const artifactReceiptExceptions = new Set([
      'spreadsheet_inspect',
      'read_file',
      'find_workspace_files',
      'list_workspace'
    ]);
    const artifactProducingTools = new Set(
      descriptor.tool_names.filter((tool) => !artifactReceiptExceptions.has(tool))
    );
    const passedArtifactCalls = calls.filter((call) => (
      call.status === 'passed' && artifactProducingTools.has(call.tool)
    ));
    if (artifacts.length === 0 || passedArtifactCalls.some((call) => !artifacts.some((artifact) => (
      artifact.source_tool === call.tool && artifact.source_index === call.index
    )))) {
      blockers.push('host_capability_artifact_receipt_missing');
    }
  }
  return uniqueStrings(blockers);
}

function normalizeDocumentSourcePath(value: unknown): string | null {
  const normalized = normalizeWorkspaceResourcePath(value);
  return typeof value === 'string'
    && value === normalized
    && /\.html$/i.test(normalized)
    ? normalized
    : null;
}

function workspaceResourceKey(resourcePath: string): string {
  return `sha256:${sha256(resourcePath)}`;
}

function extractHostToolResourceKey(tool: string, item: unknown): string | null {
  if ((tool === 'html_to_pdf' || tool === 'html_to_screenshot') && isRecord(item)) {
    const toolInput = isRecord(item.arguments)
      ? item.arguments
      : isRecord(item.input)
        ? item.input
        : {};
    const sourcePath = normalizeDocumentSourcePath(toolInput.source_path);
    return sourcePath ? workspaceResourceKey(sourcePath) : null;
  }
  return extractToolResourceKey(item);
}

function extractToolResourceKey(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: item.arguments, depth: 0 },
    { value: item.input, depth: 0 },
    { value: item.result?.structured_content ?? item.result?.structuredContent ?? item.result, depth: 0 }
  ];
  let visited = 0;
  while (queue.length > 0 && visited < 256) {
    const current = queue.shift()!;
    visited += 1;
    if (current.depth > 5 || current.value === null || current.value === undefined) continue;
    if (Array.isArray(current.value)) {
      for (const child of current.value) queue.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(current.value)) continue;
    for (const [key, value] of Object.entries(current.value)) {
      if (/^(?:path|file_path|filepath|workbook_path|workbook|source_path|target_path|output_path)$/i.test(key)) {
        const resourcePath = normalizeWorkspaceResourcePath(value);
        if (resourcePath) return workspaceResourceKey(resourcePath);
      }
      queue.push({ value, depth: current.depth + 1 });
    }
  }
  return null;
}

function normalizeWorkspaceResourcePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const original = value.trim();
  if (!original
    || original.length > MAX_ARTIFACT_PATH_CHARS
    || /[\r\n\0\\]/.test(original)
    || original.startsWith('/')
    || /^[a-z]:/i.test(original)) return null;
  const segments = original.split('/');
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function isSpreadsheetDeliverable(artifact: ObservedHostArtifactReceipt): boolean {
  const artifactPath = normalizeWorkspaceResourcePath(artifact.path);
  return artifact.role === 'deliverable'
    && (artifact.kind === 'xlsx' || artifact.kind === 'spreadsheet')
    && artifact.media_type === XLSX_MEDIA_TYPE
    && Boolean(artifactPath && /\.xlsx$/i.test(artifactPath));
}

function artifactMatchesResource(artifact: ObservedHostArtifactReceipt, resourceKey: string | null): boolean {
  const artifactPath = normalizeWorkspaceResourcePath(artifact.path);
  return Boolean(resourceKey && artifactPath && workspaceResourceKey(artifactPath) === resourceKey);
}

function isDocumentRenderDeliverable(
  artifact: ObservedHostArtifactReceipt,
  tool: string
): boolean {
  const artifactPath = normalizeWorkspaceResourcePath(artifact.path);
  const pdf = tool === 'html_to_pdf';
  return artifact.role === 'deliverable'
    && artifact.kind === (pdf ? 'pdf' : 'png')
    && artifact.media_type === (pdf ? 'application/pdf' : 'image/png')
    && Boolean(artifactPath && (pdf ? /\.pdf$/i : /\.png$/i).test(artifactPath));
}

function extractArtifactReceipts(value: unknown): HostArtifactReceipt[] {
  const result: HostArtifactReceipt[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 512) {
    const current = queue.shift()!;
    visited += 1;
    if (current.depth > 6 || current.value === null || current.value === undefined) continue;
    if (typeof current.value === 'string') {
      const text = current.value.trim();
      if (text && Buffer.byteLength(text, 'utf8') <= MAX_RECEIPT_JSON_STRING_BYTES && /^[{[]/.test(text)) {
        try {
          queue.push({ value: JSON.parse(text), depth: current.depth + 1 });
        } catch {}
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) queue.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(current.value)) continue;
    const artifact = normalizeArtifactReceipt(current.value);
    if (artifact) result.push(artifact);
    for (const child of Object.values(current.value)) queue.push({ value: child, depth: current.depth + 1 });
  }
  return dedupeArtifacts(result);
}

function normalizeArtifactReceipt(value: Record<string, unknown>): HostArtifactReceipt | null {
  const artifactPath = normalizeWorkspaceResourcePath(value.path) || '';
  const kind = typeof value.kind === 'string' ? value.kind.trim().toLowerCase() : '';
  const mediaType = typeof value.media_type === 'string'
    ? value.media_type.trim().toLowerCase()
    : typeof value.mediaType === 'string' ? value.mediaType.trim().toLowerCase() : '';
  const receiptHash = typeof value.sha256 === 'string' ? value.sha256.trim().toLowerCase() : '';
  const bytes = typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes > 0 ? value.bytes : 0;
  const role = typeof value.role === 'string' && ['deliverable', 'scratch', 'temp', 'log'].includes(value.role)
    ? value.role as HostArtifactReceipt['role']
    : null;
  if (!artifactPath
    || !kind
    || kind.length > 64
    || !mediaType
    || mediaType.length > 160
    || !SHA256_RECEIPT_PATTERN.test(receiptHash)
    || !bytes
    || !role) return null;
  return { path: artifactPath, kind, media_type: mediaType, sha256: receiptHash, bytes, role };
}

function dedupeArtifacts<T extends HostArtifactReceipt>(values: readonly T[]): HostArtifactReceipt[] {
  const byPath = new Map(values.map((value) => [value.path, {
      path: value.path,
      kind: value.kind,
      media_type: value.media_type,
      sha256: value.sha256,
      bytes: value.bytes,
      role: value.role
    }]));
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function dedupeObservedArtifacts(values: readonly ObservedHostArtifactReceipt[]): ObservedHostArtifactReceipt[] {
  const byPath = new Map(values.map((value) => [value.path, value]));
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function projectArtifactReceipt(value: HostArtifactReceipt): HostArtifactReceipt {
  return {
    path: value.path,
    kind: value.kind,
    media_type: value.media_type,
    sha256: value.sha256,
    bytes: value.bytes,
    role: value.role
  };
}

function projectArtifactSourceReceipt(value: ObservedHostArtifactReceipt): HostArtifactSourceReceipt {
  return {
    path: value.path,
    source_tool: value.source_tool,
    source_event_sha256: value.source_hash
  };
}

function emptyHookObservations(binding: HostCapabilityHookRuntimeBinding): HostCapabilityHookObservations {
  return {
    schema: HOST_CAPABILITY_HOOK_OBSERVATIONS_SCHEMA,
    mission_id: binding.mission_id,
    workflow_run_id: binding.workflow_run_id,
    session_scope: binding.session_scope,
    allowlist_digest: binding.runtime.allowlist_digest,
    pre_tool_uses: [],
    tool_calls: [],
    blockers: []
  };
}

function normalizePreToolObservation(value: unknown): HostCapabilityPreToolObservation | null {
  if (!isRecord(value)
    || !SHA256_RECEIPT_PATTERN.test(String(value.tool_use_id_sha256 || ''))
    || typeof value.tool !== 'string'
    || value.tool.length === 0
    || value.tool.length > 128
    || (value.decision !== 'allowed' && value.decision !== 'denied')) return null;
  const resourceKey = value.resource_key === undefined || value.resource_key === null
    ? null
    : SHA256_RECEIPT_PATTERN.test(String(value.resource_key || ''))
      ? String(value.resource_key)
      : undefined;
  if (resourceKey === undefined) return null;
  const datasourceSha256 = value.datasource_sha256 === undefined || value.datasource_sha256 === null
    ? null
    : SHA256_RECEIPT_PATTERN.test(String(value.datasource_sha256 || ''))
      ? String(value.datasource_sha256)
      : undefined;
  const schemaSnapshotSha256 = value.schema_snapshot_sha256 === undefined || value.schema_snapshot_sha256 === null
    ? null
    : SHA256_RECEIPT_PATTERN.test(String(value.schema_snapshot_sha256 || ''))
      ? String(value.schema_snapshot_sha256)
      : undefined;
  if (datasourceSha256 === undefined || schemaSnapshotSha256 === undefined) return null;
  const legacyStatus = value.decision === 'denied' ? 'denied' : 'pending';
  const reservationStatus = value.reservation_status === undefined
    ? legacyStatus
    : ['pending', 'completed', 'failed', 'denied'].includes(String(value.reservation_status || ''))
      ? value.reservation_status as HostCapabilityPreToolObservation['reservation_status']
      : null;
  const blocker = value.blocker === undefined || value.blocker === null
    ? null
    : typeof value.blocker === 'string' && value.blocker.length > 0 && value.blocker.length <= 160
      ? value.blocker
      : undefined;
  if (!reservationStatus || blocker === undefined
    || (value.decision === 'denied' && reservationStatus !== 'denied')
    || (value.decision === 'allowed' && reservationStatus === 'denied')) return null;
  return {
    tool_use_id_sha256: value.tool_use_id_sha256,
    tool: value.tool,
    resource_key: resourceKey,
    datasource_sha256: datasourceSha256,
    schema_snapshot_sha256: schemaSnapshotSha256,
    decision: value.decision,
    reservation_status: reservationStatus,
    blocker
  };
}

function isPostToolObservation(value: unknown): value is HostCapabilityPostToolObservation {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.sequence)
    || Number(value.sequence) < 1
    || !SHA256_RECEIPT_PATTERN.test(String(value.tool_use_id_sha256 || ''))
    || typeof value.tool !== 'string'
    || value.tool.length === 0
    || value.tool.length > 128
    || (value.status !== 'passed' && value.status !== 'failed')
    || !SHA256_RECEIPT_PATTERN.test(String(value.event_sha256 || ''))
    || (value.resource_key !== null && !SHA256_RECEIPT_PATTERN.test(String(value.resource_key || '')))
    || !isHostToolSemanticReceipt(value.semantic_receipt)
    || (value.validation_blocker !== null
      && (typeof value.validation_blocker !== 'string' || value.validation_blocker.length > 160))
    || !Array.isArray(value.artifacts)) return false;
  return value.artifacts.length <= MAX_ARTIFACT_RECEIPTS
    && value.artifacts.every((artifact) => isRecord(artifact) && normalizeArtifactReceipt(artifact) !== null);
}

function normalizePostToolObservation(value: unknown): HostCapabilityPostToolObservation | null {
  if (!isPostToolObservation(value)) return null;
  const semanticReceipt = normalizeStoredSemanticReceipt(value.semantic_receipt);
  if (value.semantic_receipt !== null && !semanticReceipt) return null;
  return {
    sequence: value.sequence,
    tool_use_id_sha256: value.tool_use_id_sha256,
    tool: value.tool,
    status: value.status,
    event_sha256: value.event_sha256,
    resource_key: value.resource_key,
    semantic_receipt: semanticReceipt,
    validation_blocker: value.validation_blocker,
    artifacts: value.artifacts.map((artifact) => normalizeArtifactReceipt(artifact as unknown as Record<string, unknown>)!)
  };
}

function isHostCapabilityRuntime(value: unknown): value is HostCapabilityRuntime {
  if (!isRecord(value)
    || value.schema !== HOST_CAPABILITY_RUNTIME_SCHEMA
    || typeof value.ok !== 'boolean'
    || value.server !== HOST_CAPABILITY_MCP_SERVER
    || !Array.isArray(value.requested_capability_ids)
    || !Array.isArray(value.task_workflows)
    || !Array.isArray(value.requested_tool_names)
    || !Array.isArray(value.observed_tool_names)
    || !Array.isArray(value.allowed_tool_names)
    || !Array.isArray(value.denied_tool_names)
    || !Array.isArray(value.explicit_denied_tool_names)
    || !Array.isArray(value.capabilities)
    || !Array.isArray(value.blockers)) return false;
  const knownIds = new Set(HOST_CAPABILITY_DESCRIPTORS.map((descriptor) => descriptor.id));
  const knownTools = new Set(HOST_CAPABILITY_DESCRIPTORS.flatMap((descriptor) => descriptor.tool_names));
  const requested = uniqueStrings(value.requested_capability_ids);
  const requestedTools = uniqueStrings(value.requested_tool_names);
  const observed = uniqueStrings(value.observed_tool_names);
  const allowed = uniqueStrings(value.allowed_tool_names);
  const denied = uniqueStrings(value.denied_tool_names);
  const blockers = uniqueStrings(value.blockers);
  if (requested.length !== value.requested_capability_ids.length
    || requested.some((id) => !knownIds.has(id))
    || requestedTools.length !== value.requested_tool_names.length
    || requestedTools.some((tool) => !knownTools.has(tool))
    || observed.length !== value.observed_tool_names.length
    || allowed.length !== value.allowed_tool_names.length
    || allowed.some((tool) => !knownTools.has(tool) || !observed.includes(tool) || EXPLICIT_DENIAL_PATTERN.test(tool))
    || denied.length !== value.denied_tool_names.length
    || JSON.stringify(denied) !== JSON.stringify(observed.filter((tool) => !allowed.includes(tool)))
    || blockers.length !== value.blockers.length
    || value.blockers.some((blocker: unknown) => typeof blocker !== 'string' || blocker.length > 256)
    || value.ok !== (blockers.length === 0)
    || JSON.stringify(uniqueWorkflows(value.task_workflows)) !== JSON.stringify(value.task_workflows)
    || value.capabilities.length !== HOST_CAPABILITY_DESCRIPTORS.length
    || JSON.stringify(value.capabilities.map((entry: any) => entry?.id))
      !== JSON.stringify(HOST_CAPABILITY_DESCRIPTORS.map((descriptor) => descriptor.id))
    || value.capabilities.some((entry) => !isHostCapabilityRuntimeEntry(entry, requested, observed, allowed))
    || typeof value.server_present !== 'boolean'
    || typeof value.server_enabled !== 'boolean'
    || value.server_scope !== (value.server_present ? 'project' : null)
    || (value.inventory_source !== null && !boundedRuntimeText(value.inventory_source, 512))
    || !boundedRuntimeText(value.health_status, 128)) return false;
  const allowedFromEntries = uniqueStrings(value.capabilities.flatMap((entry: any) => entry.allowed_tool_names));
  if (JSON.stringify(allowedFromEntries) !== JSON.stringify(allowed)) return false;
  const explicitDenied = denied.filter((tool) => EXPLICIT_DENIAL_PATTERN.test(tool));
  if (JSON.stringify(explicitDenied) !== JSON.stringify(value.explicit_denied_tool_names)) return false;
  const expectedDigest = hostCapabilityRuntimeDigest(value as unknown as HostCapabilityRuntime);
  return value.allowlist_digest === expectedDigest
    && value.capability_digest === hostCapabilityDigest(HOST_CAPABILITY_DESCRIPTORS);
}

function isHostCapabilityRuntimeEntry(
  value: unknown,
  requested: readonly string[],
  observed: readonly string[],
  allowed: readonly string[]
): boolean {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.requested !== 'boolean'
    || !['available', 'missing', 'unhealthy', 'not_requested'].includes(String(value.state || ''))
    || !Array.isArray(value.expected_tool_names)
    || !Array.isArray(value.observed_tool_names)
    || !Array.isArray(value.allowed_tool_names)
    || !Array.isArray(value.blockers)) return false;
  const descriptor = HOST_CAPABILITY_DESCRIPTORS.find((entry) => entry.id === value.id);
  if (!descriptor) return false;
  const expectedObserved = uniqueStrings(descriptor.tool_names.filter((tool) => observed.includes(tool)));
  const expectedAllowed = descriptor.executable !== false && requested.includes(value.id)
    ? uniqueStrings(descriptor.tool_names.filter((tool) => allowed.includes(tool)))
    : [];
  const entryBlockers = uniqueStrings(value.blockers);
  return value.requested === requested.includes(value.id)
    && JSON.stringify(value.expected_tool_names) === JSON.stringify(descriptor.tool_names)
    && JSON.stringify(value.allowed_tool_names) === JSON.stringify(expectedAllowed)
    && JSON.stringify(value.observed_tool_names) === JSON.stringify(expectedObserved)
    && JSON.stringify(value.blockers) === JSON.stringify(entryBlockers)
    && entryBlockers.every((blocker) => blocker.length <= 256)
    && (requested.includes(value.id) ? value.state !== 'not_requested' : value.state === 'not_requested');
}

function hostCapabilityRuntimeMatchesRequest(
  runtime: HostCapabilityRuntime,
  request: HostCapabilityRequest
): boolean {
  return JSON.stringify(runtime.requested_capability_ids) === JSON.stringify(uniqueStrings(request.capability_ids))
    && JSON.stringify(runtime.task_workflows) === JSON.stringify(uniqueWorkflows(request.workflows))
    && JSON.stringify(runtime.requested_tool_names) === JSON.stringify(uniqueStrings(request.tool_names || []));
}
function structuredHostToolResponse(value: unknown): Record<string, any> | null {
  if (!isRecord(value)) return null;
  const structuredContent = parseBoundedHostToolJsonObject(
    value.structured_content,
    MAX_HOST_TOOL_STRUCTURED_RESULT_BYTES
  ) ?? parseBoundedHostToolJsonObject(
    value.structuredContent,
    MAX_HOST_TOOL_STRUCTURED_RESULT_BYTES
  );
  const contentObjects = Array.isArray(value.content)
    ? value.content
      .filter((item) => isRecord(item) && item.type === 'text')
      .map((item) => parseBoundedHostToolJsonObject(item.text, MAX_EVENT_LINE_BYTES))
      .filter((item): item is Record<string, unknown> => item !== null)
    : [];
  const distinctContentObjects = distinctJsonObjects(contentObjects);
  if (distinctContentObjects.length > 1) return null;
  const contentObject = distinctContentObjects[0] ?? null;
  if (structuredContent) {
    return contentObject && !sameJsonObject(structuredContent, contentObject)
      ? null
      : structuredContent;
  }
  if (value.structured_content !== undefined || value.structuredContent !== undefined) return null;
  return contentObject;
}

function normalizeHostToolSemanticReceipt(
  tool: string,
  toolInput: unknown,
  response: Record<string, any>
): { receipt: HostToolSemanticReceipt | null; blocker: string | null } {
  if (tool === 'datasource_schema_context') {
    const input = isRecord(toolInput) ? toolInput : {};
    const datasource = boundedIdentity(response.datasource);
    const inputDatasource = boundedIdentity(input.datasource);
    const snapshotId = boundedIdentity(response.schema_snapshot_id);
    return datasource && (!inputDatasource || datasource === inputDatasource) && snapshotId
      ? {
          receipt: {
            kind: 'datasource_schema',
            datasource_sha256: `sha256:${sha256(datasource)}`,
            schema_snapshot_sha256: `sha256:${sha256(snapshotId)}`
          },
          blocker: null
        }
      : {
          receipt: null,
          blocker: datasource && inputDatasource && datasource !== inputDatasource
            ? 'host_capability_schema_datasource_mismatch'
            : 'host_capability_schema_receipt_invalid'
        };
  }
  if (tool === 'datasource_query_readonly') {
    const input = isRecord(toolInput) ? toolInput : {};
    const datasource = boundedIdentity(response.datasource);
    const inputDatasource = boundedIdentity(input.datasource);
    const snapshotId = boundedIdentity(response.schema_snapshot_id);
    const inputSnapshotId = boundedIdentity(input.schema_snapshot_id);
    const query = boundedQueryText(input.query ?? input.sql);
    const querySha256 = typeof response.query_sha256 === 'string'
      ? response.query_sha256.trim().toLowerCase()
      : '';
    const rowCount = nonnegativeSafeInteger(response.row_count);
    const columnCount = nonnegativeSafeInteger(response.column_count);
    const status = String(response.status || '').trim().toLowerCase();
    if (!datasource) {
      return { receipt: null, blocker: 'host_capability_readonly_query_receipt_invalid' };
    }
    if (inputDatasource && datasource !== inputDatasource) {
      return { receipt: null, blocker: 'host_capability_readonly_query_datasource_mismatch' };
    }
    if (!snapshotId || !inputSnapshotId || snapshotId !== inputSnapshotId) {
      return { receipt: null, blocker: 'host_capability_readonly_query_schema_mismatch' };
    }
    if (!query || !SHA256_RECEIPT_PATTERN.test(querySha256)
      || querySha256 !== `sha256:${sha256(query)}`) {
      return { receipt: null, blocker: 'host_capability_readonly_query_hash_mismatch' };
    }
    if (rowCount === null || columnCount === null || typeof response.truncated !== 'boolean' || status !== 'passed') {
      return { receipt: null, blocker: 'host_capability_readonly_query_receipt_invalid' };
    }
    return {
      receipt: {
        kind: 'datasource_query',
        datasource_sha256: `sha256:${sha256(datasource)}`,
        schema_snapshot_sha256: `sha256:${sha256(snapshotId)}`,
        query_sha256: querySha256,
        row_count: rowCount,
        column_count: columnCount,
        truncated: response.truncated,
        status: 'passed'
      },
      blocker: null
    };
  }
  if (tool === 'spreadsheet_inspect') {
    const sheetNames = Array.isArray(response.sheet_names)
      ? response.sheet_names.map((value: unknown) => boundedIdentity(value)).filter(Boolean) as string[]
      : [];
    const rowCountKeys = isRecord(response.row_counts) ? Object.keys(response.row_counts).sort() : [];
    const rowCounts = isRecord(response.row_counts)
      ? Object.values(response.row_counts).map(nonnegativeSafeInteger)
      : [];
    const formulas = Array.isArray(response.formulas) ? response.formulas : null;
    const errorCells = Array.isArray(response.error_cells) ? response.error_cells : null;
    const successful = response.ok === true || response.success === true
      || ['passed', 'success', 'completed'].includes(String(response.status || '').trim().toLowerCase());
    if (!successful
      || sheetNames.length === 0
      || sheetNames.length > 256
      || uniqueStrings(sheetNames).length !== sheetNames.length
      || sheetNames.length !== response.sheet_names.length
      || rowCounts.length !== sheetNames.length
      || JSON.stringify(rowCountKeys) !== JSON.stringify([...sheetNames].sort())
      || rowCounts.some((count) => count === null)
      || formulas === null
      || formulas.length > MAX_SEMANTIC_RECEIPT_ITEMS
      || errorCells === null
      || errorCells.length > MAX_SEMANTIC_RECEIPT_ITEMS) {
      return { receipt: null, blocker: 'host_capability_spreadsheet_inspection_receipt_invalid' };
    }
    if (errorCells.length > 0) {
      return { receipt: null, blocker: 'host_capability_spreadsheet_error_cells_present' };
    }
    const totalRowCount = (rowCounts as number[]).reduce((sum, count) => sum + count, 0);
    if (!Number.isSafeInteger(totalRowCount)) {
      return { receipt: null, blocker: 'host_capability_spreadsheet_inspection_receipt_invalid' };
    }
    return {
      receipt: {
        kind: 'spreadsheet_inspection',
        sheet_names_sha256: `sha256:${sha256(JSON.stringify(sheetNames))}`,
        sheet_count: sheetNames.length,
        row_count: totalRowCount,
        formula_count: formulas.length,
        error_cell_count: 0
      },
      blocker: null
    };
  }
  return { receipt: null, blocker: null };
}

function isHostToolSemanticReceipt(value: unknown): value is HostToolSemanticReceipt | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.kind === 'datasource_schema') {
    return SHA256_RECEIPT_PATTERN.test(String(value.datasource_sha256 || ''))
      && SHA256_RECEIPT_PATTERN.test(String(value.schema_snapshot_sha256 || ''));
  }
  if (value.kind === 'datasource_query') {
    return SHA256_RECEIPT_PATTERN.test(String(value.datasource_sha256 || ''))
      && SHA256_RECEIPT_PATTERN.test(String(value.schema_snapshot_sha256 || ''))
      && SHA256_RECEIPT_PATTERN.test(String(value.query_sha256 || ''))
      && nonnegativeSafeInteger(value.row_count) !== null
      && nonnegativeSafeInteger(value.column_count) !== null
      && typeof value.truncated === 'boolean'
      && value.status === 'passed';
  }
  if (value.kind === 'spreadsheet_inspection') {
    return SHA256_RECEIPT_PATTERN.test(String(value.sheet_names_sha256 || ''))
      && nonnegativeSafeInteger(value.sheet_count) !== null
      && nonnegativeSafeInteger(value.row_count) !== null
      && nonnegativeSafeInteger(value.formula_count) !== null
      && value.error_cell_count === 0;
  }
  return false;
}

function normalizeStoredSemanticReceipt(value: unknown): HostToolSemanticReceipt | null {
  if (value === null) return null;
  if (!isHostToolSemanticReceipt(value)) return null;
  if (value.kind === 'datasource_schema') {
    return {
      kind: value.kind,
      datasource_sha256: value.datasource_sha256,
      schema_snapshot_sha256: value.schema_snapshot_sha256
    };
  }
  if (value.kind === 'datasource_query') {
    return {
      kind: value.kind,
      datasource_sha256: value.datasource_sha256,
      schema_snapshot_sha256: value.schema_snapshot_sha256,
      query_sha256: value.query_sha256,
      row_count: value.row_count,
      column_count: value.column_count,
      truncated: value.truncated,
      status: 'passed'
    };
  }
  return {
    kind: value.kind,
    sheet_names_sha256: value.sheet_names_sha256,
    sheet_count: value.sheet_count,
    row_count: value.row_count,
    formula_count: value.formula_count,
    error_cell_count: 0
  };
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedRuntimeText(value: unknown, maxLength: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= maxLength && !/[\r\n\0]/.test(text) ? text : null;
}

function boundedQueryText(value: unknown): string | null {
  const text = typeof value === 'string' ? value : '';
  return text.trim()
    && Buffer.byteLength(text, 'utf8') <= MAX_RECEIPT_JSON_STRING_BYTES
    && !/[\0]/.test(text)
    ? text
    : null;
}

function hostToolResponseFailed(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.isError === true || value.is_error === true || value.ok === false || value.success === false) return true;
  const status = String(value.status || '').trim().toLowerCase();
  return status === 'failed' || status === 'error';
}

function boundedIdentity(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 256 && !/[\r\n\0]/.test(text) ? text : null;
}
function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1]?.trim();
  for (const candidate of [trimmed, ...(fenced ? [fenced] : [])]) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function parseBoundedHostToolJsonObject(
  value: unknown,
  maxBytes: number
): Record<string, unknown> | null {
  if (isRecord(value)) {
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes
        ? value
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, 'utf8') > maxBytes) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function distinctJsonObjects(values: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const distinct = new Map<string, Record<string, unknown>>();
  for (const value of values) distinct.set(canonicalJson(value), value);
  return [...distinct.values()];
}

function sameJsonObject(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function uniqueWorkflows(values: readonly unknown[]): HostCapabilityWorkflow[] {
  const valid = new Set<HostCapabilityWorkflow>([
    'datasource_sql_generation',
    'datasource_query',
    'spreadsheet_create',
    'spreadsheet_edit',
    'document_render',
    'web_capture',
    'workspace_files',
    'artifact_delivery'
  ]);
  return uniqueStrings(values).filter((value): value is HostCapabilityWorkflow => valid.has(value as HostCapabilityWorkflow));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
