import { leanEngineeringCompactText, leanEngineeringLongText } from './lean-engineering-policy.js';
export { leanEngineeringCompactText, leanEngineeringLongText };
import { ALLOWED_REASONING_EFFORTS, FROM_CHAT_IMG_CHECKLIST_ARTIFACT, FROM_CHAT_IMG_COVERAGE_ARTIFACT, FROM_CHAT_IMG_QA_LOOP_ARTIFACT, FROM_CHAT_IMG_SOURCE_INVENTORY_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS, FROM_CHAT_IMG_VISUAL_MAP_ARTIFACT, FROM_CHAT_IMG_WORK_ORDER_ARTIFACT, RECOMMENDED_SKILLS, REFLECTION_SKILL_NAME, USAGE_TOPICS } from './routes/constants.js';
import { CODEX_APP_IMAGE_GENERATION_DOC_URL, CODEX_COMPUTER_USE_ONLY_POLICY, CODEX_IMAGEGEN_REQUIRED_POLICY, CODEX_WEB_VERIFICATION_POLICY, RESERVED_CODEX_PLUGIN_SKILL_NAMES } from './routes/evidence.js';
import { getdesignReferencePolicyText, imageUxReviewPipelinePolicyText } from './routes/design-policy.js';
import { PPT_PIPELINE_SKILL_ALLOWLIST, pptPipelineAllowlistPolicyText } from './routes/ppt-policy.js';
import { normalizeDollarSkillName, prefixKnownSksDollarReferences, sksPrefixedDollarCommand, sksPrefixedSkillName, unprefixedSksSkillName } from './routes/dollar-prefix.js';
import { classifyTaskProfile, looksLikeDatabaseWorkRequest, type TaskProfile } from './runtime/task-profile.js';
import { legacyCoreSkillNames } from './codex-native/core-skill-manifest.js';

export * from './routes/constants.js';
export * from './routes/design-policy.js';
export * from './routes/evidence.js';
export * from './routes/ppt-policy.js';
export * from './routes/dollar-prefix.js';

export interface PromptIntentScores {
  answerOnly: number;
  directWork: number;
  tinyDirectFix: number;
  research: number;
  db: number;
  superSearch: number;
  reasons: string[];
}

export interface NarutoRouteDecision {
  mode: 'none' | 'generic_naruto' | 'route_owned';
  required: boolean;
  route_id: string | null;
  task_profile: TaskProfile;
  reason: string;
  trivial: boolean;
  default_parallel: boolean;
}

export function looksLikeProblemSolvingRequest(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  const problemCue = /(문제|오류|에러|버그|고장|깨짐|실패|안\s*(?:됨|돼|되|나옴|보임|돌아|먹)|작동\s*안|해결|고쳐|수정|복구|troubleshoot|not\s+working|broken|bug|error|failure|fails?|crash|fix|repair|resolve|solve)/i.test(text);
  const actionCue = /(해줘|해달|해라|되게|찾아|검색|기반|수정|진행|apply|implement|fix|repair|resolve|solve|troubleshoot|patch|update|change)/i.test(text);
  return problemCue && actionCue;
}

export function solutionScoutPolicyText(prompt: any = '') {
  if (!looksLikeProblemSolvingRequest(prompt)) return '';
  return [
    'Solution Scout hook: this prompt looks like a problem-solving or repair request.',
    'Before code edits, run a short web search for similar error reports, bug fixes, docs notes, or prior resolution patterns using the concrete symptom, stack, package, and error text from the repo.',
    'Prefer primary sources and official docs for package/API behavior; use Context7 when the fix depends on a library, SDK, MCP, package manager, or generated documentation.',
    'Summarize the relevant external patterns in 2-3 bullets, then design the local SKS fix from current code/tests plus those patterns. Do not copy a workaround blindly.',
    'If web search is unavailable or the issue is fully local and trivial, state that the external-similarity search is unverified and continue from local evidence only.'
  ].join('\n');
}

export function dollarSkillName(commandOrId: any) {
  return normalizeDollarSkillName(commandOrId);
}

export function stripVisibleDecisionAnswerBlocks(value: any = '') {
  return stripNonAuthoritativeLiveChatBlocks(String(value || ''))
    .replace(/\s*\[(?=[^\]]*\b[A-Z][A-Z0-9_]{2,}\s*:)[^\]]{0,6000}\]\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripNonAuthoritativeLiveChatBlocks(value: any = '') {
  return String(value || '')
    .replace(/(?:^|\n)\s*[›>]\s*\[## Live Chat[\s\S]*?\]\s*(?=(?:이|이거|그리고|근데|계속|고쳐|수정|해결|Pane|pane|please|fix|also|and|$))/g, '\n')
    .replace(/(?:^|\n)\s*\[## Live Chat[\s\S]*?\]\s*(?=(?:이|이거|그리고|근데|계속|고쳐|수정|해결|Pane|pane|please|fix|also|and|$))/g, '\n')
    .replace(/^\s*-?\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+\S+\s+\[[^\]]+\]:.*$/gm, '')
    .replace(/^\s*## Live Chat\s*$/gm, '')
    .trim();
}

export function triwikiContextTracking(commandPrefix: any = 'sks') {
  const prefix = String(commandPrefix || 'sks');
  return {
    ssot: 'triwiki',
    default_pack: '.sneakoscope/wiki/context-pack.json',
    pack_command: `${prefix} wiki pack`,
    refresh_command: `${prefix} wiki refresh`,
    prune_command: `${prefix} wiki prune`,
    validate_command: `${prefix} wiki validate .sneakoscope/wiki/context-pack.json`,
    hydrate_policy: 'hydrate_by_id_hash_source_path_rgba_trig_coordinate',
    attention_policy: 'use_attention_use_first_for_fast_high_trust_recall_and_hydrate_attention_hydrate_first_before_risky_or_lower_trust_decisions',
    required_schema: 'sks.wiki-coordinate.v1+vx:sks.wiki-voxel.v1',
    selected_text_policy: 'selected_text_is_only_the_visible_slice',
    stack_current_docs: stackCurrentDocsPolicy(prefix),
    stage_policy: [
      'before_each_route_stage_read_relevant_context_pack',
      'require_latest_coordinate_plus_voxel_overlay_pack',
      'during_each_stage_hydrate_relevant_low_trust_claims_from_source',
      'after_new_findings_or_artifact_changes_refresh_or_pack',
      'before_each_handoff_validate_context_pack',
      'before_final_answer_recheck_relevant_wiki_claims_against_sources'
    ],
    required_for: ['every_work_stage', 'long_running_routes', 'subagent_handoffs', 'context_pressure', 'cross_turn_continuity']
  };
}


export function stackCurrentDocsPolicy(commandPrefix: any = 'sks') {
  const prefix = String(commandPrefix || 'sks');
  return {
    trigger: 'when_tech_stack_is_added_or_package_framework_runtime_version_changes',
    evidence_required: ['context7_resolve_library_id_and_query_docs', 'or_official_vendor_web_docs'],
    memory_path: '.sneakoscope/memory/q2_facts/stack-current-docs.md',
    refresh_command: `${prefix} wiki refresh`,
    validate_command: `${prefix} wiki validate .sneakoscope/wiki/context-pack.json`,
    priority: 'must_precede_coding_style_defaults',
    examples: [
      'Supabase hosted projects should prefer sb_publishable_ and sb_secret_ keys over legacy anon and service role keys when current docs apply.',
      'Next.js 16 deprecates the middleware file convention in favor of proxy.ts/proxy.js.',
      'Vercel Function duration limits, including the 300s default with Fluid Compute, are deployment constraints that must shape long-running server work.'
    ]
  };
}

export function stackCurrentDocsPolicyText(commandPrefix: any = 'sks') {
  const policy = stackCurrentDocsPolicy(commandPrefix);
  return `Stack current-docs policy: whenever project tech stack is added or a framework/package/runtime/platform version changes, fetch current docs with Context7 (resolve-library-id then query-docs) or official vendor web docs before coding, record the syntax/limits/security guidance as high-priority TriWiki claims in ${policy.memory_path}, run "${policy.refresh_command}", then "${policy.validate_command}". Treat these claims as higher priority than model-memory defaults. Examples include Supabase publishable/secret keys replacing legacy anon and service role guidance for hosted projects, Next.js 16 proxy.ts/proxy.js replacing the deprecated middleware file convention, avoiding stale webpack defaults when newer framework guidance says otherwise, and Vercel Function duration limits such as the 300s default under Fluid Compute.`;
}

export function triwikiContextTrackingText(commandPrefix: any = 'sks') {
  const ctx = triwikiContextTracking(commandPrefix);
  return `Context tracking SSOT: TriWiki. Use only the latest TriWiki pack shape at every work stage: ${ctx.required_schema}; coordinate-only legacy packs are invalid and must be refreshed before use. Read ${ctx.default_pack} before each route phase, consume attention.use_first as the compact high-trust recall set, hydrate attention.hydrate_first from source before risky or lower-trust decisions, refresh with "${ctx.refresh_command}" or "${ctx.pack_command}" after new findings/artifact changes, prune stale/oversized wiki state with "${ctx.prune_command}" when retention matters, and validate with "${ctx.validate_command}" before each handoff or final claim. Selected text is only the visible slice; non-selected claims remain hydratable by id, hash, source path, and RGBA/trig coordinate. Follow high-trust claims unless newer source evidence contradicts them; low-trust claims should trigger source/evidence hydration before implementation or final claims. ${stackCurrentDocsPolicyText(commandPrefix)}`;
}

export function triwikiStagePolicyText(commandPrefix: any = 'sks') {
  const ctx = triwikiContextTracking(commandPrefix);
  return [
    'TriWiki stage policy:',
    `- Before each route phase, read the relevant parts of ${ctx.default_pack} instead of relying on memory or a one-time initial summary; the pack must validate as ${ctx.required_schema}.`,
    '- Consume `attention.use_first` for the fastest high-trust context path; hydrate `attention.hydrate_first` from source before making risky, user-visible, or final claims.',
    `- If a TriWiki pack is coordinate-only or lacks voxel overlay metadata, run "${ctx.refresh_command}" or "${ctx.pack_command}" and do not use the legacy pack for pipeline decisions.`,
    '- During the phase, when a decision touches a wiki claim, hydrate low-trust or stale claims from their source path/hash/RGBA anchor before relying on them.',
    `- After new findings, changed artifacts, native agent results, debate conclusions, implementation changes, reviews, or blockers, run "${ctx.refresh_command}" or "${ctx.pack_command}" so later stages see the update.`,
    `- When package manifests, framework versions, runtime targets, MCPs, SDKs, DB clients, or deployment platforms change, add current official docs or Context7 evidence to ${stackCurrentDocsPolicy(commandPrefix).memory_path}, refresh/validate TriWiki, and make those claims the coding baseline.`,
    `- Before every handoff and before final output, run or require "${ctx.validate_command}" and re-check high-impact claims against current sources.`
  ].join('\n');
}

export function chatCaptureIntakeText() {
  return `From-Chat-IMG intake: explicit signal only. Select forensic visual effort. Treat uploads as chat screenshot plus originals. For web/browser/webapp targets, use the Codex Chrome Extension path first; for native Mac/non-web app surfaces, use Codex Computer Use visual inspection when available. List requirements first in source order, match regions to attachments with confidence, and write ${FROM_CHAT_IMG_WORK_ORDER_ARTIFACT}, ${FROM_CHAT_IMG_SOURCE_INVENTORY_ARTIFACT}, ${FROM_CHAT_IMG_VISUAL_MAP_ARTIFACT}, ${FROM_CHAT_IMG_COVERAGE_ARTIFACT}, ${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}, ${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}, and ${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}. ${CODEX_WEB_VERIFICATION_POLICY} ${CODEX_COMPUTER_USE_ONLY_POLICY} Preserve each visible customer request as source-bound text, account for every screenshot image region and separate attachment, map each item to work-order actions, perform the customer-request work, then run a scoped QA-LOOP over that exact work-order range before Naruto completion. Update checklist checkboxes as work proceeds until all boxes are checked, unresolved_items is empty, scoped_qa_loop_completed=true, QA unresolved findings are zero, and schema validation passes. ${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT} is temporary TriWiki-backed session context with expires_after_sessions=${FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS}, so it can be forgotten by retention after enough later sessions. Do not assume ordinary image prompts are chat captures.`;
}

export function noUnrequestedFallbackCodePolicyText() {
  return leanEngineeringCompactText();
}

export function outcomeRubricPolicyText() {
  return 'Outcome rubric: apply the Core Engineering Directive, then use Proof Field, route-gate, reflection, and Honest Mode evidence to judge goal fit, touched surface, verification, and escalation.';
}

export function speedLanePolicyText() {
  return 'Proof Field speed lane policy: after the intended write scope is known, run or mentally apply `sks proof-field scan --intent "<goal>" --changed <files>`. Fast lanes keep the parent-owned minimal patch, listed verification, TriWiki validate, and Honest Mode; DB, security, visual-forensic, unknown surface, broad changes, failed verification, or unsupported claims fail closed to the normal Naruto/Honest path.';
}

export function hasFromChatImgSignal(prompt: any = '') {
  return /(?:^|\s)\$?(?:sks-)?from-chat-img(?:\s|:|$)/i.test(String(prompt || ''));
}

export function looksLikeChatCaptureRequest(prompt: any = '') {
  const text = String(prompt || '');
  return hasFromChatImgSignal(text)
    && /(chat|conversation|message|messenger|kakao|slack|discord|whatsapp|채팅|대화|메신저|카톡|캡처|스크린샷)/i.test(text)
    && /(image|photo|screenshot|capture|attachment|attached|이미지|사진|첨부)/i.test(text)
    && /(client|customer|request|change|modify|fix|match|ocr|extract|text|work\s*order|고객사|클라이언트|요청|수정|변경|매칭|추출|글자|텍스트|작업|지시서)/i.test(text);
}

export const ROUTES = [
  {
    id: 'DFix',
    command: '$DFix',
    mode: 'DFIX',
    route: 'fast direct fix',
    description: 'Tiny simple direct edits such as copy, labels, typos, wording, spacing, colors, or clearly scoped one-line changes. Bypasses the general SKS pipeline and runs an ultralight, no-record task-list path.',
    requiredSkills: ['dfix'],
    lifecycle: ['micro_task_list', 'targeted_inspection', 'listed_edits_only', 'cheap_verification'],
    context7Policy: 'optional',
    reasoningPolicy: 'medium',
    stopGate: 'dfix-gate.json',
    cliEntrypoint: 'sks dfix',
    examples: ['$DFix 글자 색 바꿔줘', '$DFix README 오타 고쳐줘']
  },
  {
    id: 'Answer',
    command: '$Answer',
    mode: 'ANSWER',
    route: 'answer-only research',
    description: 'Answer questions without starting implementation. Uses TriWiki, web, Context7 when relevant, and Honest Mode fact-checking.',
    requiredSkills: ['answer', 'honest-mode'],
    lifecycle: ['intent_classification', 'triwiki_hydration', 'web_or_context7_evidence_when_needed', 'honest_fact_check', 'direct_answer'],
    context7Policy: 'if_external_docs',
    reasoningPolicy: 'medium',
    stopGate: 'none',
    coverageExemptReason: 'read-only answer route; never writes or modifies code/files',
    cliEntrypoint: 'implicit question route',
    codexAppOnly: true,
    codexAppOnlyReason: '$Answer has no direct CLI verb; it is only reachable as an implicit natural-language question route inside Codex App prompts',
    examples: ['이 파이프라인이 왜 이렇게 동작해?', 'What does this hook do?']
  },
  {
    id: 'SKS',
    command: '$SKS',
    mode: 'SKS',
    route: 'general SKS workflow',
    description: 'General Sneakoscope setup, help, status, and workflow routing.',
    requiredSkills: ['sks', 'prompt-pipeline', 'honest-mode'],
    lifecycle: ['skill_context', 'command_discovery_or_lightest_route', 'honest_mode'],
    context7Policy: 'optional',
    reasoningPolicy: 'medium',
    stopGate: 'honest_mode',
    coverageExemptReason: 'setup/help/status routing only; delegates any real work to the target route it dispatches to',
    cliEntrypoint: 'sks commands',
    codexAppOnly: true,
    codexAppOnlyReason: '$SKS itself has no direct CLI verb; `sks commands` is a related discovery command, not an invocation of $SKS. $SKS is only reachable as a Codex App prompt route',
    examples: ['$SKS show me available workflows']
  },
  {
    id: 'Planner',
    command: '$Plan',
    mode: 'PLAN',
    route: 'planning-only frontdoor',
    // 20차 P0-8: $Plan currently writes a fixed template (goal/scope/steps
    // headings) with no task-specific agent reasoning behind it — it is a
    // scaffold to fill in, not the "decision-complete planning" this used to
    // claim. Retracted rather than reimplemented as a real planning agent
    // (out of scope for this pass); implementation remains disallowed until
    // $Work runs the plan.
    description: 'Plan scaffold only: writes a fixed-template .sneakoscope/plans/<slug>.md (goal/scope/steps headings to fill in), not project-specific decision-complete planning. Keeps implementation disallowed until $Work runs the plan.',
    requiredSkills: ['plan', 'honest-mode'],
    lifecycle: ['plan_intake', 'scope_and_acceptance', 'write_plan_artifact', 'implementation_allowed_false', 'honest_mode'],
    context7Policy: 'if_external_docs',
    reasoningPolicy: 'high',
    stopGate: 'plan-only',
    cliEntrypoint: 'Codex App prompt route only: $Plan "task"',
    examples: ['$Plan "결제 모듈 리팩터"', '$Plan "settings polish without editing code"']
  },
  {
    id: 'Review',
    command: '$Review',
    mode: 'REVIEW',
    route: 'machine-first diff review',
    description: 'Review staged or selected diffs with machine evidence sorted above LLM opinion.',
    requiredSkills: ['review', 'honest-mode'],
    lifecycle: ['diff_collection', 'machine_checks', 'read_only_review_lenses', 'dedupe_findings', 'optional_one_fix_attempt', 'review_report'],
    context7Policy: 'optional',
    reasoningPolicy: 'high',
    stopGate: 'review-report.json',
    cliEntrypoint: 'sks review [--staged|--diff <ref>] [--fix] [--json]',
    examples: ['$Review', 'sks review --staged']
  },
  {
    id: 'FastMode',
    command: '$Fast-Mode',
    mode: 'FAST_MODE',
    route: 'fast-mode toggle',
    description: 'Turn the SKS Fast mode default on or off for project-local dollar-command and routed workflows. Explicit --fast, --no-fast, and --service-tier flags still override it.',
    requiredSkills: ['fast-mode', 'honest-mode'],
    dollarAliases: ['$Fast-On', '$Fast-Off'],
    appSkillAliases: ['fast-on', 'fast-off'],
    lifecycle: ['project_state_toggle', 'policy_status', 'honest_mode'],
    context7Policy: 'not_required',
    reasoningPolicy: 'low',
    stopGate: 'none',
    coverageExemptReason: 'single boolean project-config toggle, not a code-changing work order',
    cliEntrypoint: 'sks fast-mode on|off|status|clear [--json]',
    examples: ['$Fast-On', '$Fast-Off', '$Fast-Mode status']
  },
  {
    id: 'LocalModel',
    command: '$with-local-llm-on',
    mode: 'LOCAL_MODEL',
    route: 'local Ollama worker toggle',
    description: 'Turn the optional local Ollama worker backend on or off. Default off keeps SKS GPT-only; enabled mode lets eligible simple code/collection worker slices use Ollama while GPT/Codex owns strategy, design, review, verification, and integration.',
    requiredSkills: ['with-local-llm-on', 'honest-mode'],
    dollarAliases: ['$with-local-llm-off'],
    appSkillAliases: ['with-local-llm-off'],
    lifecycle: ['global_local_model_toggle', 'worker_only_policy_status', 'honest_mode'],
    context7Policy: 'not_required',
    reasoningPolicy: 'low',
    stopGate: 'none',
    coverageExemptReason: 'single boolean project-config toggle, not a code-changing work order',
    cliEntrypoint: 'sks with-local-llm on|off|status|set-model [--json]',
    examples: ['$with-local-llm-on', '$with-local-llm-off', 'sks with-local-llm status --json']
  },
  {
    id: 'Naruto',
    command: '$Naruto',
    mode: 'NARUTO',
    route: 'Codex official subagent workflow',
    description: '$Naruto prepares a lightweight Codex official subagent workflow. The Sol Max parent owns decomposition, delegates only defensible direct-child slices, reuses bounded query-aware TriWiki attention anchors, waits for every requested thread, integrates the results, and reports scoped verification. Automatic fan-out starts at four for bounded work, six for explicit parallel work, and eight for large-scale work, may expand up to twelve while independent useful slices and healthy host capacity remain, then is capped dynamically by ready DAG width, disjoint ownership, verifier/tool capacity, reserved thread slots, and positive marginal usefulness; explicit --agents remains authoritative.',
    requiredSkills: ['naruto', 'pipeline-runner', 'prompt-pipeline', 'honest-mode'],
    dollarAliases: ['$Work'],
    appSkillAliases: ['work', 'from-chat-img'],
    lifecycle: ['task_profile', 'subagent_plan', 'official_delegation_context', 'subagent_events', 'parent_integration', 'scoped_verification', 'honest_mode'],
    context7Policy: 'optional',
    reasoningPolicy: 'high',
    stopGate: 'naruto-gate.json',
    coverage_required: true,
    cliEntrypoint: 'sks naruto run "task" [--agents N] [--max-threads N] [--trusted-project] | sks naruto status|subagents|proof | sks naruto parent-summary --mission M-... --stdin',
    examples: ['$Naruto run review twelve independent packages with --agents 12', '$Work']
  },
  {
    id: 'ReleaseReview',
    command: '$Release-Review',
    mode: 'RELEASE_REVIEW',
    route: 'official subagent release review',
    description: 'Run release-readiness collaboration through official Codex subagents with explicit thread budget, disjoint ownership, parent integration, scoped verification, and cleanup evidence.',
    requiredSkills: ['release-review', 'naruto', 'pipeline-runner', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['subagent_plan', 'release_fixture_matrix', 'risk_scoped_review', 'parent_integration', 'session_cleanup', 'honest_mode'],
    context7Policy: 'optional',
    reasoningPolicy: 'high',
    stopGate: 'release-readiness-report.json',
    cliEntrypoint: 'sks naruto run "$Release-Review release audit" --agents <n> --read-only --json',
    examples: ['$Release-Review agents:10 release audit', 'sks naruto run "$Release-Review wide release audit" --agents 10 --read-only --json']
  },
  {
    id: 'QALoop',
    command: '$QA-LOOP',
    mode: 'QALOOP',
    route: 'QA loop',
    description: 'Dogfood UI/API as human proxy with safety gates, Codex Chrome Extension-first web UI evidence, safe fixes, rechecks, Honest Mode.',
    requiredSkills: ['qa-loop', 'pipeline-runner', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['qa_questions_answered', 'contract_sealed', 'qa_checklist', 'qa_loop_cycles', 'safe_remediation', 'focused_reverification', 'qa_report_md', 'qa_gate', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'optional',
    reasoningPolicy: 'high',
    stopGate: 'qa-gate.json',
    cliEntrypoint: 'sks qa-loop prepare|answer|run|status',
    examples: ['$QA-LOOP dogfood UI and API against local dev', '$QA-LOOP deployed smoke only']
  },
  {
    id: 'PPT',
    command: '$PPT',
    mode: 'PPT',
    route: 'HTML/PDF presentation pipeline',
    description: 'Create restrained, information-first HTML/PDF presentation artifacts after delivery context, audience profile, STP, decision context, pain-point, research, design-system, and verification questions are sealed.',
    requiredSkills: [...PPT_PIPELINE_SKILL_ALLOWLIST],
    lifecycle: ['stp_audience_questions', 'audience_strategy_artifact', 'contract_sealed', 'source_ledger', 'storyboard_aha_moments', 'design_system', 'html_artifact', 'pdf_export', 'render_qa', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'if_external_docs',
    reasoningPolicy: 'high',
    stopGate: 'ppt-gate.json',
    cliEntrypoint: 'Codex App prompt route only: $PPT <topic>',
    examples: ['$PPT 우리 SaaS 소개자료를 HTML 기반 PDF로 만들어줘', '$PPT 투자자용 피치덱 만들어줘']
  },
  {
    id: 'ImageUXReview',
    command: '$Image-UX-Review',
    mode: 'IMAGE_UX_REVIEW',
    route: 'image-generation UI/UX review loop',
    description: 'Review UI/UX through the imagegen/gpt-image-2 visual critique loop: source screenshots become generated annotated review images, those images become issue ledgers, then fixes are rechecked.',
    requiredSkills: ['image-ux-review', 'imagegen', 'cu', 'pipeline-runner', REFLECTION_SKILL_NAME, 'honest-mode'],
    hiddenDollarAliases: ['$UX-Review', '$Visual-Review', '$UI-UX-Review'],
    lifecycle: ['target_and_capture_inventory', 'source_screenshots', 'gpt_image_2_annotated_review_image', 'generated_image_text_extraction', 'issue_ledger', 'optional_safe_fixes', 'changed_screen_recheck', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'if_external_docs',
    reasoningPolicy: 'high',
    stopGate: 'image-ux-review-gate.json',
    cliEntrypoint: 'sks ux-review run --image <path> --fix --json | sks ux-review callouts --image <path> --json | sks ux-review extract-issues --generated-image <path> --json | sks ux-review fix|recapture|recheck|status latest --json',
    examples: ['$Image-UX-Review localhost 화면을 이미지 생성 리뷰 루프로 검수해줘', '$UX-Review 이 스크린샷을 gpt-image-2 콜아웃 리뷰로 분석하고 고쳐줘']
  },
  {
    id: 'ComputerUse',
    command: '$Computer-Use',
    mode: 'COMPUTER_USE',
    route: 'native Computer Use fast lane',
    description: 'Maximum-speed Codex Computer Use lane for native macOS, desktop-app, OS-settings, and non-web visual tasks only. Browser, localhost, website, webapp, and web-based app verification must route through Codex Chrome Extension readiness first.',
    requiredSkills: ['cu', 'honest-mode'],
    dollarAliases: ['$CU'],
    appSkillAliases: ['computer-use-fast', 'cu'],
    lifecycle: ['fast_intake', 'focused_computer_use_steps', 'evidence_summary', 'final_triwiki_refresh_validate', 'honest_mode'],
    context7Policy: 'optional',
    reasoningPolicy: 'low',
    stopGate: 'computer-use-gate.json',
    cliEntrypoint: 'Codex App prompt route only: $Computer-Use <target/task>',
    examples: ['$Computer-Use inspect this native Mac settings dialog', '$CU set up the local desktop app permission prompt']
  },
  {
    id: 'Goal',
    command: '$Goal',
    mode: 'GOAL',
    route: 'Codex native /goal control',
    description: 'Use Codex native Goal directly with a detailed outcome, scope, constraints, verification, completion conditions, stop conditions, and non-goals. SKS writes no Goal state.',
    requiredSkills: ['goal'],
    lifecycle: ['native_goal_create_or_control'],
    context7Policy: 'not_required',
    reasoningPolicy: 'low',
    stopGate: 'none',
    coverage_required: false,
    coverageExemptReason: 'Goal creation and lifecycle are owned entirely by Codex native /goal; SKS creates no route mission or evidence artifacts.',
    cliEntrypoint: 'Codex native /goal; sks goal is a stateless command-rendering compatibility helper only',
    examples: ['$Goal define a measurable migration outcome and completion criteria']
  },
  {
    id: 'Commit',
    command: '$Commit',
    mode: 'COMMIT',
    route: 'simple git commit',
    description: 'Summarize current git changes, stage them, and create one commit without the full SKS pipeline.',
    requiredSkills: ['commit', 'honest-mode'],
    lifecycle: ['git_status_summary', 'git_add_all', 'git_commit', 'short_result'],
    context7Policy: 'not_required',
    reasoningPolicy: 'low',
    stopGate: 'none',
    coverageExemptReason: 'packages already-made changes into one commit; does not itself decide what work to do',
    cliEntrypoint: 'sks commit [--message "msg"] [--json]',
    examples: ['$Commit 이번 작업 커밋해줘']
  },
  {
    id: 'CommitAndPush',
    command: '$Commit-And-Push',
    mode: 'COMMIT_AND_PUSH',
    route: 'simple git commit and push',
    description: 'Summarize current git changes, stage them, create one commit, then run git push without the full SKS pipeline.',
    requiredSkills: ['commit-and-push', 'honest-mode'],
    lifecycle: ['git_status_summary', 'git_add_all', 'git_commit', 'git_push', 'short_result'],
    context7Policy: 'not_required',
    reasoningPolicy: 'low',
    stopGate: 'none',
    coverageExemptReason: 'packages already-made changes into one commit and pushes; does not itself decide what work to do',
    cliEntrypoint: 'sks commit-and-push [--message "msg"] [--json]',
    examples: ['$Commit-And-Push 커밋하고 바로 푸쉬해줘']
  },
  {
    id: 'Research',
    command: '$Research',
    mode: 'RESEARCH',
    route: 'research mission',
    description: 'Frontier discovery with named xhigh persona-lens agents, Eureka ideas, vigorous evidence-bound debate, layered public source retrieval, falsification, a paper manuscript, a final genius-opinion summary, and testable predictions.',
    requiredSkills: ['research', 'pipeline-runner', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['research_plan', 'source_skill', 'layered_source_ledger', 'xhigh_agent_council', 'eureka_moments', 'debate_ledger', 'report', 'paper', 'genius_opinion_summary', 'novelty_ledger', 'falsification_ledger', 'research_gate', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'if_external_docs',
    reasoningPolicy: 'xhigh',
    stopGate: 'research-gate.json',
    cliEntrypoint: 'sks research prepare|run',
    examples: ['$Research investigate this idea']
  },
  {
    id: 'SuperSearch',
    command: '$Super-Search',
    mode: 'SUPER_SEARCH',
    route: 'provider-independent source intelligence',
    description: 'Run Super-Search source acquisition, source normalization, claim/proof ledgers, and provider-independent citation evidence without requiring provider-specific credentials.',
    requiredSkills: ['super-search', 'pipeline-runner', 'context7-docs', 'honest-mode'],
    appSkillAliases: ['super-search'],
    lifecycle: ['source_intent', 'query_variants', 'provider_plan', 'source_ledgers', 'claim_ledgers', 'super_search_gate', 'honest_mode'],
    context7Policy: 'if_external_docs',
    reasoningPolicy: 'high',
    stopGate: 'super-search/super-search-gate.json',
    cliEntrypoint: 'sks super-search doctor|run|x|fetch|status|inspect|sources|claims|cache|bench',
    examples: ['$Super-Search run "current package release notes"', '$Super-Search x "site:x.com product launch"']
  },
  {
    id: 'SEOGEOOptimizer',
    command: '$SEO-GEO-OPTIMIZER',
    mode: 'SEO_GEO_OPTIMIZER',
    route: 'search visibility optimization audit/apply/verify',
    description: 'Unified SEO/GEO optimizer route for Search Engine Optimization and Generative Engine Optimization. Uses one shared kernel with mode-specific evidence, gates, safe apply, rollback, and Completion Proof. Not a ranking, traffic, or AI citation guarantee.',
    requiredSkills: ['seo-geo-optimizer', 'search-visibility-core', 'pipeline-runner', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['doctor', 'read_only_audit', 'mode_specific_evidence', 'marketing_research', 'source_backed_strategy', 'marketing_truthfulness_gate', 'mutation_plan', 'marketing_mutation_plan', 'explicit_apply_only', 'rollback_manifest', 'source_verify', 'seo_or_geo_gate', 'completion_proof', 'honest_mode'],
    context7Policy: 'if_external_docs',
    reasoningPolicy: 'high',
    stopGate: 'seo-gate.json|geo-gate.json',
    cliEntrypoint: 'sks seo-geo-optimizer doctor|audit|research|strategy|plan|apply|verify|status|rollback|fixture --mode seo|geo [--include-marketing]',
    examples: ['$SEO-GEO-OPTIMIZER audit this site', 'sks seo-geo-optimizer audit --mode seo --target package --json', 'sks seo-geo-optimizer research --offline --json', 'sks seo-geo-optimizer strategy latest --json', 'sks seo-geo-optimizer plan latest --mode seo --include-marketing --json', 'sks seo-geo-optimizer apply latest --mode seo --include-marketing --apply --json', 'sks seo-geo-optimizer apply latest --mode geo --include-llms-txt --apply']
  },
  {
    id: 'AutoResearch',
    command: '$AutoResearch',
    mode: 'AUTORESEARCH',
    route: 'iterative experiment loop',
    description: 'Program, hypothesize, test, measure, keep/discard, falsify, and report evidence.',
    requiredSkills: ['autoresearch', 'autoresearch-loop', 'performance-evaluator', 'pipeline-runner', 'context7-docs', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['experiment_ledger', 'metric', 'keep_or_discard', 'falsification', 'post_route_reflection', 'honest_conclusion'],
    context7Policy: 'required',
    reasoningPolicy: 'xhigh',
    stopGate: 'research-gate.json',
    cliEntrypoint: 'sks pipeline status',
    examples: ['$AutoResearch improve this workflow with experiments']
  },
  {
    id: 'DB',
    command: '$DB',
    mode: 'DB',
    route: 'database safety',
    description: 'Database, Supabase, migration, SQL, or MCP safety checks with canonical data-access, pool lifecycle, query-efficiency, and transaction-integrity evidence.',
    requiredSkills: ['db', 'db-safety-guard', 'pipeline-runner', 'context7-docs', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['db_scan', 'canonical_db_access_scan', 'pool_lifecycle_review', 'n_plus_one_review', 'transaction_integrity_review', 'manual_sql_or_mad_sks_sql_plane', 'safe_mcp_policy', 'destructive_operation_zero', 'context7_docs', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'high',
    stopGate: 'db-review.json',
    cliEntrypoint: 'Codex App prompt route only',
    codexAppOnly: true,
    codexAppOnlyReason: '$DB is a route-level safety policy and has no standalone CLI command.',
    examples: ['$DB check this migration safely']
  },
  {
    id: 'MadSKS',
    command: '$MAD-SKS',
    mode: 'MADSKS',
    route: 'explicit scoped permission-widening modifier plus SQL-plane execution',
    description: 'Explicit high-risk authorization modifier that can be combined with other $ commands to temporarily open approved target-project scopes such as files, shell, package installs, services, network, Computer Use/browser workflows, generated assets, file permissions, migrations, Supabase MCP DB writes, direct execute SQL, schema cleanup, and normal targeted DB writes for the active invocation. Its SQL-plane executor authorizes CREATE, ALTER, table/schema DROP, column add/drop/rename, INSERT, UPDATE, DELETE including all-row mutations, TRUNCATE, execute_sql, and apply_migration only for the bound Supabase project, keeps Supabase project/account/billing/credential control-plane actions denied, and requires tool-result plus read-back proof and final read-only restoration.',
    requiredSkills: ['mad-sks', 'db-safety-guard', 'pipeline-runner', 'context7-docs', REFLECTION_SKILL_NAME, 'honest-mode'],
    appSkillAliases: ['mad-sks'],
    lifecycle: ['explicit_invocation', 'auto_sealed_permission_scope', 'single_mission_capability_v2', 'ephemeral_write_profile', 'tool_inventory', 'scoped_permission_override', 'catastrophic_guard', 'execute_sql_or_apply_migration', 'read_back_verification', 'close_and_read_only_restore', 'permission_deactivation', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'xhigh',
    stopGate: 'mad-sks-gate.json',
    cliEntrypoint: 'sks mad-sks plan|run|apply|sql|apply-migration|status|close|rollback-apply',
    examples: ['$MAD-SKS $Naruto target project maintenance with package/service/file and DB scopes', '$DB Supabase 점검 $MAD-SKS']
  },
  {
    id: 'GX',
    command: '$GX',
    mode: 'GX',
    route: 'visual context',
    description: 'Deterministic GX visual context cartridges.',
    requiredSkills: ['gx', 'gx-visual-generate', 'gx-visual-read', 'gx-visual-validate', 'pipeline-runner', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['vgraph_beta_render', 'validate', 'drift_snapshot', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'high',
    stopGate: 'gx-gate.json',
    cliEntrypoint: 'sks gx init|render|validate|drift|snapshot',
    examples: ['$GX render a visual context cartridge']
  },
  {
    id: 'Wiki',
    command: '$Wiki',
    mode: 'WIKI',
    route: 'TriWiki refresh and maintenance',
    description: 'Refresh, pack, validate, or prune TriWiki context packs from Codex App.',
    requiredSkills: ['wiki', 'sks', 'honest-mode'],
    lifecycle: ['intent_classification', 'wiki_refresh_or_pack', 'wiki_validate', 'honest_mode'],
    context7Policy: 'optional',
    reasoningPolicy: 'medium',
    stopGate: 'none',
    coverageExemptReason: 'single fixed maintenance action (refresh/pack/validate/prune), not a free-form work order',
    cliEntrypoint: 'sks wiki refresh|pack|validate|prune',
    examples: ['$Wiki refresh', '$Wiki prune and validate']
  },
  {
    id: 'Align',
    command: '$Align',
    mode: 'ALIGN',
    route: 'evidence-gated GPT-5.6 / Plugins modernization',
    description: 'One-shot modernization of SKS prompts, settings, and generated skill/command surfaces against current GPT-5.6 prompting, programmatic tool calling, Agents, Codex skill-schema, and Plugins contracts. It records adoption decisions, audits complete surface coverage, removes superseded compatibility settings, and deduplicates policy without weakening invariants.',
    requiredSkills: ['align', 'pipeline-runner', 'prompt-pipeline', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['align_plan', 'latest_model_prompt_grammar', 'programmatic_tool_calling', 'agents_guidance', 'codex_skills_and_plugins', 'latest_only_cleanup', 'deduplicate_prompt_config', 'align_ledger', 'align_gate', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'if_external_docs',
    reasoningPolicy: 'high',
    stopGate: 'align-gate.json',
    coverage_required: true,
    cliEntrypoint: 'sks align prepare|run|status|proof',
    examples: ['$Align modernize SKS skills to latest GPT-5.6', 'sks align prepare --json', 'sks align run "prompts and skills"']
  },
  {
    id: 'Help',
    command: '$Help',
    mode: 'HELP',
    route: 'command help',
    description: 'Explain installed SKS commands and workflows.',
    requiredSkills: ['help', 'prompt-pipeline'],
    lifecycle: ['skill_context', 'discovery_output'],
    context7Policy: 'optional',
    reasoningPolicy: 'medium',
    stopGate: 'none',
    coverageExemptReason: 'read-only help/discovery output; never writes or modifies code/files',
    cliEntrypoint: 'sks help',
    examples: ['$Help show available SKS commands']
  }
];

for (const route of ROUTES as any[]) {
  if (Array.isArray(route.requiredSkills)) {
    route.requiredSkills = Array.from(new Set(route.requiredSkills.map((name: any) => sksPrefixedSkillName(name))));
  }
}

export function legacyRouteAppSkillNames(route: any) {
  const canonical = dollarSkillName(route.command);
  const reserved = new Set(RESERVED_CODEX_PLUGIN_SKILL_NAMES);
  return Array.from(new Set([canonical, ...(route.appSkillAliases || [])].filter((name: any) => !reserved.has(name))));
}

export function routeAppSkillNames(route: any) {
  return Array.from(new Set(legacyRouteAppSkillNames(route).map((name: any) => sksPrefixedSkillName(name))));
}

export const LEGACY_DOLLAR_COMMAND_NAMES = Array.from(new Set(ROUTES
  .filter((route: any) => route.hidden !== true)
  .flatMap((route: any) => [route.command, ...(route.dollarAliases || [])])));
export const LEGACY_DOLLAR_SKILL_NAMES = Array.from(new Set(ROUTES.flatMap((route: any) => legacyRouteAppSkillNames(route))));
export const DOLLAR_SKILL_NAMES = Array.from(new Set(ROUTES.flatMap((route: any) => routeAppSkillNames(route))));
const PACKAGED_MANAGED_SUPPORT_SKILL_NAMES = [
  'sks-autoresearch-loop',
  'sks-context7-docs',
  'sks-db-safety-guard',
  'sks-design-artifact-expert',
  'sks-design-system-builder',
  'sks-design-ui-editor',
  'sks-from-chat-img',
  'sks-getdesign-reference',
  'sks-gx-visual-generate',
  'sks-gx-visual-read',
  'sks-gx-visual-validate',
  'sks-honest-mode',
  'sks-hproof-claim-ledger',
  'sks-hproof-evidence-bind',
  'sks-imagegen',
  'sks-imagegen-source-scout',
  'sks-performance-evaluator',
  'sks-pipeline-runner',
  'sks-prompt-pipeline',
  'sks-reasoning-router',
  'sks-reflection',
  'sks-solution-scout',
  'sks-turbo-context-pack'
];
export const MANAGED_ROUTE_SKILL_NAMES = Array.from(new Set([
  ...DOLLAR_SKILL_NAMES,
  ...RECOMMENDED_SKILLS,
  ...PACKAGED_MANAGED_SUPPORT_SKILL_NAMES,
  ...legacyCoreSkillNames().map((name) => sksPrefixedSkillName(name)),
  ...ROUTES.flatMap((route: any) => Array.isArray(route.requiredSkills) ? route.requiredSkills : [])
]));
export const INVALID_EXPLICIT_MANAGED_SKILL_NAME = 'sks-invalid-explicit-managed-skill';
const LEGACY_DOLLAR_REFERENCE_NAMES = Array.from(new Set([
  ...LEGACY_DOLLAR_SKILL_NAMES,
  ...LEGACY_DOLLAR_COMMAND_NAMES.map((command: any) => normalizeDollarSkillName(command)),
  'from-chat-img'
]));
export const DOLLAR_COMMANDS = ROUTES.filter((route: any) => route.hidden !== true).flatMap(({ command, route, description, dollarAliases = [] }: any) => [
  {
    command: sksPrefixedDollarCommand(command),
    route,
    description: prefixKnownSksDollarReferences(description, LEGACY_DOLLAR_REFERENCE_NAMES)
  },
  ...dollarAliases.map((alias: any) => ({
    command: sksPrefixedDollarCommand(alias),
    route,
    description: prefixKnownSksDollarReferences(description, LEGACY_DOLLAR_REFERENCE_NAMES)
  }))
]);
export const DOLLAR_COMMAND_ALIASES = ROUTES.flatMap((route: any) => [
  ...routeAppSkillNames(route).map((alias: any) => ({ canonical: sksPrefixedDollarCommand(route.command), app_skill: `$${alias}` }))
]);

const MANAGED_ROUTE_SKILL_NAME_SET = new Set(MANAGED_ROUTE_SKILL_NAMES);

const ROUTE_BY_ID = new Map<string, any>();
const ROUTE_BY_DOLLAR_COMMAND = new Map<string, any>();

for (const route of ROUTES as any[]) {
  for (const key of [route.id, route.mode, dollarSkillName(route.command), ...(route.appSkillAliases || [])]) {
    if (key) ROUTE_BY_ID.set(String(key).toLowerCase(), route);
  }
  for (const key of [
    dollarSkillName(route.command),
    ...(route.dollarAliases || []).map((alias: any) => dollarSkillName(alias)),
    ...(route.hiddenDollarAliases || []).map((alias: any) => dollarSkillName(alias)),
    ...(route.appSkillAliases || []),
    ...routeAppSkillNames(route)
  ]) {
    if (key) ROUTE_BY_DOLLAR_COMMAND.set(String(key).toLowerCase(), route);
  }
}

ROUTE_BY_DOLLAR_COMMAND.set('from-chat-img', ROUTE_BY_ID.get('naruto'));
ROUTE_BY_DOLLAR_COMMAND.set('sks-from-chat-img', ROUTE_BY_ID.get('naruto'));
ROUTE_BY_DOLLAR_COMMAND.set('work', ROUTE_BY_ID.get('naruto'));
ROUTE_BY_DOLLAR_COMMAND.set('plan', ROUTE_BY_ID.get('planner'));

export const COMMAND_CATALOG = [
  { name: 'help', usage: 'sks help [topic]', description: 'Show CLI help or focused help for a topic.' },
  { name: 'version', usage: 'sks version | sks --version', description: 'Print the installed Sneakoscope Codex version.' },
  { name: 'update-check', usage: 'sks update-check [--json]', description: 'Refresh the shared update-status.v3 snapshot.' },
  { name: 'mcp', usage: 'sks mcp config list|get|add|edit|duplicate|enable|disable|remove|test|login|logout|backups|restore [--scope global|project|effective] [--stdin-json] [--json]', description: 'Manage global/project MCP configuration through the shared guarded MCP Config Domain v2.' },
  { name: 'wizard', usage: 'sks wizard', description: 'Open an interactive setup UI for install scope, setup, doctor, and verification.' },
  { name: 'commands', usage: 'sks commands [--json]', description: 'List every user-facing command with a short description.' },
  { name: 'check', usage: 'sks check --tier instant|affected|confidence|release|real-check [--sla 5m] [--changed-since auto] [--json]', description: 'Run build-once proof-bank checks: affected/confidence use incremental build and cached proof reuse; release keeps full clean proof for publish readiness.' },
  { name: 'task', usage: 'sks task run [--sla 5m] [--json]', description: 'Run the normal affected-scope, release-equivalent task verification path.' },
  { name: 'release', usage: 'sks release affected|full|background|stage [--json]', description: 'Run affected release proof, full release proof, or background release proof explicitly, or drive the staged npm publish up to the human approval step.' },
  { name: 'triwiki', usage: 'sks triwiki index|affected|proof-bank [--json]', description: 'Inspect TriWiki module cards, gate impact maps, affected graphs, and proof bank status.' },
  { name: 'daemon', usage: 'sks daemon status|warm|stop [--json]', description: 'Inspect or warm the local SKS daemon cache state for build/proof reuse.' },
  { name: 'run', usage: 'sks run "task" [--visual|--research|--db] [--json]', description: 'Classify a plain-language task, materialize a mission, and route it through the SKS trust kernel.' },
  { name: 'plan', usage: 'sks plan "task" [--json]', description: 'Write a planning-only artifact under .sneakoscope/plans without editing code.' },
  { name: 'status', usage: 'sks status [--json]', description: 'Show the active mission, route, phase, proof, trust, official-subagent evidence, image voxel, DB safety, and next action.' },
  { name: 'review', usage: 'sks review [--staged|--diff <ref>] [--fix] [--json]', description: 'Review a diff with machine-evidence findings sorted above LLM review notes.' },
  { name: 'usage', usage: `sks usage [${USAGE_TOPICS}]`, description: 'Print copy-ready workflows for common tasks.' },
  { name: 'quickstart', usage: 'sks quickstart', description: 'Show the shortest safe setup and verification flow.' },
  { name: 'bootstrap', usage: 'sks bootstrap [--install-scope global|project] [--local-only] [--json]', description: 'Initialize the current project, install SKS Codex App files/skills, check Context7/Codex App/Zellij, and print ready true/false.' },
  { name: 'root', usage: 'sks root [--json]', description: 'Show whether SKS is using a project root or the per-user global SKS runtime root.' },
  { name: 'update', usage: 'sks update status|check|review|now|rollback [--refresh] [--version <version>] [--json] [--dry-run]', description: 'Inspect update-status.v3, review the exact staged operation, update the global package, or run guarded rollback.' },
  { name: 'uninstall', usage: 'sks uninstall [--dry-run] [--yes] [--keep-config] [--keep-data] [--purge-projects] [--json]', description: 'Remove SKS global skills, hooks, menu bar, state, temp files, and optional project residue while preserving user-owned content by default.' },
  { name: 'deps', usage: 'sks deps check [--json] [--yes]', description: 'Check Node/npm, Codex CLI, and Zellij readiness; pass --yes to repair missing Codex CLI/Zellij tooling when supported.' },
  { name: 'codex', usage: 'sks codex compatibility|version|update-status [--refresh]|update|doctor|schema|0.144 [--json]', description: 'Check Codex CLI compatibility/version/update status, run the official `codex update`, and inspect current manifest, capability, and hook-schema evidence.' },
  { name: 'codex-app', usage: 'sks codex-app [check|set-openrouter-key --api-key-stdin|use-openrouter --model <id>|openrouter-status|product-design|chrome-extension|pat status|remote-control]', description: 'Check Codex App install, OpenRouter provider activation, codex-lb key-entry guidance, Product Design plugin readiness, Codex Chrome Extension web verification readiness, PAT-safe status, first-party MCP/plugin readiness, and Codex CLI remote-control availability.' },
  { name: 'codex-native', usage: 'sks codex-native status|feature-broker|invocation-plan|init-deep [--json]', description: 'Inspect Codex Native feature broker readiness, invocation routing, pattern evidence, and managed memory setup.' },
  { name: 'hooks', usage: 'sks hooks explain|status|trust-report|replay|codex-validate|warning-check ... [--json]', description: 'Explain Codex hook events, validate vendored latest 10-event output schemas, replay fixtures, and enforce warning-zero SKS hook policies under the 0.134 compatibility matrix.' },
  { name: 'codex-lb', usage: 'sks codex-lb status|health|metrics|doctor|circuit|repair|setup ...', description: 'Configure, health-check, repair, and record circuit evidence for codex-lb provider auth without confusing ChatGPT OAuth and proxy keys.' },
  { name: 'remote', usage: 'sks remote readiness|machines|worker ... [--json]', description: 'Inspect official Codex Remote readiness and the allowlisted proof-aware SSH stdio worker surface.' },
  { name: 'zellij', usage: 'sks zellij status|repair [--json] | sks --mad', description: 'Inspect Zellij runtime status, explain repair (no auto-install), and open the SKS Zellij runtime used by MAD. Zellij panes are not official Naruto subagent evidence.' },
  { name: 'mad-sks', usage: 'sks mad-sks plan|run|apply|sql|apply-migration|status|close|rollback-apply ... | sks --mad [--high]', description: 'Open or inspect MAD-SKS scoped permission workflows, merged SQL-plane execution, and the Zellij permission launcher.' },
  { name: 'auto-review', usage: 'sks auto-review status|enable|start [--high] | sks --Auto-review --high', description: 'Enable Codex automatic approval review and launch SKS Zellij with the auto-review profile.' },
  { name: 'dollar-commands', usage: 'sks dollar-commands [--json]', description: 'List Codex App $ commands such as $sks-dfix and $sks-naruto.' },
  { name: 'fast-mode', usage: 'sks fast-mode on|off|status|clear [--project] [--json]', description: 'Toggle the global Codex Desktop GPT-5.6 Fast default used by $sks-fast-on/$sks-fast-off and keep project worker preference in sync; pass --project for project-local only.' },
  { name: 'with-local-llm', usage: 'sks with-local-llm on|off|status|set-model [--json]', description: 'Toggle the optional local Ollama worker backend used by $sks-with-local-llm-on/$sks-with-local-llm-off and eligible simple worker slices.' },
  { name: 'commit', usage: 'sks commit [--message "msg"] [--json]', description: 'Stage current changes, summarize them, and create a simple git commit without the full SKS pipeline.' },
  { name: 'commit-and-push', usage: 'sks commit-and-push [--message "msg"] [--json]', description: 'Stage current changes, create a simple git commit, and push without the full SKS pipeline.' },
  { name: 'dfix', usage: 'sks dfix', description: 'Explain $sks-dfix ultralight direct-fix mode.' },
  { name: 'qa-loop', usage: 'sks qa-loop prepare|answer|run|status ...', description: 'Dogfood UI/API as human proxy with safety gates, safe fixes, rechecks, Codex Chrome Extension-first web UI evidence, report.' },
  { name: 'ppt', usage: 'sks ppt build|status <mission-id|latest> [--json]', description: 'Build or inspect $sks-ppt HTML/PDF artifacts from a sealed presentation decision contract.' },
  { name: 'image-ux-review', usage: 'sks ux-review run --image <path> --fix --json | sks image-ux-review status <mission-id|latest> [--json]', description: 'Run or inspect $sks-image-ux-review gpt-image-2/imagegen annotated UI/UX review artifacts, issue ledgers, safe fix loops, recapture, and proof gates.' },
  { name: 'computer-use', usage: 'sks computer-use import|status|smoke|require ... [--json]', description: 'Record native Mac/non-web Computer Use visual evidence while keeping web verification on the Chrome Extension path.' },
  { name: 'context7', usage: 'sks context7 check|setup|tools|resolve|docs|evidence ...', description: 'Check, configure, and call the local Context7 MCP requirement.' },
  { name: 'super-search', usage: 'sks super-search doctor|run|x|fetch|status|inspect|sources|claims|cache|bench', description: 'Run Super-Search provider-independent source intelligence.' },
  { name: 'search', usage: 'sks search status|files|text|structure|symbol|context|benchmark|doctor [--json]', description: 'Local SearchProvider engines for files/text/structure/symbol/context (no required rg/ast-grep/fd).' },
  { name: 'recallpulse', usage: 'sks recallpulse run|status|eval|governance|checklist <mission-id|latest>', description: 'Run report-only RecallPulse active recall, durable status, proof capsule, evidence envelope, and governance checks.' },
  { name: 'pipeline', usage: 'sks pipeline status|resume|plan|answer ...', description: 'Inspect the active skill-first route, materialized execution plan, ambiguity gates, and completion gates.' },
  { name: 'guard', usage: 'sks guard check [--json]', description: 'Check SKS harness self-protection lock, fingerprints, and source-repo exception state.' },
  { name: 'conflicts', usage: 'sks conflicts check|prompt|cleanup --yes [--json]', description: 'Detect other Codex harnesses such as OMX/DCodex, print a cleanup prompt, or quarantine them automatically.' },
  { name: 'versioning', usage: 'sks versioning status|bump|disable [--json]', description: 'Manage explicit project version syncs; SKS does not install Git pre-commit hooks.' },
  { name: 'features', usage: 'sks features list|check|inventory [--json] [--write-docs]', description: 'Build and validate the feature registry that maps CLI commands, hidden handlers, dollar routes, app skill aliases, and skills.' },
  { name: 'all-features', usage: 'sks all-features selftest --mock [--json]', description: 'Run the mock all-features contract selftest for feature registry, proof, Voxel TriWiki, and failure-contract coverage.' },
  { name: 'aliases', usage: 'sks aliases', description: 'Show command aliases and npm binary names.' },
  { name: 'align', usage: 'sks align prepare|run|status|proof ["scope"] [--json]', description: 'Prepare or inspect the $sks-align modernization mission that aligns SKS prompts, settings, and skills to latest GPT-5.6 / openai/skills guidance.' },
  { name: 'setup', usage: 'sks setup [--bootstrap] [--install-scope global|project] [--local-only] [--force] [--json]', description: 'Initialize SKS state, Codex App files, hooks, skills, and rules.' },
  { name: 'fix-path', usage: 'sks fix-path [--install-scope global|project] [--json]', description: 'Refresh hook commands with the resolved SKS binary path.' },
  { name: 'doctor', usage: 'sks doctor [--fix] [--local-only] [--json] [--install-scope global|project]', description: 'Check and repair SKS generated files, while blocking setup if another Codex harness is detected.' },
  { name: 'git', usage: 'sks git policy|install|status|doctor|precommit|publish-plan|summary [--json]', description: 'Install and validate SKS git hygiene, merge-friendly shared TriWiki shards, ignored runtime state, and precommit checks.' },
  { name: 'paths', usage: 'sks paths managed [--json]', description: 'List SKS-owned managed paths and rollback eligibility.' },
  { name: 'rollback', usage: 'sks rollback list|apply <id> [--json]', description: 'List or explicitly apply managed-path rollback actions with confirmation.' },
  { name: 'init', usage: 'sks init [--force] [--local-only] [--install-scope global|project]', description: 'Initialize the local SKS control surface.' },
  { name: 'selftest', usage: 'sks selftest [--mock]', description: 'Run local smoke tests without calling a model.' },
  { name: 'goal', usage: 'sks goal create|edit|pause|resume|clear|status ...', description: 'Print a detailed Codex native /goal command without creating SKS Goal state.' },
  { name: 'seo-geo-optimizer', usage: 'sks seo-geo-optimizer [seo|geo] doctor|audit|research|strategy|plan|apply|verify|status|rollback|fixture [mission|latest] [--mode seo|geo] [--target auto|website|docs|package] [--include-marketing] [--json]', description: 'Run the unified SEO/GEO optimizer on the shared search-visibility kernel with mode-specific gates, marketing research/strategy, safe apply, and proof.' },
  { name: 'research', usage: 'sks research prepare|run|status ...', description: 'Run long-form real research missions with xhigh agent Eureka ideas, debate, layered sources, paper, novelty, and falsification gates.' },
  { name: 'eval', usage: 'sks eval run|compare|thresholds ...', description: 'Run deterministic context-quality and performance evidence checks.' },
  { name: 'harness', usage: 'sks harness fixture|review [--json]', description: 'Run Harness Growth Factory fixtures for forgetting, skills, experiments, tool taxonomy, permissions, MultiAgentV2, and Zellij views.' },
  { name: 'perf', usage: 'sks perf run|workflow|cold-start [--json] [--iterations N]', description: 'Measure structured GPT-5.6/SKS performance budgets, including cold-start, Proof Field workflow decisions, and fast-lane evidence.' },
  { name: 'bench', usage: 'sks bench core|route-fixtures|blackbox|trust-kernel [--json]', description: 'Measure core trust-kernel hot paths and write performance budget artifacts.' },
  { name: 'proof', usage: 'sks proof show|latest|validate|export|smoke [--json|--md]', description: 'Show, validate, export, or smoke-write the unified Completion Proof Engine surface.' },
  { name: 'trust', usage: 'sks trust report|validate|status|explain [latest|mission-id] [--json]', description: 'Validate route contracts, evidence indexes, stale/mock evidence, and trust report blockers.' },
  { name: 'wrongness', usage: 'sks wrongness list|show|add|resolve|summarize|validate|context|rules ...', description: 'Record, retrieve, and validate TriWiki wrongness memory: negative evidence, failed assumptions, stale proof, visual/DB/hook mismatches, and avoidance rules.' },
  { name: 'proof-field', usage: 'sks proof-field scan [--json] [--intent "task"] [--changed file1,file2]', description: 'Analyze Potential Proof Field cones, negative-work cache, and fast-lane eligibility for a change set.' },
  { name: 'skill-dream', usage: 'sks skill-dream status|run|record [--json]', description: 'Track generated-skill usage in lightweight JSON and periodically report keep, merge, prune, and improvement candidates without deleting skills automatically.' },
  { name: 'code-structure', usage: 'sks code-structure scan [--json]', description: 'Scan handwritten source files for 1000/2000/3000-line structure gates and split-review exceptions.' },
  { name: 'rust', usage: 'sks rust status|smoke [--json] [--require-native]', description: 'Inspect optional Rust accelerator availability and verify JS fallback parity for image hash, voxel validation, secret scanning, and search files/text/batch.' },
  { name: 'validate-artifacts', usage: 'sks validate-artifacts [mission-id|latest] [--json]', description: 'Validate schema-backed mission artifacts for work orders, official subagent evidence, visual maps, dogfood reports, skills, mistake memory, and Honest Mode.' },
  { name: 'wiki', usage: 'sks wiki coords|pack|refresh|publish|rebuild-index|validate|validate-shared|wrongness ...', description: 'Build, refresh, publish shared shards, rebuild ignored indexes, validate, and attach wrongness-memory context to RGBA/trig LLM Wiki packs with attention.use_first and attention.hydrate_first for compact recall plus source hydration.' },
  { name: 'memory', usage: 'sks memory build [--json] | sks memory gc [--dry-run]', description: 'Project TriWiki context-pack memory into managed AGENTS.md blocks or run bounded memory cleanup.' },
  { name: 'hproof', usage: 'sks hproof check [mission-id|latest]', description: 'Evaluate the H-Proof done gate for a mission.' },
  { name: 'naruto', usage: 'sks naruto run \"task\" [--agents N] [--max-threads N] [--trusted-project] [--json] | sks naruto status|subagents|proof [latest|M-...] [--json] | sks naruto parent-summary --mission M-... --stdin [--json]', description: 'Run or inspect the Codex official subagent workflow with a Sol Max parent and fixed Luna Max mechanical, Sol High implementation, Sol Max judgment, and Terra Medium long-context/tool profiles, max_depth=1, and structured parent-thread completion evidence.' },
  { name: 'reasoning', usage: 'sks reasoning ["prompt"] [--json]', description: 'Show SKS temporary reasoning-effort routing: medium for simple tasks, high for logic, xhigh for research.' },
  { name: 'gx', usage: 'sks gx init|render|validate|drift|snapshot [name]', description: 'Create and verify deterministic SVG/HTML visual context cartridges.' },
  { name: 'profile', usage: 'sks profile show|set <model>', description: 'Inspect or set the current SKS model profile metadata.' },
  { name: 'gc', usage: 'sks gc [--dry-run] [--json]', description: 'Compact oversized logs and prune stale runtime artifacts.' },
  { name: 'stats', usage: 'sks stats [--full] [--json]', description: 'Show package and .sneakoscope storage size.' },
  { name: 'mcp-server', usage: 'sks mcp-server [--expose-exec] [--probe]', description: 'Run a stdio MCP server exposing SKS read-only commands as tools for any MCP-capable agent host; --expose-exec also exposes non-read-only commands; --probe round-trips initialize/tools-list and exits.' },
  { name: 'agent-bridge', usage: 'sks agent-bridge setup [--trusted-project] [--json]', description: 'Publish the agent-bridge manifest, print host registration snippets (generic MCP host, Codex CLI, non-interactive contract), and run a live non-interactive smoke test; project MCP inventory requires explicit project trust.' }
];

export function routeById(id: any): any {
  const key = String(id || '').replace(/^\$/, '').toLowerCase();
  return ROUTE_BY_ID.get(key) || ROUTE_BY_ID.get(unprefixedSksSkillName(key)) || null;
}

export function routeByDollarCommand(commandName: any): any {
  const key = String(commandName || '').replace(/^\$/, '').toLowerCase();
  return ROUTE_BY_DOLLAR_COMMAND.get(key) || ROUTE_BY_DOLLAR_COMMAND.get(unprefixedSksSkillName(key)) || null;
}

function leadingDollarCommandMatch(prompt: any) {
  const text = String(prompt || '').trim();
  return text.match(/^\$([A-Za-z][A-Za-z0-9_-]*)(?:\s|:|$)/)
    || text.match(/^\[\$([A-Za-z][A-Za-z0-9_-]*)\]\([^)]+\)(?:\s|:|$)/);
}

function embeddedDollarCommandMatch(prompt: any) {
  const text = String(prompt || '');
  const matches: any[] = [];
  for (const match of text.matchAll(/\[\$([A-Za-z][A-Za-z0-9_-]*)\]\([^)]+\)/g)) matches.push({ index: match.index ?? 0, command: match[1] || '' });
  for (const match of text.matchAll(/(^|[\s([{<])\$([A-Za-z][A-Za-z0-9_-]*)(?=\s|:|$|[.,!?;)\]}])/g)) matches.push({ index: (match.index ?? 0) + (match[1] || '').length, command: match[2] || '' });
  return matches
    .sort((a: any, b: any) => a.index - b.index)
    .find((match: any) => routeByDollarCommand(match.command) || String(match.command || '').toUpperCase() === 'MAD-SKS') || null;
}

export function dollarCommand(prompt: any) {
  const leading = leadingDollarCommandMatch(prompt);
  if (leading?.[1]) return leading[1].toUpperCase();
  const embedded = embeddedDollarCommandMatch(prompt);
  return embedded ? embedded.command.toUpperCase() : null;
}

export function explicitManagedSkillNames(prompt: any = ''): string[] {
  const text = String(prompt || '');
  const matches: Array<{ index: number; name: string }> = [];
  for (const match of text.matchAll(/\[\$([A-Za-z][A-Za-z0-9_-]*)\]\([^)]+\)/g)) {
    matches.push({ index: match.index ?? 0, name: match[1] || '' });
  }
  for (const match of text.matchAll(/(^|[\s([{<])\$([A-Za-z][A-Za-z0-9_-]*)(?=\s|:|$|[.,!?;)\]}])/g)) {
    matches.push({ index: (match.index ?? 0) + (match[1] || '').length, name: match[2] || '' });
  }
  const selected: string[] = [];
  for (const match of matches.sort((a, b) => a.index - b.index)) {
    const rawName = normalizeDollarSkillName(match.name);
    const skillName = sksPrefixedSkillName(match.name);
    if (!skillName || skillName.length > 100) continue;
    const matchedRoute = routeByDollarCommand(match.name);
    if (matchedRoute) {
      const canonicalRouteSkillName = sksPrefixedSkillName(dollarSkillName(matchedRoute.command));
      const selectedSkillName = MANAGED_ROUTE_SKILL_NAME_SET.has(skillName)
        ? skillName
        : canonicalRouteSkillName;
      if (!MANAGED_ROUTE_SKILL_NAME_SET.has(selectedSkillName) || selected.includes(selectedSkillName)) continue;
      selected.push(selectedSkillName);
      continue;
    }
    if (!rawName.startsWith('sks-')) continue;
    const boundedSkillName = MANAGED_ROUTE_SKILL_NAME_SET.has(skillName)
      ? skillName
      : INVALID_EXPLICIT_MANAGED_SKILL_NAME;
    if (selected.includes(boundedSkillName)) continue;
    selected.push(boundedSkillName);
  }
  return selected;
}

export function managedSkillNamesForPrompt(route: any, prompt: any = ''): string[] {
  return Array.from(new Set([
    ...(Array.isArray(route?.requiredSkills) ? route.requiredSkills.map(String) : []),
    ...explicitManagedSkillNames(prompt)
  ]));
}

export function allowlistedManagedRouteSkillNames(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .slice(0, MANAGED_ROUTE_SKILL_NAMES.length + 1)
    .filter((name: any) => typeof name === 'string'
      && (MANAGED_ROUTE_SKILL_NAME_SET.has(name) || name === INVALID_EXPLICIT_MANAGED_SKILL_NAME))));
}

export function hasMadSksSignal(prompt: any = '') {
  return /(?:^|\s)(?:\$(?:sks-)?MAD-SKS|\[\$(?:sks-)?MAD-SKS\]\([^)]+\))(?:\s|:|$)/i.test(String(prompt || ''));
}

export function stripMadSksSignal(prompt: any = '') {
  return String(prompt || '')
    .replace(/(?:^|\s)(?:\$(?:sks-)?MAD-SKS|\[\$(?:sks-)?MAD-SKS\]\([^)]+\))(?:\s|:)?/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripDollarCommand(prompt: any) {
  return String(prompt || '').trim()
    .replace(/^\$[A-Za-z][A-Za-z0-9_-]*(?:\s|:)?\s*/, '')
    .replace(/^\[\$[A-Za-z][A-Za-z0-9_-]*\]\([^)]+\)(?:\s|:)?\s*/, '')
    .trim();
}

export function looksLikeTinyDirectFix(prompt: any) {
  const text = String(prompt || '');
  if (looksLikeDirectFixQuestion(text)) return false;
  const broadCodeCue = /(구현|개발|리팩터|마이그레이션|버그|기능|로직|인증|데이터베이스|스키마|서버|API|테스트|동작|작동|호환|배포|릴리즈|다음\s*버전|컨텍스트7|커맨드|명령어|닥터|업데이트|업그레이드|설치|정리|중복|레거시|접두사|별칭|매니페스트|context7|MCP|implement|build|develop|refactor|rewrite|migrate|bug|feature|logic|auth|database|schema|server|endpoint|test|deploy|release|publish|compat(?:ible|ibility)?|next\s+version|command|cli|doctor|update|upgrade|install|cleanup|dedup(?:e|lication)?|legacy|prefix|namespace|alias|manifest|generator|workflow|flow|work(?:ing)?)/i.test(text);
  if (broadCodeCue) return false;
  const creationCue = /(?:\b(?:create|add|make|build|implement)\b.*\b(?:button|component|page|screen|form|modal|endpoint|feature|route|view|flow)\b)|(?:(?:버튼|컴포넌트|페이지|화면|폼|모달|엔드포인트|기능|플로우).*(?:만들|생성|추가|구현))/i.test(text);
  if (creationCue && !/(라벨|문구|텍스트|글자|색|컬러|간격|여백|정렬|label|copy|text|color|spacing|padding|margin|align)/i.test(text)) return false;
  const simpleSurfaceCue = /(글자|텍스트|문구|내용|색|컬러|폰트|간격|여백|정렬|라벨|영어|한국어|번역|오타|맞춤법|문장|제목|헤딩|README|문서|주석|메시지|버전|설정값|copy|text|color|font|spacing|padding|margin|align|label|translate|typo|spelling|grammar|wording|title|heading|docs?|comment|message|string|literal|placeholder|tooltip|config\s+value|package\.json|package-lock\.json|package\s+version|version\s*(?:to|만|으로))/i.test(text);
  const behaviorCue = /(\b(?:submit|save|delete|navigate|redirect|validate|send|fetch|call|trigger|execute|toggle|upload|download)\b|\b(?:on\s*click|click\s+handler|handler|event)\b|submit(?:s|ting)?\s+(?:the\s+)?form|폼\s*제출|제출(?:하|되|하게)|클릭|핸들러|이벤트|저장|삭제|이동|검증|전송|호출|실행|토글|업로드|다운로드)/i.test(text);
  if (behaviorCue && !simpleSurfaceCue) return false;
  const directCue = simpleSurfaceCue || /(버튼|button)/i.test(text);
  const changeCue = /(바꿔|변경|수정|교체|고쳐|영어로|한국어로|change|replace|update|make|turn|translate|fix)/i.test(text);
  return directCue && changeCue && (!looksLikeAnswerOnlyRequest(text) || looksLikeDirectWorkRequest(text));
}

function looksLikeDirectFixQuestion(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (looksLikePoliteDirectWorkRequest(text)) return false;
  return looksLikeMethodQuestion(text)
    && /(fix|change|replace|update|edit|typo|wording|label|color|spacing|고치|바꾸|변경|수정|교체|오타|문구|라벨|색|간격)/i.test(text)
    && !/(해줘|고쳐줘|바꿔줘|변경해줘|수정해줘|교체해줘|please\s+(?:fix|change|replace|update|edit)|\b(?:fix|change|replace|update|edit)\b.*(?:for\s+me|now)$)/i.test(text);
}

function looksLikeMethodQuestion(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  return /(?:\?|^(?:how\s+(?:do|can|could|should|would)\s+(?:i|we)\b|how\s+to\b|what(?:'s| is)?\s+(?:the\s+)?(?:best\s+)?way\b|(?:can|could|should|would)\s+(?:i|we)\b)|^(?:어떻게|방법|왜|무엇|뭐|언제|어디|가능|맞아|인가|인지)\b)/i.test(text);
}

function looksLikePoliteDirectWorkRequest(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  return /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:fix|change|replace|update|edit|make|turn|translate|create|add|build|implement|delete|remove)\b/i.test(text)
    || /(?:해줄\s*수|해\s*줄래|바꿔줄|고쳐줄|수정해줄|변경해줄|교체해줄)/i.test(text);
}

export function looksLikePresentationArtifactRequest(prompt: any = '') {
  const text = String(prompt || '');
  const lower = text.toLowerCase();
  const cue = /\b(ppt|presentation|deck|slide|slides|pitch\s*deck|proposal\s*deck)\b|발표자료|발표\s*자료|소개자료|제안서|피치덱|슬라이드|pdf\s*자료/i.test(text);
  if (!cue) return false;
  const meta = /커맨드|command|route|routing|파이프라인|pipeline|schema|스키마|모호성|ambiguity|질문|게이트|gate/i.test(text);
  if (meta) return false;
  return /만들|작성|생성|제작|디자인|export|pdf|html|create|generate|build|write|make/i.test(text) || /\b(ppt|presentation|deck|slides?)\b/.test(lower);
}

export function looksLikeImageUxReviewRequest(prompt: any = '') {
  const text = String(prompt || '');
  const reviewCue = /(ui\/?ux|ux|ui|screen|screenshot|visual|interface|화면|스크린|캡처|비주얼|인터페이스|사용성|유아이|유엑스)/i.test(text)
    && /(review|critique|audit|inspect|analy[sz]e|검수|리뷰|분석|평가|진단)/i.test(text);
  const imagegenCue = /(gpt-image-2|imagegen|\$imagegen|image\s*generation|generated\s*review|annotated\s*review|callout|이미지\s*생성|생성\s*이미지|콜아웃|주석\s*이미지)/i.test(text);
  const commandCue = /\$?(?:image-ux-review|ux-review|visual-review|ui-ux-review)\b/i.test(text);
  return commandCue || (reviewCue && imagegenCue);
}

export function looksLikeGeoLocationRequest(prompt: any = '') {
  return /\b(?:geolocation|geoip|geo\s*ip|map\s+coordinates?|coordinates?|latitude|longitude|location\s+permission|cdn\s+edge\s+geography|regional?\s+redirect|country\s+routing|지도\s*좌표|위치\s*권한|지역\s*리다이렉트|국가별\s*라우팅)\b/i.test(String(prompt || ''));
}

export function looksLikeSeoRequest(prompt: any = '') {
  const text = String(prompt || '');
  return /\b(?:SEO|search\s+engine\s+optimization|technical\s+seo|canonical|sitemap|robots\.txt|hreflang|structured\s+data|json-ld|indexability|crawlability|metadata|meta\s+description|npm\s+seo|package\s+seo|검색\s*엔진\s*최적화|검색\s*노출|사이트맵|캐노니컬|구조화\s*데이터)\b/i.test(text);
}

export function looksLikeGenerativeEngineOptimizationRequest(prompt: any = '') {
  if (looksLikeGeoLocationRequest(prompt)) return false;
  const text = String(prompt || '');
  return /\b(?:GEO|generative\s+engine\s+optimization|AI\s+(?:answer|search)\s+(?:visibility|discoverability)|LLM\s+(?:citation|answer|visibility|discoverability)|answerability|entity\s+(?:facts?|clarity)|claim\s+evidence|crawler\s+policy|OAI-SearchBot|GPTBot|ChatGPT-User|Claude-SearchBot|ClaudeBot|Claude-User|llms\.txt|AI\s*검색\s*가시성|AI\s*답변\s*가시성|생성형\s*엔진\s*최적화)\b/i.test(text);
}

export function looksLikeSuperSearchRequest(prompt: any = '') {
  const text = String(prompt || '');
  return /\b(?:SuperSearch|Super-Search|source\s+intelligence|provider-independent\s+source|source\s+acquisition|citation\s+proof|x-search|site:x\.com|site:twitter\.com)\b|슈퍼\s*서치|소스\s*인텔리전스/i.test(text);
}

export function routePrompt(prompt: any): any {
  const text = stripVisibleDecisionAnswerBlocks(prompt);
  const intentScores = scorePromptIntent(text);
  const taskProfile = classifyTaskProfile(text);
  const explicitCommand = Boolean(dollarCommand(text)) || /^\$?plan\b/i.test(text);
  const select = (route: any) => withTaskProfile(withPromptIntentScores(route, intentScores), taskProfile, explicitCommand);
  if (!explicitCommand && taskProfile === 'passthrough') return null;
  if (/^\$?plan\b/i.test(text)) return select(routeById('Planner'));
  if (/^\$work\b/i.test(text)) return select(routeById('Naruto'));
  const command = dollarCommand(text);
  if (command) {
    if (unprefixedSksSkillName(command) === 'mad-sks') {
      const afterModifier = stripMadSksSignal(text);
      const nestedCommand = dollarCommand(afterModifier);
      if (nestedCommand) return select(routeByDollarCommand(nestedCommand) || routeById('MadSKS'));
      if (looksLikeAnswerOnlyRequest(afterModifier)) return select(routeById('Answer'));
      if (looksLikeCodeChangingWork(afterModifier) || looksLikeDirectWorkRequest(afterModifier)) return select(routeById('Naruto'));
      return select(routeById('MadSKS'));
    }
    const route = routeByDollarCommand(command);
    if (!route) return null;
    return select(route);
  }
  if (hasFromChatImgSignal(text)) return select(routeById('Naruto'));
  const simpleGitRoute = simpleGitOnlyRouteId(text);
  if (simpleGitRoute) return select(routeById(simpleGitRoute));
  if (looksLikePresentationArtifactRequest(text)) return select(routeById('PPT'));
  if (looksLikeImageUxReviewRequest(text)) return select(routeById('ImageUXReview'));
  if (looksLikeComputerUseFastLane(text)) return select(routeById('ComputerUse'));
  if (looksLikeTinyDirectFix(text)) return select(routeById('DFix'));
  if (looksLikeDatabaseWorkRequest(text)) return select(routeById('DB'));
  if (looksLikeSuperSearchRequest(text) && !looksLikeCodeChangingWork(text)) return select(routeById('SuperSearch'));
  if (taskProfile === 'answer' && !looksLikeSpecializedAnswerRouteSignal(text) && !looksLikeDirectWorkRequest(text)) return select(routeById('Answer'));
  if (/\bautoresearch\b/i.test(text) && !looksLikeCodeChangingWork(text)) return select(routeById('AutoResearch'));
  if (/\b(research|hypothesis|falsify|novelty|frontier)\b|조사|연구/i.test(text) && !looksLikeCodeChangingWork(text)) return select(routeById('Research'));
  if (taskProfile === 'parallel-read' || taskProfile === 'parallel-write') return select(routeById('Naruto'));
  if (looksLikeQuestionShapedDirective(text)) return select(routeById('Naruto'));
  if (looksLikeDirectWorkRequest(text)) return select(routeById('Naruto'));
  if (looksLikeAnswerOnlyRequest(text)) return select(routeById('Answer'));
  if (/\b(team|multi-agent|subagent|parallel agents|agent team)\b|병렬|팀/i.test(text)) return select(routeById('Naruto'));
  if (looksLikeChatCaptureRequest(text) && !looksLikeAnswerOnlyRequest(text)) return select(routeById('Naruto'));
  if (/\b(qa[-\s]?loop|qaloop|e2e\s+qa|qa\s+e2e)\b/i.test(text)) return select(routeById('QALoop'));
  if (looksLikeSuperSearchRequest(text) && !looksLikeCodeChangingWork(text) && !looksLikeAnswerOnlyRequest(text)) return select(routeById('SuperSearch'));
  if (looksLikeGenerativeEngineOptimizationRequest(text)) return select(routeById('SEOGEOOptimizer'));
  if (looksLikeSeoRequest(text)) return select(routeById('SEOGEOOptimizer'));
  if (/\b(autoresearch|experiment|benchmark|ranking|optimi[sz]e|improve metric|github stars?|npm downloads?|스타|다운로드)\b/i.test(text)) return select(routeById('AutoResearch'));
  if (/\b(research|hypothesis|falsify|novelty|frontier|조사|연구)\b/i.test(text)) return select(routeById('Research'));
  if (/(wiki\s+(refresh|pack|validate|prune)|triwiki\s+(refresh|pack|validate)|위키\s*(갱신|리프레시|정리|검증|패킹)|트라이위키|triwiki)/i.test(text) && !looksLikeDirectWorkRequest(text)) return select(routeById('Wiki'));
  if (/\b(GX|vgraph|visual context|render cartridge|wiki coordinate|rgba|trig|llm wiki)\b/i.test(text)) return select(routeById('GX'));
  if (looksLikeNarutoDefaultWork(text)) return select(routeById('Naruto'));
  if (taskProfile === 'answer') return select(routeById('Answer'));
  return select(routeById('SKS'));
}

function looksLikeSpecializedAnswerRouteSignal(prompt: any = '') {
  const text = String(prompt || '');
  return /\b(qa[-\s]?loop|qaloop|autoresearch|research|hypothesis|falsify|novelty|frontier|wiki|triwiki|GX|vgraph|visual context|render cartridge|wiki coordinate|rgba|trig|llm wiki|SEO|GEO|generative engine optimization)\b|조사|연구|위키|트라이위키|검색\s*엔진\s*최적화|생성형\s*엔진\s*최적화/i.test(text);
}

export function scorePromptIntent(prompt: any = ''): PromptIntentScores {
  const text = String(prompt || '').trim();
  const reasons = new Set<string>();
  const questionShape = /(?:\?|^(?:why|what|how|when|where|who|which|can|could|should|would)\b|^(?:왜|뭐|무엇|어떻게|언제|어디|누구|가능|인가|인지)\b)/i.test(text);
  const conditionalWork = looksLikeConditionalWorkRequest(text);
  const complaintDirective = looksLikeComplaintDirectiveRequest(text);
  const commandSignal = Boolean(dollarCommand(text));
  const tinyDirectFix = looksLikeTinyDirectFix(text);
  const directWork = looksLikeDirectWorkRequest(text);
  const answerOnly = looksLikeAnswerOnlyRequest(text);
  let answerOnlyScore = 0;
  let directWorkScore = 0;
  let tinyDirectFixScore = 0;
  let researchScore = 0;
  let dbScore = 0;
  let superSearchScore = 0;

  if (questionShape) {
    answerOnlyScore += 1;
    reasons.add('question_shape');
  }
  if (commandSignal) reasons.add('command_signal');
  if (tinyDirectFix) {
    tinyDirectFixScore += 5;
    directWorkScore += 2;
    reasons.add('tiny_direct_fix');
  }
  if (conditionalWork) {
    directWorkScore += 5;
    reasons.add('conditional_work');
  }
  if (complaintDirective) {
    directWorkScore += 4;
    reasons.add('complaint_directive');
  }
  if (looksLikeQuestionShapedDirective(text)) {
    directWorkScore += 4;
    reasons.add('question_shaped_directive');
  }
  if (directWork) {
    directWorkScore += 3;
    reasons.add('direct_work');
  }
  if (answerOnly) {
    answerOnlyScore += 4;
    reasons.add('answer_only');
  }
  if (/\b(research|hypothesis|falsify|novelty|frontier|조사|연구)\b/i.test(text)) {
    researchScore += 2;
    reasons.add('research');
  }
  if (looksLikeDatabaseWorkRequest(text)) {
    dbScore += 3;
    reasons.add('db');
  }
  if (looksLikeSuperSearchRequest(text)) {
    superSearchScore += 4;
    reasons.add('super_search');
  }
  return {
    answerOnly: answerOnlyScore,
    directWork: directWorkScore,
    tinyDirectFix: tinyDirectFixScore,
    research: researchScore,
    db: dbScore,
    superSearch: superSearchScore,
    reasons: [...reasons]
  };
}

function withPromptIntentScores(route: any, intentScores: PromptIntentScores) {
  if (!route) return route;
  return { ...route, intent_scores: intentScores };
}

function withTaskProfile(route: any, taskProfile: TaskProfile, explicitInvocation: boolean = false) {
  if (!route) return route;
  return { ...route, task_profile: taskProfile, explicit_invocation: explicitInvocation };
}

export function looksLikeComputerUseFastLane(prompt: any = '') {
  const text = String(prompt || '');
  const computerUseCue = /\b(computer\s*use|codex\s+computer\s+use|computer-use)\b|컴퓨터\s*유즈|컴퓨터\s*사용|컴퓨터유즈/i.test(text);
  if (!computerUseCue) return false;
  if (/\b(browser|localhost|web(?:site|app)?|page|url|http|https|frontend|site)\b|브라우저|웹앱|웹\s*앱|웹\s*사이트|사이트|페이지|로컬호스트/i.test(text)) return false;
  return /\b(native|macos|desktop|os\s*settings|system\s*settings|visual|screen|screenshot|fast|lane|pipeline|app)\b|맥|맥OS|데스크톱|네이티브|시스템\s*설정|화면|시각|스크린|캡처|빠른|고속|파이프라인|작업|속도/i.test(text);
}

export function looksLikeNarutoDefaultWork(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (looksLikeTinyDirectFix(text) || looksLikeAnswerOnlyRequest(text)) return false;
  return looksLikeCodeChangingWork(text) || looksLikeDirectWorkRequest(text);
}

export function looksLikeAnswerOnlyRequest(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (looksLikeQuestionShapedDirective(text)) return false;
  if (looksLikeConditionalWorkRequest(text)) return false;
  if (looksLikeComplaintDirectiveRequest(text)) return false;
  const infoCue = /(왜|뭐야|무엇|뭔가|어떤|어떻게|언제|어디|누구|얼마|가능해|맞아|인가|인지|차이|의미|원리|이유|방법|설명|알려줘|요약|정리|비교|찾아줘|찾아봐|검색|조사|근거|출처|fact|source|cite|explain|what|why|how|when|where|who|which|whether|compare|summari[sz]e|search|look up|research|tell me|question|\?)/i.test(text);
  if (!infoCue) return false;
  return !looksLikeDirectWorkRequest(text);
}

export function looksLikeQuestionShapedDirective(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  const complaint = looksLikeComplaintDirectiveRequest(text);
  if (looksLikeMethodQuestion(text) && !looksLikePoliteDirectWorkRequest(text) && !looksLikeExplicitDirectWorkDirective(text) && !complaint) return false;
  const questionDirective = /(?:\?|왜|why)[\s\S]{0,160}(?:질문|물음표|answer|라우팅|route|routing)[\s\S]{0,160}(?:고쳐|수정|변경|막아|fix|patch|change|update)/i.test(text);
  const directive = /(반드시|필수|무조건|해야\s*(?:해|함|돼|한다|하지|한다는|되는)|해야지|해야돼|해야한다|알지|기억해|파악해야|구분해야|막아야|보장해야|강제|기본적으로)/i.test(text);
  const pipelineCue = /(질문|질문형|암묵|지시|파이프라인|라우팅|route|routing|team|팀|sks|기본|구성|게이트|gate|작업|수정|구현|실행)/i.test(text);
  return questionDirective || (directive && pipelineCue) || complaint;
}

export function looksLikeDirectWorkRequest(prompt: any = '') {
  const text = String(prompt || '');
  if (/(?:설명만|설명\s*만|just\s+explain|explain\s+only|only\s+explain)/i.test(text)) return false;
  if (looksLikePureExplanationRequest(text)) return false;
  const explicitDirective = looksLikeExplicitDirectWorkDirective(text);
  if (looksLikeDirectFixQuestion(text) && !explicitDirective) return false;
  if (looksLikeMethodQuestion(text) && !looksLikePoliteDirectWorkRequest(text) && !looksLikeQuestionShapedDirective(text) && !explicitDirective) return false;
  return looksLikeCodeChangingWork(text)
    || looksLikeChatCaptureRequest(text)
    || looksLikeConditionalWorkRequest(text)
    || looksLikeQuestionShapedDirective(text)
    || explicitDirective
    || /(작업|파이프라인|구현|수정|변경|추가|적용|반영|처리|수행|검수|설치|해결|리드미|README).*(해줘|해달|해라|해야|되게|줘야|줘야지|달라)/i.test(text)
    || /(진행해|수행해|작업해|처리해|적용해|반영해|검수해|고쳐줘|바꿔줘|해결해줘|만들어줘|해줘야|해줘야지|해달라|해야지|되게 해|install|run|execute|test|deploy|commit|push)/i.test(text);
}

function looksLikePureExplanationRequest(prompt: any = '') {
  const text = String(prompt || '').trim();
  const explanationEnding = /(?:설명|알려)\s*(?:해\s*줘|해\s*주세요|해달라|줘)\s*[.!?]*$/i.test(text)
    || /^(?:can|could|would) you explain\b/i.test(text);
  if (!explanationEnding) return false;
  return !/\b(fix|implement|change|edit|add|remove|delete|modify|refactor|build|create|write|update|rename|rewrite|patch|apply|execute|repair|resolve|publish|release|deploy|migrate)\b|고쳐|수정|변경|추가|삭제|구현|리팩터|작성|생성|업데이트|적용|실행|해결|배포|출시|마이그레이션/i.test(text);
}

function looksLikeConditionalWorkRequest(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  return /(확인하고|검토하고|봐서|보고|문제\s*있으면|가능한지).*(고쳐|수정|변경|처리|해결|진행|반영|해줘|해달)/i.test(text)
    || /\b(?:check|inspect|verify|see)\b[\s\S]{0,120}\b(?:if|whether|when)\b[\s\S]{0,120}\b(?:fix|patch|update|change|repair|resolve)\b/i.test(text)
    || /\b(?:if|when)\b[\s\S]{0,120}\b(?:problem|issue|bug|broken|fails?)\b[\s\S]{0,120}\b(?:fix|patch|update|change|repair|resolve)\b/i.test(text);
}

function looksLikeComplaintDirectiveRequest(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  return /(왜|근데|그런데).*(안\s*하|안\s*되|없이|누락|빠뜨|생략|스킵|못\s*하).*(많|자주|계속|이렇게|함|하지|하냐|하니|\?)/i.test(text)
    || /\bwhy\b[\s\S]{0,80}\b(?:not|missing|skipped|failed|still|keeps?)\b[\s\S]{0,120}\b(?:fix|patch|route|routing|work|do|done)\b/i.test(text);
}

function looksLikeExplicitDirectWorkDirective(prompt: any = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  const koreanDirective = /(해\s*줘|해\s*주세요|해달|달라|진행해|수행해|작업해|처리해|적용해|반영해|검수해|고쳐줘|수정해줘|변경해줘|바꿔줘|해결해줘|만들어줘|준비해줘|완료해줘|배포\s*준비|릴리즈\s*준비|다음\s*버전)/i.test(text);
  const englishDirective = /\b(?:please\s+)?(?:fix|repair|resolve|solve|implement|patch|update|change|modify|prepare|ship|release|publish|deploy)\b[\s\S]{0,180}\b(?:for\s+me|now|release|deployment|publish|next\s+version|ship|deploy|prepare)\b/i.test(text)
    || /^(?:please\s+)?work\s+on\b/i.test(text)
    || /\b(?:prepare|make)\b[\s\S]{0,120}\b(?:next\s+version|release|deployment|publish|ship)\b/i.test(text)
    || /\b(?:fix|repair|resolve|solve|implement|patch|update|change|modify)\b[\s\S]{0,180}\b(?:prepare|ship|release|publish|deploy)\b/i.test(text);
  return koreanDirective || englishDirective;
}

export function routeNeedsContext7(route: any, prompt: any = '') {
  if (!route) return false;
  if (route.context7Policy === 'required') return true;
  if (route.context7Policy !== 'if_external_docs') return false;
  return /\b(package|library|framework|SDK|API|MCP|Supabase|React|Next|Vue|Svelte|Vite|Prisma|Drizzle|Knex|Postgres|npm|node_modules|docs?|documentation)\b/i.test(String(prompt || ''));
}

const NARUTO_GATE_BYPASS_ROUTE_IDS = new Set([
  'Answer',
  'DFix',
  'Help',
  'Wiki',
  'ComputerUse',
  'Goal',
  'Commit',
  'CommitAndPush',
  'FastMode',
  'LocalModel',
  'Planner'
]);

const NARUTO_GATE_ROUTE_OWNED_IDS = new Set([
  'Research',
  'AutoResearch',
  'QALoop'
]);

const NARUTO_GATE_SPECIALIZED_PARALLEL_ROUTE_IDS = new Set([
  'Review',
  'ReleaseReview',
  'PPT',
  'ImageUXReview',
  'SuperSearch',
  'SEOGEOOptimizer',
  'DB',
  'MadSKS',
  'GX'
]);

export function narutoDecisionForRoute(
  route: any,
  prompt: any = '',
  profile: TaskProfile = classifyTaskProfile(prompt)
): NarutoRouteDecision {
  const routeId = route?.id ? String(route.id) : null;
  if (!routeId) {
    return narutoRouteDecision('none', null, profile, 'no_route_or_task_context', true);
  }
  if (NARUTO_GATE_ROUTE_OWNED_IDS.has(routeId)) {
    // These routes already own their orchestration lifecycle. The common
    // Naruto gate records that fact but must not add a second generic fanout.
    return narutoRouteDecision('route_owned', routeId, profile, `route_owned_orchestration:${routeId}`, false);
  }
  if (NARUTO_GATE_BYPASS_ROUTE_IDS.has(routeId)) {
    return narutoRouteDecision('none', routeId, profile, `lightweight_route_bypass:${routeId}`, true);
  }
  if (routeId === 'Naruto' && route.explicit_invocation !== false) {
    return narutoRouteDecision('generic_naruto', routeId, profile, 'explicit_official_subagent_route', false);
  }
  if (/(?:^|\s)--agents(?:=|\s+)\d+\b/i.test(String(prompt || ''))) {
    return narutoRouteDecision('generic_naruto', routeId, profile, 'explicit_subagent_count', false);
  }
  if (NARUTO_GATE_SPECIALIZED_PARALLEL_ROUTE_IDS.has(routeId)) {
    return narutoRouteDecision('generic_naruto', routeId, profile, `specialized_route_default_parallel:${routeId}`, false);
  }
  if (profile === 'passthrough' || profile === 'answer' || profile === 'tiny-change') {
    return narutoRouteDecision('none', routeId, profile, `task_profile_${profile}_bypass`, true);
  }
  if (profile === 'bounded-work' || profile === 'parallel-read' || profile === 'parallel-write' || profile === 'high-risk') {
    return narutoRouteDecision('generic_naruto', routeId, profile, `task_profile_${profile}_default_parallel`, false);
  }
  return narutoRouteDecision('none', routeId, profile, `task_profile_${profile}_bypass`, true);
}

export function routeRequiresSubagents(route: any, prompt: any = '', profile: TaskProfile = classifyTaskProfile(prompt)) {
  return narutoDecisionForRoute(route, prompt, profile).mode === 'generic_naruto';
}

function narutoRouteDecision(
  mode: NarutoRouteDecision['mode'],
  routeId: string | null,
  profile: TaskProfile,
  reason: string,
  trivial: boolean
): NarutoRouteDecision {
  const required = mode === 'generic_naruto';
  return {
    mode,
    required,
    route_id: routeId,
    task_profile: profile,
    reason,
    trivial,
    default_parallel: required
  };
}

export function simpleGitOnlyRouteId(prompt: any = '') {
  const text = stripVisibleDecisionAnswerBlocks(String(prompt || '')).trim();
  if (!text) return null;
  const hasCommit = /\bcommit\b|커밋/i.test(text);
  const hasPush = /\bpush\b|푸쉬|푸시/i.test(text);
  if (!hasCommit && !hasPush) return null;
  const repairOrImplementationCue = /(고쳐|수정|변경|해결|구현|코드|버그|오류|에러|문제|깨짐|작동|분석|조사|리서치|설계|fix|repair|resolve|solve|implement|patch|bug|error|problem|broken|analy[sz]e|research|design|refactor|hook|pipeline|route|routing)/i.test(text);
  const safeGitObjectCue = /(변경사항|스테이징|스테이지|현재\s*변경|작업\s*내용|diff|staged|current\s+changes|changes|working\s+tree|git)/i.test(text);
  if (repairOrImplementationCue && !safeGitObjectCue) return null;
  const commitAction = hasCommit && /(커밋\s*(?:하고|해|해줘|해주세요|생성|만들|작성)|(?:create|make|do|write)?\s*(?:a\s+)?commit(?:\s+(?:and|&)\s+push)?|commit\s+(?:changes|staged|current))/i.test(text);
  const pushAction = hasPush && /(푸쉬|푸시|\bpush\b)/i.test(text);
  if (commitAction && pushAction) return 'CommitAndPush';
  if (commitAction) return 'Commit';
  return null;
}

export function reflectionRequiredForRoute(route: any) {
  const id = String(route?.id || route?.mode || route?.route || route || '').replace(/^\$/, '');
  return /^(naruto|qaloop|qa-loop|ppt|imageuxreview|image-ux-review|research|autoresearch|seo|geo|db|database|madsks|mad-sks|gx|align)$/i.test(id);
}

export function looksLikeCodeChangingWork(prompt: any = '') {
  const text = String(prompt || '');
  return /\b(implement|build|make|add|edit|modify|change|fix|refactor|rewrite|migrate|create|delete|remove|rename|update|patch)\b/i.test(text)
    || /(코드|구현|개발|수정|변경|추가|삭제|해결|고쳐|바꿔|리팩터|마이그레이션)/i.test(text);
}

export function looksLikeExecutionWork(prompt: any = '') {
  const text = String(prompt || '');
  return looksLikeCodeChangingWork(text)
    || /\b(test|verify|run|doctor|setup|install|lint|typecheck|selftest|release|publish|execute|deploy)\b/i.test(text)
    || /(실행|검증|테스트|설치|배포|릴리즈|출시)/i.test(text);
}

export function subagentExecutionPolicyText(route: any, prompt: any = '') {
  const required = routeRequiresSubagents(route, prompt);
  if (route?.id === 'Goal') {
    if (!required) return 'Subagent policy: Goal uses Codex native /goal only; no SKS mission or subagent workflow is created for Goal control.';
    return [
      'Subagent policy: Goal remains a Codex-native control turn with no SKS-owned state.',
      'Because the prompt also requests explicitly parallel execution, continue through the selected SKS execution route and use that route\'s Codex subagent workflow.'
    ].join(' ');
  }
  if (!required) {
    return 'Subagent policy: not required for this task profile. Keep the work parent-owned unless a later, concrete decomposition reveals independent slices.';
  }
  return [
    'Codex subagent workflow: required for this explicit Naruto or parallel task.',
    'The parent agent owns decomposition, integration, scoped verification, and the final answer.',
    'Delegate only genuinely independent slices. Use Luna Max only for tiny short-context mechanical work, Sol High for ordinary implementation, Sol Max for review/debug/planning/architecture/integration/risk judgment, and Terra Medium for long-context or Computer Use, Browser/Chrome, and image-generation execution.',
    'Parallel writes require disjoint paths; serialize overlapping paths, prohibit nested delegation, avoid duplicate work, wait for all requested agent threads, and close completed threads after collecting results.',
    'Completion evidence comes from official SubagentStart/SubagentStop events plus the parent integration summary, not process counts or PID evidence.'
  ].join(' ');
}

export function routeReasoning(route: any, prompt: any = '') {
  const text = String(prompt || '');
  const base = ALLOWED_REASONING_EFFORTS.has(route?.reasoningPolicy) ? route.reasoningPolicy : 'medium';
  if (hasFromChatImgSignal(text)) return reasoning('xhigh', 'from_chat_img_image_work_order_analysis');
  if (/(?:^|\s)sks\s+--mad\b|(?:^|\s)--mad\b|\$MAD-SKS\b|\bmad-sks\b|\bmadsks\b/i.test(text)) return reasoning('xhigh', 'mad_sks_or_mad_launch_default');
  if (route?.id === 'Naruto') return narutoRouteReasoning(text);
  if (route?.id === 'Research' || route?.id === 'AutoResearch') return reasoning('xhigh', 'research_or_experiment_route');
  if (route?.id === 'SuperSearch') return reasoning('high', 'source_intelligence_route');
  if (route?.id === 'SEOGEOOptimizer') return reasoning('high', 'search_visibility_route');
  if (route?.id === 'ImageUXReview') return reasoning('high', 'image_generation_visual_review_route');
  if (/\b(research|autoresearch|hypothesis|falsify|novelty|frontier|benchmark|experiment|ranking|연구|실험|가설|검증)\b/i.test(text)) return reasoning('xhigh', 'research_level_prompt');
  if (base === 'xhigh') return reasoning('xhigh', 'route_policy_xhigh');
  if (base === 'high' || /\b(architecture|design|migration|database|security|parallel|orchestrat|refactor|algorithm|logic|tradeoff|검토|설계|마이그레이션|보안|병렬|팀|논리)\b/i.test(text)) return reasoning('high', 'logical_or_safety_work');
  if (base === 'low') return reasoning('low', 'route_policy_low');
  return reasoning('medium', 'simple_fulfillment');
}

function narutoRouteReasoning(_text: any = '') {
  return reasoning('max', 'naruto_parent_sol_max');
}

export function reasoningProfileName(effort: any) {
  if (effort === 'low') return 'sks-task-low';
  if (effort === 'ultra') return 'sks-research-ultra';
  if (effort === 'max') return 'sks-research-max';
  if (effort === 'xhigh') return 'sks-research-xhigh';
  if (effort === 'high') return 'sks-logic-high';
  return 'sks-task-medium';
}

export function reasoningInstruction(info: any) {
  const profile = reasoningProfileName(info?.effort);
  return `Temporary reasoning route: use ${info?.effort || 'medium'} reasoning (${profile}) in Fast service tier for this SKS route only; do not persist profile changes, and return to the default/user-selected profile after the route gate passes.`;
}

function reasoning(effort: any, reason: any) {
  const normalizedEffort = ALLOWED_REASONING_EFFORTS.has(effort) ? effort : 'medium';
  return { effort: normalizedEffort, profile: reasoningProfileName(normalizedEffort), reason, temporary: true };
}

export function context7RequirementText(required: any = true) {
  if (!required) return 'Context7 MCP is optional for this route unless external API/library documentation becomes relevant.';
  return 'Context7 MCP is required before completion: call resolve-library-id for the relevant package or API, then query-docs (or legacy get-library-docs), and let SKS record both PostToolUse events.';
}

export function formatDollarCommandsDetailed(indent: any = '') {
  const width = Math.max(...DOLLAR_COMMANDS.map((c: any) => c.command.length));
  return DOLLAR_COMMANDS.map((c: any) => `${indent}${c.command.padEnd(width)}  ${c.route}: ${c.description}`).join('\n');
}

export function formatDollarCommandsCompact(indent: any = '') {
  const width = Math.max(...DOLLAR_COMMANDS.map((c: any) => c.command.length));
  return DOLLAR_COMMANDS.map((c: any) => `${indent}${c.command.padEnd(width)}  ${c.route}`).join('\n');
}

export function dollarCommandNames() {
  return Array.from(new Set([
    ...DOLLAR_COMMANDS.map((c: any) => c.command),
    ...DOLLAR_COMMAND_ALIASES.map((alias: any) => alias.app_skill)
  ])).join(', ');
}

export function context7ConfigToml(transport: any = 'remote') {
  if (transport === 'remote') return '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n';
  return '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp@latest"]\n';
}

export function hasContext7ConfigText(text: any) {
  const s = String(text || '');
  return /\[mcp_servers\.context7\]/.test(s)
    && (/@upstash\/context7-mcp@latest/.test(s) || /https:\/\/mcp\.context7\.com\/mcp/.test(s));
}
