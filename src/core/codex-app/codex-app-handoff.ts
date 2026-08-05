import path from 'node:path'
import { detectCodexCurrentAppCapability, type CodexCurrentAppCapability } from '../codex-control/codex-current-app-capability.js'
import { nowIso, writeJsonAtomic, writeTextAtomic } from '../fsx.js'
import { attemptCodexAppLaunch, type CodexAppLaunchAttempt } from './codex-app-launcher.js'

export interface CodexAppHandoffRequest {
  schema: 'sks.codex-app-handoff-request.v1'
  mission_id: string
  route: '$QA-LOOP' | '$Research' | '$Naruto' | '$MAD' | string
  reason: string
  thread_ref?: string | null
  workspace_path: string
  artifacts: string[]
  prompt: string
  require_desktop: boolean
  capability_required: 'codex-current'
  launch_mode?: 'artifact-only' | 'attempt-launch'
}

export interface CodexAppHandoffResult {
  schema: 'sks.codex-app-handoff-result.v1'
  ok: boolean
  attempted: boolean
  launched: boolean
  status: 'pending' | 'skipped' | 'blocked_for_desktop_review' | 'launched_pending_confirmation'
  codex_current_app_capability: CodexCurrentAppCapability
  command_line: string[]
  launch_attempt?: CodexAppLaunchAttempt | null
  confirmation_required: boolean
  desktop_handoff_supported: boolean
  fallback_reason: string | null
  artifact_path: string
  prompt_artifact_path: string
  blockers: string[]
}

export function buildCodexAppHandoffPrompt(request: CodexAppHandoffRequest): string {
  return [
    'SKS Codex Desktop /app handoff request',
    `Mission: ${request.mission_id}`,
    `Route: ${request.route}`,
    `Reason: ${request.reason}`,
    `Workspace: ${request.workspace_path}`,
    request.thread_ref ? `Thread: ${request.thread_ref}` : '',
    '',
    'Artifacts:',
    ...(request.artifacts || []).map((artifact) => `- ${artifact}`),
    '',
    'Prompt:',
    request.prompt,
    '',
    'Operator instruction: open Codex Desktop with `codex /app` and continue this mission using the artifacts above. Do not treat this handoff artifact as web UI verification evidence.'
  ].filter((line) => line !== '').join('\n')
}

export async function runCodexAppHandoff(root: string, request: CodexAppHandoffRequest): Promise<CodexAppHandoffResult> {
  const capability = await detectCodexCurrentAppCapability()
  const platformSupported = process.platform === 'darwin' || process.platform === 'win32'
  const desktopSupported = capability.supports_app_handoff === true && platformSupported
  const launchMode = request.launch_mode || 'artifact-only'
  const dir = path.join(root, '.sneakoscope', 'missions', request.mission_id, 'qa-loop')
  const artifactPath = path.join(dir, 'app-handoff.json')
  const promptArtifactPath = path.join(dir, 'app-handoff-prompt.md')
  const blockers = [
    ...(capability.supports_app_handoff ? [] : ['codex_current_app_handoff_unavailable']),
    ...(platformSupported ? [] : ['codex_app_handoff_platform_unsupported'])
  ]
  const prompt = buildCodexAppHandoffPrompt(request)
  await writeTextAtomic(promptArtifactPath, prompt)
  const launchAttempt = desktopSupported
    ? await attemptCodexAppLaunch({
        cwd: root,
        promptArtifactPath,
        mode: launchMode,
        timeoutMs: 3000
      })
    : await attemptCodexAppLaunch({
        cwd: root,
        promptArtifactPath,
        mode: 'artifact-only',
        timeoutMs: 3000
      })
  const status: CodexAppHandoffResult['status'] = request.require_desktop && !desktopSupported
    ? 'blocked_for_desktop_review'
    : request.require_desktop && launchMode === 'attempt-launch' && launchAttempt.attempted && !launchAttempt.launched
      ? 'blocked_for_desktop_review'
      : desktopSupported && launchAttempt.launched
        ? 'launched_pending_confirmation'
        : desktopSupported
          ? 'pending'
          : 'skipped'
  const result: CodexAppHandoffResult = {
    schema: 'sks.codex-app-handoff-result.v1',
    ok: request.require_desktop ? status !== 'blocked_for_desktop_review' : true,
    attempted: launchAttempt.attempted,
    launched: launchAttempt.launched,
    status,
    codex_current_app_capability: capability,
    command_line: launchAttempt.command_line,
    launch_attempt: launchAttempt,
    confirmation_required: request.require_desktop,
    desktop_handoff_supported: desktopSupported,
    fallback_reason: desktopSupported
      ? launchAttempt.fallback_reason || 'desktop_handoff_pending_operator_confirmation'
      : blockers.join(';') || null,
    artifact_path: artifactPath,
    prompt_artifact_path: promptArtifactPath,
    blockers: request.require_desktop ? [...blockers, ...(status === 'blocked_for_desktop_review' ? launchAttempt.blockers : [])] : []
  }
  await writeJsonAtomic(artifactPath, {
    ...result,
    request,
    operator_instruction: {
      open: 'codex /app',
      prompt_artifact: path.relative(root, promptArtifactPath),
      created_at: nowIso()
    }
  })
  return result
}

export function qaLoopShouldRequestAppHandoff(input: {
  args?: string[]
  uiRequired?: boolean
  visualArtifactsPresent?: boolean
  pluginAppTemplateUnavailable?: boolean
  userRequestedDesktopReview?: boolean
} = {}) {
  const args = input.args || []
  return args.includes('--app-handoff')
    || process.env.SKS_QA_LOOP_APP_HANDOFF === '1'
    || input.visualArtifactsPresent === true
    || input.pluginAppTemplateUnavailable === true
    || input.userRequestedDesktopReview === true
    || input.uiRequired === true && process.env.SKS_QA_LOOP_APP_HANDOFF_FOR_VISUAL === '1'
}
