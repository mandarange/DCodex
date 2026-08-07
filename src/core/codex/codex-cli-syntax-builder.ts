export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type CodexServiceTier = 'fast' | 'standard'

export type BuildCodexExecArgsOptions = {
  json?: boolean
  outputSchema?: string | null
  outputLastMessage?: string | null
  ephemeral?: boolean
  skipGitRepoCheck?: boolean
  profile?: string | null
  profileAlias?: 'long' | 'short'
  ignoreUserConfig?: boolean
  noMcp?: boolean
  ignoreRules?: boolean
  sandbox?: CodexSandboxMode
  serviceTier?: CodexServiceTier | null
  danger?: boolean
  allowDanger?: boolean
  prompt: string
}

export function buildCodexExecArgs(opts: BuildCodexExecArgsOptions): string[] {
  if (opts.danger && !opts.allowDanger) {
    throw new Error('codex exec danger mode requires explicit allowDanger=true')
  }
  if (opts.profile && opts.ignoreUserConfig) {
    throw new Error('codex exec cannot combine --profile with --ignore-user-config')
  }

  const args = ['exec']
  if (opts.json) args.push('--json')
  if (opts.outputSchema) args.push('--output-schema', opts.outputSchema)
  if (opts.outputLastMessage) args.push('--output-last-message', opts.outputLastMessage)
  if (opts.ephemeral) args.push('--ephemeral')
  if (opts.skipGitRepoCheck) args.push('--skip-git-repo-check')
  if (opts.noMcp) args.push('--no-mcp')
  if (opts.profile) args.push(...buildCodexProfileArgs(opts.profile, opts.profileAlias))
  else if (opts.ignoreUserConfig) args.push('--ignore-user-config')
  if (opts.ignoreRules) args.push('--ignore-rules')
  if (opts.danger) args.push('--dangerously-bypass-approvals-and-sandbox')
  else if (opts.sandbox) args.push('--sandbox', opts.sandbox)
  const serviceTier = normalizeCodexServiceTier(opts.serviceTier)
  if (serviceTier) args.push('-c', `service_tier=${serviceTier}`)
  args.push(opts.prompt)
  return args
}

export function buildCodexProfileArgs(profile: string, alias: 'long' | 'short' = 'long'): string[] {
  return alias === 'short' ? ['-P', profile] : ['--profile', profile]
}

function normalizeCodexServiceTier(value: unknown): CodexServiceTier | null {
  const text = String(value || '').toLowerCase()
  if (text === 'fast' || text === 'priority') return 'fast'
  if (text === 'standard' || text === 'default') return 'standard'
  return null
}
