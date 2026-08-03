import type { ProviderSessionPin } from './provider-session-policy.js';
import { assertProviderModeModel, type CodexProviderMode } from './provider-mode.js';

export type ChildModelStrategy = 'native-oauth' | 'codex-lb-dynamic' | 'openrouter-registered';

export function decideProviderChildModel(input: {
  session: ProviderSessionPin;
  requestedModel?: string | null;
  registeredOpenRouterModels?: readonly string[];
}) {
  const mode: CodexProviderMode = input.session.mode;
  if (mode === 'chatgpt-oauth') {
    if (input.requestedModel) {
      return blocked('native-oauth', 'oauth_child_model_override_forbidden');
    }
    return {
      schema: 'sks.provider-child-model-decision.v1' as const,
      ok: true,
      strategy: 'native-oauth' as const,
      model_override: null,
      inherit_session_mode: true,
      inherit_credential_binding: true,
      settings_owner: 'codex-native' as const,
      blockers: []
    };
  }

  const requested = String(input.requestedModel || '').trim();
  if (!requested) return blocked(mode === 'codex-lb' ? 'codex-lb-dynamic' : 'openrouter-registered', 'child_model_selection_required');
  if (mode === 'codex-lb') {
    try {
      assertProviderModeModel('codex-lb', requested, input.session.allowed_models);
    } catch (error) {
      return blocked('codex-lb-dynamic', `child_${(error as Error).message}`);
    }
    return allowed('codex-lb-dynamic', requested, 'codex-lb-session');
  }

  const registered = input.registeredOpenRouterModels || [];
  try {
    assertProviderModeModel('openrouter', requested, registered);
    assertProviderModeModel('openrouter', requested, input.session.allowed_models);
  } catch (error) {
    return blocked('openrouter-registered', `child_${(error as Error).message}`);
  }
  return allowed('openrouter-registered', requested, 'sks-center');
}

function allowed(strategy: Exclude<ChildModelStrategy, 'native-oauth'>, model: string, owner: 'codex-lb-session' | 'sks-center') {
  return {
    schema: 'sks.provider-child-model-decision.v1' as const,
    ok: true,
    strategy,
    model_override: model,
    inherit_session_mode: true,
    inherit_credential_binding: true,
    settings_owner: owner,
    blockers: []
  };
}

function blocked(strategy: ChildModelStrategy, blocker: string) {
  return {
    schema: 'sks.provider-child-model-decision.v1' as const,
    ok: false,
    strategy,
    model_override: null,
    inherit_session_mode: true,
    inherit_credential_binding: true,
    settings_owner: strategy === 'native-oauth' ? 'codex-native' as const : strategy === 'openrouter-registered' ? 'sks-center' as const : 'codex-lb-session' as const,
    blockers: [blocker]
  };
}
