import { NARUTO_ACTIONS } from '../core/safety/command-contract/types.js';

export type CommandMaturity = 'stable' | 'beta' | 'labs';
export type CommandRiskLite = 'R0' | 'R1' | 'R2' | 'R3';
export type CommandLatencyLite = 'fast' | 'normal' | 'long';
export type CommandInputProfileLite =
  | 'none'
  | 'json-only'
  | 'naruto'
  | 'paths'
  | 'pipeline-status'
  | 'stats'
  | 'stop-gate'
  | 'proof'
  | 'trust'
  | 'gates'
  | 'validate-artifacts';

export interface CommandManifestLiteEntry {
  name: string;
  summary: string;
  maturity: CommandMaturity;
  readonly?: boolean;
  diagnostic?: boolean;
  allowedDuringActiveRoute?: boolean;
  skipMigrationGate?: boolean;
  mutatesRouteState?: boolean;
  deprecated?: boolean;
  hidden?: boolean;
  risk: CommandRiskLite;
  latency: CommandLatencyLite;
  supportsJson: boolean;
  remoteAllowed: boolean;
  telegramAllowed: boolean;
  inputProfile: CommandInputProfileLite;
  requiredCapabilities: readonly string[];
}

type CommandManifestLiteSourceEntry = Omit<CommandManifestLiteEntry,
  'risk' | 'latency' | 'supportsJson' | 'remoteAllowed' | 'telegramAllowed' | 'inputProfile' | 'requiredCapabilities'>;

export type CommandContractMetadataLite = Pick<CommandManifestLiteEntry,
  'risk' | 'latency' | 'supportsJson' | 'remoteAllowed' | 'telegramAllowed' | 'inputProfile' | 'requiredCapabilities'>;

const COMMAND_MANIFEST_LITE_BASE = [
  { name: 'help', summary: 'Show SKS help', maturity: 'stable', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'version', summary: 'Show SKS version', maturity: 'stable', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'commands', summary: 'List SKS commands', maturity: 'stable', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'check', summary: 'Run five-minute proof-bank affected checks', maturity: 'stable', skipMigrationGate: true },
  { name: 'gates', summary: 'Run release gate DAG by gate id or preset', maturity: 'stable', skipMigrationGate: true },
  { name: 'task', summary: 'Run an SLA-bounded SKS task check', maturity: 'stable', skipMigrationGate: true },
  { name: 'release', summary: 'Run affected/full/background release gates', maturity: 'stable', skipMigrationGate: true },
  { name: 'triwiki', summary: 'Inspect TriWiki index, affected graph, and proof bank', maturity: 'stable', skipMigrationGate: true },
  { name: 'daemon', summary: 'Inspect or warm the local SKS daemon cache', maturity: 'stable', skipMigrationGate: true },
  { name: 'run', summary: 'Classify and execute a task through the SKS trust kernel', maturity: 'beta' },
  { name: 'plan', summary: 'Write a planning-only SKS plan artifact without code edits', maturity: 'stable' },
  { name: 'status', summary: 'Show concise active mission and trust status', maturity: 'stable', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'review', summary: 'Review a git diff with machine evidence first', maturity: 'stable', allowedDuringActiveRoute: true },
  { name: 'root', summary: 'Show active SKS root', maturity: 'stable', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'update', summary: 'Inspect, review, apply, or roll back the global SKS update', maturity: 'stable' },
  { name: 'uninstall', summary: 'Uninstall SKS global skills, hooks, config, menu bar, and optional project residue', maturity: 'stable', allowedDuringActiveRoute: true },
  { name: 'update-check', summary: 'Show the shared SKS, Codex CLI, and Menu Bar update status', maturity: 'stable', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'mcp', summary: 'Manage scoped Codex MCP configuration', maturity: 'beta', skipMigrationGate: true },
  { name: 'wizard', summary: 'Open setup wizard help', maturity: 'stable' },
  { name: 'usage', summary: 'Show focused usage topic', maturity: 'stable', readonly: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'quickstart', summary: 'Show quickstart flow', maturity: 'stable' },
  { name: 'setup', summary: 'Initialize SKS state', maturity: 'stable', skipMigrationGate: true },
  { name: 'bootstrap', summary: 'Initialize SKS project files', maturity: 'stable', skipMigrationGate: true },
  { name: 'init', summary: 'Initialize local control surface', maturity: 'stable' },
  { name: 'deps', summary: 'Check local dependencies', maturity: 'stable' },
  { name: 'fix-path', summary: 'Repair hook command paths', maturity: 'stable' },
  { name: 'doctor', summary: 'Check and repair SKS install', maturity: 'stable', skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'git', summary: 'Inspect and enforce SKS git collaboration hygiene', maturity: 'beta' },
  { name: 'paths', summary: 'Inspect SKS managed paths', maturity: 'beta', readonly: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'rollback', summary: 'List or apply managed-path rollback actions', maturity: 'beta', skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'postinstall', summary: 'Run postinstall bootstrap', maturity: 'stable', skipMigrationGate: true },
  { name: 'codex', summary: 'Check Codex CLI compatibility and vendored hook schemas', maturity: 'beta', skipMigrationGate: true },
  { name: 'codex-app', summary: 'Check Codex App readiness', maturity: 'beta', skipMigrationGate: true },
  { name: 'codex-native', summary: 'Inspect Codex Native broker and routing readiness', maturity: 'beta' },
  { name: 'codex-lb', summary: 'Inspect codex-lb status and circuit health', maturity: 'beta', skipMigrationGate: true },
  { name: 'menubar', summary: 'Inspect/install/restart/uninstall SKS menu bar', maturity: 'beta', skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'remote', summary: 'Inspect official Remote readiness and run the proof-aware SSH stdio worker', maturity: 'beta' },
  { name: 'telegram', summary: 'Pair and run the private local Codex Telegram Hub', maturity: 'beta' },
  { name: 'hooks', summary: 'Explain and inspect Codex hooks', maturity: 'beta', skipMigrationGate: true },
  { name: 'zellij-lane', summary: 'Render a Zellij lane frame for SKS sessions', maturity: 'beta' },
  { name: 'zellij-slot-pane', summary: 'Render a compact Zellij worker slot pane', maturity: 'beta' },
  { name: 'zellij-monitor-pane', summary: 'Render the live Zellij MAD/Naruto monitor pane', maturity: 'beta', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'zellij-viewport-pane', summary: 'Render a dynamically bound Zellij worker viewport pane', maturity: 'beta', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'zellij-slot-column-anchor', summary: 'Render the compact SLOTS anchor pane for first-slot-down Zellij stacks', maturity: 'beta' },
  { name: 'zellij', summary: 'Inspect Zellij runtime status and explain repair (no auto-install)', maturity: 'beta', skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'mad-sks', summary: 'MAD-SKS scoped permission modifier + SQL-plane execution', maturity: 'beta', mutatesRouteState: true },
  { name: 'auto-review', summary: 'Manage auto-review profile', maturity: 'beta' },
  { name: 'dollar-commands', summary: 'List Codex App dollar commands', maturity: 'stable', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'fast-mode', summary: 'Toggle SKS Fast mode default for dollar-command routes', maturity: 'stable', skipMigrationGate: true },
  { name: 'commit', summary: 'Create a simple git commit', maturity: 'stable' },
  { name: 'commit-and-push', summary: 'Create a simple git commit and push', maturity: 'stable' },
  { name: 'dfix', summary: 'Run DFix diagnose/plan/patch/verify loop', maturity: 'stable', mutatesRouteState: true },
  { name: 'with-local-llm', summary: 'Enable or inspect local Ollama worker backend', maturity: 'beta' },
  { name: 'naruto', summary: 'Run the $sks-naruto Codex official subagent workflow', maturity: 'labs', mutatesRouteState: true },
  { name: 'stop-gate', summary: 'Check canonical stop-gate resolution for a route/mission', maturity: 'beta', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'route', summary: 'Inspect or close active route state', maturity: 'beta', skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'loop', summary: 'Dynamic Loop Runtime: plan/run/status/proof loop graphs.', maturity: 'labs', mutatesRouteState: true },
  { name: 'qa-loop', summary: 'Run QA loop missions', maturity: 'beta', mutatesRouteState: true },
  { name: 'research', summary: 'Run research missions', maturity: 'labs', mutatesRouteState: true },
  { name: 'autoresearch', summary: 'Alias for research/autoresearch route', maturity: 'labs', mutatesRouteState: true },
  { name: 'ppt', summary: 'Inspect/build PPT artifacts', maturity: 'labs', mutatesRouteState: true },
  { name: 'image-ux-review', summary: 'Inspect image UX artifacts', maturity: 'labs', mutatesRouteState: true },
  { name: 'computer-use', summary: 'Record native Mac/non-web Computer Use visual evidence', maturity: 'beta', mutatesRouteState: true },
  { name: 'context7', summary: 'Context7 checks and docs', maturity: 'beta' },
  { name: 'super-search', summary: 'Run Super-Search provider-independent source intelligence', maturity: 'beta' },
  { name: 'recallpulse', summary: 'RecallPulse evidence route', maturity: 'labs' },
  { name: 'pipeline', summary: 'Inspect pipeline missions', maturity: 'beta', readonly: true, skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'guard', summary: 'Check harness guard', maturity: 'beta' },
  { name: 'conflicts', summary: 'Check harness conflicts', maturity: 'beta' },
  { name: 'versioning', summary: 'Manage release version metadata', maturity: 'stable' },
  { name: 'reasoning', summary: 'Show reasoning route', maturity: 'labs' },
  { name: 'aliases', summary: 'Show command aliases', maturity: 'stable' },
  { name: 'selftest', summary: 'Run local mock selftest', maturity: 'stable' },
  { name: 'goal', summary: 'Print stateless Codex native Goal controls', maturity: 'beta' },
  { name: 'seo-geo-optimizer', summary: 'Run unified SEO/GEO optimizer audit/plan/apply/verify plus research/strategy (--include-marketing) on the search-visibility kernel', maturity: 'beta' },
  { name: 'hook', summary: 'Codex hook entrypoint', maturity: 'beta', skipMigrationGate: true },
  { name: 'profile', summary: 'Inspect/set profile', maturity: 'labs' },
  { name: 'hproof', summary: 'Evaluate H-Proof gate', maturity: 'beta' },
  { name: 'validate-artifacts', summary: 'Validate mission artifacts', maturity: 'beta' },
  { name: 'proof', summary: 'Show and validate completion proof', maturity: 'beta' },
  { name: 'trust', summary: 'Report and validate route trust kernel evidence', maturity: 'beta' },
  { name: 'wrongness', summary: 'Record and inspect TriWiki wrongness negative evidence', maturity: 'beta' },
  { name: 'proof-field', summary: 'Scan proof field', maturity: 'beta' },
  { name: 'skill-dream', summary: 'Track skill dream counters', maturity: 'labs' },
  { name: 'code-structure', summary: 'Scan source structure', maturity: 'labs' },
  { name: 'rust', summary: 'Inspect optional Rust accelerator status and smoke parity', maturity: 'beta' },
  { name: 'gx', summary: 'Render/validate GX cartridges', maturity: 'labs' },
  { name: 'eval', summary: 'Run eval reports', maturity: 'labs' },
  { name: 'harness', summary: 'Run harness fixtures', maturity: 'labs' },
  { name: 'wiki', summary: 'Manage TriWiki and image voxel ledgers', maturity: 'beta', skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'memory', summary: 'Project TriWiki memory into managed AGENTS.md blocks or run memory GC', maturity: 'beta' },
  { name: 'gc', summary: 'Compact/prune runtime state', maturity: 'labs', skipMigrationGate: true, allowedDuringActiveRoute: true, diagnostic: true },
  { name: 'stats', summary: 'Show storage stats', maturity: 'labs', readonly: true, diagnostic: true },
  { name: 'features', summary: 'Validate feature registry', maturity: 'beta' },
  { name: 'all-features', summary: 'Run all-features selftest', maturity: 'beta' },
  { name: 'perf', summary: 'Run performance checks', maturity: 'beta' },
  { name: 'bench', summary: 'Run core trust-kernel benchmark budgets', maturity: 'beta' },
  { name: 'mcp-server', summary: 'Run a stdio MCP server exposing SKS commands as tools for MCP-capable agent hosts', maturity: 'beta', skipMigrationGate: true, allowedDuringActiveRoute: true },
  { name: 'agent-bridge', summary: 'Publish the agent-bridge manifest and print host registration snippets for external agent systems', maturity: 'beta', readonly: true, diagnostic: true }
] as const satisfies readonly CommandManifestLiteSourceEntry[];

export type CommandNameLite = typeof COMMAND_MANIFEST_LITE_BASE[number]['name'];

const SAFE_COMMAND_CONTRACT_LITE: CommandContractMetadataLite = {
  risk: 'R2',
  latency: 'normal',
  supportsJson: false,
  remoteAllowed: false,
  telegramAllowed: false,
  inputProfile: 'none',
  requiredCapabilities: []
};

const COMMAND_CONTRACT_OVERRIDES_LITE = {
  autoresearch: { latency: 'long' },
  bench: { latency: 'long' },
  check: { risk: 'R1', latency: 'long' },
  'commit-and-push': { risk: 'R3' },
  'computer-use': { latency: 'long' },
  dfix: { latency: 'long' },
  'dollar-commands': { risk: 'R2', latency: 'normal' },
  eval: { latency: 'long' },
  gates: {
    risk: 'R1', latency: 'long', supportsJson: true, remoteAllowed: true, telegramAllowed: true,
    inputProfile: 'gates', requiredCapabilities: ['project.git', 'proof.gates']
  },
  harness: { latency: 'long' },
  'image-ux-review': { latency: 'long' },
  loop: { latency: 'long' },
  'mad-sks': { risk: 'R3', latency: 'long' },
  mcp: { risk: 'R2', latency: 'long', supportsJson: true, inputProfile: 'json-only' },
  naruto: {
    risk: 'R2', latency: 'long', supportsJson: true, remoteAllowed: false, telegramAllowed: false,
    inputProfile: 'naruto'
  },
  paths: {
    supportsJson: true, remoteAllowed: true, inputProfile: 'paths',
    requiredCapabilities: ['project.fs.read']
  },
  perf: { latency: 'long' },
  pipeline: {
    risk: 'R2', latency: 'normal', supportsJson: true, remoteAllowed: true, inputProfile: 'pipeline-status',
    requiredCapabilities: ['proof.pipeline']
  },
  postinstall: { latency: 'long' },
  ppt: { latency: 'long' },
  proof: {
    risk: 'R0', latency: 'fast', supportsJson: true, remoteAllowed: true, telegramAllowed: true,
    inputProfile: 'proof', requiredCapabilities: ['proof.read']
  },
  'qa-loop': { latency: 'long' },
  recallpulse: { latency: 'long' },
  release: { risk: 'R1', latency: 'long' },
  remote: { risk: 'R2', latency: 'long', supportsJson: true, remoteAllowed: false, telegramAllowed: false, inputProfile: 'json-only' },
  research: { latency: 'long' },
  review: { risk: 'R1' },
  run: { latency: 'long' },
  stats: {
    supportsJson: true, remoteAllowed: true, inputProfile: 'stats',
    requiredCapabilities: ['project.fs.read']
  },
  status: {
    supportsJson: true, remoteAllowed: true, telegramAllowed: true, inputProfile: 'json-only',
    requiredCapabilities: ['proof.read']
  },
  'stop-gate': {
    supportsJson: true, remoteAllowed: true, telegramAllowed: true, inputProfile: 'stop-gate',
    requiredCapabilities: ['proof.stop-gate']
  },
  task: { risk: 'R1', latency: 'long' },
  telegram: { risk: 'R2', latency: 'long', supportsJson: true, remoteAllowed: false, telegramAllowed: false, inputProfile: 'json-only' },
  trust: {
    risk: 'R0', latency: 'fast', supportsJson: true, remoteAllowed: true, telegramAllowed: true,
    inputProfile: 'trust', requiredCapabilities: ['proof.trust']
  },
  uninstall: { risk: 'R3', latency: 'long' },
  update: { latency: 'long' },
  'update-check': {
    supportsJson: true, remoteAllowed: true, inputProfile: 'json-only',
    requiredCapabilities: ['network.npm.read']
  },
  'validate-artifacts': {
    risk: 'R1', supportsJson: true, remoteAllowed: true, inputProfile: 'validate-artifacts',
    requiredCapabilities: ['proof.artifacts']
  }
} as const satisfies Partial<Record<CommandNameLite, Partial<CommandContractMetadataLite>>>;

export const COMMAND_MANIFEST_LITE = COMMAND_MANIFEST_LITE_BASE.map((entry) => ({
  ...SAFE_COMMAND_CONTRACT_LITE,
  ...('readonly' in entry && entry.readonly === true ? { risk: 'R0' as const, latency: 'fast' as const } : {}),
  ...entry,
  ...(COMMAND_CONTRACT_OVERRIDES_LITE[entry.name as keyof typeof COMMAND_CONTRACT_OVERRIDES_LITE] || {})
})) as readonly (CommandManifestLiteEntry & { name: CommandNameLite })[];

export function commandInputSchema(profile: CommandInputProfileLite): Record<string, unknown> {
  if (profile === 'json-only') return objectSchema({ json: { type: 'boolean' } });
  if (profile === 'naruto') {
    return objectSchema({
      action: { type: 'string', enum: [...NARUTO_ACTIONS] },
      task: boundedString(1, 32_768),
      prompt: boundedString(1, 32_768),
      mission: boundedString(1, 160),
      agents: { type: 'integer', minimum: 1 },
      max_threads: { type: 'integer', minimum: 1 },
      readonly: { type: 'boolean' },
      trusted_project: { type: 'boolean' },
      json: { type: 'boolean' }
    });
  }
  if (profile === 'paths') {
    return objectSchema({
      action: { type: 'string', enum: ['managed', 'git-policy'] },
      json: { type: 'boolean' }
    });
  }
  if (profile === 'pipeline-status') {
    return objectSchema({
      action: { type: 'string', enum: ['status'] },
      json: { type: 'boolean' }
    });
  }
  if (profile === 'stats') return objectSchema({ full: { type: 'boolean' }, json: { type: 'boolean' } });
  if (profile === 'stop-gate') {
    return objectSchema({
      route: boundedString(1, 80),
      mission: boundedString(1, 160),
      gate: boundedString(1, 1024),
      json: { type: 'boolean' }
    });
  }
  if (profile === 'proof') {
    return objectSchema({
      action: { type: 'string', enum: ['show', 'latest', 'validate', 'route'] },
      mission: boundedString(1, 160),
      completion: { type: 'boolean' },
      json: { type: 'boolean' }
    });
  }
  if (profile === 'trust') {
    return objectSchema({
      action: { type: 'string', enum: ['report', 'status', 'explain'] },
      mission: boundedString(1, 160),
      json: { type: 'boolean' }
    });
  }
  if (profile === 'gates') {
    return objectSchema({
      target: boundedString(1, 120),
      mode: { type: 'string', enum: ['preset', 'gate'] },
      full: { type: 'boolean' },
      json: { type: 'boolean' }
    });
  }
  if (profile === 'validate-artifacts') {
    return objectSchema({
      mission: boundedString(1, 160),
      required: {
        type: 'array',
        items: boundedString(1, 80),
        maxItems: 32
      },
      json: { type: 'boolean' }
    });
  }
  return objectSchema({});
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: false };
}

function boundedString(minLength: number, maxLength: number): Record<string, unknown> {
  return { type: 'string', minLength, maxLength };
}

export const LEGACY_COMMAND_ALIASES_LITE = {
} as const satisfies Record<string, CommandNameLite>;

export const COMMAND_ALIASES_LITE = {
  ...LEGACY_COMMAND_ALIASES_LITE,
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-v': 'version',
  '--mad': 'mad-sks',
  '--MAD': 'mad-sks',
  '--mad-sks': 'mad-sks',
  'ux-review': 'image-ux-review',
  'visual-review': 'image-ux-review',
  'ui-ux-review': 'image-ux-review'
} as const satisfies Record<string, CommandNameLite>;

export const COMMAND_MANIFEST_BY_NAME = Object.fromEntries(
  COMMAND_MANIFEST_LITE.map((entry) => [entry.name, entry])
) as Record<CommandNameLite, CommandManifestLiteEntry>;

export const COMMAND_NAME_SET = new Set<string>(COMMAND_MANIFEST_LITE.map((entry) => entry.name));

export function commandManifestNames(): CommandNameLite[] {
  return COMMAND_MANIFEST_LITE.map((entry) => entry.name).sort() as CommandNameLite[];
}
