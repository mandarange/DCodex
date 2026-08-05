import { PACKAGE_VERSION } from '../../fsx.js';
import { buildSksCoreSkillManifest, isCoreSkillName, legacyCoreSkillNames } from '../../codex-native/core-skill-manifest.js';
import {
  DOLLAR_COMMANDS,
  DOLLAR_SKILL_NAMES,
  LEGACY_DOLLAR_SKILL_NAMES,
  RECOMMENDED_SKILLS
} from '../../routes.js';

export const SKS_SKILL_MANIFEST_FILE = '.sks-generated.json';
export const PACKAGED_SKILLS_MANIFEST_SCHEMA = 'sks.skills-manifest.v1';
export const SKILLS_HASH_LEDGER_SCHEMA = 'sks.skills-hash-ledger.v1';
export const MAX_SKILL_HASH_HISTORY = 8;

export const RETIRED_PUBLIC_IMAGE_UX_REVIEW_SKILL_ALIASES = [
  'sks-ux-review',
  'sks-visual-review',
  'sks-ui-ux-review'
] as const;
export const RETIRED_PUBLIC_IMAGE_UX_REVIEW_SKILL_ALIAS_SET = new Set<string>(
  RETIRED_PUBLIC_IMAGE_UX_REVIEW_SKILL_ALIASES
);

export const REMOVED_SKS_SKILL_NAMES = [
  'old-workflow',
  'team-legacy',
  'team',
  'agent-team',
  'agent',
  'mad-db',
  'tmux',
  'xai',
  'swarm',
  'shadow-clone',
  'shadow-clone-legacy',
  'kage-bunshin',
  'qaloop',
  'wiki-refresh',
  'wikirefresh',
  'research-discovery',
  'sks-research-discovery',
  'ralph',
  'ralph-supervisor',
  'ralph-resolver',
  // NC-38: SKS-owned persisted loop retired; Codex native Goal owns goals/loops.
  'loop',
  'sks-loop'
] as const;

export const LEGACY_SKS_SUPPORT_SKILL_NAMES = [
  'autoresearch-loop',
  'context7-docs',
  'db-safety-guard',
  'design-artifact-expert',
  'design-system-builder',
  'design-ui-editor',
  'from-chat-img',
  'getdesign-reference',
  'gx-visual-generate',
  'gx-visual-read',
  'gx-visual-validate',
  'honest-mode',
  'hproof-claim-ledger',
  'hproof-evidence-bind',
  'imagegen',
  'imagegen-source-scout',
  'performance-evaluator',
  'pipeline-runner',
  'prompt-pipeline',
  'reasoning-router',
  'reflection',
  'solution-scout',
  'turbo-context-pack'
] as const;

export const LEGACY_UNPREFIXED_SKS_SKILL_NAMES = Array.from(new Set([
  ...LEGACY_DOLLAR_SKILL_NAMES,
  ...legacyCoreSkillNames(),
  ...LEGACY_SKS_SUPPORT_SKILL_NAMES
].map((name) => canonicalSkillNameFromValue(name)).filter((name) => name && name !== 'sks'))).sort();

export const SKS_SKILL_NAMES_TO_CLEAN_UP = Array.from(new Set([
  ...REMOVED_SKS_SKILL_NAMES,
  ...LEGACY_UNPREFIXED_SKS_SKILL_NAMES
]));
export const REMOVED_SKS_SKILL_NAME_SET = new Set<string>(SKS_SKILL_NAMES_TO_CLEAN_UP);
export const SKILL_ALIASES: Record<string, string[]> = {};

export function canonicalSkillNameFromValue(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildFallbackSkillsManifest() {
  const names = new Set<string>([
    ...DOLLAR_SKILL_NAMES.map((name) => canonicalSkillNameFromValue(name)),
    ...RECOMMENDED_SKILLS.map((name) => canonicalSkillNameFromValue(name)),
    ...DOLLAR_COMMANDS.map((command) => canonicalSkillNameFromValue(String(command.command || '').replace(/^\$/, ''))),
    ...buildSksCoreSkillManifest().skills.map((skill) => skill.canonical_name)
  ].filter((name) => Boolean(name)
    && !REMOVED_SKS_SKILL_NAME_SET.has(name)
    && !RETIRED_PUBLIC_IMAGE_UX_REVIEW_SKILL_ALIAS_SET.has(name)));
  return {
    schema: PACKAGED_SKILLS_MANIFEST_SCHEMA,
    package_version: PACKAGE_VERSION,
    skills: [...names].sort().map((name) => ({
      canonical_name: name,
      type: isCoreSkillName(name) ? 'core' : 'official',
      content_sha256: '',
      hash_history: [],
      deprecated_aliases: SKILL_ALIASES[name] || []
    }))
  };
}
