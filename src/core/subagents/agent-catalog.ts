import {
  MANAGED_OFFICIAL_SUBAGENT_ROLES,
  managedOfficialSubagentRoleByName,
  type ManagedOfficialSubagentRole
} from '../managed-assets/managed-assets-manifest.js'
import type { HardwareCapacityProbeInput } from '../naruto/hardware-capacity-probe.js'
import {
  decideSubagentModel,
  type SubagentModelPolicyId,
  type SubagentModelReasoningEffort
} from './model-policy.js'
import { HARD_NARUTO_MAX_THREADS } from './thread-budget.js'
import { escapeRegExp } from '../text/regex.js'

export const DEFAULT_AUTOMATIC_SUBAGENT_COUNT = 4
export const PARALLEL_AUTOMATIC_SUBAGENT_COUNT = 6
export const LARGE_SCALE_AUTOMATIC_SUBAGENT_COUNT = 8
export const MAX_AUTOMATIC_SUBAGENT_COUNT = HARD_NARUTO_MAX_THREADS
export const MAX_AUTOMATIC_REVIEWER_COUNT = 2
export const MAX_CRITICAL_AUTOMATIC_REVIEWER_COUNT = 3
export const MASS_PARALLEL_AUTOMATIC_SUBAGENT_COUNT = 16
export const MAX_MASS_AUTOMATIC_SUBAGENT_COUNT = HARD_NARUTO_MAX_THREADS
/** Catalog injection is bounded by the real installed role catalog, not fan-out width. */
export const MAX_ON_DEMAND_SUBAGENT_ROLE_COUNT = 25

export interface OfficialSubagentRoleSummary {
  name: string
  description: string
  model_policy: SubagentModelPolicyId
  model: string
  model_reasoning_effort: SubagentModelReasoningEffort
  sandbox_mode: 'inherit' | 'read-only' | 'workspace-write'
}

export function officialSubagentRoleCatalog(): OfficialSubagentRoleSummary[] {
  return MANAGED_OFFICIAL_SUBAGENT_ROLES.map(roleSummary)
}

export function officialSubagentOnDemandRoleCatalog(roleNames: readonly string[]): OfficialSubagentRoleSummary[] {
  const selected: ManagedOfficialSubagentRole[] = []
  const seen = new Set<string>()
  for (const name of roleNames) {
    const role = managedOfficialSubagentRoleByName(String(name || ''))
    if (!role || seen.has(role.codex_name)) continue
    seen.add(role.codex_name)
    selected.push(role)
    if (selected.length >= MAX_ON_DEMAND_SUBAGENT_ROLE_COUNT) break
  }
  return selected.map(roleSummary)
}

export function officialSubagentOnDemandRolePlan(
  roleNames: readonly string[]
): Record<string, Omit<OfficialSubagentRoleSummary, 'name'>> {
  return Object.fromEntries(officialSubagentOnDemandRoleCatalog(roleNames).map(({ name, ...config }) => [name, config]))
}

function roleSummary(role: ManagedOfficialSubagentRole): OfficialSubagentRoleSummary {
  return {
    name: role.codex_name,
    description: role.description,
    model_policy: role.model_policy,
    model: role.model,
    model_reasoning_effort: role.model_reasoning_effort,
    sandbox_mode: role.sandbox || 'inherit'
  }
}

export function officialSubagentRolePlan(): Record<string, Omit<OfficialSubagentRoleSummary, 'name'>> {
  return Object.fromEntries(officialSubagentRoleCatalog().map(({ name, ...config }) => [name, config]))
}

export function recommendOfficialSubagentRoles(input: {
  title?: string | null
  description?: string | null
  role?: string | null
  expectedOutput?: string | null
  paths?: readonly string[] | null
  readOnly?: boolean
  requiresWrite?: boolean
  limit?: number
} = {}): string[] {
  const text = normalizeText([
    input.title,
    input.description,
    input.role,
    input.expectedOutput,
    ...(input.paths || [])
  ])
  const limit = clamp(input.limit ?? MAX_ON_DEMAND_SUBAGENT_ROLE_COUNT, 1, MAX_ON_DEMAND_SUBAGENT_ROLE_COUNT)
  const scored = MANAGED_OFFICIAL_SUBAGENT_ROLES
    .map((role, index) => ({ role, index, score: roleScore(role, text, input) }))
    .filter((row) => input.readOnly !== true || row.role.sandbox === 'read-only')
  const narrowSpecialistMatched = scored.some((row) => row.score > 0
    && !['worker', 'expert'].includes(row.role.codex_name))
  const ranked = scored
    .filter((row) => !(narrowSpecialistMatched && row.role.codex_name === 'worker'))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((row) => row.role.codex_name)

  if (input.requiresWrite === true && WRITABLE_IMPLEMENTATION_RE.test(text)) {
    const writableSpecialist = ranked.find((name) => {
      return WRITABLE_IMPLEMENTATION_SPECIALIST_ROLES.has(name)
    })
    if (!writableSpecialist) return unique(['implementation_specialist', ...ranked]).slice(0, limit)
  }

  if (ranked.length) return unique(ranked).slice(0, limit)
  const lane = decideSubagentModel({ description: text }).policy
  if (lane === 'terra_max_context_tools') return ['explorer']
  if (lane === 'luna_max_mechanical' && input.readOnly !== true) return ['worker']
  if (input.readOnly === true) return ['expert']
  return [input.requiresWrite === true ? 'implementation_specialist' : 'expert']
}

export function selectOfficialSubagentRole(input: Parameters<typeof recommendOfficialSubagentRoles>[0] = {}): string {
  return recommendOfficialSubagentRoles({ ...input, limit: 1 })[0] || 'expert'
}

export function officialSubagentFanoutPolicy(input: {
  requestedSubagents?: number | null
  requestedExplicit?: boolean
  requestedSource?: 'operator' | 'route_contract' | 'automatic'
  taskProfile?: string | null
  suggestedRoles?: readonly string[] | null
  goal?: string | null
  independentSliceCount?: number | null
  maxThreads?: number | null
  hardware?: HardwareCapacityProbeInput | null
  /**
   * Explicit write intent. The reviewer cap exists to stop a read-only review
   * panel from inventing work; a mission that will WRITE was being clamped to
   * two workers by the same rule, purely because every recommended role
   * happened to end in `_reviewer`.
   */
  requiresWrite?: boolean | null
} = {}) {
  const countSource = input.requestedSource === 'route_contract'
    ? 'route_contract'
    : input.requestedExplicit === true || input.requestedSource === 'operator'
      ? 'operator'
      : 'automatic'
  const explicit = countSource !== 'automatic'
  const explicitRequested = input.requestedSubagents === undefined || input.requestedSubagents === null
    ? DEFAULT_AUTOMATIC_SUBAGENT_COUNT
    : boundedThreadCount(input.requestedSubagents, 'requested_subagents')
  const automatic = automaticSubagentFanout({
    ...(input.taskProfile === undefined ? {} : { taskProfile: input.taskProfile }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.suggestedRoles === undefined ? {} : { suggestedRoles: input.suggestedRoles }),
    ...(input.independentSliceCount === undefined ? {} : { independentSliceCount: input.independentSliceCount }),
    ...(input.maxThreads === undefined ? {} : { maxThreads: input.maxThreads }),
    ...(input.hardware === undefined ? {} : { hardware: input.hardware }),
    ...(input.requiresWrite === undefined ? {} : { requiresWrite: input.requiresWrite })
  })
  const requested = explicit ? explicitRequested : automatic.count
  const automaticReviewerCeiling = automatic.criticalMultiDomain
    ? MAX_CRITICAL_AUTOMATIC_REVIEWER_COUNT
    : MAX_AUTOMATIC_REVIEWER_COUNT
  return {
    mode: countSource === 'operator'
      ? 'explicit_operator_count'
      : countSource === 'route_contract'
        ? 'route_owned_contract_count'
        : 'parent_owned_risk_based',
    count_source: countSource,
    requested_subagents: requested,
    default_subagents: DEFAULT_AUTOMATIC_SUBAGENT_COUNT,
    automatic_selected: explicit ? null : automatic.count,
    automatic_ceiling: automatic.ceiling,
    mass_parallel: automatic.massParallel === true,
    automatic_reviewer_ceiling: automaticReviewerCeiling,
    selection_reason: countSource === 'operator'
      ? 'explicit_operator_count_preserved'
      : countSource === 'route_contract'
        ? 'route_owned_contract_count_preserved'
        : automatic.reason,
    risk_domains: automatic.riskDomains,
    critical_multi_domain: automatic.criticalMultiDomain,
    requires_independent_non_overlapping_slices: true,
    suggested_agents: unique((input.suggestedRoles || []).map(String)).slice(0, MAX_ON_DEMAND_SUBAGENT_ROLE_COUNT)
  }
}

function automaticSubagentFanout(input: {
  taskProfile?: string | null
  goal?: string | null
  suggestedRoles?: readonly string[] | null
  independentSliceCount?: number | null
  maxThreads?: number | null
  hardware?: HardwareCapacityProbeInput | null
  requiresWrite?: boolean | null
}) {
  const text = normalizeText([input.goal])
  const riskDomains = unique([
    ...riskDomainsFromText(text),
    ...riskDomainsFromRoles(input.suggestedRoles || [])
  ])
  const parallel = input.taskProfile === 'parallel-read' || input.taskProfile === 'parallel-write'
  const highRisk = input.taskProfile === 'high-risk'
  const critical = CRITICAL_RISK_RE.test(text)
  const largeScale = LARGE_SCALE_WORK_RE.test(text)
  const criticalMultiDomain = highRisk && critical && riskDomains.length >= 3
  // Only a mission with no declared write intent gets the reviewer cap. A
  // single recommended `*_reviewer` role was enough to pin an implementing
  // mission to two workers AND to make 2 its hard ceiling.
  const reviewerOnly = isReviewerOnlyFanout(input.suggestedRoles || [])
    && input.requiresWrite !== true
  // Mass/bulk cheap-lane work (broad search, exploration sweeps, typing shards)
  // scales far above the protected strata, but never when reviewer-only or
  // critical multi-domain caps apply.
  const massLane = decideSubagentModel({ description: text }).policy
  const massParallel = MASS_PARALLEL_WORK_RE.test(text)
    && !NON_CHEAP_MASS_ACTION_RE.test(text)
    && (massLane === 'luna_max_mechanical' || massLane === 'terra_max_context_tools')
    && !reviewerOnly
    && !criticalMultiDomain
  const automaticCeiling = massParallel ? MAX_MASS_AUTOMATIC_SUBAGENT_COUNT : MAX_AUTOMATIC_SUBAGENT_COUNT
  const decomposedSliceCount = Number(input.independentSliceCount)
  const roleWidth = unique((input.suggestedRoles || []).map((role) => String(role || '').trim()).filter(Boolean)).length
  if (input.maxThreads !== undefined && input.maxThreads !== null) {
    boundedThreadCount(input.maxThreads, 'max_threads')
  }

  if (Number.isFinite(decomposedSliceCount) && decomposedSliceCount > 0) {
    const reviewerCeiling = criticalMultiDomain
      ? MAX_CRITICAL_AUTOMATIC_REVIEWER_COUNT
      : MAX_AUTOMATIC_REVIEWER_COUNT
    const ceiling = reviewerOnly ? reviewerCeiling : automaticCeiling
    return {
      count: clamp(decomposedSliceCount, 1, ceiling),
      ceiling,
      reason: 'parent_decomposed_independent_slices',
      riskDomains,
      criticalMultiDomain,
      massParallel
    }
  }

  if (reviewerOnly) {
    const count = criticalMultiDomain
      ? MAX_CRITICAL_AUTOMATIC_REVIEWER_COUNT
      : MAX_AUTOMATIC_REVIEWER_COUNT
    return {
      count,
      ceiling: count,
      reason: criticalMultiDomain
        ? 'critical_multi_domain_reviewer_cap'
        : 'independent_reviewer_cap',
      riskDomains,
      criticalMultiDomain,
      massParallel: false
    }
  }

  let baseCount = DEFAULT_AUTOMATIC_SUBAGENT_COUNT
  let reason = 'non_trivial_default_parallel'
  if (massParallel) {
    baseCount = MASS_PARALLEL_AUTOMATIC_SUBAGENT_COUNT
    reason = 'mass_parallel_cheap_lane'
  } else if (largeScale) {
    baseCount = LARGE_SCALE_AUTOMATIC_SUBAGENT_COUNT
    reason = 'large_scale_dynamic_parallel'
  } else if (criticalMultiDomain) {
    baseCount = Math.min(
      LARGE_SCALE_AUTOMATIC_SUBAGENT_COUNT,
      Math.max(PARALLEL_AUTOMATIC_SUBAGENT_COUNT, riskDomains.length + 1)
    )
    reason = 'critical_multi_domain_risk'
  } else if (parallel) {
    baseCount = PARALLEL_AUTOMATIC_SUBAGENT_COUNT
    reason = 'explicit_parallel_or_independent_slices'
  } else if (highRisk && riskDomains.length >= 2) {
    baseCount = Math.max(DEFAULT_AUTOMATIC_SUBAGENT_COUNT, riskDomains.length + 1)
    reason = 'independent_multi_domain_risk'
  } else if (roleWidth >= 3) {
    baseCount = Math.max(DEFAULT_AUTOMATIC_SUBAGENT_COUNT, Math.min(PARALLEL_AUTOMATIC_SUBAGENT_COUNT, roleWidth + 1))
    reason = 'role_width_parallel'
  }

  // Until decomposition provides real independent slices, these values are
  // planning hints only. Raising them to the host cap would invent work.
  const count = Math.min(baseCount, automaticCeiling)
  return {
    count,
    ceiling: automaticCeiling,
    reason,
    riskDomains,
    criticalMultiDomain: Boolean(criticalMultiDomain),
    massParallel
  }
}

function boundedThreadCount(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > HARD_NARUTO_MAX_THREADS) {
    throw new RangeError(`${label}_must_be_integer_1_to_${HARD_NARUTO_MAX_THREADS}:${String(value)}`)
  }
  return parsed
}

function isReviewerOnlyFanout(roles: readonly string[]): boolean {
  const normalized = unique(roles.map((role) => String(role || '').trim()).filter(Boolean))
  return normalized.length > 0 && normalized.every((role) => (
    role === 'expert'
    || role === 'debugger'
    || role.endsWith('_reviewer')
  ))
}

function riskDomainsFromText(text: string): string[] {
  const domains: string[] = []
  for (const [domain, pattern] of RISK_DOMAIN_PATTERNS) {
    if (pattern.test(text)) domains.push(domain)
  }
  return domains
}

function riskDomainsFromRoles(roles: readonly string[]): string[] {
  return roles
    .map((role) => ROLE_RISK_DOMAINS[String(role || '').trim()] || null)
    .filter((domain): domain is string => Boolean(domain))
}

function roleScore(
  role: ManagedOfficialSubagentRole,
  text: string,
  input: { readOnly?: boolean; requiresWrite?: boolean }
): number {
  const semanticScore = [...role.selection_keywords, ...(ROLE_LANGUAGE_HINTS[role.codex_name] || [])]
    .reduce((total, keyword) => total + keywordScore(text, keyword), 0)
  if (semanticScore <= 0) return 0
  let score = semanticScore
  if (ROLE_PRIORITY_PATTERNS[role.codex_name]?.test(text)) score += 8
  if (FOCUSED_ROLE_REVIEW_PATTERNS[role.codex_name]?.test(text)) score += 12
  if (input.readOnly === true) score += role.sandbox === 'read-only' ? 2 : role.sandbox ? -3 : 0
  if (input.requiresWrite === true) score += role.sandbox === 'read-only' ? -8 : role.sandbox === 'workspace-write' ? 3 : 1
  if (input.requiresWrite === true && WRITABLE_IMPLEMENTATION_RE.test(text) && role.codex_name === 'implementation_specialist') score += 12
  if (role.codex_name === 'worker' && !looksClearBounded(text)) score -= 4
  if (role.codex_name === 'expert') score -= 1
  return score
}

function keywordScore(text: string, keyword: string): number {
  const normalized = normalizeText([keyword])
  if (!normalized) return 0
  const matched = /^[a-z0-9]+$/i.test(normalized)
    ? new RegExp(`(?:^|\\b)${escapeRegExp(normalized)}(?:\\b|$)`, 'i').test(text)
    : text.includes(normalized)
  if (!matched) return 0
  return normalized.includes(' ') ? 4 : 3
}

function looksClearBounded(text: string): boolean {
  const tinyMechanical = /\b(tiny|trivial|mechanical|repeatable|one[- ]line|single[- ]file|exact (?:rename|copy|replace|format)|typo|format only)\b|한\s*줄|단일\s*파일|극단적으로\s*단순|기계적|반복적|오타|이름\s*변경/i.test(text)
  const longOrRisky = /\b(long[- ]context|large[- ](?:file|document|codebase|repository)|repository[- ]wide|browser|chrome|computer[- ]use|imagegen|review|debug|security|architecture|research)\b|긴\s*컨텍스트|장문|대규모|브라우저|컴퓨터\s*유즈|이미지\s*생성|리뷰|디버깅|보안|아키텍처|연구/i.test(text)
  return tinyMechanical && !longOrRisky
}

function normalizeText(values: readonly unknown[]): string {
  return values
    .map((value) => String(value || '').normalize('NFKC').toLowerCase())
    .join(' ')
    .replace(/[_/\\.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(Number(value) || minimum)))
}

const ROLE_LANGUAGE_HINTS: Record<string, string[]> = {
  worker: ['기계적', '반복적', '단순 변경', '정확한 변경'],
  implementation_specialist: ['구현', '기능 추가', '핵심 로직', '백엔드', '복잡한 변경'],
  expert: ['모호', '전략', '판단', '트레이드오프'],
  explorer: ['탐색', '찾아', '추적', '인벤토리', '구조 파악'],
  debugger: ['디버깅', '원인', '실패', '재현', '회귀'],
  test_engineer: ['테스트', '회귀 테스트', '검증', '픽스처', '커버리지'],
  ui_implementer: ['화면', '터미널', '젤리', '패널', '팬', '레이아웃', '사용성'],
  native_app_specialist: ['네이티브 앱', '메뉴바', '앱킷', '스위프트', '맥os', '데스크톱', 'tcc'],
  toolchain_specialist: ['툴체인', '의존성', '패키지 매니저', '빌드', '설치', '닥터', '업데이트', 'ci 자동화'],
  protocol_reviewer: ['프로토콜', '계약', '스키마', '직렬화', 'api', 'sdk', 'cli', 'mcp', '하위 호환'],
  runtime_reliability_reviewer: ['런타임 신뢰성', '훅', '세션', '락', '데몬', '프로세스 정리', '멱등성', '복구', '경쟁 상태', '교착'],
  triwiki_evidence_reviewer: ['트라이위키', '컨텍스트 팩', '출처 계보', '신뢰 앵커', '증명 아티팩트', 'wrongness', '소스 하이드레이션'],
  architecture_reviewer: ['아키텍처', '설계', '수명주기', '결합도', '리팩터'],
  security_reviewer: ['보안', '권한', '인증', '비밀', '신뢰 경계'],
  database_reviewer: ['데이터베이스', '디비', '마이그레이션', '롤백', '스키마'],
  research_synthesizer: ['연구', '논문', '가설', '종합', '새로움'],
  research_reviewer: ['논문 검토', '적대적 평가', '방법론', '재현성', '반증'],
  release_reviewer: ['배포', '릴리스', '출시', '퍼블리시', '버전'],
  docs_maintainer: ['문서', '리드미', '변경로그', '마이그레이션 가이드'],
  integration_reviewer: ['통합', '병합', '리베이스', '호환성', '엔드투엔드'],
  performance_analyst: ['성능', '지연', '벤치마크', '동시성', '토큰', '메모리'],
  long_context_analyst: ['롱 컨텍스트', '긴 컨텍스트', '장문', '대규모 파일', '여러 문서', '긴 로그', '컨텍스트 압축'],
  computer_use_operator: ['컴퓨터 유즈', '데스크톱 조작', '맥os 점검', '시스템 설정', '네이티브 앱 점검'],
  browser_use_operator: ['브라우저 유즈', '브라우저', '크롬', '웹사이트', '웹앱', '로컬호스트', '플레이라이트'],
  image_generation_operator: ['이미지 생성', '이미지젠', 'gpt image', 'gpt-image-2', '비주얼 에셋']
}

const ROLE_PRIORITY_PATTERNS: Readonly<Record<string, RegExp>> = {
  debugger: /\b(?:debug|diagnos|root cause|failure|flaky)\b|디버깅|진단|원인|실패/i,
  test_engineer: /\b(?:add|write|create|implement)\b[^\n]{0,48}\b(?:test|fixture|coverage|regression)\b|(?:테스트|픽스처|커버리지|회귀\s*테스트)[^\n]{0,24}(?:추가|작성|구현)/i,
  architecture_reviewer: /\b(?:architecture|architect|refactor|state ownership|coupling)\b|아키텍처|리팩터|결합도/i,
  security_reviewer: /\b(?:security|permission|secret|auth|trust boundary|abuse)\b|보안|권한|인증|비밀|신뢰\s*경계/i,
  database_reviewer: /\b(?:database|db|sql|migration|rls|rollback)\b|데이터베이스|디비|마이그레이션|롤백/i,
  release_reviewer: /\b(?:release|publish|deploy|distribution|versioning)\b|릴리스|배포|출시|퍼블리시/i,
  research_reviewer: /\b(?:research review|paper review|methodology|falsification|reproducibility)\b|논문\s*검토|방법론|반증|재현성/i,
  browser_use_operator: /\b(?:browser|chrome|playwright|selenium|puppeteer|website|webapp|localhost)\b|브라우저|크롬|웹사이트|웹앱|로컬호스트/i,
  computer_use_operator: /\b(?:computer[- ]use|desktop interaction|system settings|native app inspection)\b|컴퓨터\s*유즈|데스크톱\s*조작|시스템\s*설정/i,
  image_generation_operator: /\b(?:imagegen|image generation|gpt[- ]image(?:-2)?|generate image|edit image)\b|이미지\s*생성|이미지젠/i,
  long_context_analyst: /\b(?:long[- ]context|large[- ](?:file|document|codebase)|multi[- ]document|extensive logs|context compression)\b|긴\s*컨텍스트|장문|대규모|여러\s*문서|긴\s*로그/i,
  triwiki_evidence_reviewer: /\b(?:triwiki|context pack|provenance|trust anchor|wrongness memory|source hydration)\b|트라이위키|컨텍스트\s*팩|출처\s*계보|신뢰\s*앵커/i
}

const WRITABLE_IMPLEMENTATION_RE = /\b(?:implement|build|create|modify|fix|code|feature|handler|parser|component|backend|frontend|logic)\b|구현|기능\s*추가|수정|코드|로직|백엔드|프론트엔드|컴포넌트/i

const WRITABLE_IMPLEMENTATION_SPECIALIST_ROLES = new Set([
  'implementation_specialist',
  'ui_implementer',
  'native_app_specialist',
  'toolchain_specialist'
])

const FOCUSED_ROLE_REVIEW_PATTERNS: Readonly<Record<string, RegExp>> = {
  debugger: /\b(?:debug|diagnos|root cause|failure|flaky|regression)\b|디버깅|진단|원인|실패|회귀/i,
  architecture_reviewer: /\barchitecture\b[^\n]{0,32}\b(?:review|decision|design|plan)\b|아키텍처[^\n]{0,24}(?:리뷰|결정|설계|계획)/i,
  security_reviewer: /\bsecurity\b[^\n]{0,48}\b(?:review|audit|risk|permission|trust boundary)\b|보안[^\n]{0,32}(?:리뷰|감사|위험|권한|신뢰\s*경계)/i,
  database_reviewer: /\b(?:database|db)\b[^\n]{0,48}\b(?:review|audit|migration|schema|rollback)\b|데이터베이스[^\n]{0,32}(?:리뷰|감사|마이그레이션|스키마|롤백)/i,
  release_reviewer: /\brelease\b[^\n]{0,48}\b(?:review|audit|publish|version|distribution)\b|릴리스[^\n]{0,32}(?:리뷰|감사|배포|버전)/i
}

const CRITICAL_RISK_RE = /\b(?:critical|catastrophic|production|data loss|security incident|breaking release)\b|치명|중대|운영|데이터\s*손실|보안\s*사고/i

const LARGE_SCALE_WORK_RE = /\b(?:large[- ]scale|repo(?:sitory)?[- ]wide|many (?:files|tasks|modules)|bulk change|mass migration|wide fan[- ]?out|maximum parallel)\b|대규모|저장소\s*전체|많은\s*(?:파일|작업|모듈)|대량\s*(?:변경|마이그레이션)|최대한\s*병렬|한번에\s*(?:많은|대규모)/i

// Mass cheap-lane fan-out intent: bulk search/scan/exploration sweeps or
// hundreds of explicitly cheap, independent shards. Numeric scale alone must
// not promote ordinary implementation or judgment work into the mass lane.
const MASS_PARALLEL_WORK_RE = /\b(?:mass|bulk|wide|broad)[- ](?:search|scan|sweep|exploration|collection|gathering|enumeration|inventory)\b|\b(?:mass|bulk)[- ](?:parallel|fan[- ]?out)\b|\bhundreds?\s+of\s+(?:(?:independent|mechanical|simple)\s+)?(?:files?|items?|documents?|logs?|records?|entries|shards?|replacements?|renames?|copies|lookups?|searches|scans)\b|대량\s*(?:탐색|검색|수집|스캔|병렬)|수백(?:\s*(?:개의?|개))?\s*(?:파일|항목|문서|로그|레코드|엔트리|샤드|치환|이름\s*변경|복사|조회|검색|스캔)|전체\s*(?:검색|탐색|스캔)|대규모\s*병렬/i

const NON_CHEAP_MASS_ACTION_RE = /\b(?:implement|build|create|add|modify|fix|refactor|review|audit|debug|diagnose|plan|assess)\b|(?:구현|개발|추가|수정|고쳐|리팩터|리뷰|검토|감사|디버깅|진단|계획|평가)/i

const RISK_DOMAIN_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['database', /\b(?:database|db|sql|postgres|supabase|migration|rls)\b|데이터베이스|디비|마이그레이션/i],
  ['security', /\b(?:security|permission|auth|authentication|secret|trust boundary)\b|보안|권한|인증|비밀|신뢰\s*경계/i],
  ['release', /\b(?:release|publish|deploy|distribution|package registry|production rollout)\b|릴리스|배포|출시|퍼블리시/i],
  ['payment', /\b(?:payment|billing|checkout|transaction)\b|결제|청구|트랜잭션/i],
  ['performance', /\b(?:performance|latency|throughput|concurrency|resource usage)\b|성능|지연|처리량|동시성/i],
  ['integration', /\b(?:integration|compatibility|cross-module|end-to-end)\b|통합|호환성|엔드투엔드/i],
  ['protocol', /\b(?:protocol|mcp|sdk|api contract|schema|serialization|wire format)\b|프로토콜|계약|스키마|직렬화/i],
  ['runtime', /\b(?:hook|session|lock|daemon|process cleanup|idempotency|recovery|race condition|deadlock)\b|훅|세션|락|데몬|프로세스\s*정리|멱등성|복구|경쟁\s*상태|교착/i],
  ['toolchain', /\b(?:toolchain|dependency upgrade|runtime upgrade|package manager|build script|install flow|doctor flow|update flow|ci automation)\b|툴체인|의존성|패키지\s*매니저|빌드|설치|닥터|업데이트/i],
  ['evidence', /\b(?:triwiki|context pack|provenance|trust anchor|proof artifact|wrongness memory)\b|트라이위키|컨텍스트\s*팩|출처|신뢰\s*앵커|증거|증명/i]
]

const ROLE_RISK_DOMAINS: Readonly<Record<string, string>> = {
  security_reviewer: 'security',
  database_reviewer: 'database',
  release_reviewer: 'release',
  performance_analyst: 'performance',
  integration_reviewer: 'integration',
  protocol_reviewer: 'protocol',
  runtime_reliability_reviewer: 'runtime',
  toolchain_specialist: 'toolchain',
  triwiki_evidence_reviewer: 'evidence'
}
