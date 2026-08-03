export const TRIWIKI_MODULE_CARD_SCHEMA = 'sks.triwiki-module-card.v1';

export interface TriWikiModuleCard {
  schema: typeof TRIWIKI_MODULE_CARD_SCHEMA;
  module_id: string;
  paths: string[];
  owns_gate_prefixes: string[];
  gate_packs: string[];
  risk: 'low' | 'medium' | 'high' | 'critical';
  invariants: string[];
  required_proof_type: string;
}

export const DEFAULT_TRIWIKI_MODULE_CARDS: TriWikiModuleCard[] = [
  moduleCard('triwiki', ['src/core/triwiki/**', 'src/scripts/triwiki-*.ts'], ['triwiki:'], ['triwiki'], 'high'),
  moduleCard('release-parity', ['package.json', 'package-lock.json', 'release-gates.v2.json'], ['release:'], ['release-parity'], 'high'),
  moduleCard('release-dag', ['src/core/release/release-gate-*.ts', 'src/scripts/release-*.ts'], ['release:'], ['release-parity'], 'high'),
  moduleCard('triwiki-proof-bank', ['src/core/triwiki/triwiki-proof-*.ts', 'src/core/triwiki/triwiki-cache-key.ts', 'src/core/triwiki/triwiki-invalidation.ts', 'src/scripts/triwiki-proof-*.ts', 'src/scripts/triwiki-cache-*.ts', 'src/scripts/triwiki-stale-*.ts'], ['triwiki:proof', 'triwiki:cache', 'triwiki:stale'], ['triwiki'], 'high'),
  moduleCard('triwiki-affected-graph', ['src/core/triwiki/triwiki-module-card.ts', 'src/core/triwiki/triwiki-gate-impact-map.ts', 'src/core/triwiki/triwiki-affected-graph.ts', 'src/scripts/triwiki-affected-*.ts', 'src/scripts/triwiki-module-*.ts'], ['triwiki:affected', 'triwiki:module', 'triwiki:gate-impact'], ['triwiki'], 'high'),
  moduleCard('gate-pack-runner', ['src/core/release/gate-pack-*.ts', 'src/scripts/gate-pack-*.ts'], ['gate-pack:'], ['release-parity'], 'high'),
  moduleCard('extreme-scheduler', ['src/core/release/*scheduler.ts', 'src/core/release/resource-class-budget.ts', 'src/core/release/critical-path-ledger.ts', 'src/scripts/scheduler-*.ts'], ['scheduler:'], ['release-parity'], 'high'),
  moduleCard('build-once', ['src/core/build/**', 'src/scripts/build-once-*.ts', 'tsconfig.json'], ['build-once:'], ['doctor-production'], 'medium'),
  moduleCard('sksd-daemon', ['src/core/daemon/**', 'src/scripts/sksd-*.ts'], ['sksd:'], ['startup-mcp'], 'medium'),
  moduleCard('probe-memoization', ['src/core/probes/**', 'src/scripts/probe-*.ts'], ['probes:'], ['startup-mcp'], 'medium'),
  moduleCard('doctor-transaction', ['src/core/doctor/doctor-transaction.ts', 'src/commands/doctor.ts', 'src/scripts/doctor-transaction-*.ts'], ['doctor:transaction'], ['doctor-production'], 'high'),
  moduleCard('doctor-dirty-repair', ['src/core/doctor/doctor-dirty-planner.ts', 'src/core/doctor/doctor-repair-postcheck.ts', 'src/scripts/doctor-dirty-*.ts'], ['doctor:dirty'], ['doctor-production'], 'high'),
  moduleCard('startup-config-repair', ['src/core/doctor/*startup*.ts', 'src/scripts/doctor-startup-*.ts'], ['doctor:startup'], ['doctor-production'], 'high'),
  moduleCard('context7-mcp', ['src/core/doctor/*context7*.ts', 'src/commands/context7.ts'], ['doctor:context7', 'context7:'], ['startup-mcp'], 'critical'),
  moduleCard('supabase-mcp', ['src/core/doctor/*supabase*.ts', 'src/core/db-safety.ts', 'src/core/mad-sks/sql-plane/**', 'src/core/pipeline-internals/runtime-core.ts'], ['doctor:supabase', 'mad-sks:sql-plane-', 'mad-sks:'], ['startup-mcp'], 'critical'),
  moduleCard('native-capability', ['src/core/codex-native/**', 'src/scripts/native-*.ts'], ['native:', 'codex-native:'], ['native-capability'], 'high'),
  moduleCard('secret-preservation', ['src/core/**/secret*.ts', 'src/scripts/secret-*.ts', 'safety-mutation-allowlist.json'], ['secret:', 'supabase-secret'], ['doctor-production'], 'critical'),
  moduleCard('core-skill', ['.agents/skills/**', 'src/scripts/core-skill-*.ts'], ['core-skill:'], ['core-skill'], 'high'),
  moduleCard('skill-dedupe', ['src/scripts/skill-*.ts', '.sneakoscope/skills/**'], ['skill:'], ['skill-dedupe'], 'medium'),
  moduleCard('codex-0140', ['src/scripts/codex-0140-*.ts', 'src/vendor/openai-codex/**'], ['codex:0140'], ['codex-0140'], 'medium'),
  moduleCard('loop-mesh', ['src/core/loops/**', 'src/scripts/loop-*.ts'], ['loop:'], ['loop-mesh'], 'medium'),
  moduleCard('qa-loop', ['src/commands/qa-loop.ts', 'src/scripts/qa-*.ts'], ['qa-', 'qa:'], ['qa-research-image'], 'medium'),
  moduleCard('research', ['src/commands/research.ts', 'src/scripts/research-*.ts'], ['research:'], ['qa-research-image'], 'medium'),
  moduleCard('image-path', ['src/commands/image-ux-review.ts', 'src/scripts/*image*.ts', 'src/scripts/ux-review-*.ts'], ['image:', 'ux-review:'], ['qa-research-image'], 'medium'),
  moduleCard('legacy-purge', ['src/scripts/legacy-*.ts', 'src/scripts/orphan-*.ts', 'docs/sks-4-migration.md'], ['legacy:', 'orphan:'], ['release-parity'], 'high'),
  moduleCard('cli-check', ['src/core/commands/check-command.ts', 'src/commands/**/*.ts', 'src/cli/**'], ['cli:', 'sks:', 'check:'], ['native-capability'], 'high')
];

export function moduleCard(moduleId: string, paths: string[], ownsGatePrefixes: string[], gatePacks: string[], risk: TriWikiModuleCard['risk']): TriWikiModuleCard {
  return {
    schema: TRIWIKI_MODULE_CARD_SCHEMA,
    module_id: moduleId,
    paths,
    owns_gate_prefixes: ownsGatePrefixes,
    gate_packs: gatePacks,
    risk,
    invariants: [`${moduleId}:release-equivalent-proof-required`],
    required_proof_type: risk === 'critical' ? 'real-postcheck-plus-release-gate' : 'release-gate'
  };
}

export function moduleIdsForPath(file: string, cards: TriWikiModuleCard[] = DEFAULT_TRIWIKI_MODULE_CARDS): string[] {
  const normalized = file.replace(/\\/g, '/');
  const matches = cards.filter((card) => card.paths.some((pattern) => pathMatches(pattern, normalized))).map((card) => card.module_id);
  return matches.length ? matches : ['unknown'];
}

export function pathMatches(pattern: string, file: string): boolean {
  if (pattern.endsWith('/**')) return file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2));
  if (!pattern.includes('*')) return file === pattern || file.startsWith(`${pattern}/`);
  const re = new RegExp(`^${globToRegexSource(pattern)}$`);
  return re.test(file);
}

function globToRegexSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += /[\\^$+?.()|{}[\]]/.test(char || '') ? `\\${char}` : char;
  }
  return out;
}
