export type TaskProfile =
  | 'passthrough'
  | 'answer'
  | 'tiny-change'
  | 'bounded-work'
  | 'parallel-read'
  | 'parallel-write'
  | 'high-risk'

export type GateProfile = 'none' | 'minimal' | 'scoped' | 'full'

export const TASK_PROFILE_GATE_PROFILES = Object.freeze({
  passthrough: 'none',
  answer: 'none',
  'tiny-change': 'minimal',
  'bounded-work': 'scoped',
  'parallel-read': 'scoped',
  'parallel-write': 'scoped',
  'high-risk': 'full'
} satisfies Readonly<Record<TaskProfile, GateProfile>>)

const TASK_PROFILES = new Set<TaskProfile>(Object.keys(TASK_PROFILE_GATE_PROFILES) as TaskProfile[])

const GREETING_RE =
  /^(hi|hello|hey|thanks|thank you|good morning|good evening|안녕|안녕하세요|고마워|고마워요|감사해|감사합니다|잘 지내\??)[!.?\s]*$/i

const NON_DATABASE_HIGH_RISK_RE =
  /\b(security|permission|publish|release|deploy|auth|payment|production)\b|보안|권한|배포|릴리즈|출시|인증|결제|운영/i

const DATABASE_DOMAIN_RE =
  /\b(?:SQL|Supabase|Postgres|PostgreSQL|RLS|Prisma|Drizzle|Knex|database|DB|execute_sql|migrate|migration|migrations)\b|데이터베이스|디비|마이그레이션/i

const STRONG_DATABASE_DOMAIN_RE =
  /\b(?:SQL|Supabase|Postgres|PostgreSQL|RLS|Prisma|Drizzle|Knex|database|execute_sql|migrate|migration|migrations)\b|데이터베이스|마이그레이션/i

const GENERIC_DATABASE_DOMAIN_RE = /\bDB\b|디비/i

const DATABASE_WORK_RE =
  /\b(?:apply|execute|run|fix|change|modify|migrate|audit|review|inspect|analy[sz]e|query|seed|backfill|optimi[sz]e|create|alter|drop|truncate|update|delete|repair)\b|적용|실행|수정|변경|검수|검토|점검|분석|조회|쿼리|시드|백필|최적화|생성|추가|삭제|복구|만들어/i

const DATABASE_CONTROL_SURFACE_META_RE =
  /\bsks\s+db\b|\b(?:db|database|migrate|migrations?)\b[\s\S]{0,48}\b(?:command|cli|route|routing|parser|classifier|regex|help|usage|topic|docs?|documentation|constant|keyword|alias)\b|\b(?:command|cli|route|routing|parser|classifier|regex|help|usage|topic|docs?|documentation|constant|keyword|alias)\b[\s\S]{0,48}\b(?:db|database|migrate|migrations?)\b|(?:db|디비|데이터베이스|migration|migrate|마이그레이션)\s*(?:커맨드|명령|명령어|CLI|라우트|라우팅|파서|분류기|정규식|도움말|헬프|사용법|토픽|문서|상수|키워드|별칭)|(?:커맨드|명령|명령어|CLI|라우트|라우팅|파서|분류기|정규식|도움말|헬프|사용법|토픽|문서|상수|키워드|별칭)[\s\S]{0,32}(?:db|디비|데이터베이스|migration|migrate|마이그레이션)/i

const PARALLEL_CUE_RE =
  /\b(parallel|subagents?|one agent per|fan out|independent slices?|naruto)\b|병렬|하위\s*에이전트|서브\s*에이전트|나루토|분담/i

const CHANGE_RE =
  /\b(fix|implement|implementation|change|edit|add|remove|delete|drop|modify|refactor|build|create|write|update|rename|rewrite|patch|apply|execute|repair|resolve|solve|publish|release|deploy|migrate)\b|\bwork\s+on\b|고쳐|고치|수정|변경|추가|삭제|구현|리팩터|작성|생성|만들어|업데이트|적용|실행|해결|이름\s*변경|배포|출시|마이그레이션/i

const BOUNDED_READ_WORK_RE =
  /\b(audit|review|inspect|analy[sz]e|diagnose|trace|map|verify|test|check|investigate|evaluate)\b|감사|검토|점검|분석|진단|추적|매핑|검증|테스트|조사|평가/i

const TINY_CHANGE_RE =
  /\b(typo|copy|wording|label|spacing|whitespace|punctuation|spelling|one[-\s]?line|single[-\s]?(?:line|word)|rename only)\b|오타|문구|라벨|띄어쓰기|공백|맞춤법|구두점|한\s*줄|단어\s*하나|이름만\s*변경/i

const NON_RUNTIME_TINY_SURFACE_RE =
  /\b(copy|wording|label|spacing|whitespace|punctuation|spelling|readme|docs?|documentation|comment)\b|문구|라벨|띄어쓰기|공백|맞춤법|구두점|문서|주석/i

const EXPLANATION_QUESTION_RE =
  /^(how\s+(?:do|can|should|would)\s+(?:i|we|you)\b|what\b|why\b|when\b|where\b|which\b|explain\b|tell me how\b)|(?:어떻게|무엇|뭐가|왜|언제|어디|방법|설명)(?:.*(?:인가요|일까요|하나요|해요|할까|\?))?$/i

const DIRECT_REQUEST_RE =
  /^(please\s+|can you\s+|could you\s+|would you\s+)|(?:해줘|해주세요|해\s*주세요|바꿔줘|고쳐줘|수정해줘|구현해줘)/i

const EXPLANATION_REQUEST_RE = /^(?:can|could|would) you explain\b|(?:설명|알려)\s*(?:해\s*줘|해\s*주세요|해달라|줘)\s*[.!?]*$/i

export function classifyTaskProfile(prompt: unknown): TaskProfile {
  const text = String(prompt ?? '').trim()

  if (!text || GREETING_RE.test(text)) return 'passthrough'
  if (looksLikeExplanationQuestion(text)) return 'answer'
  const databaseWork = looksLikeDatabaseWorkRequest(text)
  const highRiskMutation = databaseWork || (CHANGE_RE.test(text) && NON_DATABASE_HIGH_RISK_RE.test(text))
  // Keep explicitly small edits small even when their subject happens to be a
  // high-risk noun (for example an auth label in README), but never let a
  // generic "one-line" cue downgrade a real database/security mutation.
  if (looksLikeTinyChange(text) && (!highRiskMutation || NON_RUNTIME_TINY_SURFACE_RE.test(text))) return 'tiny-change'
  if (highRiskMutation) return 'high-risk'
  if (PARALLEL_CUE_RE.test(text) && CHANGE_RE.test(text)) return 'parallel-write'
  if (PARALLEL_CUE_RE.test(text)) return 'parallel-read'
  if (DATABASE_CONTROL_SURFACE_META_RE.test(text) && DATABASE_WORK_RE.test(text)) return 'bounded-work'
  if (CHANGE_RE.test(text)) return 'bounded-work'
  if (BOUNDED_READ_WORK_RE.test(text)) return 'bounded-work'
  return 'answer'
}

export function gateProfileForTask(profileOrPrompt: TaskProfile | unknown): GateProfile {
  const profile = isTaskProfile(profileOrPrompt)
    ? profileOrPrompt
    : classifyTaskProfile(profileOrPrompt)
  return TASK_PROFILE_GATE_PROFILES[profile]
}

export function isTaskProfile(value: unknown): value is TaskProfile {
  return TASK_PROFILES.has(String(value || '') as TaskProfile)
}

export function looksLikeDatabaseWorkRequest(prompt: unknown): boolean {
  const text = String(prompt ?? '').trim()
  if (!text || !DATABASE_DOMAIN_RE.test(text)) return false
  if (DATABASE_CONTROL_SURFACE_META_RE.test(text)) return false
  if (!DATABASE_WORK_RE.test(text)) return false
  if (STRONG_DATABASE_DOMAIN_RE.test(text)) return true
  return GENERIC_DATABASE_DOMAIN_RE.test(text)
    && hasNearbyMatches(text, GENERIC_DATABASE_DOMAIN_RE, DATABASE_WORK_RE, 96)
}

function hasNearbyMatches(text: string, left: RegExp, right: RegExp, maxDistance: number): boolean {
  const leftIndexes = matchIndexes(text, left)
  const rightIndexes = matchIndexes(text, right)
  return leftIndexes.some((leftIndex) => rightIndexes.some((rightIndex) => Math.abs(leftIndex - rightIndex) <= maxDistance))
}

function matchIndexes(text: string, pattern: RegExp): number[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return [...text.matchAll(new RegExp(pattern.source, flags))]
    .map((match) => match.index)
    .filter((index): index is number => Number.isInteger(index))
}

function looksLikeTinyChange(text: string): boolean {
  return CHANGE_RE.test(text) && TINY_CHANGE_RE.test(text)
}

function looksLikeExplanationQuestion(text: string): boolean {
  return (EXPLANATION_QUESTION_RE.test(text) || EXPLANATION_REQUEST_RE.test(text))
    && (EXPLANATION_REQUEST_RE.test(text) || !DIRECT_REQUEST_RE.test(text))
}
