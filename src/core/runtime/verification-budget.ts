import { isTaskProfile, type TaskProfile } from './task-profile.js'

export type VerificationBudget =
  | 'none'
  | 'single-check'
  | 'affected'
  | 'confidence'
  | 'release'

/** Weakest to strongest. The order is the escalation `planVerification` renders. */
const VERIFICATION_BUDGET_ORDER = Object.freeze([
  'none',
  'single-check',
  'affected',
  'confidence',
  'release'
] as const)

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

/**
 * The verification budget a finished run must report.
 *
 * The planned budget is a forecast made before a single file changed. Once the
 * parent reports what the run actually changed, that forecast stops being the
 * best available answer: a run that turned out to touch release surface must not
 * finalize claiming the `affected` budget it was planned with.
 *
 * The result is never weaker than the plan. Observed breadth may only escalate a
 * forecast; it may not relax one, because a plan written for a profile this
 * function cannot re-derive is still a commitment the run has to honour.
 */
export function finalizedVerificationBudget(input: {
  plannedBudget: unknown
  taskProfile: unknown
  changedFiles: readonly unknown[]
}): VerificationBudget {
  const planned = isVerificationBudget(input.plannedBudget) ? input.plannedBudget : null
  if (!isTaskProfile(input.taskProfile)) return planned ?? 'affected'
  const changedFiles = (Array.isArray(input.changedFiles) ? input.changedFiles : [])
    .map((file) => String(file || '').trim())
    .filter(Boolean)
  const observed = chooseVerificationBudget({ taskProfile: input.taskProfile, changedFiles })
  if (planned === null) return observed
  return VERIFICATION_BUDGET_ORDER.indexOf(observed) >= VERIFICATION_BUDGET_ORDER.indexOf(planned)
    ? observed
    : planned
}

function isVerificationBudget(value: unknown): value is VerificationBudget {
  return (VERIFICATION_BUDGET_ORDER as readonly string[]).includes(String(value || ''))
}
