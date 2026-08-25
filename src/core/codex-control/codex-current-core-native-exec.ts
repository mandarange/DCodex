/**
 * Release-authorizing current-core probes prove Codex CLI compatibility, not
 * Desktop Bridge liveness. Host config may keep OpenCodex Design B /
 * Desktop Bridge `openai_base_url` loopback while `model_provider = "openai"`.
 * That selection is allowed by the launch guard, but a down bridge then fails
 * the web-search and image-path turns. Ignore user config and pin native
 * OpenAI so auth still comes from CODEX_HOME.
 */
export const CODEX_CURRENT_CORE_NATIVE_EXEC_ARGS = [
  '--ignore-user-config',
  '-c',
  'model_provider="openai"',
  '-c',
  'forced_login_method="chatgpt"',
  '-c',
  'mcp_servers={}'
] as const

export const CODEX_CURRENT_CORE_NATIVE_LOOPBACK_ENV_KEYS = [
  'OPENAI_BASE_URL',
  'CHATGPT_BASE_URL',
  'OPENAI_API_BASE',
  'CODEX_API_BASE',
  'CODEX_BASE_URL'
] as const

export function nativeCodexCurrentCoreProbeEnv(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source }
  for (const key of CODEX_CURRENT_CORE_NATIVE_LOOPBACK_ENV_KEYS) delete env[key]
  return env
}

export function withNativeCodexCurrentCoreExecArgs(
  extraArgs: readonly string[] = []
): string[] {
  return [...CODEX_CURRENT_CORE_NATIVE_EXEC_ARGS, ...extraArgs]
}
