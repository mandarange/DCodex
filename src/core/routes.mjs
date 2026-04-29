const REFLECTION_SKILL_NAME = 'reflection';
export const FROM_CHAT_IMG_COVERAGE_ARTIFACT = 'from-chat-img-coverage-ledger.json';
export const FROM_CHAT_IMG_CHECKLIST_ARTIFACT = 'from-chat-img-checklist.md';
export const FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT = 'from-chat-img-temp-triwiki.json';
export const FROM_CHAT_IMG_QA_LOOP_ARTIFACT = 'from-chat-img-qa-loop.json';
export const FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS = 5;
export const USAGE_TOPICS = 'install|setup|bootstrap|deps|cmux|auto-review|team|qa-loop|ralph|research|db|codex-app|dfix|design|imagegen|dollar|context7|pipeline|reasoning|guard|conflicts|versioning|eval|hproof|gx|wiki';

export const RECOMMENDED_MCP_SERVERS = [
  {
    id: 'context7',
    required: true,
    transport: 'local',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
    remote_url: 'https://mcp.context7.com/mcp',
    purpose: 'Current library/API/framework documentation for route gates.'
  }
];

export const RECOMMENDED_SKILLS = [
  'reasoning-router',
  'pipeline-runner',
  'context7-docs',
  'seo-geo-optimizer',
  'autoresearch-loop',
  'performance-evaluator',
  'design-artifact-expert',
  'design-system-builder',
  'design-ui-editor',
  'imagegen',
  'db-safety-guard',
  REFLECTION_SKILL_NAME,
  'honest-mode'
];

export function dollarSkillName(commandOrId) {
  return String(commandOrId || '').replace(/^\$/, '').toLowerCase();
}

export function triwikiContextTracking(commandPrefix = 'sks') {
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
    required_for: ['every_work_stage', 'long_running_routes', 'team_handoffs', 'context_pressure', 'cross_turn_continuity']
  };
}


export function stackCurrentDocsPolicy(commandPrefix = 'sks') {
  const prefix = String(commandPrefix || 'sks');
  return {
    trigger: 'when_tech_stack_is_added_or_package_framework_runtime_version_changes',
    evidence_required: ['context7_resolve_library_id_and_query_docs', 'or_official_vendor_web_docs'],
    memory_path: '.sneakoscope/memory/q2_facts/stack-current-docs.md',
    refresh_command: `${prefix} wiki refresh`,
    validate_command: `${prefix} wiki validate .sneakoscope/wiki/context-pack.json`,
    priority: 'must_precede_coding_style_defaults',
    examples: [
      'Supabase hosted projects should prefer sb_publishable_ and sb_secret_ keys over legacy anon/service_role keys when current docs apply.',
      'Next.js 16 deprecates the middleware file convention in favor of proxy.ts/proxy.js.',
      'Vercel Function duration limits, including the 300s default with Fluid Compute, are deployment constraints that must shape long-running server work.'
    ]
  };
}

export function stackCurrentDocsPolicyText(commandPrefix = 'sks') {
  const policy = stackCurrentDocsPolicy(commandPrefix);
  return `Stack current-docs policy: whenever project tech stack is added or a framework/package/runtime/platform version changes, fetch current docs with Context7 (resolve-library-id then query-docs) or official vendor web docs before coding, record the syntax/limits/security guidance as high-priority TriWiki claims in ${policy.memory_path}, run "${policy.refresh_command}", then "${policy.validate_command}". Treat these claims as higher priority than model-memory defaults. Examples include Supabase publishable/secret keys replacing legacy anon/service_role guidance for hosted projects, Next.js 16 proxy.ts/proxy.js replacing the deprecated middleware file convention, avoiding stale webpack defaults when newer framework guidance says otherwise, and Vercel Function duration limits such as the 300s default under Fluid Compute.`;
}

export function triwikiContextTrackingText(commandPrefix = 'sks') {
  const ctx = triwikiContextTracking(commandPrefix);
  return `Context tracking SSOT: TriWiki. Use only the latest TriWiki pack shape at every work stage: ${ctx.required_schema}; coordinate-only legacy packs are invalid and must be refreshed before use. Read ${ctx.default_pack} before each route phase, consume attention.use_first as the compact high-trust recall set, hydrate attention.hydrate_first from source before risky or lower-trust decisions, refresh with "${ctx.refresh_command}" or "${ctx.pack_command}" after new findings/artifact changes, prune stale/oversized wiki state with "${ctx.prune_command}" when retention matters, and validate with "${ctx.validate_command}" before each handoff or final claim. Selected text is only the visible slice; non-selected claims remain hydratable by id, hash, source path, and RGBA/trig coordinate. Follow high-trust claims unless newer source evidence contradicts them; low-trust claims should trigger source/evidence hydration before implementation or final claims. ${stackCurrentDocsPolicyText(commandPrefix)}`;
}

export function triwikiStagePolicyText(commandPrefix = 'sks') {
  const ctx = triwikiContextTracking(commandPrefix);
  return [
    'TriWiki stage policy:',
    `- Before each route phase, read the relevant parts of ${ctx.default_pack} instead of relying on memory or a one-time initial summary; the pack must validate as ${ctx.required_schema}.`,
    '- Consume `attention.use_first` for the fastest high-trust context path; hydrate `attention.hydrate_first` from source before making risky, user-visible, or final claims.',
    `- If a TriWiki pack is coordinate-only or lacks voxel overlay metadata, run "${ctx.refresh_command}" or "${ctx.pack_command}" and do not use the legacy pack for pipeline decisions.`,
    '- During the phase, when a decision touches a wiki claim, hydrate low-trust or stale claims from their source path/hash/RGBA anchor before relying on them.',
    `- After new findings, changed artifacts, scout results, debate conclusions, implementation changes, reviews, or blockers, run "${ctx.refresh_command}" or "${ctx.pack_command}" so later stages see the update.`,
    `- When package manifests, framework versions, runtime targets, MCPs, SDKs, DB clients, or deployment platforms change, add current official docs or Context7 evidence to ${stackCurrentDocsPolicy(commandPrefix).memory_path}, refresh/validate TriWiki, and make those claims the coding baseline.`,
    `- Before every handoff and before final output, run or require "${ctx.validate_command}" and re-check high-impact claims against current sources.`
  ].join('\n');
}

export function chatCaptureIntakeText() {
  return `From-Chat-IMG intake: explicit signal only. Treat uploads as chat screenshot plus originals, use Computer Use/browser visual inspection when available, list requirements first in source order, match regions to attachments with confidence, and write ${FROM_CHAT_IMG_COVERAGE_ARTIFACT}, ${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}, ${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}, and ${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}. Preserve each visible customer request as source-bound text, account for every screenshot image region and separate attachment, map each item to work-order actions, perform the customer-request work, then run a scoped QA-LOOP over that exact work-order range before Team completion. Update checklist checkboxes as work proceeds until all boxes are checked, unresolved_items is empty, scoped_qa_loop_completed=true, and QA unresolved findings are zero. ${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT} is temporary TriWiki-backed session context with expires_after_sessions=${FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS}, so it can be forgotten by retention after enough later sessions. Do not assume ordinary image prompts are chat captures.`;
}

export function hasFromChatImgSignal(prompt = '') {
  return /(?:^|\s)\$?from-chat-img(?:\s|:|$)/i.test(String(prompt || ''));
}

export function looksLikeChatCaptureRequest(prompt = '') {
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
    route: 'fast design/content fix',
    description: 'Small UI/content edits such as text color, copy, label, spacing, or translation. Bypasses the general SKS pipeline and runs an ultralight task-list path.',
    requiredSkills: ['dfix'],
    lifecycle: ['micro_task_list', 'targeted_inspection', 'listed_edits_only', 'cheap_verification'],
    context7Policy: 'optional',
    reasoningPolicy: 'medium',
    stopGate: 'none',
    cliEntrypoint: 'sks dfix',
    examples: ['$DFix 글자 색 바꿔줘', '$DFix 내용을 영어로 바꿔줘']
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
    cliEntrypoint: 'implicit question route',
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
    cliEntrypoint: 'sks commands',
    examples: ['$SKS show me available workflows']
  },
  {
    id: 'Team',
    command: '$Team',
    mode: 'TEAM',
    route: 'multi-agent team orchestration',
    description: 'Run parallel analysis scouts, refresh TriWiki, debate, compile a concrete runtime task graph with worker inboxes, form a fresh executor team, then clean up team sessions before final evidence.',
    requiredSkills: ['team', 'pipeline-runner', 'context7-docs', 'prompt-pipeline', REFLECTION_SKILL_NAME, 'honest-mode'],
    dollarAliases: ['$From-Chat-IMG'],
    appSkillAliases: ['from-chat-img'],
    lifecycle: ['parallel_analysis_scouting', 'triwiki_refresh', 'planning_debate', 'live_transcript', 'consensus_artifact', 'fresh_implementation_team', 'review_artifact', 'integration_evidence', 'session_cleanup', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'high',
    stopGate: 'team-gate.json',
    cliEntrypoint: 'sks team "task" [executor:5 reviewer:2 user:1] | sks team log|tail|watch|status|event',
    examples: ['$Team executor:5 agree on the best plan and implement it', '$From-Chat-IMG 채팅+첨부 이미지 작업 지시서']
  },
  {
    id: 'QALoop',
    command: '$QA-LOOP',
    mode: 'QALOOP',
    route: 'QA loop',
    description: 'Dogfood UI/API as human proxy with safety gates, Browser/Computer evidence, safe fixes, rechecks, Honest Mode.',
    requiredSkills: ['qa-loop', 'pipeline-runner', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['qa_questions_answered', 'contract_sealed', 'qa_checklist', 'qa_loop_cycles', 'safe_remediation', 'focused_reverification', 'qa_report_md', 'qa_gate', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'optional',
    reasoningPolicy: 'high',
    stopGate: 'qa-gate.json',
    cliEntrypoint: 'sks qa-loop prepare|answer|run|status',
    examples: ['$QA-LOOP dogfood UI and API against local dev', '$QA-LOOP deployed smoke only']
  },
  {
    id: 'Ralph',
    command: '$Ralph',
    mode: 'RALPH',
    route: 'Ralph mission',
    description: 'Mandatory clarification and no-question autonomous mission workflow.',
    requiredSkills: ['ralph', 'ralph-supervisor', 'ralph-resolver', 'pipeline-runner', 'context7-docs', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['questions_answered', 'contract_sealed', 'sks_ralph_run', 'done_gate_passed', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'high',
    stopGate: 'done-gate.json',
    cliEntrypoint: 'sks ralph prepare|answer|run',
    examples: ['$Ralph implement this with mandatory clarification']
  },
  {
    id: 'Research',
    command: '$Research',
    mode: 'RESEARCH',
    route: 'research mission',
    description: 'Frontier discovery, hypotheses, falsification, and testable predictions.',
    requiredSkills: ['research', 'research-discovery', 'pipeline-runner', 'context7-docs', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['research_plan', 'report', 'novelty_ledger', 'falsification', 'research_gate', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'xhigh',
    stopGate: 'research-gate.json',
    cliEntrypoint: 'sks research prepare|run',
    examples: ['$Research investigate this idea']
  },
  {
    id: 'AutoResearch',
    command: '$AutoResearch',
    mode: 'AUTORESEARCH',
    route: 'iterative experiment loop',
    description: 'Program, hypothesize, test, measure, keep/discard, falsify, and report evidence.',
    requiredSkills: ['autoresearch', 'autoresearch-loop', 'seo-geo-optimizer', 'performance-evaluator', 'pipeline-runner', 'context7-docs', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['experiment_ledger', 'metric', 'keep_or_discard', 'falsification', 'post_route_reflection', 'honest_conclusion'],
    context7Policy: 'required',
    reasoningPolicy: 'xhigh',
    stopGate: 'autoresearch-gate.json',
    cliEntrypoint: 'sks pipeline status',
    examples: ['$AutoResearch improve this workflow with experiments']
  },
  {
    id: 'DB',
    command: '$DB',
    mode: 'DB',
    route: 'database safety',
    description: 'Database, Supabase, migration, SQL, or MCP safety checks.',
    requiredSkills: ['db', 'db-safety-guard', 'pipeline-runner', 'context7-docs', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['db_scan', 'safe_mcp_policy', 'destructive_operation_zero', 'context7_docs', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'high',
    stopGate: 'db-review.json',
    cliEntrypoint: 'sks db scan',
    examples: ['$DB check this migration safely']
  },
  {
    id: 'MadSKS',
    command: '$MAD-SKS',
    mode: 'MADSKS',
    route: 'explicit scoped database authorization modifier',
    description: 'Explicit high-risk authorization modifier that can be combined with other $ commands to temporarily widen Supabase MCP DB permissions for that active invocation only; table deletion still requires user confirmation with an approximately 30 second timeout.',
    requiredSkills: ['mad-sks', 'db-safety-guard', 'pipeline-runner', 'context7-docs', REFLECTION_SKILL_NAME, 'honest-mode'],
    lifecycle: ['explicit_invocation', 'auto_sealed_permission_scope', 'scoped_db_override', 'table_delete_confirmation_gate', 'permission_deactivation', 'post_route_reflection', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'high',
    stopGate: 'mad-sks-gate.json',
    cliEntrypoint: 'Codex App prompt route only: $MAD-SKS <task>',
    examples: ['$MAD-SKS $Team Supabase MCP로 main 대상 DB 작업을 수행하되 테이블 삭제는 확인받아', '$DB Supabase 점검 $MAD-SKS']
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
    cliEntrypoint: 'sks wiki refresh|pack|validate|prune',
    examples: ['$Wiki refresh', '$Wiki prune and validate']
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
    cliEntrypoint: 'sks help',
    examples: ['$Help show available SKS commands']
  }
];

export const DOLLAR_COMMANDS = ROUTES.flatMap(({ command, route, description, dollarAliases = [] }) => [
  { command, route, description },
  ...dollarAliases.map((alias) => ({ command: alias, route, description }))
]);
export const DOLLAR_SKILL_NAMES = ROUTES.flatMap((route) => [
  dollarSkillName(route.command),
  ...(route.appSkillAliases || [])
]);
export const DOLLAR_COMMAND_ALIASES = ROUTES.flatMap((route) => [
  { canonical: route.command, app_skill: `$${dollarSkillName(route.command)}` },
  ...(route.appSkillAliases || []).map((alias) => ({ canonical: route.command, app_skill: `$${alias}` }))
]);

export const COMMAND_CATALOG = [
  { name: 'help', usage: 'sks help [topic]', description: 'Show CLI help or focused help for a topic.' },
  { name: 'version', usage: 'sks version | sks --version', description: 'Print the installed Sneakoscope Codex version.' },
  { name: 'update-check', usage: 'sks update-check [--json]', description: 'Check npm for the latest Sneakoscope Codex version.' },
  { name: 'wizard', usage: 'sks wizard', description: 'Open an interactive setup UI for install scope, setup, doctor, and verification.' },
  { name: 'commands', usage: 'sks commands [--json]', description: 'List every user-facing command with a short description.' },
  { name: 'usage', usage: `sks usage [${USAGE_TOPICS}]`, description: 'Print copy-ready workflows for common tasks.' },
  { name: 'quickstart', usage: 'sks quickstart', description: 'Show the shortest safe setup and verification flow.' },
  { name: 'bootstrap', usage: 'sks bootstrap [--install-scope global|project] [--local-only] [--json]', description: 'Initialize the current project, install SKS Codex App files/skills, check Context7/Codex App/cmux, and print ready true/false.' },
  { name: 'deps', usage: 'sks deps check|install [cmux|codex|context7|all] [--yes]', description: 'Check or guided-install Node/npm PATH, Codex CLI/App, Context7, Browser Use, Computer Use, cmux, and Homebrew on macOS.' },
  { name: 'codex-app', usage: 'sks codex-app [check|open]', description: 'Check Codex App install and first-party MCP/plugin readiness, then show app setup files and examples.' },
  { name: 'cmux', usage: 'sks cmux [check|status] [--workspace name]', description: 'Open the SKS cmux runtime with the ㅅㅋㅅ ASCII status pane and Codex CLI.' },
  { name: 'mad', usage: 'sks --mad [--high]', description: 'Open a one-shot cmux Codex CLI workspace with the SKS MAD full-access auto-review profile.' },
  { name: 'auto-review', usage: 'sks auto-review status|enable|start [--high] | sks --Auto-review --high', description: 'Enable Codex automatic approval review and launch SKS cmux with the auto-review profile.' },
  { name: 'dollar-commands', usage: 'sks dollar-commands [--json]', description: 'List Codex App $ commands such as $DFix and $Team.' },
  { name: 'dfix', usage: 'sks dfix', description: 'Explain $DFix ultralight design/content fix mode.' },
  { name: 'qa-loop', usage: 'sks qa-loop prepare|answer|run|status ...', description: 'Dogfood UI/API as human proxy with safety gates, safe fixes, rechecks, Browser/Computer evidence, report.' },
  { name: 'context7', usage: 'sks context7 check|setup|tools|resolve|docs|evidence ...', description: 'Check, configure, and call the local Context7 MCP requirement.' },
  { name: 'pipeline', usage: 'sks pipeline status|resume|answer ...', description: 'Inspect the active skill-first route, pass mandatory ambiguity gates, and inspect completion gates.' },
  { name: 'guard', usage: 'sks guard check [--json]', description: 'Check SKS harness self-protection lock, fingerprints, and source-repo exception state.' },
  { name: 'conflicts', usage: 'sks conflicts check|prompt [--json]', description: 'Detect other Codex harnesses such as OMX/DCodex and print the GPT-5.5 high cleanup prompt.' },
  { name: 'versioning', usage: 'sks versioning status|bump|pre-commit [--json]', description: 'Manage automatic project version bumps on every commit with a shared Git lock.' },
  { name: 'aliases', usage: 'sks aliases', description: 'Show command aliases and npm binary names.' },
  { name: 'setup', usage: 'sks setup [--bootstrap] [--install-scope global|project] [--local-only] [--force] [--json]', description: 'Initialize SKS state, Codex App files, hooks, skills, and rules.' },
  { name: 'fix-path', usage: 'sks fix-path [--install-scope global|project] [--json]', description: 'Refresh hook commands with the resolved SKS binary path.' },
  { name: 'doctor', usage: 'sks doctor [--fix] [--local-only] [--json] [--install-scope global|project]', description: 'Check and repair SKS generated files, while blocking setup if another Codex harness is detected.' },
  { name: 'init', usage: 'sks init [--force] [--local-only] [--install-scope global|project]', description: 'Initialize the local SKS control surface.' },
  { name: 'selftest', usage: 'sks selftest [--mock]', description: 'Run local smoke tests without calling a model.' },
  { name: 'ralph', usage: 'sks ralph prepare|answer|run|status ...', description: 'Run mandatory-clarification Ralph missions with a no-question execution loop.' },
  { name: 'research', usage: 'sks research prepare|run|status ...', description: 'Run frontier-style research missions with novelty and falsification gates.' },
  { name: 'db', usage: 'sks db policy|scan|mcp-config|classify|check ...', description: 'Inspect and enforce database/Supabase safety policy.' },
  { name: 'eval', usage: 'sks eval run|compare|thresholds ...', description: 'Run deterministic context-quality and performance evidence checks.' },
  { name: 'wiki', usage: 'sks wiki coords|pack|refresh|prune|validate ...', description: 'Build, refresh, prune, and validate RGBA/trig LLM Wiki context packs with attention.use_first and attention.hydrate_first for compact recall plus source hydration.' },
  { name: 'hproof', usage: 'sks hproof check [mission-id|latest]', description: 'Evaluate the H-Proof done gate for a mission.' },
  { name: 'team', usage: 'sks team "task" [executor:5 reviewer:2 user:1]|log|tail|watch|status|event ...', description: 'Create and observe a scout-first Team mission: parallel analysis, TriWiki attention, role debate, runtime graph/inbox handoff, then executor parallel development.' },
  { name: 'reasoning', usage: 'sks reasoning ["prompt"] [--json]', description: 'Show SKS temporary reasoning-effort routing: medium for simple tasks, high for logic, xhigh for research.' },
  { name: 'gx', usage: 'sks gx init|render|validate|drift|snapshot [name]', description: 'Create and verify deterministic SVG/HTML visual context cartridges.' },
  { name: 'profile', usage: 'sks profile show|set <model>', description: 'Inspect or set the current SKS model profile metadata.' },
  { name: 'gc', usage: 'sks gc [--dry-run] [--json]', description: 'Compact oversized logs and prune stale runtime artifacts.' },
  { name: 'memory', usage: 'sks memory [--dry-run] [--json]', description: 'Alias for SKS garbage collection and retention handling.' },
  { name: 'stats', usage: 'sks stats [--json]', description: 'Show package and .sneakoscope storage size.' }
];

export function routeById(id) {
  const key = String(id || '').replace(/^\$/, '').toLowerCase();
  return ROUTES.find((route) => {
    const aliases = [
      route.id,
      route.mode,
      dollarSkillName(route.command),
      ...(route.appSkillAliases || [])
    ].map((x) => String(x || '').toLowerCase());
    return aliases.includes(key);
  }) || null;
}

export function routeByDollarCommand(commandName) {
  const key = String(commandName || '').replace(/^\$/, '').toLowerCase();
  return ROUTES.find((route) => [
    dollarSkillName(route.command),
    ...(route.dollarAliases || []).map((alias) => dollarSkillName(alias)),
    ...(route.appSkillAliases || [])
  ].includes(key)) || null;
}

export function dollarCommand(prompt) {
  const match = String(prompt || '').trim().match(/^\$([A-Za-z][A-Za-z0-9_-]*)(?:\s|:|$)/);
  return match ? match[1].toUpperCase() : null;
}

export function hasMadSksSignal(prompt = '') {
  return /(?:^|\s)\$MAD-SKS(?:\s|:|$)/i.test(String(prompt || ''));
}

export function stripMadSksSignal(prompt = '') {
  return String(prompt || '').replace(/(?:^|\s)\$MAD-SKS(?:\s|:)?/ig, ' ').replace(/\s+/g, ' ').trim();
}

export function stripDollarCommand(prompt) {
  return String(prompt || '').trim().replace(/^\$[A-Za-z][A-Za-z0-9_-]*(?:\s|:)?\s*/, '').trim();
}

export function looksLikeFastDesignFix(prompt) {
  const text = String(prompt || '');
  const designCue = /(글자|텍스트|문구|내용|색|컬러|폰트|간격|여백|정렬|버튼|라벨|영어|한국어|번역|copy|text|color|font|spacing|padding|margin|align|label|button|translate)/i.test(text);
  const changeCue = /(바꿔|변경|수정|교체|고쳐|영어로|한국어로|change|replace|update|make|turn|translate|fix)/i.test(text);
  return designCue && changeCue && (!looksLikeAnswerOnlyRequest(text) || looksLikeDirectWorkRequest(text));
}

export function routePrompt(prompt) {
  const command = dollarCommand(prompt);
  const text = String(prompt || '');
  if (command) {
    if (command === 'MAD-SKS') {
      const afterModifier = stripMadSksSignal(text);
      const nestedCommand = dollarCommand(afterModifier);
      if (nestedCommand) return routeByDollarCommand(nestedCommand) || routeById('MadSKS');
      if (looksLikeAnswerOnlyRequest(afterModifier)) return routeById('Answer');
      if (looksLikeFastDesignFix(afterModifier)) return routeById('DFix');
      if (looksLikeCodeChangingWork(afterModifier) || looksLikeDirectWorkRequest(afterModifier)) return routeById('Team');
      return routeById('MadSKS');
    }
    const route = routeByDollarCommand(command) || null;
    if (route?.id === 'SKS' && looksLikeTeamDefaultWork(stripDollarCommand(text))) return routeById('Team');
    return route;
  }
  if (hasFromChatImgSignal(text)) return routeById('Team');
  if (looksLikeFastDesignFix(text)) return routeById('DFix');
  if (looksLikeQuestionShapedDirective(text)) return routeById('Team');
  if (looksLikeAnswerOnlyRequest(text)) return routeById('Answer');
  if (/\b(SQL|Supabase|Postgres|migration|RLS|Prisma|Drizzle|Knex|database|DB|execute_sql|mcp)\b/i.test(text)) return routeById('DB');
  if (/\b(team|multi-agent|subagent|parallel agents|agent team)\b|병렬|팀/i.test(text)) return routeById('Team');
  if (looksLikeChatCaptureRequest(text) && !looksLikeAnswerOnlyRequest(text)) return routeById('Team');
  if (/\b(qa[-\s]?loop|qaloop|e2e\s+qa|qa\s+e2e)\b/i.test(text)) return routeById('QALoop');
  if (/\b(autoresearch|experiment|benchmark|SEO|GEO|ranking|optimi[sz]e|improve metric|discoverability|visibility|github stars?|npm downloads?|검색|노출|스타|다운로드)\b/i.test(text)) return routeById('AutoResearch');
  if (/\b(research|hypothesis|falsify|novelty|frontier|조사|연구)\b/i.test(text)) return routeById('Research');
  if (/(wiki\s+(refresh|pack|validate|prune)|triwiki\s+(refresh|pack|validate)|위키\s*(갱신|리프레시|정리|검증|패킹)|트라이위키|triwiki)/i.test(text)) return routeById('Wiki');
  if (/\b(GX|vgraph|visual context|render cartridge|wiki coordinate|rgba|trig|llm wiki)\b/i.test(text)) return routeById('GX');
  if (looksLikeTeamDefaultWork(text)) return routeById('Team');
  return routeById('SKS');
}

export function looksLikeTeamDefaultWork(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (looksLikeFastDesignFix(text) || looksLikeAnswerOnlyRequest(text)) return false;
  return looksLikeCodeChangingWork(text) || looksLikeDirectWorkRequest(text);
}

export function looksLikeAnswerOnlyRequest(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (looksLikeQuestionShapedDirective(text)) return false;
  const infoCue = /(왜|뭐야|무엇|뭔가|어떤|어떻게|언제|어디|누구|얼마|가능해|맞아|인가|인지|차이|의미|원리|이유|방법|설명|알려줘|요약|정리|비교|찾아줘|찾아봐|검색|조사|근거|출처|fact|source|cite|explain|what|why|how|when|where|who|which|whether|compare|summari[sz]e|search|look up|research|tell me|question|\?)/i.test(text);
  if (!infoCue) return false;
  return !looksLikeDirectWorkRequest(text);
}

export function looksLikeQuestionShapedDirective(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) return false;
  const directive = /(반드시|필수|무조건|해야\s*(?:해|함|돼|한다|하지|한다는|되는)|해야지|해야돼|해야한다|알지|기억해|파악해야|구분해야|막아야|보장해야|강제|기본적으로)/i.test(text);
  const pipelineCue = /(질문|질문형|암묵|지시|파이프라인|라우팅|route|routing|team|팀|sks|기본|구성|게이트|gate|작업|수정|구현|실행)/i.test(text);
  const complaint = /(왜|근데|그런데).*(안\s*하|안\s*되|없이|누락|빠뜨|생략|스킵|못\s*하).*(많|자주|계속|이렇게|함|하지|하냐|하니|\?)/i.test(text);
  return (directive && pipelineCue) || complaint;
}

export function looksLikeDirectWorkRequest(prompt = '') {
  const text = String(prompt || '');
  return looksLikeCodeChangingWork(text)
    || looksLikeChatCaptureRequest(text)
    || looksLikeQuestionShapedDirective(text)
    || /(작업|파이프라인|구현|수정|변경|추가|적용|반영|처리|수행|검수|설치|리드미|README).*(해줘|해달|해라|해야|되게|줘야|줘야지|달라)/i.test(text)
    || /(진행해|수행해|작업해|처리해|적용해|반영해|검수해|고쳐줘|바꿔줘|만들어줘|해줘야|해줘야지|해달라|해야지|되게 해|install|run|execute|test|deploy|commit|push)/i.test(text);
}

export function routeNeedsContext7(route, prompt = '') {
  if (!route) return false;
  if (route.context7Policy === 'required') return true;
  if (route.context7Policy !== 'if_external_docs') return false;
  return /\b(package|library|framework|SDK|API|MCP|Supabase|React|Next|Vue|Svelte|Vite|Prisma|Drizzle|Knex|Postgres|npm|node_modules|docs?|documentation)\b/i.test(String(prompt || ''));
}

export function routeRequiresSubagents(route, prompt = '') {
  if (!route) return false;
  if (route.id === 'Team') return true;
  if (route.id === 'SKS') return looksLikeTeamDefaultWork(prompt);
  if (route.id === 'Help' || route.id === 'Answer' || route.id === 'Wiki') return false;
  if (route.id === 'Research' || route.id === 'AutoResearch') return true;
  if (route.id === 'Ralph' || route.id === 'DB' || route.id === 'GX') return looksLikeExecutionWork(prompt);
  if (route.id === 'DFix') return looksLikeCodeChangingWork(prompt) && !looksLikeFastDesignFix(prompt);
  return looksLikeExecutionWork(prompt);
}

export function reflectionRequiredForRoute(route) {
  const id = String(route?.id || route?.mode || route?.route || route || '').replace(/^\$/, '');
  return /^(team|qaloop|qa-loop|ralph|research|autoresearch|db|database|madsks|mad-sks|gx)$/i.test(id);
}

export function looksLikeCodeChangingWork(prompt = '') {
  return /\b(implement|build|add|edit|modify|change|fix|refactor|rewrite|migrate|create|delete|remove|rename|update|patch|코드|구현|개발|수정|변경|추가|삭제|고쳐|바꿔|리팩터|마이그레이션)\b/i.test(String(prompt || ''));
}

export function looksLikeExecutionWork(prompt = '') {
  const text = String(prompt || '');
  return looksLikeCodeChangingWork(text)
    || /\b(test|verify|run|doctor|setup|install|lint|typecheck|selftest|release|publish|execute|실행|검증|테스트|설치|배포)\b/i.test(text);
}

export function subagentExecutionPolicyText(route, prompt = '') {
  const required = routeRequiresSubagents(route, prompt);
  if (!required) {
    return 'Subagent policy: optional for this route; use subagents only when parallel exploration materially helps.';
  }
  return [
    'Subagent policy: REQUIRED for code-changing or execution work in this route.',
    'Before editing, the parent orchestrator must visibly state the SKS route, split independent write scopes, and spawn worker/reviewer subagents whenever the tools are available.',
    'Run workers in parallel only with disjoint ownership. The parent owns integration, verification, and final evidence.',
    'If subagent tools are unavailable or the work cannot be safely split, record that as explicit subagent evidence before editing.'
  ].join(' ');
}

export function routeReasoning(route, prompt = '') {
  const text = String(prompt || '');
  const base = route?.reasoningPolicy || 'medium';
  if (route?.id === 'Research' || route?.id === 'AutoResearch') return reasoning('xhigh', 'research_or_experiment_route');
  if (/\b(research|autoresearch|hypothesis|falsify|novelty|frontier|benchmark|experiment|SEO|GEO|ranking|연구|실험|가설|검증)\b/i.test(text)) return reasoning('xhigh', 'research_level_prompt');
  if (base === 'high' || /\b(architecture|design|migration|database|security|parallel|orchestrat|refactor|algorithm|logic|tradeoff|검토|설계|마이그레이션|보안|병렬|팀|논리)\b/i.test(text)) return reasoning('high', 'logical_or_safety_work');
  return reasoning('medium', 'simple_fulfillment');
}

export function reasoningProfileName(effort) {
  if (effort === 'xhigh') return 'sks-research-xhigh';
  if (effort === 'high') return 'sks-logic-high';
  return 'sks-task-medium';
}

export function reasoningInstruction(info) {
  const profile = reasoningProfileName(info?.effort);
  return `Temporary reasoning route: use ${info?.effort || 'medium'} reasoning (${profile}) for this SKS route only; do not persist profile changes, and return to the default/user-selected profile after the route gate passes.`;
}

function reasoning(effort, reason) {
  return { effort, profile: reasoningProfileName(effort), reason, temporary: true };
}

export function context7RequirementText(required = true) {
  if (!required) return 'Context7 MCP is optional for this route unless external API/library documentation becomes relevant.';
  return 'Context7 MCP is required before completion: call resolve-library-id for the relevant package or API, then query-docs (or legacy get-library-docs), and let SKS record both PostToolUse events.';
}

export function formatDollarCommandsDetailed(indent = '') {
  const width = Math.max(...DOLLAR_COMMANDS.map((c) => c.command.length));
  return DOLLAR_COMMANDS.map((c) => `${indent}${c.command.padEnd(width)}  ${c.route}: ${c.description}`).join('\n');
}

export function formatDollarCommandsCompact(indent = '') {
  const width = Math.max(...DOLLAR_COMMANDS.map((c) => c.command.length));
  return DOLLAR_COMMANDS.map((c) => `${indent}${c.command.padEnd(width)}  ${c.route}`).join('\n');
}

export function dollarCommandNames() {
  return Array.from(new Set([
    ...DOLLAR_COMMANDS.map((c) => c.command),
    ...DOLLAR_COMMAND_ALIASES.map((alias) => alias.app_skill)
  ])).join(', ');
}

export function context7ConfigToml(transport = 'local') {
  if (transport === 'remote') return '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n';
  return '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp@latest"]\n';
}

export function hasContext7ConfigText(text) {
  const s = String(text || '');
  return /\[mcp_servers\.context7\]/.test(s)
    && (/@upstash\/context7-mcp@latest/.test(s) || /https:\/\/mcp\.context7\.com\/mcp/.test(s));
}
