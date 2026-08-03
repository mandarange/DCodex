import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentsBlockText, codexAppQuickReference, normalizeInstallScope, sksCommandPrefix } from '../init.js';
import { mergeManagedBlock, readText, writeTextAtomic } from '../fsx.js';
import { LEGACY_DOLLAR_SKILL_NAMES } from '../routes.js';
import {
  isSksGeneratedRetiredProfileText,
  reconcileRetiredSksConfigText,
  RETIRED_SKS_CONFIG_PROFILE_NAMES
} from '../auto-review.js';
import { validateCodexConfigRoundTrip } from '../codex/codex-config-toml.js';
import {
  inspectConfinedPath,
  moveConfinedPath,
  removeManagedPathVerified,
  uniqueConfinedPath
} from '../managed-path-safety.js';
import {
  collectNestedProjectRoots,
  type NestedProjectGuidanceScanWarning
} from './current-project-guidance-nested.js';
import { escapeRegExp } from '../text/regex.js';

export const CURRENT_PROJECT_GUIDANCE_SCHEMA = 'sks.current-project-guidance.v1' as const;

const AGENTS_MARKER = 'BEGIN Sneakoscope Codex GX MANAGED BLOCK';
const RETIRED_COMMAND_NAMES = ['team', 'mad-db', 'tmux', 'xai', 'swarm', 'agent', 'ralph', 'db', 'ui', 'glm'] as const;
const RETIRED_DOLLAR_COMMAND_NAMES = ['Agent', 'Team', 'MAD-DB', 'Swarm', 'ShadowClone', 'Kagebunshin', 'Ralph'] as const;
const LEGACY_UNPREFIXED_DOLLAR_COMMAND_NAMES = Array.from(new Set([
  ...RETIRED_DOLLAR_COMMAND_NAMES,
  ...LEGACY_DOLLAR_SKILL_NAMES.filter((name) => name !== 'sks')
]));
const TOKEN_CONTINUATION = '-A-Za-z0-9_.';
const RETIRED_MULTIPLEXER_NAME = ['zel', 'lij'].join('');
const RETIRED_COMMAND_RE = new RegExp(
  `(?:^|[^${TOKEN_CONTINUATION}])sks\\s+(?:${RETIRED_COMMAND_NAMES.map(escapeRegExp).join('|')})(?![${TOKEN_CONTINUATION}])`,
  'i'
);
const RETIRED_OPTION_NAMES = ['agent', 'naruto', 'clones', `${RETIRED_MULTIPLEXER_NAME}-dashboard`, 'glm'] as const;
const RETIRED_OPTION_RE = new RegExp(
  `(?:^|[^${TOKEN_CONTINUATION}])--(?:${RETIRED_OPTION_NAMES.map(escapeRegExp).join('|')})(?![${TOKEN_CONTINUATION}])`,
  'i'
);
const RETIRED_MULTIPLEXER_DASHBOARD_RE = new RegExp(
  `(?:^|[^${TOKEN_CONTINUATION}])sks\\s+${RETIRED_MULTIPLEXER_NAME}\\s+dashboard(?![${TOKEN_CONTINUATION}])`,
  'i'
);
const RETIRED_DOLLAR_COMMAND_RE = new RegExp(
  `(?:^|[^${TOKEN_CONTINUATION}$])\\$(?:${LEGACY_UNPREFIXED_DOLLAR_COMMAND_NAMES.map(escapeRegExp).join('|')})(?![${TOKEN_CONTINUATION}])`,
  'i'
);
export interface CurrentProjectGuidanceReport {
  schema: typeof CURRENT_PROJECT_GUIDANCE_SCHEMA;
  ok: boolean;
  fix: boolean;
  detected_count: number;
  reconciled_count: number;
  remaining_count: number;
  preserved_user_file_count: number;
  error_count: number;
  warnings: NestedProjectGuidanceScanWarning[];
}

type GuidanceScope = {
  root: string;
  installScope: 'global' | 'project';
};

type GuidanceCounters = {
  detected: number;
  reconciled: number;
  remaining: number;
  preserved: number;
  errors: number;
  warnings: NestedProjectGuidanceScanWarning[];
};

export function containsRetiredPublicSurface(text: unknown): boolean {
  const value = String(text || '');
  return RETIRED_COMMAND_RE.test(value)
    || RETIRED_OPTION_RE.test(value)
    || RETIRED_MULTIPLEXER_DASHBOARD_RE.test(value)
    || RETIRED_DOLLAR_COMMAND_RE.test(value);
}

export async function reconcileCurrentProjectGuidance(opts: {
  root: string;
  home?: string;
  globalRuntimeRoot?: string;
  fix: boolean;
}): Promise<CurrentProjectGuidanceReport> {
  const projectRoot = path.resolve(opts.root);
  const home = path.resolve(opts.home || process.env.HOME || os.homedir());
  const globalRuntimeRoot = path.resolve(
    opts.globalRuntimeRoot
      || (opts.home ? '' : process.env.SKS_GLOBAL_ROOT || '')
      || path.join(home, '.sneakoscope-global')
  );
  const scopes = uniqueScopes([
    { root: projectRoot, installScope: 'project' },
    { root: home, installScope: 'global' },
    { root: globalRuntimeRoot, installScope: 'global' }
  ]);
  const counters: GuidanceCounters = {
    detected: 0,
    reconciled: 0,
    remaining: 0,
    preserved: 0,
    errors: 0,
    warnings: []
  };
  const runId = `${Date.now()}-${process.pid}`;

  for (const scope of scopes) {
    await reconcileGuidanceScope(scope, opts.fix, runId, counters);
  }
  if (projectRoot !== home && projectRoot !== globalRuntimeRoot) {
    await reconcileNestedProjectGuidance(
      projectRoot,
      new Set([home, globalRuntimeRoot]),
      opts.fix,
      runId,
      counters
    );
  }

  return {
    schema: CURRENT_PROJECT_GUIDANCE_SCHEMA,
    ok: counters.remaining === 0 && counters.errors === 0,
    fix: opts.fix,
    detected_count: counters.detected,
    reconciled_count: counters.reconciled,
    remaining_count: counters.remaining,
    preserved_user_file_count: counters.preserved,
    error_count: counters.errors,
    warnings: counters.warnings
  };
}

async function reconcileGuidanceScope(
  scope: GuidanceScope,
  fix: boolean,
  runId: string,
  counters: GuidanceCounters
): Promise<void> {
  const rootStat = await fsp.lstat(scope.root).catch((error: any) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!rootStat) return;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    counters.errors += 1;
    counters.remaining += 1;
    return;
  }

  const quarantineRoot = path.join(scope.root, '.sneakoscope', 'quarantine', 'current-project-guidance', runId);
  await reconcileAgentsGuidance(scope, path.join(scope.root, 'AGENTS.md'), quarantineRoot, fix, counters);
  await reconcileQuickReference(scope, quarantineRoot, fix, counters);
  await reconcileCodexConfig(scope, quarantineRoot, fix, counters);
  await reconcileRetiredProfileFile(scope, quarantineRoot, fix, counters);
}

async function reconcileAgentsGuidance(
  scope: GuidanceScope,
  file: string,
  quarantineRoot: string,
  fix: boolean,
  counters: GuidanceCounters
): Promise<void> {
  const inspection = await inspectGuidancePath(scope.root, file, counters);
  if (!inspection?.exists) return;
  if (inspection.leafSymlink || !inspection.stat?.isFile()) {
    counters.errors += 1;
    counters.remaining += 1;
    return;
  }

  const before = await readText(file, '');
  if (before.includes(AGENTS_MARKER)) {
    if (!managedAgentsBlockNeedsReconcile(before)) return;
    counters.detected += 1;
    if (!fix) {
      counters.remaining += 1;
      return;
    }
    try {
      await mergeManagedBlock(file, 'Sneakoscope Codex GX MANAGED BLOCK', agentsBlockText());
      const after = await readText(file, '');
      if (managedAgentsBlockNeedsReconcile(after)) counters.remaining += 1;
      else counters.reconciled += 1;
    } catch (error: unknown) {
      counters.errors += 1;
      counters.remaining += 1;
    }
    return;
  }

  if (!containsRetiredPublicSurface(before)) {
    counters.preserved += 1;
    return;
  }
  counters.detected += 1;
  counters.preserved += 1;
  if (!fix) {
    counters.remaining += 1;
    return;
  }
  try {
    await quarantineUserGuidance(scope.root, file, quarantineRoot);
    await mergeManagedBlock(file, 'Sneakoscope Codex GX MANAGED BLOCK', agentsBlockText());
    counters.reconciled += 1;
  } catch (error: unknown) {
    counters.errors += 1;
    counters.remaining += 1;
  }
}

async function reconcileNestedProjectGuidance(
  projectRoot: string,
  excludedRoots: Set<string>,
  fix: boolean,
  runId: string,
  counters: GuidanceCounters
): Promise<void> {
  const rootStat = await fsp.lstat(projectRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return;
  const scan = await collectNestedProjectRoots(projectRoot, excludedRoots);
  if (scan.errorCount > 0) {
    counters.errors += scan.errorCount;
    counters.remaining += scan.errorCount;
  }
  counters.warnings.push(...scan.warnings);
  const scope: GuidanceScope = { root: projectRoot, installScope: 'project' };
  const quarantineRoot = path.join(projectRoot, '.sneakoscope', 'quarantine', 'current-project-guidance', runId);
  for (const root of scan.roots) {
    await reconcileAgentsGuidance(scope, path.join(root, 'AGENTS.md'), quarantineRoot, fix, counters);
    await reconcileQuickReference(scope, quarantineRoot, fix, counters, path.join(root, '.codex', 'SNEAKOSCOPE.md'));
    await reconcileCodexConfig(scope, quarantineRoot, fix, counters, path.join(root, '.codex', 'config.toml'));
    await reconcileRetiredProfileFile(scope, quarantineRoot, fix, counters, path.join(root, '.codex'));
  }
}

async function reconcileQuickReference(
  scope: GuidanceScope,
  quarantineRoot: string,
  fix: boolean,
  counters: GuidanceCounters,
  file = path.join(scope.root, '.codex', 'SNEAKOSCOPE.md')
): Promise<void> {
  const inspection = await inspectGuidancePath(scope.root, file, counters);
  if (!inspection?.exists) return;
  if (inspection.leafSymlink || !inspection.stat?.isFile()) {
    counters.errors += 1;
    counters.remaining += 1;
    return;
  }

  const before = await readText(file, '');
  if (isManagedQuickReference(before)) {
    const expected = codexAppQuickReference(
      quickReferenceInstallScope(before, scope.installScope),
      quickReferenceCommandPrefix(before, scope.installScope)
    );
    if (before === expected && !containsRetiredPublicSurface(before)) return;
    counters.detected += 1;
    if (!fix) {
      counters.remaining += 1;
      return;
    }
    try {
      await writeTextAtomic(file, expected);
      const after = await readText(file, '');
      if (after !== expected || containsRetiredPublicSurface(after)) counters.remaining += 1;
      else counters.reconciled += 1;
    } catch (error: unknown) {
      counters.errors += 1;
      counters.remaining += 1;
    }
    return;
  }

  if (!containsRetiredPublicSurface(before)) {
    counters.preserved += 1;
    return;
  }
  counters.detected += 1;
  counters.preserved += 1;
  if (!fix) {
    counters.remaining += 1;
    return;
  }
  try {
    const installScope = quickReferenceInstallScope(before, scope.installScope);
    const commandPrefix = quickReferenceCommandPrefix(before, installScope);
    await quarantineUserGuidance(scope.root, file, quarantineRoot);
    await writeTextAtomic(file, codexAppQuickReference(installScope, commandPrefix));
    counters.reconciled += 1;
  } catch (error: unknown) {
    counters.errors += 1;
    counters.remaining += 1;
  }
}

async function reconcileCodexConfig(
  scope: GuidanceScope,
  quarantineRoot: string,
  fix: boolean,
  counters: GuidanceCounters,
  file = path.join(scope.root, '.codex', 'config.toml')
): Promise<void> {
  const inspection = await inspectGuidancePath(scope.root, file, counters);
  if (!inspection?.exists) return;
  if (inspection.leafSymlink || !inspection.stat?.isFile()) {
    counters.errors += 1;
    counters.remaining += 1;
    return;
  }

  const before = await readText(file, '');
  const reconciled = reconcileRetiredSksConfigText(before);
  if (reconciled.detected_count === 0) return;
  counters.detected += reconciled.detected_count;
  if (!fix) {
    counters.remaining += reconciled.detected_count;
    return;
  }
  if (!validateCodexConfigRoundTrip(reconciled.text).ok) {
    counters.errors += 1;
    counters.remaining += reconciled.detected_count;
    return;
  }
  try {
    if (reconciled.user_authored_conflict) {
      counters.preserved += 1;
      await quarantineUserGuidance(scope.root, file, quarantineRoot);
    }
    await writeTextAtomic(file, reconciled.text, { mode: 0o600 });
    const after = reconcileRetiredSksConfigText(await readText(file, ''));
    if (after.detected_count > 0) counters.remaining += after.detected_count;
    else counters.reconciled += reconciled.detected_count;
  } catch (error: unknown) {
    counters.errors += 1;
    counters.remaining += reconciled.detected_count;
  }
}

async function reconcileRetiredProfileFile(
  scope: GuidanceScope,
  quarantineRoot: string,
  fix: boolean,
  counters: GuidanceCounters,
  codexRoot = path.join(scope.root, '.codex')
): Promise<void> {
  for (const profile of RETIRED_SKS_CONFIG_PROFILE_NAMES) {
    const file = path.join(codexRoot, `${profile}.config.toml`);
    const inspection = await inspectGuidancePath(scope.root, file, counters);
    if (!inspection?.exists) continue;
    counters.detected += 1;
    if (!fix) {
      counters.remaining += 1;
      continue;
    }
    try {
      if (inspection.leafSymlink || !inspection.stat?.isFile()) {
        counters.preserved += 1;
        await quarantineUserGuidance(scope.root, file, quarantineRoot);
      } else {
        const before = await readText(file, '');
        if (isSksGeneratedRetiredProfileText(before)) {
          await removeManagedPathVerified(scope.root, file);
        } else {
          counters.preserved += 1;
          await quarantineUserGuidance(scope.root, file, quarantineRoot);
        }
      }
      const after = await inspectConfinedPath(scope.root, file);
      if (after.exists) counters.remaining += 1;
      else counters.reconciled += 1;
    } catch (error: unknown) {
      counters.errors += 1;
      counters.remaining += 1;
    }
  }
}

async function inspectGuidancePath(root: string, file: string, counters: GuidanceCounters) {
  try {
    return await inspectConfinedPath(root, file);
  } catch (error: unknown) {
    counters.errors += 1;
    counters.remaining += 1;
    void error;
    return null;
  }
}

function managedAgentsBlockNeedsReconcile(text: string): boolean {
  if (containsRetiredPublicSurface(text)) return true;
  const begin = '<!-- BEGIN Sneakoscope Codex GX MANAGED BLOCK -->';
  const end = '<!-- END Sneakoscope Codex GX MANAGED BLOCK -->';
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if (start < 0 || finish < start) return true;
  const current = text.slice(start + begin.length, finish).trim();
  return current !== agentsBlockText().trim();
}

function isManagedQuickReference(text: string): boolean {
  return text.startsWith('# ㅅㅋㅅ\n')
    && text.includes('Files: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md');
}

function quickReferenceInstallScope(text: string, fallback: 'global' | 'project' = 'global'): 'global' | 'project' {
  const requested = text.match(/^Install scope:\s*`([^`]+)`/m)?.[1] || fallback;
  try {
    return normalizeInstallScope(requested);
  } catch {
    return fallback;
  }
}

function quickReferenceCommandPrefix(text: string, fallback: 'global' | 'project' = 'global'): string {
  const existing = text.match(/^Command:\s*`(.+?)\s+<command>`/m)?.[1]?.trim();
  if (existing) return existing;
  const scope = quickReferenceInstallScope(text, fallback);
  return sksCommandPrefix(scope);
}

async function quarantineUserGuidance(root: string, file: string, quarantineRoot: string): Promise<void> {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('guidance_quarantine_path_outside_root');
  }
  const target = await uniqueConfinedPath(root, path.join(quarantineRoot, relative));
  await moveConfinedPath(root, file, target);
}

function uniqueScopes(scopes: GuidanceScope[]): GuidanceScope[] {
  const unique = new Map<string, GuidanceScope>();
  for (const scope of scopes) {
    const resolved = path.resolve(scope.root);
    if (!unique.has(resolved)) unique.set(resolved, { ...scope, root: resolved });
  }
  return [...unique.values()];
}
