import path from 'node:path';
import { exists, nowIso, readJson, readText, writeJsonAtomic, writeTextAtomic } from './fsx.mjs';

export const QA_LOOP_ROUTE = 'QALoop';

export function buildQaLoopQuestionSchema(prompt) {
  return {
    schema_version: 1,
    route: QA_LOOP_ROUTE,
    description: 'QA-LOOP questions must be answered before execution. Login secrets and browser auth state are runtime-only and must not be saved to mission files or TriWiki. UI evidence must prefer official Codex Browser Use and Computer Use MCP/plugin tools.',
    prompt,
    slots: [
      { id: 'GOAL_PRECISE', question: 'Define the QA objective in one sentence.', required: true, type: 'string' },
      { id: 'QA_SCOPE', question: 'Which QA surface should run?', required: true, type: 'enum', options: ['ui_e2e_only', 'api_e2e_only', 'ui_and_api_e2e', 'all_available'] },
      { id: 'TARGET_ENVIRONMENT', question: 'Where should QA run?', required: true, type: 'enum', options: ['local_dev_server', 'preview_or_staging_domain', 'deployed_production_domain'] },
      { id: 'TARGET_BASE_URL', question: 'What base URL should QA target?', required: true, type: 'string' },
      { id: 'DEV_SERVER_COMMAND', question: 'If local dev is selected, what command starts the app? Use none if already running.', required: true, type: 'string' },
      { id: 'API_BASE_URL', question: 'If API E2E is selected, what API base URL should be used? Use same_as_target when identical.', required: true, type: 'string' },
      { id: 'QA_MUTATION_POLICY', question: 'May QA create or change seeded data?', required: true, type: 'enum', options: ['read_only_smoke_only', 'seeded_create_change_only', 'seeded_create_change_remove_local_only'] },
      { id: 'DESTRUCTIVE_DEPLOYED_TESTS_ALLOWED', question: 'Can non-local QA run destructive removal scenarios?', required: true, type: 'enum', options: ['never'] },
      { id: 'EXTERNAL_SIDE_EFFECT_POLICY', question: 'How should email, SMS, webhook, payment, and admin side effects be handled?', required: true, type: 'enum', options: ['block_all_external_side_effects', 'mock_or_sandbox_only'] },
      { id: 'LOGIN_REQUIRED', question: 'Does UI/API QA require login?', required: true, type: 'enum', options: ['no', 'yes'] },
      { id: 'TEMP_TEST_CREDENTIALS_READY', question: 'If login is required, are test-only credentials ready to provide ephemerally during the run?', required: true, type: 'enum', options: ['not_required', 'yes_temp_only', 'no_block_authenticated_tests'] },
      { id: 'TEST_CREDENTIALS_RUNTIME_SOURCE', question: 'If login is required, how will test-only credentials be provided without saving the values?', required: true, type: 'enum', options: ['not_required', 'ephemeral_chat_only', 'environment_variables', 'secret_manager'] },
      { id: 'CREDENTIAL_STORAGE_ACK', question: 'Acknowledge credential handling policy.', required: true, type: 'enum', options: ['never_store_credentials_in_artifacts_or_wiki'] },
      { id: 'UI_COMPUTER_USE_ACK', question: 'Acknowledge UI E2E evidence policy.', required: true, type: 'enum', options: ['use_browser_use_or_computer_use_for_ui_e2e_or_mark_ui_not_verified'] },
      { id: 'TEAM_MODE_ALLOWED', question: 'May QA-LOOP use Team/subagents where useful?', required: true, type: 'enum', options: ['yes_parallel_where_safe', 'no_parent_only'] },
      { id: 'MAX_QA_CYCLES', question: 'How many no-question QA cycles are allowed before pausing?', required: true, type: 'string' },
      { id: 'ACCEPTANCE_CRITERIA', question: 'List the QA completion criteria.', required: true, type: 'array_or_string' },
      { id: 'NON_GOALS', question: 'List anything QA-LOOP must not test.', required: true, type: 'array_or_string', allow_empty: true },
      { id: 'RISK_BOUNDARY', question: 'List hard safety boundaries for data, auth, permissions, money, messages, and third-party systems.', required: true, type: 'array_or_string' },
      { id: 'MID_RALPH_UNKNOWN_POLICY', question: 'If ambiguity appears during no-question QA, choose the fallback order.', required: true, type: 'array', options: ['preserve_existing_behavior', 'smallest_reversible_change', 'defer_optional_scope', 'block_only_if_no_safe_path'] }
    ]
  };
}

export function validateQaLoopAnswers(schema, answers = {}) {
  if (schema?.route !== QA_LOOP_ROUTE) return [];
  const errors = [];
  const env = answers.TARGET_ENVIRONMENT;
  const mutation = answers.QA_MUTATION_POLICY;
  const extra = Object.keys(answers).filter((k) => /(password|passwd|token|secret|cookie|storage_state|login_username|login_password)/i.test(k));
  if (extra.length) errors.push({ slot: extra.join(','), error: 'qa_loop_credentials_must_not_be_saved_in_answers_json' });
  if (env !== 'local_dev_server' && mutation === 'seeded_create_change_remove_local_only') errors.push({ slot: 'QA_MUTATION_POLICY', error: 'destructive_removal_tests_are_local_dev_only' });
  if (env === 'deployed_production_domain' && mutation !== 'read_only_smoke_only') errors.push({ slot: 'QA_MUTATION_POLICY', error: 'production_deployed_qa_is_read_only_smoke_only' });
  if (answers.DESTRUCTIVE_DEPLOYED_TESTS_ALLOWED !== 'never') errors.push({ slot: 'DESTRUCTIVE_DEPLOYED_TESTS_ALLOWED', error: 'destructive_deployed_tests_never_allowed' });
  if (isUiScope(answers.QA_SCOPE) && answers.UI_COMPUTER_USE_ACK !== 'use_browser_use_or_computer_use_for_ui_e2e_or_mark_ui_not_verified') errors.push({ slot: 'UI_COMPUTER_USE_ACK', error: 'ui_e2e_requires_browser_or_computer_use_ack' });
  if (answers.LOGIN_REQUIRED === 'yes' && answers.TEMP_TEST_CREDENTIALS_READY !== 'yes_temp_only') errors.push({ slot: 'TEMP_TEST_CREDENTIALS_READY', error: 'authenticated_tests_require_ephemeral_test_credentials_or_must_be_blocked' });
  if (answers.LOGIN_REQUIRED === 'yes' && answers.TEST_CREDENTIALS_RUNTIME_SOURCE === 'not_required') errors.push({ slot: 'TEST_CREDENTIALS_RUNTIME_SOURCE', error: 'credential_runtime_source_required' });
  if (answers.CREDENTIAL_STORAGE_ACK !== 'never_store_credentials_in_artifacts_or_wiki') errors.push({ slot: 'CREDENTIAL_STORAGE_ACK', error: 'credential_temp_only_ack_required' });
  return errors;
}

export function isUiScope(scope) {
  return ['ui_e2e_only', 'ui_and_api_e2e', 'all_available'].includes(scope);
}

export function isApiScope(scope) {
  return ['api_e2e_only', 'ui_and_api_e2e', 'all_available'].includes(scope);
}

export function defaultQaGate(contract = {}) {
  const a = contract.answers || {};
  return {
    passed: false,
    clarification_contract_sealed: Boolean(contract.sealed_hash),
    qa_report_written: false,
    qa_ledger_complete: false,
    checklist_completed: false,
    safety_reviewed: false,
    deployed_destructive_tests_blocked: a.TARGET_ENVIRONMENT === 'local_dev_server' || a.DESTRUCTIVE_DEPLOYED_TESTS_ALLOWED === 'never',
    credentials_not_persisted: false,
    ui_e2e_required: isUiScope(a.QA_SCOPE),
    ui_computer_use_evidence: !isUiScope(a.QA_SCOPE),
    api_e2e_required: isApiScope(a.QA_SCOPE),
    unsafe_external_side_effects: false,
    honest_mode_complete: false,
    evidence: [],
    notes: []
  };
}

export async function writeQaLoopArtifacts(dir, mission, contract) {
  const a = contract.answers || {};
  const checklist = qaChecklist(a);
  await writeJsonAtomic(path.join(dir, 'qa-ledger.json'), {
    schema_version: 1,
    generated_at: nowIso(),
    mission_id: mission.id,
    target: { scope: a.QA_SCOPE, environment: a.TARGET_ENVIRONMENT, base_url: a.TARGET_BASE_URL, api_base_url: a.API_BASE_URL },
    safety: { mutation_policy: a.QA_MUTATION_POLICY, deployed_destructive_tests_allowed: 'never', credentials: 'temp_only_never_saved', ui_evidence: 'browser_use_or_computer_use_required_for_ui_e2e' },
    checklist
  });
  await writeJsonAtomic(path.join(dir, 'qa-gate.json'), defaultQaGate(contract));
  await writeTextAtomic(path.join(dir, 'qa-report.md'), qaReportTemplate(mission, contract, checklist));
  return { checklist_count: checklist.length };
}

export async function evaluateQaGate(dir) {
  const gate = await readJson(path.join(dir, 'qa-gate.json'), {});
  const reasons = [];
  for (const key of ['clarification_contract_sealed', 'qa_report_written', 'qa_ledger_complete', 'checklist_completed', 'safety_reviewed', 'deployed_destructive_tests_blocked', 'credentials_not_persisted', 'ui_computer_use_evidence', 'honest_mode_complete']) {
    if (gate[key] !== true) reasons.push(`${key}_missing`);
  }
  if (gate.unsafe_external_side_effects === true) reasons.push('unsafe_external_side_effects');
  if (!(await exists(path.join(dir, 'qa-report.md')))) reasons.push('qa_report_missing');
  if (!(await exists(path.join(dir, 'qa-ledger.json')))) reasons.push('qa_ledger_missing');
  const passed = gate.passed === true && reasons.length === 0;
  const result = { checked_at: nowIso(), passed, reasons, gate };
  await writeJsonAtomic(path.join(dir, 'qa-gate.evaluated.json'), result);
  return result;
}

export async function writeMockQaResult(dir, mission, contract) {
  await writeTextAtomic(path.join(dir, 'qa-report.md'), `# QA-LOOP Report\n\nMission: ${mission.id}\nMode: mock verification\n\nMock QA-LOOP completed. No live UI/API actions were executed.\n\n## Honest Mode\n\nThis is a mock smoke run for command verification, not production QA evidence.\n`);
  await writeJsonAtomic(path.join(dir, 'qa-gate.json'), { ...defaultQaGate(contract), passed: true, qa_report_written: true, qa_ledger_complete: true, checklist_completed: true, safety_reviewed: true, credentials_not_persisted: true, ui_computer_use_evidence: true, honest_mode_complete: true, evidence: ['mock QA-LOOP smoke completed'], notes: ['No live UI/API verification was claimed.'] });
  return evaluateQaGate(dir);
}

export function buildQaLoopPrompt({ id, mission, contract, cycle, previous }) {
  return `You are running SKS QA-LOOP.\nMISSION: ${id}\nTASK: ${mission.prompt}\nCYCLE: ${cycle}\nNO QUESTIONS: use decision-contract.json and the decision ladder.\nUI E2E: if UI is in scope, prefer official Codex MCP/plugin tools. Use Browser Use first for local browser targets such as localhost, 127.0.0.1, file:// URLs, and current browser-tab inspection. Use Computer Use for desktop app interaction, screenshots, and browser/app evidence. If neither evidence path is available, mark UI not verified. Do not claim UI E2E from text logs alone.\nCREDENTIALS: use only test credentials already provided ephemerally or through the approved runtime source. If they are unavailable, mark authenticated checks blocked; never save login secrets, cookies, auth state, or screenshots containing secrets to files, Team transcript, reports, logs, or TriWiki.\nDEPLOYED SAFETY: deployed domains are read-only smoke only; never run destructive removal scenarios on deployed domains.\nEXTERNAL SAFETY: payment/billing, email/SMS/webhook sends, admin permission changes, and bulk writes are forbidden unless safely mocked/sandboxed by the sealed contract.\nARTIFACTS: check qa-ledger.json case by case, save bounded raw output under qa-loop/cycle-${cycle}/, refresh qa-report.md and qa-gate.json. Continue until qa-gate.json passes or a hard blocker is documented.\nDECISION CONTRACT:\n${JSON.stringify(contract, null, 2)}\nPrevious cycle tail:\n${String(previous || '').slice(-2500)}\n`;
}

export async function qaStatus(dir) {
  const gate = await readJson(path.join(dir, 'qa-gate.evaluated.json'), await readJson(path.join(dir, 'qa-gate.json'), null));
  const ledger = await readJson(path.join(dir, 'qa-ledger.json'), null);
  const report = await readText(path.join(dir, 'qa-report.md'), '');
  return { gate, checklist_count: ledger?.checklist?.length ?? null, report_written: Boolean(report.trim()) };
}

function qaChecklist(a) {
  const cases = [
    ['preflight.target', 'Confirm target URL, environment, and allowed mutation policy.'],
    ['preflight.safety', 'Block destructive, billing, email/SMS/webhook, admin, and bulk-write side effects outside local disposable data.'],
    ['preflight.auth', 'Confirm login requirement and ephemeral test credential handling without saving secrets.'],
    ['preflight.data', 'Identify seed data, cleanup limits, and rollback expectations.'],
    ['preflight.roles', 'Map user roles, permissions, and protected areas in scope.']
  ];
  if (isUiScope(a.QA_SCOPE)) cases.push(
    ['ui.official_mcp_tools', 'Use Browser Use for local browser targets and Computer Use for desktop/browser evidence, or mark UI not verified.'],
    ['ui.navigation', 'Check primary navigation, deep links, back/forward, refresh, and protected routes.'],
    ['ui.auth', 'Check login, logout, session expiry, unauthorized access, and role-specific visibility.'],
    ['ui.forms', 'Check required fields, validation, disabled states, optimistic UI, submit success, and submit failure.'],
    ['ui.states', 'Check loading, empty, error, retry, offline/timeout, and slow network states.'],
    ['ui.crud', 'Check allowed create/change flows and block forbidden destructive flows by environment.'],
    ['ui.responsive', 'Check desktop, tablet, mobile, overflow, long text, and keyboard focus order.'],
    ['ui.a11y', 'Check labels, focus traps, modals, contrast-sensitive controls, and screen-reader names.'],
    ['ui.visual', 'Capture evidence for meaningful UI regressions without storing secrets.']
  );
  if (isApiScope(a.QA_SCOPE)) cases.push(
    ['api.health', 'Check health/version/readiness endpoints when available.'],
    ['api.auth', 'Check anonymous, authenticated, expired, and wrong-role access.'],
    ['api.contract', 'Check status codes, response shape, headers, content type, and error format.'],
    ['api.validation', 'Check missing, malformed, boundary, duplicate, and over-limit payloads.'],
    ['api.listing', 'Check pagination, sorting, filters, search, and empty results.'],
    ['api.mutation', 'Check allowed seeded create/change and forbid deployed destructive flows.'],
    ['api.idempotency', 'Check retry/idempotency behavior for safe operations.'],
    ['api.concurrency', 'Check stale change, conflict, and double-submit behavior.'],
    ['api.failure', 'Check timeout, upstream error, rate-limit, and rollback-visible failure paths.'],
    ['api.security', 'Check CORS, auth headers, PII redaction, and permission boundaries.']
  );
  cases.push(['report.evidence', 'Record pass/fail/blocked/skipped with evidence path for every case.'], ['report.honest', 'Run Honest Mode: list passed checks, gaps, risks, and non-verified areas.']);
  return cases.map(([id, title]) => ({ id, title, status: 'pending', evidence: [] }));
}

function qaReportTemplate(mission, contract, checklist) {
  const a = contract.answers || {};
  return `# QA-LOOP Report\n\nMission: ${mission.id}\nTarget: ${a.TARGET_BASE_URL || 'unset'}\nScope: ${a.QA_SCOPE || 'unset'}\nEnvironment: ${a.TARGET_ENVIRONMENT || 'unset'}\n\n## Safety\n\n- Deployed destructive tests: never\n- Credentials: temp-only, never saved to artifacts or TriWiki\n- UI evidence: Browser Use or Computer Use evidence required when UI E2E is in scope\n\n## Checklist\n\n${checklist.map((item) => `- [ ] ${item.id}: ${item.title}`).join('\n')}\n\n## Findings\n\nTBD\n\n## Honest Mode\n\nTBD\n`;
}
