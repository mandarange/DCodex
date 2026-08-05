import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_DOLLAR_SKILL_NAMES } from '../routes.js';
import { legacyCoreSkillNames } from '../codex-native/core-skill-manifest.js';
import { prefixKnownSksDollarReferences } from '../routes/dollar-prefix.js';
import { inspectConfinedPath } from '../managed-path-safety.js';
import { messageOf as errorMessage } from '../errors/message.js';
import { collectNestedProjectRoots } from './current-project-guidance-nested.js';
import { containsRetiredPublicSurface } from './current-project-guidance.js';

export const SKILL_LEGACY_SURFACE_SCHEMA = 'sks.skill-legacy-surface.v1' as const;

/** Foreign harness skill directory names — remove from the live picker (backup under quarantine). */
export const OTHER_HARNESS_SKILL_DIR_NAMES = ['omx', 'dcodex', 'omx-codex', 'dcodex-codex'] as const;

const TOKEN = 'A-Za-z0-9_.\\-';
const LEFT = `(^|[^${TOKEN}])`;
const RIGHT = `(?![${TOKEN}])`;
const RETIRED_MULTIPLEXER_NAME = ['zel', 'lij'].join('');

type RewriteRule = { id: string; pattern: RegExp; replace: string };

const REWRITE_RULES: RewriteRule[] = [
  { id: 'dollar-mad-db', pattern: new RegExp(`${LEFT}\\$MAD-DB${RIGHT}`, 'gi'), replace: '$1$sks-db-safety-guard' },
  { id: 'dollar-shadow-clone', pattern: new RegExp(`${LEFT}\\$ShadowClone${RIGHT}`, 'gi'), replace: '$1$sks-naruto' },
  { id: 'dollar-kagebunshin', pattern: new RegExp(`${LEFT}\\$Kagebunshin${RIGHT}`, 'gi'), replace: '$1$sks-naruto' },
  { id: 'dollar-team', pattern: new RegExp(`${LEFT}\\$Team${RIGHT}`, 'gi'), replace: '$1$sks-naruto' },
  { id: 'dollar-agent', pattern: new RegExp(`${LEFT}\\$Agent${RIGHT}`, 'gi'), replace: '$1$sks-naruto' },
  { id: 'dollar-swarm', pattern: new RegExp(`${LEFT}\\$Swarm${RIGHT}`, 'gi'), replace: '$1$sks-naruto' },
  { id: 'dollar-ralph', pattern: new RegExp(`${LEFT}\\$Ralph${RIGHT}`, 'gi'), replace: '$1$sks-naruto' },

  {
    id: 'cli-glm-profile',
    pattern: new RegExp(`${LEFT}sks\\s+codex-app\\s+glm-profile(?:\\s+[A-Za-z0-9_-]+)?${RIGHT}`, 'gi'),
    replace: '$1sks bridge provider configure openrouter --api-key-stdin'
  },
  { id: 'cli-mad-db', pattern: new RegExp(`${LEFT}sks\\s+mad-db${RIGHT}`, 'gi'), replace: '$1sks mad-sks' },
  { id: 'cli-team', pattern: new RegExp(`${LEFT}sks\\s+team${RIGHT}`, 'gi'), replace: '$1sks naruto' },
  { id: 'cli-agent', pattern: new RegExp(`${LEFT}sks\\s+agent${RIGHT}`, 'gi'), replace: '$1sks naruto' },
  { id: 'cli-swarm', pattern: new RegExp(`${LEFT}sks\\s+swarm${RIGHT}`, 'gi'), replace: '$1sks naruto' },
  { id: 'cli-ralph', pattern: new RegExp(`${LEFT}sks\\s+ralph${RIGHT}`, 'gi'), replace: '$1sks loop' },
  { id: 'cli-tmux', pattern: new RegExp(`${LEFT}sks\\s+tmux${RIGHT}`, 'gi'), replace: '$1sks --mad' },
  { id: 'cli-xai', pattern: new RegExp(`${LEFT}sks\\s+xai${RIGHT}`, 'gi'), replace: '$1sks bridge provider configure openrouter --api-key-stdin' },
  { id: 'cli-glm', pattern: new RegExp(`${LEFT}sks\\s+glm${RIGHT}`, 'gi'), replace: '$1sks bridge provider configure openrouter --api-key-stdin' },
  { id: 'cli-ui', pattern: new RegExp(`${LEFT}sks\\s+ui${RIGHT}`, 'gi'), replace: '$1sks image-ux-review' },
  { id: 'cli-db', pattern: new RegExp(`${LEFT}sks\\s+db${RIGHT}`, 'gi'), replace: '$1sks mad-sks' },
  {
    id: 'cli-retired-multiplexer-dashboard',
    pattern: new RegExp(`${LEFT}sks\\s+${RETIRED_MULTIPLEXER_NAME}\\s+dashboard${RIGHT}`, 'gi'),
    replace: '$1sks mad-sks status'
  },
  {
    id: 'cli-opt-retired-multiplexer-dashboard',
    pattern: new RegExp(`${LEFT}sks\\s+--${RETIRED_MULTIPLEXER_NAME}-dashboard${RIGHT}`, 'gi'),
    replace: '$1sks mad-sks status'
  },
  {
    id: 'cli-opt-glm',
    pattern: new RegExp(`${LEFT}sks\\s+--glm${RIGHT}`, 'gi'),
    replace: '$1sks bridge provider configure openrouter --api-key-stdin'
  },
  {
    id: 'cli-opt-naruto',
    pattern: new RegExp(`${LEFT}sks\\s+--naruto${RIGHT}`, 'gi'),
    replace: '$1sks naruto'
  },
  {
    id: 'cli-opt-clones',
    pattern: new RegExp(`${LEFT}sks\\s+--clones(?:=|\\s+)(\\d+)${RIGHT}`, 'gi'),
    replace: '$1sks naruto --agents $2'
  },
  {
    id: 'cli-opt-agent',
    pattern: new RegExp(`${LEFT}sks\\s+--agent(?![${TOKEN}-])(?:=|\\s+)[^\\s\`"']+`, 'gi'),
    replace: '$1sks naruto'
  },
  {
    id: 'opt-retired-multiplexer-dashboard',
    pattern: new RegExp(`${LEFT}--${RETIRED_MULTIPLEXER_NAME}-dashboard${RIGHT}`, 'gi'),
    replace: '$1sks mad-sks status'
  },
  {
    id: 'opt-glm',
    pattern: new RegExp(`${LEFT}--glm${RIGHT}`, 'gi'),
    replace: '$1sks bridge provider configure openrouter --api-key-stdin'
  },
  {
    id: 'opt-naruto',
    pattern: new RegExp(`${LEFT}--naruto${RIGHT}`, 'gi'),
    replace: '$1sks naruto'
  },
  {
    id: 'opt-agent',
    pattern: new RegExp(`${LEFT}--agent(?![${TOKEN}-])(?:=|\\s+)[^\\s\`"']+`, 'gi'),
    replace: '$1sks naruto'
  },
  {
    id: 'opt-clones',
    pattern: new RegExp(`${LEFT}--clones(?:=|\\s+)(\\d+)${RIGHT}`, 'gi'),
    replace: '$1--agents $2'
  },
  {
    id: 'harness-omx-install',
    pattern: /(?:^|\n)[^\n]*(?:\.omx\b|\.dcodex\b|(?<![A-Za-z0-9_-])omx(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_-])dcodex(?![A-Za-z0-9_-]))[^\n]*\b(?:install|setup|enable|activate)\b[^\n]*|(?:^|\n)[^\n]*\b(?:install|setup|enable|activate)\b[^\n]*(?:\.omx\b|\.dcodex\b|(?<![A-Za-z0-9_-])omx(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_-])dcodex(?![A-Za-z0-9_-]))[^\n]*/gi,
    replace: '\nRun `sks conflicts cleanup --yes` to quarantine conflicting third-party Codex harness markers from the live surface.'
  }
];

const PREFIX_LEGACY_NAMES = Array.from(new Set([
  ...LEGACY_DOLLAR_SKILL_NAMES,
  ...legacyCoreSkillNames(),
  'from-chat-img',
  'autoresearch-loop',
  'context7-docs',
  'db-safety-guard',
  'honest-mode',
  'reflection',
  'prompt-pipeline',
  'pipeline-runner'
]));

export interface SkillLegacyRewriteResult {
  text: string;
  changed: boolean;
  hits: string[];
}

export interface SkillLegacySurfaceReport {
  schema: typeof SKILL_LEGACY_SURFACE_SCHEMA;
  ok: boolean;
  fix: boolean;
  scanned_count: number;
  rewritten_count: number;
  removed_other_harness_skill_count: number;
  preserved_other_harness_skill_count: number;
  preserved_user_skill_count: number;
  remaining_count: number;
  preserved_clean_count: number;
  error_count: number;
  rewritten: string[];
  removed_other_harness_skills: string[];
  preserved_other_harness_skills: string[];
  preserved_user_skills: string[];
  remaining: string[];
  errors: string[];
  cleanup_prompt_command: 'sks conflicts cleanup --yes';
}

export function rewriteSkillLegacySurface(input: unknown): SkillLegacyRewriteResult {
  let text = String(input || '');
  const hits: string[] = [];

  for (const rule of REWRITE_RULES) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) {
      rule.pattern.lastIndex = 0;
      continue;
    }
    rule.pattern.lastIndex = 0;
    const next = text.replace(rule.pattern, rule.replace);
    if (next !== text) {
      hits.push(rule.id);
      text = next;
    }
  }

  const prefixed = prefixKnownSksDollarReferences(text, PREFIX_LEGACY_NAMES);
  if (prefixed !== text) {
    hits.push('dollar-prefix-known-sks');
    text = prefixed;
  }

  return {
    text,
    changed: hits.length > 0,
    hits: Array.from(new Set(hits))
  };
}

export function skillLegacySurfaceNeedsRewrite(text: unknown): boolean {
  const value = String(text || '');
  if (containsRetiredPublicSurface(value)) return true;
  if (/\bsks\s+codex-app\s+glm-profile\b/i.test(value)) return true;
  if (hasOtherHarnessInstallCue(value)) return true;
  return prefixKnownSksDollarReferences(value, PREFIX_LEGACY_NAMES) !== value;
}

function hasOtherHarnessInstallCue(text: string): boolean {
  for (const line of text.split('\n')) {
    // Remediation guidance that only tells operators to clear foreign harness residue is current.
    if (/\b(?:clear|remove|quarantine)\b[^\n]*\b(?:third-party|conflicting)\b[^\n]*harness/i.test(line)) continue;
    if (/\b(?:clear|remove)\b[^\n]*\b(?:omx|dcodex)\b/i.test(line) && /\bconflicts cleanup\b/i.test(line)) continue;
    const hasHarness = /(?:\.omx\b|\.dcodex\b|(?<![A-Za-z0-9_-])omx(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_-])dcodex(?![A-Za-z0-9_-]))/i.test(line);
    const hasInstallVerb = /\b(?:install|setup|enable|activate)\b/i.test(line);
    if (hasHarness && hasInstallVerb) return true;
  }
  return false;
}

export async function reconcileSkillLegacySurface(opts: {
  root: string;
  home?: string;
  globalRuntimeRoot?: string;
  fix?: boolean;
}): Promise<SkillLegacySurfaceReport> {
  const projectRoot = path.resolve(opts.root);
  const home = path.resolve(opts.home || process.env.HOME || os.homedir());
  const globalRuntimeRoot = path.resolve(
    opts.globalRuntimeRoot
      || (opts.home ? '' : process.env.SKS_GLOBAL_ROOT || '')
      || path.join(home, '.sneakoscope-global')
  );
  const fix = opts.fix === true;
  const skillRoots = await collectSkillRoots(projectRoot, home, globalRuntimeRoot);
  const rewritten: string[] = [];
  const removedOtherHarness: string[] = [];
  const preservedOtherHarness: string[] = [];
  const preservedUserSkills: string[] = [];
  const remaining: string[] = [];
  const errors: string[] = [];
  let scanned = 0;
  let preservedClean = 0;

  for (const skillRoot of skillRoots) {
    const { ownerRoot, targetDir } = skillRoot;
    let ownerStat;
    try {
      ownerStat = await fsp.lstat(ownerRoot);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      errors.push(`${displayPath(skillRoot, targetDir)}:${errorMessage(error)}`);
      remaining.push(displayPath(skillRoot, targetDir));
      continue;
    }
    if (ownerStat.isSymbolicLink() || !ownerStat.isDirectory()) {
      errors.push(`${displayPath(skillRoot, targetDir)}:managed_path_boundary_not_directory:${ownerRoot}`);
      remaining.push(displayPath(skillRoot, targetDir));
      continue;
    }

    let inspection;
    try {
      inspection = await inspectConfinedPath(ownerRoot, targetDir);
    } catch (error: unknown) {
      // Missing skill roots are normal before first install; only real path faults remain.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      const message = errorMessage(error);
      if (/managed_path_boundary_missing|ENOENT/i.test(message)) continue;
      errors.push(`${displayPath(skillRoot, targetDir)}:${message}`);
      remaining.push(displayPath(skillRoot, targetDir));
      continue;
    }
    if (!inspection.exists || inspection.leafSymlink || !inspection.stat?.isDirectory()) continue;

    let rows;
    try {
      rows = await fsp.readdir(targetDir, { withFileTypes: true });
    } catch (error: unknown) {
      errors.push(`${displayPath(skillRoot, targetDir)}:${errorMessage(error)}`);
      remaining.push(displayPath(skillRoot, targetDir));
      continue;
    }

    for (const row of rows) {
      if (!row.isDirectory()) continue;
      const dir = path.join(targetDir, row.name);
      const display = displayPath(skillRoot, dir);

      if (isOtherHarnessSkillDirName(row.name)) {
        scanned += 1;
        // Doctor/update are not authorized to move third-party harness files.
        // The dedicated conflicts cleanup command owns that quarantining path.
        preservedOtherHarness.push(display);
        remaining.push(display);
        continue;
      }

      const skillFile = path.join(dir, 'SKILL.md');
      let skillInspection;
      try {
        skillInspection = await inspectConfinedPath(ownerRoot, skillFile);
      } catch (error: unknown) {
        errors.push(`${display}:${errorMessage(error)}`);
        remaining.push(display);
        continue;
      }
      if (!skillInspection.exists || skillInspection.leafSymlink || !skillInspection.stat?.isFile()) continue;

      scanned += 1;
      let before = '';
      try {
        before = await fsp.readFile(skillFile, 'utf8');
      } catch (error: unknown) {
        errors.push(`${displayPath(skillRoot, skillFile)}:${errorMessage(error)}`);
        remaining.push(display);
        continue;
      }

      if (!skillLegacySurfaceNeedsRewrite(before)) {
        preservedClean += 1;
        continue;
      }

      const result = rewriteSkillLegacySurface(before);
      if (!result.changed) {
        remaining.push(display);
        continue;
      }
      // A skill body without an independently verified generation receipt may
      // be user-authored even when it contains historical SKS commands. Keep
      // it byte-for-byte and block with operator guidance instead of editing it.
      preservedUserSkills.push(display);
      remaining.push(display);
    }
  }

  return {
    schema: SKILL_LEGACY_SURFACE_SCHEMA,
    ok: remaining.length === 0 && errors.length === 0,
    fix,
    scanned_count: scanned,
    rewritten_count: rewritten.length,
    removed_other_harness_skill_count: removedOtherHarness.length,
    preserved_other_harness_skill_count: preservedOtherHarness.length,
    preserved_user_skill_count: preservedUserSkills.length,
    remaining_count: remaining.length,
    preserved_clean_count: preservedClean,
    error_count: errors.length,
    rewritten: Array.from(new Set(rewritten)).sort(),
    removed_other_harness_skills: Array.from(new Set(removedOtherHarness)).sort(),
    preserved_other_harness_skills: Array.from(new Set(preservedOtherHarness)).sort(),
    preserved_user_skills: Array.from(new Set(preservedUserSkills)).sort(),
    remaining: Array.from(new Set(remaining)).sort(),
    errors: Array.from(new Set(errors)).sort(),
    cleanup_prompt_command: 'sks conflicts cleanup --yes'
  };
}

type SkillRoot = {
  scope: 'project' | 'global' | 'global-runtime';
  ownerRoot: string;
  targetDir: string;
};

async function collectSkillRoots(projectRoot: string, home: string, globalRuntimeRoot: string): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [
    { scope: 'global', ownerRoot: home, targetDir: path.join(home, '.agents', 'skills') },
    { scope: 'global', ownerRoot: home, targetDir: path.join(home, '.codex', 'skills') },
    { scope: 'project', ownerRoot: projectRoot, targetDir: path.join(projectRoot, '.agents', 'skills') },
    { scope: 'project', ownerRoot: projectRoot, targetDir: path.join(projectRoot, '.codex', 'skills') },
    { scope: 'global-runtime', ownerRoot: globalRuntimeRoot, targetDir: path.join(globalRuntimeRoot, '.agents', 'skills') },
    { scope: 'global-runtime', ownerRoot: globalRuntimeRoot, targetDir: path.join(globalRuntimeRoot, '.codex', 'skills') }
  ];
  if (projectRoot !== home && projectRoot !== globalRuntimeRoot) {
    const scan = await collectNestedProjectRoots(projectRoot, new Set([home, globalRuntimeRoot]));
    for (const nested of scan.roots) {
      roots.push(
        { scope: 'project', ownerRoot: projectRoot, targetDir: path.join(nested, '.agents', 'skills') },
        { scope: 'project', ownerRoot: projectRoot, targetDir: path.join(nested, '.codex', 'skills') }
      );
    }
  }
  const unique = new Map<string, SkillRoot>();
  for (const root of roots) unique.set(path.resolve(root.targetDir), root);
  return [...unique.values()];
}

function isOtherHarnessSkillDirName(name: string): boolean {
  return (OTHER_HARNESS_SKILL_DIR_NAMES as readonly string[]).includes(String(name || '').trim().toLowerCase());
}

function displayPath(root: SkillRoot, target: string): string {
  const rel = path.relative(root.ownerRoot, target).split(path.sep).join('/');
  if (root.scope === 'global-runtime') return `$SKS_GLOBAL_ROOT/${rel}`;
  if (root.scope === 'global') return `~/${rel}`;
  return rel;
}
