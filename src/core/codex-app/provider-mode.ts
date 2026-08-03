import { normalizeCodexModelId, readTopLevelTomlString } from './codex-model-catalog.js';

export const CODEX_PROVIDER_MODE_MARKER_PREFIX = '# sks-managed-provider-mode:' as const;
export const CODEX_NATIVE_PROVIDER_ID = 'openai' as const;

export type CodexProviderMode = 'chatgpt-oauth' | 'codex-lb' | 'openrouter';
export type CodexProxyProviderMode = Exclude<CodexProviderMode, 'chatgpt-oauth'>;

export interface CodexProviderModeState {
  readonly schema: 'sks.codex-provider-mode-state.v1';
  readonly mode: CodexProviderMode | null;
  readonly explicit: boolean;
  readonly native_provider_selected: boolean;
  readonly loopback_required: boolean;
  readonly loopback_configured: boolean;
  readonly auxiliary_oauth_required: boolean;
  readonly blockers: readonly string[];
}

const MODES = new Set<CodexProviderMode>(['chatgpt-oauth', 'codex-lb', 'openrouter']);

export function isCodexProviderMode(value: unknown): value is CodexProviderMode {
  return MODES.has(String(value || '').trim() as CodexProviderMode);
}

export function readExplicitCodexProviderMode(configText: string): {
  readonly mode: CodexProviderMode | null;
  readonly blockers: readonly string[];
} {
  const values = String(configText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(CODEX_PROVIDER_MODE_MARKER_PREFIX))
    .map((line) => line.slice(CODEX_PROVIDER_MODE_MARKER_PREFIX.length).trim());
  if (!values.length) return { mode: null, blockers: ['provider_mode_not_explicit'] };
  if (values.length !== 1) return { mode: null, blockers: ['provider_mode_marker_conflict'] };
  const mode = values[0];
  if (!isCodexProviderMode(mode)) return { mode: null, blockers: ['provider_mode_marker_invalid'] };
  return { mode, blockers: [] };
}

export function upsertExplicitCodexProviderMode(configText: string, mode: CodexProviderMode): string {
  const lines = String(configText || '').split('\n');
  const filtered = lines.filter((line) => !line.trim().startsWith(CODEX_PROVIDER_MODE_MARKER_PREFIX));
  const marker = `${CODEX_PROVIDER_MODE_MARKER_PREFIX}${mode}`;
  const firstContent = filtered.findIndex((line) => line.trim().length > 0);
  if (firstContent < 0) return `${marker}\n`;
  filtered.splice(firstContent, 0, marker);
  return `${filtered.join('\n').replace(/^\n+|\n+$/g, '')}\n`;
}

export function codexProviderModeState(configText: string): CodexProviderModeState {
  const explicit = readExplicitCodexProviderMode(configText);
  const selectedProvider = readTopLevelTomlString(configText, 'model_provider');
  const openAiBaseUrl = readTopLevelTomlString(configText, 'openai_base_url');
  const loopbackConfigured = isLoopbackHttpUrl(openAiBaseUrl);
  const loopbackRequired = explicit.mode === 'codex-lb' || explicit.mode === 'openrouter';
  const blockers = [...explicit.blockers];
  if (explicit.mode && selectedProvider !== CODEX_NATIVE_PROVIDER_ID) {
    blockers.push('provider_mode_requires_builtin_openai');
  }
  if (loopbackRequired && !loopbackConfigured) blockers.push('provider_mode_loopback_missing');
  if (explicit.mode === 'chatgpt-oauth' && openAiBaseUrl) {
    blockers.push('chatgpt_oauth_mode_loopback_still_configured');
  }
  return {
    schema: 'sks.codex-provider-mode-state.v1',
    mode: explicit.mode,
    explicit: explicit.blockers.length === 0,
    native_provider_selected: selectedProvider === CODEX_NATIVE_PROVIDER_ID,
    loopback_required: loopbackRequired,
    loopback_configured: loopbackConfigured,
    // Codex's reserved built-in OpenAI identity currently requires its normal
    // auth plane even when the bridge replaces the upstream credential. The
    // bridge must strip this token and must never forward it.
    auxiliary_oauth_required: loopbackRequired,
    blockers: [...new Set(blockers)]
  };
}

export function providerModeOwnsModel(mode: CodexProviderMode, model: unknown): boolean {
  const normalized = normalizeCodexModelId(model);
  if (!normalized) return false;
  if (mode === 'openrouter') return normalized.includes('/');
  return !normalized.includes('/');
}

export function assertProviderModeModel(
  mode: CodexProxyProviderMode,
  model: unknown,
  allowedModels: readonly string[]
): string {
  const normalized = normalizeCodexModelId(model);
  if (!normalized) throw new Error('provider_mode_model_invalid');
  if (!providerModeOwnsModel(mode, normalized)) throw new Error('provider_mode_model_family_mismatch');
  const allowed = new Set(allowedModels.map(normalizeCodexModelId).filter((entry): entry is string => Boolean(entry)));
  if (!allowed.size) throw new Error('provider_mode_model_catalog_empty');
  if (!allowed.has(normalized)) throw new Error('provider_mode_model_not_allowed');
  return normalized;
}

function isLoopbackHttpUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return parsed.protocol === 'http:' && (host === '127.0.0.1' || host === '::1' || host === 'localhost');
  } catch {
    return false;
  }
}
