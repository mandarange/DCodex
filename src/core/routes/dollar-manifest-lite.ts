import { normalizeDollarSkillName, prefixKnownSksDollarReferences, sksPrefixedDollarCommand } from './dollar-prefix.js';

export interface DollarCommandLiteEntry {
  command: string;
  route: string;
  description: string;
}

export interface DollarCommandAliasLiteEntry {
  canonical: string;
  app_skill: string;
}

const NARUTO_DESCRIPTION = '$Naruto is the lightweight Codex official subagent workflow and the default for non-trivial execution. The Sol Max parent dynamically scales useful independent children from a bounded four/six/eight starting policy up to the SKS-owned 256-child ceiling; max_threads is a cap, never a target. A measured lower Codex host cap or explicit provider/API budget remains authoritative. Capacity is the minimum of ready DAG width, disjoint ownership, verifier/tool capacity, available child slots, and positive marginal usefulness. Child routing is fixed to Luna Max mechanical, Sol High implementation, Sol Max judgment, and Terra Max long-context/Computer Use/Browser/ImageGen execution. Duplicate slices and overlapping writes are blocked; explicit --agents remains authoritative.';
const COMPUTER_USE_DESCRIPTION = 'Maximum-speed Codex Computer Use lane for native macOS, desktop-app, OS-settings, and non-web visual tasks only. Browser, localhost, website, webapp, and web-based app verification must route through Codex Chrome Extension readiness first.';

const DOLLAR_COMMANDS_LITE_BASE = [
  { command: '$DFix', route: 'fast direct fix', description: 'Tiny simple direct edits such as copy, labels, typos, wording, spacing, colors, or clearly scoped one-line changes. Bypasses the general SKS pipeline and runs an ultralight, no-record task-list path.' },
  { command: '$Answer', route: 'answer-only research', description: 'Answer questions without starting implementation. Uses TriWiki, web, Context7 when relevant, and Honest Mode fact-checking.' },
  { command: '$SKS', route: 'general SKS workflow', description: 'General Sneakoscope setup, help, status, and workflow routing.' },
  { command: '$Plan', route: 'planning-only frontdoor', description: 'Plan scaffold only: writes a fixed-template .sneakoscope/plans/<slug>.md (goal/scope/steps headings to fill in), not project-specific decision-complete planning. Keeps implementation disallowed until an explicit $Work alias or $Naruto runs the plan.' },
  { command: '$Review', route: 'machine-first diff review', description: 'Review staged or selected diffs with machine evidence sorted above LLM opinion.' },
  { command: '$Fast-Mode', route: 'fast-mode toggle', description: 'Turn the SKS Fast mode default on or off for project-local dollar-command and routed workflows. Explicit --fast, --no-fast, and --service-tier flags still override it.' },
  { command: '$Fast-On', route: 'fast-mode toggle', description: 'Turn the SKS Fast mode default on or off for project-local dollar-command and routed workflows. Explicit --fast, --no-fast, and --service-tier flags still override it.' },
  { command: '$Fast-Off', route: 'fast-mode toggle', description: 'Turn the SKS Fast mode default on or off for project-local dollar-command and routed workflows. Explicit --fast, --no-fast, and --service-tier flags still override it.' },
  { command: '$with-local-llm-on', route: 'local Ollama worker toggle', description: 'Turn the optional local Ollama worker backend on or off. Default off keeps SKS GPT-only; enabled mode lets eligible simple code/collection worker slices use Ollama while GPT/Codex owns strategy, design, review, verification, and integration.' },
  { command: '$with-local-llm-off', route: 'local Ollama worker toggle', description: 'Turn the optional local Ollama worker backend on or off. Default off keeps SKS GPT-only; enabled mode lets eligible simple code/collection worker slices use Ollama while GPT/Codex owns strategy, design, review, verification, and integration.' },
  { command: '$Naruto', route: 'Codex official subagent workflow', description: NARUTO_DESCRIPTION },
  { command: '$Work', route: 'execution alias to the Codex official subagent workflow', description: NARUTO_DESCRIPTION },
  { command: '$Release-Review', route: 'official subagent release review', description: 'Run release-readiness collaboration through Codex official subagent threads with explicit review lanes, bounded thread budgets, structured parent outcomes, evidence, and cleanup artifacts.' },
  { command: '$QA-LOOP', route: 'QA loop', description: 'Dogfood UI/API as human proxy with safety gates, Codex Chrome Extension-first web UI evidence, safe fixes, rechecks, Honest Mode.' },
  { command: '$PPT', route: 'HTML/PDF presentation pipeline', description: 'Create restrained, information-first HTML/PDF presentation artifacts after delivery context, audience profile, STP, decision context, pain-point, research, design-system, and verification questions are sealed.' },
  { command: '$Image-UX-Review', route: 'image-generation UI/UX review loop', description: 'Review UI/UX through the imagegen/gpt-image-2 visual critique loop: source screenshots become generated annotated review images, those images become issue ledgers, then fixes are rechecked.' },
  { command: '$Computer-Use', route: 'native Computer Use fast lane', description: COMPUTER_USE_DESCRIPTION },
  { command: '$CU', route: 'native Computer Use fast lane', description: COMPUTER_USE_DESCRIPTION },
  { command: '$Goal', route: 'Codex native /goal control', description: 'Use Codex native Goal directly with detailed completion criteria; SKS creates no Goal mission, artifact, loop, or fallback state.' },
  { command: '$Commit', route: 'simple git commit', description: 'Summarize current git changes, stage them, and create one commit without the full SKS pipeline.' },
  { command: '$Commit-And-Push', route: 'simple git commit and push', description: 'Summarize current git changes, stage them, create one commit, then run git push without the full SKS pipeline.' },
  { command: '$Research', route: 'research mission', description: 'Frontier discovery with named xhigh persona-lens agents, Eureka ideas, vigorous evidence-bound debate, layered public source retrieval, falsification, a paper manuscript, a final genius-opinion summary, and testable predictions.' },
  { command: '$Super-Search', route: 'provider-independent source intelligence', description: 'Run Super-Search source acquisition, source normalization, claim/proof ledgers, and provider-independent citation evidence without requiring provider-specific credentials.' },
  { command: '$SEO-GEO-OPTIMIZER', route: 'search visibility optimization audit/apply/verify', description: 'Unified SEO/GEO optimizer route for Search Engine Optimization and Generative Engine Optimization. Supports audit, research, strategy, plan, apply, verify, status, rollback, fixture, and --include-marketing through one shared kernel with mode-specific evidence, gates, safe apply, rollback, and Completion Proof. Not a ranking, traffic, or AI citation guarantee.' },
  { command: '$AutoResearch', route: 'iterative experiment loop', description: 'Program, hypothesize, test, measure, keep/discard, falsify, and report evidence.' },
  { command: '$DB', route: 'database safety', description: 'Database, Supabase, migration, SQL, or MCP safety checks.' },
  { command: '$MAD-SKS', route: 'explicit scoped permission-widening modifier plus SQL-plane execution', description: 'Explicit high-risk authorization modifier that can be combined with other $ commands to temporarily open approved target-project scopes such as files, shell, package installs, services, network, Computer Use/browser workflows, generated assets, file permissions, migrations, Supabase MCP DB writes, direct execute SQL, schema cleanup, and normal targeted DB writes for the active invocation.' },
  { command: '$GX', route: 'visual context', description: 'Deterministic GX visual context cartridges.' },
  { command: '$Wiki', route: 'TriWiki refresh and maintenance', description: 'Refresh, pack, validate, or prune TriWiki context packs from Codex App.' },
  { command: '$Align', route: 'evidence-gated GPT-5.6 / Plugins modernization', description: 'One-shot modernization of SKS prompts, settings, and generated skill/command surfaces against current GPT-5.6 prompting, programmatic tool calling, Agents, Codex skill-schema, and Plugins contracts. Records adoption decisions, audits complete surface coverage, removes superseded compatibility settings, and deduplicates policy without weakening invariants.' },
  { command: '$Help', route: 'command help', description: 'Explain installed SKS commands and workflows.' }
] as const satisfies readonly DollarCommandLiteEntry[];

const DOLLAR_COMMAND_ALIASES_LITE_BASE = [
  { canonical: '$DFix', app_skill: '$dfix' },
  { canonical: '$Answer', app_skill: '$answer' },
  { canonical: '$SKS', app_skill: '$sks' },
  { canonical: '$Plan', app_skill: '$plan' },
  { canonical: '$Review', app_skill: '$review' },
  { canonical: '$Fast-Mode', app_skill: '$fast-mode' },
  { canonical: '$Fast-Mode', app_skill: '$fast-on' },
  { canonical: '$Fast-Mode', app_skill: '$fast-off' },
  { canonical: '$with-local-llm-on', app_skill: '$with-local-llm-on' },
  { canonical: '$with-local-llm-on', app_skill: '$with-local-llm-off' },
  { canonical: '$Naruto', app_skill: '$from-chat-img' },
  { canonical: '$Naruto', app_skill: '$naruto' },
  { canonical: '$Naruto', app_skill: '$work' },
  { canonical: '$Release-Review', app_skill: '$release-review' },
  { canonical: '$QA-LOOP', app_skill: '$qa-loop' },
  { canonical: '$PPT', app_skill: '$ppt' },
  { canonical: '$Image-UX-Review', app_skill: '$image-ux-review' },
  { canonical: '$Computer-Use', app_skill: '$computer-use-fast' },
  { canonical: '$Computer-Use', app_skill: '$cu' },
  { canonical: '$Goal', app_skill: '$goal' },
  { canonical: '$Commit', app_skill: '$commit' },
  { canonical: '$Commit-And-Push', app_skill: '$commit-and-push' },
  { canonical: '$Research', app_skill: '$research' },
  { canonical: '$Super-Search', app_skill: '$super-search' },
  { canonical: '$SEO-GEO-OPTIMIZER', app_skill: '$seo-geo-optimizer' },
  { canonical: '$AutoResearch', app_skill: '$autoresearch' },
  { canonical: '$DB', app_skill: '$db' },
  { canonical: '$MAD-SKS', app_skill: '$mad-sks' },
  { canonical: '$GX', app_skill: '$gx' },
  { canonical: '$Wiki', app_skill: '$wiki' },
  { canonical: '$Align', app_skill: '$align' },
  { canonical: '$Help', app_skill: '$help' }
] as const satisfies readonly DollarCommandAliasLiteEntry[];

const LEGACY_LITE_DOLLAR_NAMES = Array.from(new Set([
  ...DOLLAR_COMMANDS_LITE_BASE.map((entry) => normalizeDollarSkillName(entry.command)),
  ...DOLLAR_COMMAND_ALIASES_LITE_BASE.map((entry) => normalizeDollarSkillName(entry.app_skill))
]));

export const DOLLAR_COMMANDS_LITE = DOLLAR_COMMANDS_LITE_BASE.map((entry) => ({
  ...entry,
  command: sksPrefixedDollarCommand(entry.command),
  description: prefixKnownSksDollarReferences(entry.description, LEGACY_LITE_DOLLAR_NAMES)
})) satisfies readonly DollarCommandLiteEntry[];

export const DOLLAR_COMMAND_ALIASES_LITE = DOLLAR_COMMAND_ALIASES_LITE_BASE.map((entry) => ({
  canonical: sksPrefixedDollarCommand(entry.canonical),
  app_skill: sksPrefixedDollarCommand(entry.app_skill)
})) satisfies readonly DollarCommandAliasLiteEntry[];

export function dollarCommandsJsonFast(): void {
  process.stdout.write(`${JSON.stringify({
    dollar_commands: DOLLAR_COMMANDS_LITE,
    app_skill_aliases: DOLLAR_COMMAND_ALIASES_LITE
  }, null, 2)}\n`);
}
