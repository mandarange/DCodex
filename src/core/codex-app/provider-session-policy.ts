import { assertProviderModeModel, type CodexProviderMode } from './provider-mode.js';

export const PROVIDER_SESSION_SCHEMA = 'sks.provider-session.v1' as const;

export interface ProviderSessionPin {
  readonly schema: typeof PROVIDER_SESSION_SCHEMA;
  readonly session_id: string;
  readonly mode: CodexProviderMode;
  readonly model: string;
  readonly allowed_models: readonly string[];
  readonly created_at: string;
  readonly parent_session_id: string | null;
}

export function createProviderSessionPin(input: {
  sessionId: string;
  mode: CodexProviderMode;
  model: string;
  allowedModels: readonly string[];
  createdAt?: string;
  parent?: ProviderSessionPin | null;
}): ProviderSessionPin {
  const sessionId = validSessionId(input.sessionId);
  if (!sessionId) throw new Error('provider_session_id_invalid');
  if (input.parent) {
    if (input.mode !== input.parent.mode) throw new Error('provider_session_fork_mode_mismatch');
    if (input.model !== input.parent.model) throw new Error('provider_session_fork_model_mismatch');
    if (stableModels(input.allowedModels).join('\0') !== stableModels(input.parent.allowed_models).join('\0')) {
      throw new Error('provider_session_fork_catalog_mismatch');
    }
  }
  const allowedModels = stableModels(input.allowedModels);
  if (input.mode === 'chatgpt-oauth') {
    if (!allowedModels.includes(input.model)) throw new Error('provider_session_model_not_allowed');
  } else {
    assertProviderModeModel(input.mode, input.model, allowedModels);
  }
  return {
    schema: PROVIDER_SESSION_SCHEMA,
    session_id: sessionId,
    mode: input.mode,
    model: input.model,
    allowed_models: allowedModels,
    created_at: input.createdAt || new Date().toISOString(),
    parent_session_id: input.parent?.session_id || null
  };
}

export function providerSessionStatus(input: {
  pin: ProviderSessionPin | null;
  globalDefaultMode: CodexProviderMode;
}) {
  if (!input.pin) {
    return {
      schema: 'sks.provider-session-status.v1' as const,
      ok: false,
      status: 'migration_required' as const,
      session_mode: null,
      new_session_default_mode: input.globalDefaultMode,
      mode_changed_since_creation: null,
      blockers: ['legacy_session_provider_mode_selection_required'],
      action: 'Choose a mode explicitly, then start a new session.'
    };
  }
  const modeChanged = input.pin.mode !== input.globalDefaultMode;
  return {
    schema: 'sks.provider-session-status.v1' as const,
    ok: true,
    status: modeChanged ? 'pinned_while_default_changed' as const : 'pinned' as const,
    session_mode: input.pin.mode,
    new_session_default_mode: input.globalDefaultMode,
    mode_changed_since_creation: modeChanged,
    blockers: [],
    action: modeChanged
      ? `This session continues in ${input.pin.mode}; start a new session to use ${input.globalDefaultMode}.`
      : `This session is pinned to ${input.pin.mode}.`
  };
}

export function assertProviderSessionRequest(pin: ProviderSessionPin, input: {
  mode: CodexProviderMode;
  model: string;
}): void {
  if (pin.mode !== input.mode) throw new Error('provider_session_mode_switch_forbidden');
  if (!pin.allowed_models.includes(input.model)) throw new Error('provider_session_model_switch_forbidden');
}

export function classifyPinnedProviderFailure(status: number): {
  readonly retry_allowed: boolean;
  readonly stop_session: boolean;
  readonly blocker: string | null;
  readonly action: string | null;
} {
  if (status === 401 || status === 403) {
    return { retry_allowed: false, stop_session: true, blocker: 'provider_session_authentication_failed', action: 'Verify this mode credential, then start a new session.' };
  }
  if (status === 402 || status === 429) {
    return { retry_allowed: false, stop_session: true, blocker: 'provider_session_quota_or_rate_limit', action: 'Do not fail over accounts; resolve quota or start a new session explicitly.' };
  }
  if (status >= 500) {
    return { retry_allowed: false, stop_session: true, blocker: 'provider_session_upstream_failed', action: 'Keep the pinned account and retry only after explicit user action.' };
  }
  return { retry_allowed: true, stop_session: false, blocker: null, action: null };
}

function stableModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => String(model || '').trim()).filter(Boolean))].sort();
}

function validSessionId(value: unknown): string | null {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) ? id : null;
}
