export const NARUTO_PARENT_MODEL = 'gpt-5.6-sol'
export const NARUTO_PARENT_EFFORT = 'max'

export const LUNA_SUBAGENT_MODEL = 'gpt-5.6-luna'
export const TERRA_SUBAGENT_MODEL = 'gpt-5.6-terra'
export const SOL_SUBAGENT_MODEL = 'gpt-5.6-sol'

export const LUNA_SUBAGENT_EFFORT = 'max'
export const TERRA_SUBAGENT_EFFORT = 'max'
export const DEFAULT_SUBAGENT_EFFORT = 'high'
export const SOL_MAX_SUBAGENT_EFFORT = 'max'

// Compatibility exports retained for research and older callers. New code
// should select a policy profile instead of combining model/effort constants.
export const DEFAULT_SUBAGENT_MODEL = SOL_SUBAGENT_MODEL
export const THINKING_SUBAGENT_MODEL = SOL_SUBAGENT_MODEL
export const SUBAGENT_EFFORT = SOL_MAX_SUBAGENT_EFFORT

export type SubagentModelPolicyId =
  | 'luna_max_mechanical'
  | 'sol_high_implementation'
  | 'sol_max_judgment'
  | 'terra_max_context_tools'

export type SubagentTaskClass = 'mechanical' | 'implementation' | 'judgment' | 'context_tools'
export type SubagentContextMode = 'short' | 'long'
export type SubagentToolSurface = 'none' | 'computer_use' | 'browser' | 'image_generation'
export type SubagentScopeSize = 'tiny' | 'bounded' | 'large'
export type SubagentKind = 'worker' | 'expert'
export type SubagentModel = typeof LUNA_SUBAGENT_MODEL | typeof TERRA_SUBAGENT_MODEL | typeof SOL_SUBAGENT_MODEL
export type SubagentModelReasoningEffort = 'high' | 'max'

export interface SubagentModelProfile {
  policy: SubagentModelPolicyId
  kind: SubagentKind
  model: SubagentModel
  modelReasoningEffort: SubagentModelReasoningEffort
}

export interface SubagentModelDecision extends SubagentModelProfile {
  reason: SubagentModelPolicyId
}

export const SUBAGENT_MODEL_POLICIES: Readonly<Record<SubagentModelPolicyId, SubagentModelProfile>> = Object.freeze({
  luna_max_mechanical: Object.freeze({
    policy: 'luna_max_mechanical',
    kind: 'worker',
    model: LUNA_SUBAGENT_MODEL,
    modelReasoningEffort: LUNA_SUBAGENT_EFFORT
  }),
  sol_high_implementation: Object.freeze({
    policy: 'sol_high_implementation',
    kind: 'worker',
    model: SOL_SUBAGENT_MODEL,
    modelReasoningEffort: DEFAULT_SUBAGENT_EFFORT
  }),
  sol_max_judgment: Object.freeze({
    policy: 'sol_max_judgment',
    kind: 'expert',
    model: SOL_SUBAGENT_MODEL,
    modelReasoningEffort: SOL_MAX_SUBAGENT_EFFORT
  }),
  terra_max_context_tools: Object.freeze({
    policy: 'terra_max_context_tools',
    kind: 'worker',
    model: TERRA_SUBAGENT_MODEL,
    modelReasoningEffort: TERRA_SUBAGENT_EFFORT
  })
})

const JUDGMENT_TASK_RE = new RegExp([
  '\\breview(?:er|ing)?\\b',
  '\\baudit(?:or|ing)?\\b',
  '\\bdebug(?:ger|ging)?\\b',
  'diagnos',
  'investigat',
  '\\bwhy\\b',
  '\\bfail(?:ed|ure|ing)?\\b',
  'root[- ]?cause',
  'strategy',
  '\\bplan(?:ning)?\\b',
  'product',
  'architecture',
  'architect',
  '\\bdesign(?:ing)?\\b',
  'refactor',
  'integrat',
  'conflict',
  'security',
  '\\bauth(?:entication|orization)?\\b',
  '\\bsafety\\b',
  'database',
  '\\bdb\\b',
  'migration',
  'release',
  'publish',
  'deploy',
  'research',
  'hypothesis',
  'falsif',
  'novelty',
  'test[-_ ]?(?:design|strategy|coverage|gap|review)',
  'regression',
  'flaky',
  'ambiguous',
  'ambiguity',
  'trade[- ]?off',
  'quality',
  'judg',
  'assessment',
  '\\bexpert\\b',
  '\\brisk\\b',
  '리뷰',
  '검토',
  '감사',
  '디버깅',
  '진단',
  '조사',
  '원인',
  '전략',
  '기획',
  '계획',
  '설계',
  '아키텍처',
  '리팩터',
  '통합',
  '충돌',
  '보안',
  '인증',
  '안전',
  '데이터베이스',
  '마이그레이션',
  '배포',
  '릴리즈',
  '출시',
  '연구',
  '가설',
  '반증',
  '회귀',
  '모호',
  '트레이드오프',
  '품질',
  '판정',
  '위험'
].join('|'), 'i')

const CONTEXT_TOOL_TASK_RE = new RegExp([
  'computer[- ]?use',
  '\\bbrowser(?:[- ]?use)?\\b',
  '\\bchrome\\b',
  '\\bplaywright\\b',
  '\\bselenium\\b',
  '\\bpuppeteer\\b',
  'image[- ]?(?:gen|generation)',
  '\\bimagegen\\b',
  'gpt[- ]?image',
  '\\bscreenshot(?:ting)?\\b',
  'long[- ]?context',
  'long[- ]?term[- ]?memory',
  'persistent[- ]?memory',
  'memory[- ]?(?:maintenance|curation|consolidation)',
  'large[- ]?(?:file|document|codebase|repository|context|search)',
  '(?:repository|repo|codebase)[- ]?wide',
  'read[- ]?heavy',
  'supporting[- ]?documents?',
  '\\bdocs?\\b',
  'documentation',
  'reference[- ]?manual',
  'architecture[- ]?notes?',
  '\\bcompare\\b[^\\n]{0,48}\\b(?:notes?|documents?|references?)\\b',
  'multi[- ]?(?:document|file) scan',
  '\\bexplor(?:e|er|ation)\\b',
  '\\bscan(?:ning)?\\b',
  '\\bextract(?:ion)?\\b',
  '\\binventory\\b',
  'extensive[- ]?logs?',
  '\\b(?:large[- ]?scale|high[- ]?volume|bulk|mass)\\b[^\\n]{0,48}\\b(?:first[- ]?draft|draft|scaffold|code processing)\\b',
  '\\b(?:first[- ]?draft|draft|scaffold)\\b[^\\n]{0,48}\\b(?:large[- ]?scale|high[- ]?volume|bulk|mass|many files?)\\b',
  '\\b(?:broad|wide|deep|mass|bulk|repo(?:sitory)?[- ]?wide|codebase)\\b[^\\n]{0,32}\\b(?:search|lookup|find|grep|scan)\\b',
  '\\b(?:search|lookup|find|grep|scan)\\b[^\\n]{0,40}\\b(?:large|long|across|whole|entire|repository|codebase|many files?)\\b',
  '\\b(?:whole|entire)[- ]?(?:repo(?:sitory)?|codebase)\\b[^\\n]{0,40}\\b(?:search|lookup|find|grep|scan)\\b',
  '컴퓨터\\s*유즈',
  '브라우저',
  '크롬',
  '이미지\\s*생성',
  '스크린샷',
  '롱\\s*컨텍스트',
  '긴\\s*컨텍스트',
  '장기\\s*(?:기억|메모리)',
  '지속\\s*(?:기억|메모리)',
  '(?:기억|메모리)\\s*(?:관리|정리|통합)',
  '장문',
  '대규모',
  '저장소\\s*전체',
  '여러\\s*(?:문서|파일)',
  '문서\\s*(?:조사|탐색|읽기|정리)',
  '공식\\s*문서',
  '탐색',
  '스캔',
  '추출',
  '인벤토리',
  '대규모\\s*검색',
  '대량\\s*(?:검색|탐색|스캔|추출)',
  '전체\\s*검색',
  '광범위\\s*(?:검색|탐색|스캔)',
  '코드베이스\\s*(?:검색|탐색|스캔)',
  '(?:대규모|대량)[^\\n]{0,24}(?:코드\\s*)?(?:초안|초벌|스캐폴드)',
  '(?:코드\\s*)?(?:초안|초벌|스캐폴드)[^\\n]{0,24}(?:대규모|대량)'
].join('|'), 'i')

const SIMPLE_MECHANICAL_TASK_RE = new RegExp([
  '\\bone[- ]?line\\b',
  '\\bsingle[- ]?file\\b',
  '\\btiny\\b',
  '\\btrivial\\b',
  '\\bmechanical\\b',
  '\\brepeatable\\b',
  '\\bexact(?:ly)?\\b[^\\n]{0,36}\\b(?:rename|copy|replace|format|fixture|change|type|typing|paste)\\b',
  '\\b(?:typo|spacing|label|copy|format|string)[-_ ]?(?:only|fix|change|replace)?\\b',
  '\\brename\\b[^\\n]{0,24}\\b(?:symbol|file|label|key|field)\\b',
  '\\b(?:simple|quick|bounded)\\b[^\\n]{0,24}\\b(?:search|lookup|find|grep|replace|rename|type|typing)\\b',
  '\\b(?:simple|trivial|tiny|one[- ]?line|single[- ]?file)\\b[^\\n]{0,36}\\b(?:code|coding|configuration|config|setup)\\b',
  '\\b(?:simple|trivial|tiny|one[- ]?line|single[- ]?file)\\b[^\\n]{0,36}\\b(?:change|edit|fix|update|adjust)\\b',
  '\\b(?:code|coding|configuration|config|setup)\\b[^\\n]{0,24}\\bonly\\b',
  '\\b(?:search|lookup|find|grep)\\b[^\\n]{0,32}\\b(?:symbol|string|path|file|key)\\b',
  '\\bsingle[- ]?symbol[- ]?(?:lookup|search|find)\\b',
  'typing[- ]?level',
  '한\\s*줄',
  '단일\\s*파일',
  '아주\\s*(?:작은|단순한?)',
  '극단적으로\\s*단순',
  '기계적',
  '반복적',
  '정확한?[^\\n]{0,24}(?:이름\\s*변경|복사|치환|포맷|수정|타이핑)',
  '오타',
  '문구',
  '라벨',
  '간격',
  '이름\\s*변경',
  '단순\\s*(?:검색|조회|찾기|타이핑|입력|치환)',
  '(?:간단한?|단순한?|아주\\s*작은)[^\\n]{0,20}(?:코드\\s*수정|코딩|설정|구성|셋업|초기\\s*설정)',
  '(?:코드\\s*수정|코딩|설정|구성|셋업|초기\\s*설정)[^\\n]{0,16}만',
  '짧은\\s*(?:검색|조회|찾기)'
].join('|'), 'i')

const NON_MECHANICAL_COMPLEXITY_RE = new RegExp([
  '\\bmulti[- ]?file\\b',
  '\\bmultiple\\s+files?\\b',
  '\\b(?:across|throughout)\\b[^\\n]{0,32}\\b(?:files?|repository|repo|codebase)\\b',
  '(?:repository|repo|codebase)[- ]?wide',
  '\\b(?:new\\s+)?feature\\b',
  '\\b(?:endpoint|component|parser|algorithm|state machine|business logic|schema)\\b',
  '\\b(?:architecture|design|plan|review|audit|debug|diagnos|investigat|refactor|integrat|security|auth|database|migration|release|risk|ambiguous)\\w*\\b',
  '여러\\s*(?:파일|모듈)',
  '다중\\s*(?:파일|모듈)',
  '(?:저장소|코드베이스)\\s*전체',
  '(?:새\\s*)?기능',
  '엔드포인트|컴포넌트|파서|알고리즘|상태\\s*머신|비즈니스\\s*로직|스키마',
  '아키텍처|설계|계획|리뷰|검토|감사|디버깅|진단|조사|리팩터|통합|보안|인증|데이터베이스|마이그레이션|릴리즈|출시|위험|모호'
].join('|'), 'i')

const LARGE_FIRST_DRAFT_TASK_RE = new RegExp([
  '\\b(?:large[- ]?scale|high[- ]?volume|bulk|mass)\\b[^\\n]{0,56}\\b(?:first[- ]?draft|draft|scaffold|code processing|code generation)\\b',
  '\\b(?:first[- ]?draft|draft|scaffold)\\b[^\\n]{0,56}\\b(?:large[- ]?scale|high[- ]?volume|bulk|mass|many files?)\\b',
  '(?:대규모|대량)[^\\n]{0,28}(?:코드\\s*)?(?:초안|초벌|스캐폴드|생성)',
  '(?:코드\\s*)?(?:초안|초벌|스캐폴드)[^\\n]{0,28}(?:대규모|대량)'
].join('|'), 'i')

const IMPLEMENTATION_TASK_RE = new RegExp([
  '\\bimplement(?:ation|er|ing)?\\b',
  '\\bbuild(?:ing)?\\b',
  '\\bcreate\\b',
  '\\badd\\b[^\\n]{0,40}\\b(?:feature|endpoint|component|modal|button|handler|parser)\\b',
  '\\bmodify\\b',
  '\\bfix\\b',
  '\\bcod(?:e|ing)\\b',
  '\\bui\\b',
  '\\bux\\b',
  '\\bgui\\b',
  'frontend',
  'backend',
  '\\blogic\\b',
  '\\bparser\\b',
  '\\bcomponent\\b',
  '\\bmodal\\b',
  '\\bappkit\\b',
  '\\bswift\\b',
  '\\bfeature\\b',
  '구현',
  '기능\\s*추가',
  '코딩',
  '코드',
  '로직',
  '화면',
  '유아이',
  '유엑스',
  '프론트엔드',
  '백엔드',
  '컴포넌트',
  '모달',
  '버튼',
  '앱킷',
  '스위프트'
].join('|'), 'i')

const CLEAR_IMPLEMENTATION_ACTION_RE = /(?:^|[.!?]\s*|\bphase\s*:\s*)\s*(?:implement|build|create|add|modify|fix|code|refactor)\b|(?:^|[.!?]\s*)\s*(?:구현|개발|추가|수정|고쳐|코딩|리팩터)/i
const DOCUMENT_EXPLORATION_RE = /\b(?:read|scan|explore|compare|summarize|review)\b[^\n]{0,64}\b(?:docs?|documentation|manual|notes?|references?)\b|(?:문서|매뉴얼|노트|자료)[^\n]{0,32}(?:읽|탐색|조사|비교|정리|검토)/i

export function subagentModelProfile(policy: SubagentModelPolicyId): SubagentModelProfile {
  return SUBAGENT_MODEL_POLICIES[policy]
}

export function decideSubagentModel(input: {
  title?: string | undefined
  description?: string | undefined
  role?: string | undefined
  expectedOutput?: string | undefined
  requiresJudgment?: boolean | undefined
  longContext?: boolean | undefined
  toolHeavy?: boolean | undefined
  simpleMechanical?: boolean | undefined
  taskClass?: SubagentTaskClass | undefined
  contextMode?: SubagentContextMode | undefined
  toolSurface?: SubagentToolSurface | undefined
  scopeSize?: SubagentScopeSize | undefined
} = {}): SubagentModelDecision {
  const text = [
    input.title,
    input.description,
    input.role,
    input.expectedOutput
  ].filter(Boolean).join(' ')

  const documentExploration = DOCUMENT_EXPLORATION_RE.test(text)
  const implementation = IMPLEMENTATION_TASK_RE.test(text)
  const explicitContextOrTools = input.longContext === true
    || input.toolHeavy === true
    || input.contextMode === 'long'
    || (input.toolSurface !== undefined && input.toolSurface !== 'none')
    || input.scopeSize === 'large'

  // Explicit phase/task classification is authoritative unless it conflicts
  // with an even stronger explicit requirement or a clear complexity guard.
  // A caller cannot force multi-file, feature, logic, long-context, or
  // judgment work into Luna merely by labeling it mechanical.
  if (input.taskClass === 'judgment' || input.requiresJudgment === true) return decision('sol_max_judgment')
  if (input.taskClass === 'context_tools' || explicitContextOrTools) return decision('terra_max_context_tools')
  if (input.taskClass === 'implementation') return decision('sol_high_implementation')
  if (input.taskClass === 'mechanical') {
    if (NON_MECHANICAL_COMPLEXITY_RE.test(text)) {
      return decision(implementation ? 'sol_high_implementation' : 'sol_max_judgment')
    }
    return decision('luna_max_mechanical')
  }

  const focusedJudgment = !documentExploration && FOCUSED_JUDGMENT_TASK_RE.test(text)
  const resolvedIncidentalJudgment = implementation
    && CLEAR_IMPLEMENTATION_ACTION_RE.test(text)
    && /\b(?:already|previously|fully)\s+resolved\b|(?:review|debug|architecture)[^\n]{0,32}\bcontext\b[^\n]{0,16}\bresolved\b|(?:리뷰|검토|디버깅|아키텍처)[^\n]{0,24}(?:이미\s*)?해결/i.test(text)
  if (focusedJudgment && !resolvedIncidentalJudgment) return decision('sol_max_judgment')

  // Large first-draft processing is a Terra responsibility even when the
  // prompt contains implementation verbs. Keep this narrow so normal feature
  // implementation remains on Sol High.
  if (LARGE_FIRST_DRAFT_TASK_RE.test(text)) return decision('terra_max_context_tools')

  const simpleMechanical = input.simpleMechanical === true
    || input.scopeSize === 'tiny'
    || SIMPLE_MECHANICAL_TASK_RE.test(text)
  if (simpleMechanical && !NON_MECHANICAL_COMPLEXITY_RE.test(text)) return decision('luna_max_mechanical')

  if (implementation && CLEAR_IMPLEMENTATION_ACTION_RE.test(text)) return decision('sol_high_implementation')

  if (documentExploration) return decision('terra_max_context_tools')

  const contextOrTools = CONTEXT_TOOL_TASK_RE.test(text)
  if (contextOrTools) return decision('terra_max_context_tools')

  if (implementation) return decision('sol_high_implementation')

  const judgment = JUDGMENT_TASK_RE.test(text)
  if (judgment) return decision('sol_max_judgment')

  // Ambiguous work defaults to the trust-first lane. Sol High is reserved for
  // clearly identified implementation, not for underspecified judgment.
  return decision('sol_max_judgment')
}

const FOCUSED_JUDGMENT_TASK_RE = new RegExp([
  '^\\s*(?:review|audit|debug|diagnos|investigat|plan|assess|refactor)\\b',
  '\\bfinal[- ]?(?:review|decision|assessment)\\b',
  '\\b(?:security|database|release|production|high[- ]?risk)\\b[^\\n]{0,48}\\b(?:review|audit|decision|plan|assessment)\\b',
  '\\b(?:debug(?:ger|ging)?|diagnos(?:e|ing|is|tic)?|investigat(?:e|ing|ion|or)?)\\b',
  'root[- ]?cause',
  '\\barchitecture\\b[^\\n]{0,32}\\b(?:decision|review|design|plan)\\b',
  '\\b(?:unresolved|ambiguous)\\b[^\\n]{0,32}\\b(?:decision|risk|trade[- ]?off|judgment)\\b',
  '최종\\s*(?:리뷰|검토|판정)',
  '^\\s*(?:리뷰|검토|감사|디버깅|진단|조사|계획|평가)',
  '(?:보안|데이터베이스|릴리스|운영|고위험)[^\\n]{0,32}(?:리뷰|감사|판정|계획)',
  '디버깅|진단|근본\\s*원인',
  '아키텍처[^\\n]{0,24}(?:결정|리뷰|설계|계획)'
].join('|'), 'i')

export function isReasoningSensitiveSubagentTask(input: Parameters<typeof decideSubagentModel>[0] = {}): boolean {
  return decideSubagentModel(input).policy === 'sol_max_judgment'
}

function decision(policy: SubagentModelPolicyId): SubagentModelDecision {
  return {
    ...subagentModelProfile(policy),
    reason: policy
  }
}
