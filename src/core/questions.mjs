import path from 'node:path';
import { writeJsonAtomic, writeTextAtomic } from './fsx.mjs';
import { buildQaLoopQuestionSchema } from './qa-loop.mjs';

export function buildQuestionSchemaForRoute(route, prompt) {
  if (String(route?.id || '') === 'QALoop') return buildQaLoopQuestionSchema(prompt);
  return buildQuestionSchema(prompt);
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
  const inferredSlots = new Set(['MID_RALPH_UNKNOWN_POLICY']);
  const askedSlots = slots.filter((s) => !inferredSlots.has(s.id) && (domainHints.includes('db') || !skippedByDefault.test(s.id)));
  return {
    schema_version: 1,
    description: 'Only slots that can change scope, safety, behavior, or acceptance are asked. The rest is inferred from TriWiki/current code defaults. Ralph never asks the user after the contract is sealed.',
    prompt,
    domain_hints: domainHints,
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
