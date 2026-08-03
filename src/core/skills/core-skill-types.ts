// SKS Core Skill Engine — shared type contract (SkillOpt-derived).
//
// Skills are the frozen agent's external, versioned state. An optimizer proposes
// bounded edits to a single skill document; edits are accepted ONLY on strict
// held-out improvement; deployment reads an immutable accepted snapshot and never
// calls the optimizer. None of this mutates code/config/global files.

export const CORE_SKILL_CARD_SCHEMA = 'sks.core-skill-card.v1'
export const CORE_SKILL_PATCH_SCHEMA = 'sks.core-skill-patch.v1'
export const CORE_ROLLOUT_TRACE_SCHEMA = 'sks.core-rollout-trace.v1'
export const CORE_SKILL_SCORE_SCHEMA = 'sks.core-skill-rollout-score.v1'

export type CoreSkillStatus = 'candidate' | 'accepted' | 'rejected' | 'deployed'
export type SkillBackend = 'codex-sdk' | 'fake' | 'process'

export interface CoreSkillSideEffectScope {
  allowed_mutations: string[]
  read_only: boolean
}

export interface CoreSkillValidation {
  heldout_score: number
  baseline_score: number
  strict_improvement: boolean
}

export interface CoreSkillCard {
  schema: string
  skill_id: string
  route: string
  version: number
  status: CoreSkillStatus
  body: string
  deployment_snapshot: boolean
  created_from?: { rollout_set?: string | null; optimizer_epoch?: number | null }
  validation?: CoreSkillValidation | null
  side_effect_scope: CoreSkillSideEffectScope
  body_hash?: string
  created_at?: string
}

export interface RolloutScoreComponents {
  task_success: number
  proof_completeness: number
  side_effect_zero: number
  latency_budget: number
  rollback_ready: number
  requested_scope_compliance: number
}

export interface CoreRolloutTrace {
  schema: string
  route: string
  prompt: string
  skill_id: string | null
  skill_version: number | null
  backend: SkillBackend
  output?: string | undefined
  proof_artifacts: string[]
  gate_results: Array<{ id: string; ok: boolean }>
  side_effect_ledger: string[]
  latency_ms: number
  cost?: number | undefined
  failure_reason?: string | null
  rollback_ready: boolean
  requested_scope_compliant: boolean
  created_at?: string
}

export interface RolloutScore {
  schema: string
  score: number
  components: RolloutScoreComponents
  side_effect_violation: boolean
  skill_id: string | null
  skill_version: number | null
}

export type SkillPatchOp =
  | { op: 'replace'; target: string; before: string; after: string }
  | { op: 'add'; target: string; text: string }
  | { op: 'delete'; target: string; text?: string }

export interface TextualLearningRate {
  max_added_chars: number
  max_deleted_chars: number
  max_replaced_chars: number
}

export interface CoreSkillPatch {
  schema: string
  skill_id: string
  base_version: number
  operations: SkillPatchOp[]
  textual_learning_rate: TextualLearningRate
}

export interface PatchValidationResult {
  ok: boolean
  blockers: string[]
  added_chars: number
  deleted_chars: number
  replaced_chars: number
}

export interface PatchApplyResult {
  ok: boolean
  blockers: string[]
  before_hash: string
  after_hash: string
  candidate: CoreSkillCard | null
}

export interface HeldoutValidationResult {
  accept: boolean
  reason: string
  baseline_heldout: number
  candidate_heldout: number
  score_delta: number
}

export interface RejectedSkillPatchEntry {
  skill_id: string
  base_version: number
  patch_hash: string
  reason: string
  score_delta: number
  created_at: string
}

// Targets a SkillPatch may address. Anything else (code/config/global files) is
// rejected — patches only ever edit the single skill document.
export const SKILL_PATCH_TARGET_RE = /^(section|sentence|paragraph):[A-Za-z0-9 _.-]+$/
// Targets that look like filesystem/code/config paths are explicitly forbidden.
export const FORBIDDEN_PATCH_TARGET_RE = /[/\\]|\.(ts|js|mjs|json|toml|rs|md|lock)\b|^~|^\.{1,2}\//i
