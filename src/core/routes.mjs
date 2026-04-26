export const USAGE_TOPICS = 'install|setup|team|ralph|research|db|codex-app|df|dollar|context7|pipeline|reasoning|guard|conflicts|versioning|eval|gx|wiki';

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
  'db-safety-guard',
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
    validate_command: `${prefix} wiki validate .sneakoscope/wiki/context-pack.json`,
    hydrate_policy: 'hydrate_by_id_hash_source_path_rgba_trig_coordinate',
    selected_text_policy: 'selected_text_is_only_the_visible_slice',
    required_for: ['long_running_routes', 'team_handoffs', 'context_pressure', 'cross_turn_continuity']
  };
}

export function triwikiContextTrackingText(commandPrefix = 'sks') {
  const ctx = triwikiContextTracking(commandPrefix);
  return `Context tracking SSOT: TriWiki. Build or refresh ${ctx.default_pack} with "${ctx.pack_command}" and validate it with "${ctx.validate_command}". Selected text is only the visible slice; non-selected claims remain hydratable by id, hash, source path, and RGBA/trig coordinate.`;
}

export const ROUTES = [
  {
    id: 'DF',
    command: '$DF',
    mode: 'DF',
    route: 'fast design/content fix',
    description: 'Small UI/content edits such as text color, copy, label, spacing, or translation. Avoids heavy loops.',
    requiredSkills: ['df', 'prompt-pipeline', 'honest-mode'],
    lifecycle: ['skill_context', 'smallest_scoped_edit', 'cheap_verification', 'honest_mode'],
    context7Policy: 'if_external_docs',
    reasoningPolicy: 'medium',
    stopGate: 'honest_mode',
    cliEntrypoint: 'sks df',
    examples: ['$DF 글자 색 바꿔줘', '$DF 내용을 영어로 바꿔줘']
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
    description: 'Run parallel analysis scouts, refresh TriWiki, debate with role personas, agree on an objective, close debate agents, then form a fresh executor development team for parallel work.',
    appSkillAliases: ['agent-team'],
    requiredSkills: ['team', 'pipeline-runner', 'context7-docs', 'prompt-pipeline', 'honest-mode'],
    lifecycle: ['parallel_analysis_scouting', 'triwiki_refresh', 'planning_debate', 'live_transcript', 'consensus_artifact', 'fresh_implementation_team', 'review_artifact', 'integration_evidence', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'high',
    stopGate: 'team-gate.json',
    cliEntrypoint: 'sks team "task" [executor:5 reviewer:2 user:1] | sks team log|tail|watch|status|event',
    examples: ['$Team executor:5 agree on the best plan and implement it']
  },
  {
    id: 'Ralph',
    command: '$Ralph',
    mode: 'RALPH',
    route: 'Ralph mission',
    description: 'Mandatory clarification and no-question autonomous mission workflow.',
    requiredSkills: ['ralph', 'ralph-supervisor', 'ralph-resolver', 'pipeline-runner', 'context7-docs', 'honest-mode'],
    lifecycle: ['questions_answered', 'contract_sealed', 'sks_ralph_run', 'done_gate_passed', 'honest_mode'],
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
    requiredSkills: ['research', 'research-discovery', 'pipeline-runner', 'context7-docs', 'honest-mode'],
    lifecycle: ['research_plan', 'report', 'novelty_ledger', 'falsification', 'research_gate', 'honest_mode'],
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
    requiredSkills: ['autoresearch', 'autoresearch-loop', 'seo-geo-optimizer', 'performance-evaluator', 'pipeline-runner', 'context7-docs', 'honest-mode'],
    lifecycle: ['experiment_ledger', 'metric', 'keep_or_discard', 'falsification', 'honest_conclusion'],
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
    requiredSkills: ['db', 'db-safety-guard', 'pipeline-runner', 'context7-docs', 'honest-mode'],
    lifecycle: ['db_scan', 'safe_mcp_policy', 'destructive_operation_zero', 'context7_docs', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'high',
    stopGate: 'db-review.json',
    cliEntrypoint: 'sks db scan',
    examples: ['$DB check this migration safely']
  },
  {
    id: 'GX',
    command: '$GX',
    mode: 'GX',
    route: 'visual context',
    description: 'Deterministic GX visual context cartridges.',
    requiredSkills: ['gx', 'gx-visual-generate', 'gx-visual-read', 'gx-visual-validate', 'pipeline-runner', 'honest-mode'],
    lifecycle: ['vgraph_beta_render', 'validate', 'drift_snapshot', 'honest_mode'],
    context7Policy: 'required',
    reasoningPolicy: 'high',
    stopGate: 'gx-gate.json',
    cliEntrypoint: 'sks gx init|render|validate|drift|snapshot',
    examples: ['$GX render a visual context cartridge']
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

export const DOLLAR_COMMANDS = ROUTES.map(({ command, route, description }) => ({ command, route, description }));
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
  { name: 'codex-app', usage: 'sks codex-app', description: 'Show Codex App setup files and example prompts.' },
  { name: 'dollar-commands', usage: 'sks dollar-commands [--json]', description: 'List Codex App $ commands such as $DF and $Team.' },
  { name: 'df', usage: 'sks df', description: 'Explain $DF fast design/content fix mode.' },
  { name: 'context7', usage: 'sks context7 check|setup|tools|resolve|docs|evidence ...', description: 'Check, configure, and call the local Context7 MCP requirement.' },
  { name: 'pipeline', usage: 'sks pipeline status|resume [--json]', description: 'Inspect the active skill-first route and its completion gates.' },
  { name: 'guard', usage: 'sks guard check [--json]', description: 'Check SKS harness self-protection lock, fingerprints, and source-repo exception state.' },
  { name: 'conflicts', usage: 'sks conflicts check|prompt [--json]', description: 'Detect other Codex harnesses such as OMX/DCodex and print the GPT-5.5 high cleanup prompt.' },
  { name: 'versioning', usage: 'sks versioning status|bump|pre-commit [--json]', description: 'Manage automatic project version bumps on every commit with a shared Git lock.' },
  { name: 'aliases', usage: 'sks aliases', description: 'Show command aliases and npm binary names.' },
  { name: 'setup', usage: 'sks setup [--install-scope global|project] [--local-only] [--force] [--json]', description: 'Initialize SKS state, Codex App files, hooks, skills, and rules.' },
  { name: 'fix-path', usage: 'sks fix-path [--install-scope global|project] [--json]', description: 'Refresh hook commands with the resolved SKS binary path.' },
  { name: 'doctor', usage: 'sks doctor [--fix] [--local-only] [--json] [--install-scope global|project]', description: 'Check and repair SKS generated files, while blocking setup if another Codex harness is detected.' },
  { name: 'init', usage: 'sks init [--force] [--local-only] [--install-scope global|project]', description: 'Initialize the local SKS control surface.' },
  { name: 'selftest', usage: 'sks selftest [--mock]', description: 'Run local smoke tests without calling a model.' },
  { name: 'ralph', usage: 'sks ralph prepare|answer|run|status ...', description: 'Run mandatory-clarification Ralph missions with a no-question execution loop.' },
  { name: 'research', usage: 'sks research prepare|run|status ...', description: 'Run frontier-style research missions with novelty and falsification gates.' },
  { name: 'db', usage: 'sks db policy|scan|mcp-config|classify|check ...', description: 'Inspect and enforce database/Supabase safety policy.' },
  { name: 'eval', usage: 'sks eval run|compare|thresholds ...', description: 'Run deterministic context-quality and performance evidence checks.' },
  { name: 'wiki', usage: 'sks wiki coords|pack|validate ...', description: 'Build and validate RGBA/trig LLM Wiki coordinate context packs.' },
  { name: 'hproof', usage: 'sks hproof check [mission-id|latest]', description: 'Evaluate the H-Proof done gate for a mission.' },
  { name: 'team', usage: 'sks team "task" [executor:5 reviewer:2 user:1]|log|tail|watch|status|event ...', description: 'Create and observe a scout-first Team mission: parallel analysis, TriWiki refresh, role debate, then executor parallel development.' },
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

export function dollarCommand(prompt) {
  const match = String(prompt || '').trim().match(/^\$([A-Za-z][A-Za-z0-9_-]*)(?:\s|:|$)/);
  return match ? match[1].toUpperCase() : null;
}

export function stripDollarCommand(prompt) {
  return String(prompt || '').trim().replace(/^\$[A-Za-z][A-Za-z0-9_-]*(?:\s|:)?\s*/, '').trim();
}

export function looksLikeFastDesignFix(prompt) {
  const text = String(prompt || '');
  const designCue = /(글자|텍스트|문구|내용|색|컬러|폰트|간격|여백|정렬|버튼|라벨|영어|한국어|번역|copy|text|color|font|spacing|padding|margin|align|label|button|translate)/i.test(text);
  const changeCue = /(바꿔|변경|수정|교체|고쳐|영어로|한국어로|change|replace|update|make|turn|translate|fix)/i.test(text);
  return designCue && changeCue;
}

export function routePrompt(prompt) {
  const command = dollarCommand(prompt);
  if (command) return routeById(command) || null;
  const text = String(prompt || '');
  if (looksLikeFastDesignFix(text)) return routeById('DF');
  if (/\b(SQL|Supabase|Postgres|migration|RLS|Prisma|Drizzle|Knex|database|DB|execute_sql|mcp)\b/i.test(text)) return routeById('DB');
  if (/\b(team|multi-agent|subagent|parallel agents|agent team|병렬|팀)\b/i.test(text)) return routeById('Team');
  if (/\b(autoresearch|experiment|benchmark|SEO|GEO|ranking|optimi[sz]e|improve metric|discoverability|visibility|github stars?|npm downloads?|검색|노출|스타|다운로드)\b/i.test(text)) return routeById('AutoResearch');
  if (/\b(research|hypothesis|falsify|novelty|frontier|조사|연구)\b/i.test(text)) return routeById('Research');
  if (/\b(GX|vgraph|visual context|render cartridge|wiki coordinate|rgba|trig|llm wiki)\b/i.test(text)) return routeById('GX');
  return routeById('SKS');
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
  if (route.id === 'Help' || route.id === 'SKS') return false;
  if (route.id === 'Research' || route.id === 'AutoResearch') return true;
  if (route.id === 'Ralph' || route.id === 'DB' || route.id === 'GX') return looksLikeExecutionWork(prompt);
  if (route.id === 'DF') return looksLikeCodeChangingWork(prompt) && !looksLikeFastDesignFix(prompt);
  return looksLikeExecutionWork(prompt);
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
  return DOLLAR_COMMANDS.map((c) => c.command).join(', ');
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
