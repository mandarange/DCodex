import path from 'node:path';
import { writeJsonAtomic, writeTextAtomic } from './fsx.mjs';
import { buildQaLoopQuestionSchema } from './qa-loop.mjs';
import { FROM_CHAT_IMG_CHECKLIST_ARTIFACT, FROM_CHAT_IMG_COVERAGE_ARTIFACT, FROM_CHAT_IMG_QA_LOOP_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, hasFromChatImgSignal } from './routes.mjs';

export function buildQuestionSchemaForRoute(route, prompt) {
  if (String(route?.id || '') === 'QALoop') return buildQaLoopQuestionSchema(prompt);
  if (String(route?.id || '') === 'MadSKS') return buildMadSksQuestionSchema(prompt);
  return buildQuestionSchema(prompt);
}

function buildMadSksQuestionSchema(prompt) {
  const task = String(prompt || '').trim() || 'MAD-SKS scoped database override';
  return {
    schema_version: 1,
    description: 'MAD-SKS is explicit-invocation-only. It auto-seals because the dollar command itself is the permission boundary; table deletion still requires runtime user confirmation with an approximately 30 second timeout.',
    prompt,
    domain_hints: ['db', 'mad-sks'],
    inferred_answers: {
      GOAL_PRECISE: `명시적인 MAD-SKS 호출 범위에서만 DB 권한 조건을 넓혀 작업한다: ${task}`,
      ACCEPTANCE_CRITERIA: [
        '$MAD-SKS is listed in dollar commands and routes to MADSKS mode',
        'broad Supabase MCP DB manipulation is allowed only while the active MAD-SKS mission gate remains open',
        'the widened permission is inactive after the MAD-SKS gate is passed or permissions_deactivated is true',
        'table deletion requires explicit user confirmation and expires after about 30 seconds without confirmation'
      ],
      NON_GOALS: [],
      PUBLIC_API_CHANGE_ALLOWED: 'yes_if_needed',
      DB_SCHEMA_CHANGE_ALLOWED: 'yes_if_needed',
      DEPENDENCY_CHANGE_ALLOWED: 'no',
      TEST_SCOPE: ['packcheck', 'selftest'],
      MID_RALPH_UNKNOWN_POLICY: ['preserve_existing_behavior', 'smallest_reversible_change', 'defer_optional_scope', 'block_only_if_no_safe_path'],
      RISK_BOUNDARY: [
        'MAD-SKS permission widening is explicit-invocation-only',
        'MAD-SKS permission widening does not persist after the active task gate closes',
        'table deletion must pause for explicit user confirmation and timeout-abort after about 30 seconds'
      ],
      MAD_SKS_MODE: 'explicit_invocation_only',
      DATABASE_TARGET_ENVIRONMENT: 'main_branch',
      DATABASE_WRITE_MODE: 'mad_sks_full_mcp_write_for_invocation',
      SUPABASE_MCP_POLICY: 'mad_sks_project_scoped_write_for_invocation',
      DESTRUCTIVE_DB_OPERATIONS_ALLOWED: 'mad_sks_scoped_with_table_delete_confirmation',
      DB_BACKUP_OR_BRANCH_REQUIRED: 'recommended_but_not_required_in_mad_sks',
      DB_MAX_BLAST_RADIUS: 'mad_sks_active_invocation_only_table_delete_confirmation_required',
      DB_MIGRATION_APPLY_ALLOWED: 'mad_sks_active_invocation_only',
      DB_READ_ONLY_QUERY_LIMIT: '100'
    },
    inference_notes: {
      MAD_SKS_MODE: 'explicit dollar command is the permission boundary',
      DESTRUCTIVE_DB_OPERATIONS_ALLOWED: 'MAD-SKS scoped override with table deletion confirmation'
    },
    slots: []
  };
}

function hasAnswer(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function addInferred(out, notes, id, value, note) {
  if (!hasAnswer(value) && !(Array.isArray(value) && value.length === 0)) return;
  out[id] = value;
  notes[id] = note;
}

export function inferAnswersForPrompt(prompt, explicitAnswers = {}) {
  const text = `${prompt || ''}\n${explicitAnswers.GOAL_PRECISE || ''}`;
  const lower = text.toLowerCase();
  const inferred = {};
  const notes = {};
  const normalizedPrompt = String(prompt || '')
    .replace(/^\s*\$(?:Team|SKS|Ralph|team|sks|ralph)\b/i, '')
    .replace(/\b(?:executor|reviewer|planner|user)\s*:\s*\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const version = String(text || '').match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] || null;
  const versionWork = /버전|version|bump|release|publish:dry|npm\s+pack/.test(lower);
  const installWork = /bootstrap|postinstall|doctor|deps|cmux|homebrew|first install|최초\s*설치|설치\s*ux|셋업|setup/.test(lower);
  const questionGateWork = /모호|ambiguity|clarification|질문|triwiki|추론|infer|predict|예측|answers?\.json|decision-contract/.test(lower);
  const prioritySignalWork = /화|짜증|답답|;;|!!|강력|기억|우선|자주|반복|카운팅|count|frequency|frequent|priority|weight/.test(lower);
  const cliSurfaceWork = /\b(cli|command|route|usage|help|sks)\b|명령|커맨드|사용법/.test(lower);
  const chatCaptureWork = hasFromChatImgSignal(text)
    && /(chat|conversation|message|messenger|kakao|screenshot|capture|채팅|대화|메신저|카톡|캡처|스크린샷)/i.test(text)
    && /(image|photo|attachment|attached|이미지|사진|첨부)/i.test(text)
    && /(client|customer|request|change|modify|fix|match|ocr|extract|text|고객사|클라이언트|요청|수정|변경|매칭|추출|글자|텍스트)/i.test(text);
  const kind = versionWork ? 'version' : chatCaptureWork ? 'chat_capture' : prioritySignalWork ? 'priority' : questionGateWork ? 'questions' : installWork ? 'install' : null;
  const goals = {
    version: version ? `sneakoscope 버전을 ${version}로 올린다` : 'sneakoscope 버전을 다음 patch 버전으로 올린다',
    chat_capture: 'From-Chat-IMG로 채팅 요구사항과 첨부 원본 이미지를 매칭해 고객사 작업 지시서를 만들고 반영한다',
    priority: '강한 불만과 반복 요청을 TriWiki 우선순위 신호로 기록한다',
    questions: '예측 가능한 답은 추론하고 실제 모호한 항목만 질문한다',
    install: 'SKS 최초 설치와 bootstrap을 한 번에 준비 상태까지 연결한다'
  };
  const criteria = {
    version: [version ? `version refs are ${version}` : 'version refs advance consistently', 'publish:dry gate passes', 'npm publish is not run'],
    chat_capture: ['From-Chat-IMG activates chat-image intake only here', 'all visible chat requirements are listed before implementation', `${FROM_CHAT_IMG_COVERAGE_ARTIFACT} maps every customer request, screenshot region, and attachment to work-order item(s)`, `${FROM_CHAT_IMG_CHECKLIST_ARTIFACT} is updated as each request, image match, work item, scoped QA-LOOP, and verification step is completed`, `${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT} records temporary TriWiki-backed session context with retention metadata`, `${FROM_CHAT_IMG_QA_LOOP_ARTIFACT} proves QA-LOOP ran over the exact customer-request work-order range after implementation`, 'unresolved_items is empty before Team completion', 'scoped_qa_loop_completed is true with zero unresolved QA findings', 'Computer Use/browser visual inspection strengthens matches when available', 'client requests follow normal SKS gates and verification'],
    priority: ['strong feedback raises required_weight', 'request topics are counted in wiki packs', 'future inference uses priority signals'],
    questions: ['predictable answers are inferred', 'partial answers can seal contracts', 'only unresolved changing slots remain visible'],
    install: ['bootstrap/deps initialize readiness', 'missing runtime deps show repair actions', 'readiness output is concrete']
  };
  if (!hasAnswer(explicitAnswers.GOAL_PRECISE)) {
    addInferred(
      inferred,
      notes,
      'GOAL_PRECISE',
      kind ? goals[kind] : (normalizedPrompt ? `사용자 요청을 현재 코드 기준으로 구현한다: ${normalizedPrompt}` : '사용자 요청을 현재 코드 기준으로 구현한다'),
      kind || 'prompt-derived-goal'
    );
  }
  if (!hasAnswer(explicitAnswers.ACCEPTANCE_CRITERIA)) {
    addInferred(
      inferred,
      notes,
      'ACCEPTANCE_CRITERIA',
      kind ? criteria[kind] : [
        'requested behavior is implemented in the relevant code path',
        'relevant tests/checks pass or any unavailable check is explicitly justified',
        'final response states what was changed, verified, and left unverified'
      ],
      kind || 'default-implementation-criteria'
    );
  }

  if (explicitAnswers.NON_GOALS === undefined) addInferred(inferred, notes, 'NON_GOALS', [], 'empty non-goals is the safest default when the user did not exclude scope');
  if (!hasAnswer(explicitAnswers.PUBLIC_API_CHANGE_ALLOWED)) addInferred(inferred, notes, 'PUBLIC_API_CHANGE_ALLOWED', cliSurfaceWork || installWork ? 'yes_if_needed' : 'no', 'public-api');
  if (!hasAnswer(explicitAnswers.DEPENDENCY_CHANGE_ALLOWED)) addInferred(inferred, notes, 'DEPENDENCY_CHANGE_ALLOWED', 'no', 'no-new-deps');
  if (!hasAnswer(explicitAnswers.TEST_SCOPE)) {
    const releaseLike = versionWork || installWork || questionGateWork || prioritySignalWork || chatCaptureWork || /\bsneakoscope\b|\bsks\b/.test(lower);
    addInferred(inferred, notes, 'TEST_SCOPE', releaseLike ? ['packcheck', 'selftest', 'sizecheck', 'publish:dry'] : ['focused relevant tests or documented justification'], 'tests');
  }
  if (!hasAnswer(explicitAnswers.MID_RALPH_UNKNOWN_POLICY)) {
    addInferred(inferred, notes, 'MID_RALPH_UNKNOWN_POLICY', ['preserve_existing_behavior', 'smallest_reversible_change', 'defer_optional_scope', 'block_only_if_no_safe_path'], 'ladder');
  }
  if (!hasAnswer(explicitAnswers.RISK_BOUNDARY)) {
    addInferred(inferred, notes, 'RISK_BOUNDARY', [
      'no npm publish unless explicitly requested',
      'do not revert unrelated changes',
      'no destructive commands or live data writes'
    ], 'safety');
  }
  return { answers: inferred, notes };
}

export function buildQuestionSchema(prompt) {
  const lower = String(prompt || '').toLowerCase();
  const domainHints = [];
  if (/결제|payment|billing|invoice|checkout|order/.test(lower)) domainHints.push('payment');
  if (/로그인|auth|session|token|인증/.test(lower)) domainHints.push('auth');
  if (/\b(ui|modal|screen|button|visual|design)\b|화면|버튼|모달|디자인/.test(lower)) domainHints.push('uiux');
  if (/db|database|schema|migration|테이블|마이그레이션|supabase|postgres|sql/.test(lower)) domainHints.push('db');
  const slots = [
    { id: 'GOAL_PRECISE', question: '이번 작업의 최종 목표를 한 문장으로 정확히 정의해주세요.', required: true, type: 'string' },
    { id: 'ACCEPTANCE_CRITERIA', question: '완료 기준을 항목으로 적어주세요. 최소 2개 이상 권장합니다.', required: true, type: 'array_or_string' },
    { id: 'NON_GOALS', question: '이번 작업에서 제외할 범위가 있나요? 없으면 빈 배열로 답해주세요.', required: true, type: 'array_or_string', allow_empty: true },
    { id: 'PUBLIC_API_CHANGE_ALLOWED', question: 'public API 또는 외부 계약 변경을 허용하나요?', required: true, type: 'enum', options: ['no', 'yes_if_needed', 'yes'] },
    { id: 'DB_SCHEMA_CHANGE_ALLOWED', question: 'DB schema 또는 migration 변경을 허용하나요?', required: true, type: 'enum', options: ['no', 'yes_if_needed', 'yes_with_migration'] },
    { id: 'DEPENDENCY_CHANGE_ALLOWED', question: '새 dependency 추가를 허용하나요?', required: true, type: 'enum', options: ['no', 'yes_if_already_approved', 'yes'] },
    { id: 'TEST_SCOPE', question: 'Ralph가 완료 전 실행 또는 정당화해야 할 테스트 범위를 지정해주세요.', required: true, type: 'array_or_string', examples: ['unit', 'integration', 'e2e', 'lint', 'typecheck'] },
    { id: 'MID_RALPH_UNKNOWN_POLICY', question: 'Ralph 중 새 모호성이 생기면 사용자에게 묻지 않고 어떤 fallback 순서로 해결할까요?', required: true, type: 'array', options: ['preserve_existing_behavior', 'smallest_reversible_change', 'defer_optional_scope', 'block_only_if_no_safe_path'] },
    { id: 'RISK_BOUNDARY', question: '보안, 결제, 데이터 손상, 권한, 인증 등 절대 넘으면 안 되는 위험 경계를 적어주세요.', required: true, type: 'array_or_string' },

    { id: 'DATABASE_TARGET_ENVIRONMENT', question: 'DB 관련 작업의 대상 환경을 지정해주세요. production write는 Sneakoscope Codex가 허용하지 않습니다.', required: true, type: 'enum', options: ['no_database', 'local_dev', 'preview_branch', 'supabase_branch', 'production_read_only'] },
    { id: 'DATABASE_WRITE_MODE', question: 'DB 쓰기 정책을 선택해주세요. Supabase/Postgres MCP live write는 기본 차단됩니다.', required: true, type: 'enum', options: ['read_only_only', 'migration_files_only', 'non_destructive_writes_to_local_or_branch_only'] },
    { id: 'SUPABASE_MCP_POLICY', question: 'Supabase MCP를 사용한다면 어떤 안전 정책을 적용할까요?', required: true, type: 'enum', options: ['not_used', 'read_only_project_scoped_only', 'branch_only_no_live_writes'] },
    { id: 'DESTRUCTIVE_DB_OPERATIONS_ALLOWED', question: 'DROP/TRUNCATE/DB reset/mass DELETE/branch reset/project delete 같은 파괴적 DB 작업을 허용하나요? Sneakoscope Codex는 never만 허용합니다.', required: true, type: 'enum', options: ['never'] },
    { id: 'DB_BACKUP_OR_BRANCH_REQUIRED', question: 'DB 쓰기가 필요한 경우 local/preview branch 또는 백업이 있어야만 진행하도록 할까요?', required: true, type: 'enum', options: ['yes_for_any_write'] },
    { id: 'DB_MAX_BLAST_RADIUS', question: 'DML이 꼭 필요한 경우 허용 가능한 최대 영향 범위를 적어주세요. 기본 권장값은 no_live_dml입니다.', required: true, type: 'string' }
  ];
  if (domainHints.includes('payment')) {
    slots.push(
      { id: 'PAYMENT_SUCCESS_INVARIANT', question: '이미 성공 처리된 결제에 대해서는 어떤 invariant를 보존해야 하나요?', required: true, type: 'string' },
      { id: 'PAYMENT_RETRY_POLICY', question: '재시도 횟수, backoff, 실패 최종 상태 정책을 지정해주세요.', required: true, type: 'string' }
    );
  }
  if (domainHints.includes('auth')) {
    slots.push(
      { id: 'AUTH_SESSION_EXPIRED_BEHAVIOR', question: '세션/토큰 만료 시 사용자가 보게 될 UX 또는 API 동작을 지정해주세요.', required: true, type: 'string' },
      { id: 'AUTH_PROTOCOL_CHANGE_ALLOWED', question: '인증 프로토콜 변경을 허용하나요?', required: true, type: 'enum', options: ['no', 'yes_if_needed', 'yes'] }
    );
  }
  if (domainHints.includes('uiux')) {
    slots.push(
      { id: 'UI_STATE_BEHAVIOR', question: '로딩, 에러, 빈 상태, 재시도 등 UI 상태별 기대 동작을 지정해주세요.', required: true, type: 'string' },
      { id: 'VISUAL_REGRESSION_REQUIRED', question: '스크린샷/시각 검증이 필요한가요?', required: true, type: 'enum', options: ['no', 'yes_if_available', 'yes'] }
    );
  }
  if (domainHints.includes('db')) {
    slots.push(
      { id: 'DB_MIGRATION_APPLY_ALLOWED', question: 'migration 적용이 필요할 경우 어디까지 허용하나요?', required: true, type: 'enum', options: ['no', 'local_only', 'preview_branch_only'] },
      { id: 'DB_READ_ONLY_QUERY_LIMIT', question: 'MCP/SQL read-only 조회 시 기본 LIMIT를 몇으로 둘까요?', required: true, type: 'string' }
    );
  }
  const skippedByDefault = new RegExp('^(D' + 'B_|D' + 'ATABASE_|D' + 'ESTRUCTIVE_D' + 'B_|SUPA' + 'BASE_)');
  const inferred = inferAnswersForPrompt(prompt);
  const inferredSlots = new Set(['MID_RALPH_UNKNOWN_POLICY', ...Object.keys(inferred.answers)]);
  const askedSlots = slots.filter((s) => !inferredSlots.has(s.id) && (domainHints.includes('db') || !skippedByDefault.test(s.id)));
  return {
    schema_version: 1,
    description: 'Only slots that can change scope, safety, behavior, or acceptance are asked. The rest is inferred from TriWiki/current code defaults. Ralph never asks the user after the contract is sealed.',
    prompt,
    domain_hints: domainHints,
    inferred_answers: inferred.answers,
    inference_notes: inferred.notes,
    slots: askedSlots
  };
}

export function questionsMarkdown(schema) {
  const lines = [];
  const isQaLoop = schema?.route === 'QALoop';
  lines.push(isQaLoop ? '# Sneakoscope Codex QA-LOOP Prepare Questions' : '# Sneakoscope Codex Ambiguity Questions');
  lines.push('');
  if (isQaLoop) {
    lines.push('QA-LOOP는 이 질문들에 모두 답변하고 Decision Contract가 봉인된 뒤에만 실행됩니다.');
    lines.push('로그인이 필요하면 테스트 전용 계정 정보만 임시 런타임 입력으로 제공해야 하며, answers.json/리포트/로그/wiki에는 절대 저장하지 않습니다.');
    lines.push('UI E2E는 Browser Use 또는 Computer Use 증거가 없으면 검증 완료로 주장할 수 없습니다.');
    lines.push('개발 서버가 아닌 배포/스테이징 도메인에서는 삭제성 테스트를 절대 실행하지 않습니다.');
  } else {
    lines.push('이 질문들에 모두 답변하고 Decision Contract가 봉인된 뒤에만 실행됩니다.');
    lines.push('봉인 후 실행 중에는 사용자에게 새 질문을 하지 않고 decision ladder로 해결합니다.');
    lines.push('사용자 의도가 실제로 모호한 항목만 묻고, 나머지는 TriWiki/current-code 기본값으로 추론합니다.');
  }
  if (schema.description) lines.push(schema.description);
  if (schema.inferred_answers && Object.keys(schema.inferred_answers).length) {
    lines.push('');
    lines.push('## Inferred Answers');
    lines.push('');
    lines.push('These values are prefilled from the prompt, TriWiki/current-code defaults, and conservative SKS safety policy. Override only if they are wrong.');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(schema.inferred_answers, null, 2));
    lines.push('```');
  }
  lines.push('');
  for (let i = 0; i < schema.slots.length; i++) {
    const s = schema.slots[i];
    lines.push(`## ${i + 1}. ${s.id}`);
    lines.push('');
    lines.push(s.question);
    if (s.options) lines.push(`- options: ${s.options.join(', ')}`);
    if (s.examples) lines.push(`- examples: ${s.examples.join(', ')}`);
    lines.push(`- required: ${s.required}`);
    lines.push(`- type: ${s.type}`);
    lines.push('');
  }
  lines.push('## answers.json template');
  lines.push('');
  lines.push('```json');
  const example = {};
  for (const s of schema.slots) {
    if (s.type === 'array' || s.type === 'array_or_string') example[s.id] = s.options ? [s.options[0]] : [];
    else if (s.options) example[s.id] = s.options[0];
    else example[s.id] = s.id === 'DB_MAX_BLAST_RADIUS' ? 'no_live_dml' : '';
  }
  lines.push(JSON.stringify(example, null, 2));
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function writeQuestions(dir, schema) {
  await writeJsonAtomic(path.join(dir, 'required-answers.schema.json'), schema);
  await writeTextAtomic(path.join(dir, 'questions.md'), questionsMarkdown(schema));
}
