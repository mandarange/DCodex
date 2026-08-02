import type { TaskProfile } from './task-profile.js'

export type VerificationBudget =
  | 'none'
  | 'single-check'
  | 'affected'
  | 'confidence'
  | 'release'

export function chooseVerificationBudget(input: {
  taskProfile: TaskProfile
  changedFiles: readonly string[]
  failedChecks?: readonly string[]
}): VerificationBudget {
  const changedFiles = input.changedFiles.map((file) => String(file || '').replace(/\\/g, '/'))
  const failedChecks = (input.failedChecks || []).filter(Boolean)
  const releaseSurface = changedFiles.some((file) => /(?:^|\/)(?:package(?:-lock)?\.json|CHANGELOG\.md|\.github\/workflows\/|src\/core\/release\/|src\/scripts\/(?:prepublish|publish|release))/.test(file))

  if (input.taskProfile === 'passthrough') return 'none'
  if (input.taskProfile === 'answer') return 'none'
  if (releaseSurface) return 'release'
  if (failedChecks.length > 0) return input.taskProfile === 'high-risk' ? 'release' : 'confidence'
  if (input.taskProfile === 'tiny-change') return changedFiles.length > 1 ? 'affected' : 'single-check'
  if (input.taskProfile === 'high-risk') return 'confidence'
  if (changedFiles.length >= 8) return 'confidence'
  return 'affected'
}
