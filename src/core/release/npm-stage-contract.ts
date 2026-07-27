export const REQUIRED_NPM_STAGE_CLI_VERSION = '11.15.0'

export interface NpmStageCliInvocation {
  command: string
  args: string[]
}

export function exactNpmStageCliInvocation(platform = process.platform): NpmStageCliInvocation {
  return {
    command: platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['--yes', `npm@${REQUIRED_NPM_STAGE_CLI_VERSION}`]
  }
}

export function localNpmStageReviewEnvironmentBlocker(env: NodeJS.ProcessEnv): string | null {
  const oidcKeys = [
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'NPM_ID_TOKEN',
    'SIGSTORE_ID_TOKEN'
  ]
  if (env.GITHUB_ACTIONS === 'true' || oidcKeys.some((key) => Boolean(String(env[key] || '').trim()))) {
    return 'oidc_environment_not_allowed'
  }
  if (env.CI === 'true' || env.CI === '1') return 'ci_environment_not_allowed'
  return null
}
