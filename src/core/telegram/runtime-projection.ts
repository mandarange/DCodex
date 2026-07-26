import crypto from 'node:crypto';
import type { RemoteSessionTargetV1 } from '../remote/index.js';
import { buildTelegramTopicName } from './ledgers.js';
import { publicSafeText, type TelegramSessionCard } from './messages.js';
import type { RemoteActionV1, TelegramTopicRouteV1 } from './types.js';
import { asRecordOrNull as asRecord } from '../json/records.js';

export { asRecord };

export interface ProjectionSessionV1 {
  after_seq: number;
  snapshot_digest: string | null;
  draft_message_id: number | null;
  final_generation: number | null;
}

export interface ProjectionStateV1 {
  schema: 'sks.telegram-projection-state.v1';
  sessions: Record<string, ProjectionSessionV1>;
}

export function pickerAction(route: TelegramTopicRouteV1, now: number): RemoteActionV1 {
  return {
    schema: 'sks.remote-action.v1',
    action_id: crypto.randomUUID(),
    machine_id: route.machine_id,
    project_id: route.project_id,
    session_id: route.session_id,
    kind: 'read',
    risk: 'R0',
    prompt: 'pick',
    exact_scope: [route.machine_id, route.project_id, route.session_id],
    expires_at: new Date(now + 10 * 60_000).toISOString(),
    revision: 1,
    status: 'open'
  };
}

export function cardFromSnapshot(route: TelegramTopicRouteV1, snapshot: Record<string, unknown>): TelegramSessionCard {
  const project = asRecord(snapshot.project);
  return {
    machine: route.machine_id,
    project: String(project?.name ?? route.project_id),
    branch: String(project?.branch ?? 'unknown'),
    state: String(snapshot.session_state ?? snapshot.phase ?? 'unknown'),
    route: String(snapshot.route ?? 'unknown'),
    model: String(snapshot.model ?? 'not reported'),
    gate: String(snapshot.machine_gates_status ?? 'not recorded'),
    trust: String(snapshot.trust_status ?? 'not verified'),
    changed: String(snapshot.changed ?? 'not reported'),
    last_event: String(snapshot.phase ?? snapshot.updated_at ?? 'unknown'),
    checks: {
      build: snapshot.execution_terminal === true,
      focused_tests: snapshot.completion_proof_status === 'verified' || snapshot.completion_proof_status === 'verified_partial',
      full_release: snapshot.machine_gates_pass === true,
      npm_pack: snapshot.npm_pack_verified === true
    },
    latest_public_activity: snapshotSummary(snapshot)
  };
}

export function snapshotSummary(snapshot: Record<string, unknown>): string {
  return publicSafeText([
    `State: ${String(snapshot.session_state ?? 'unknown')}`,
    `Phase: ${String(snapshot.phase ?? 'unknown')}`,
    `Proof: ${String(snapshot.completion_proof_status ?? 'not verified')}`,
    `Gates: ${String(snapshot.machine_gates_status ?? 'not recorded')}`,
    `Trust: ${String(snapshot.trust_status ?? 'not verified')}`
  ].join('\n'));
}

export function successSummary(action: RemoteActionV1, data: Record<string, unknown> | null): string {
  if (action.kind === 'input') {
    const response = typeof data?.final_response === 'string' ? data.final_response.trim() : '';
    return response
      ? publicSafeText(response)
      : 'Codex completed the Telegram turn, but no public final response was available.';
  }
  if (action.kind === 'cancel') return 'Cancellation completed with owner-proof and one-time approval receipts.';
  if (action.kind === 'verify') return `Verification snapshot: ${snapshotSummary(data ?? {})}`;
  return snapshotSummary(data ?? {});
}

export function topicName(target: RemoteSessionTargetV1, sessionId: string, snapshot: Record<string, unknown> | null): string {
  const project = asRecord(snapshot?.project);
  return buildTelegramTopicName({
    machine: target.machine_id,
    repo: String(project?.name ?? target.project_id),
    branch: String(project?.branch ?? 'unknown'),
    title: String(snapshot?.route ?? sessionId)
  });
}

export function commandView(prompt: string): string {
  const view = prompt.replace(/^\//, '').trim().toLowerCase();
  return ['status', 'tail', 'diff', 'gates', 'trust', 'proof', 'artifacts', 'refresh', 'open'].includes(view) ? view : 'status';
}

export function routeKey(route: TelegramTopicRouteV1): string {
  return `${route.machine_id}:${route.project_id}:${route.session_id}:${route.generation}`;
}

export function emptyProjection(): ProjectionSessionV1 {
  return { after_seq: 0, snapshot_digest: null, draft_message_id: null, final_generation: null };
}

export function requestId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function boundedIdentifier(value: unknown): string | null {
  const text = typeof value === 'string' ? value : '';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(text) ? text : null;
}
