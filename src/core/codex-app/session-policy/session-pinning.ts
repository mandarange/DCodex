import { createHash } from 'node:crypto';
import {
  assertProviderPolicyCompatible,
  stableArchitectureHash,
  type ProviderMode,
  type ProviderPolicySnapshot,
  type SessionPin
} from '../../architecture-hardening/contracts/contracts.js';

export interface SessionResumeDecision {
  readonly schema: 'sks.session-resume-decision.v1';
  readonly ok: boolean;
  readonly status: 'resumable' | 'migration_required' | 'blocked';
  readonly pin: SessionPin | null;
  readonly blocker: string | null;
}

export function createSessionPin(input: {
  sessionId: string;
  policy: ProviderPolicySnapshot;
  model: string;
  lbAffinityToken?: string | null;
  parentSessionId?: string | null;
}): SessionPin {
  if (!validId(input.sessionId)) throw new Error('session_pin_id_invalid');
  const model = String(input.model || '').trim();
  if (!input.policy.allowed_models.includes(model)) throw new Error('session_pin_model_not_allowed');
  if ((input.policy.mode === 'openrouter') !== model.includes('/')) throw new Error('session_pin_model_family_mismatch');
  if (input.policy.mode === 'codex-lb' && !input.lbAffinityToken) throw new Error('session_pin_lb_affinity_required');
  if (input.policy.mode !== 'codex-lb' && input.lbAffinityToken) throw new Error('session_pin_lb_affinity_forbidden');
  return Object.freeze({
    schema: 'sks.session-pin.v1',
    session_id: input.sessionId,
    mode: input.policy.mode,
    model,
    credential_class: input.policy.credential_class,
    allowed_models: Object.freeze([...input.policy.allowed_models]),
    lb_affinity_token_hash: input.lbAffinityToken ? createHash('sha256').update(input.lbAffinityToken).digest('hex') : null,
    child_policy_hash: input.policy.child_policy_hash,
    catalog_version: input.policy.catalog_version,
    parent_session_id: input.parentSessionId || null
  });
}

export function forkSessionPin(parent: SessionPin, sessionId: string): SessionPin {
  if (!validId(sessionId)) throw new Error('session_pin_id_invalid');
  return Object.freeze({ ...parent, session_id: sessionId, parent_session_id: parent.session_id, allowed_models: Object.freeze([...parent.allowed_models]) });
}

export function resumeSessionPin(pin: SessionPin | null, policy: ProviderPolicySnapshot): SessionResumeDecision {
  if (!pin) return { schema: 'sks.session-resume-decision.v1', ok: false, status: 'migration_required', pin: null, blocker: 'session_pin_metadata_missing' };
  const pinnedPolicy: ProviderPolicySnapshot = {
    schema: 'sks.provider-policy-snapshot.v1',
    contract_version: policy.contract_version,
    mode: pin.mode,
    credential_class: pin.credential_class,
    allowed_models: pin.allowed_models,
    child_policy_hash: pin.child_policy_hash,
    catalog_version: pin.catalog_version
  };
  try {
    assertProviderPolicyCompatible(pinnedPolicy, policy);
  } catch (error) {
    return { schema: 'sks.session-resume-decision.v1', ok: false, status: 'blocked', pin, blocker: (error as Error).message };
  }
  if (!pin.allowed_models.includes(pin.model)) return { schema: 'sks.session-resume-decision.v1', ok: false, status: 'blocked', pin, blocker: 'session_pin_model_restore_mismatch' };
  return { schema: 'sks.session-resume-decision.v1', ok: true, status: 'resumable', pin, blocker: null };
}

export function sessionPinHash(pin: SessionPin): string {
  return stableArchitectureHash(pin);
}

export function assertSessionRequest(pin: SessionPin, input: { mode: ProviderMode; model: string; childPolicyHash: string }): void {
  if (pin.mode !== input.mode) throw new Error('session_pin_mode_switch_forbidden');
  if (pin.model !== input.model) throw new Error('session_pin_model_switch_forbidden');
  if (pin.child_policy_hash !== input.childPolicyHash) throw new Error('session_pin_child_policy_mismatch');
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(String(value || ''));
}
