import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { nowIso } from '../fsx.js';
import { buildCodexPluginInventory } from '../codex-plugins/codex-plugin-json.js';
import { inspectConfinedPath, isLexicallyConfined } from '../managed-path-safety.js';
import { currentCodexSkillRoots, type CodexSkillRootScope } from './sks-skill-paths.js';
import { writeRootConfinedJsonReport } from './confined-report-writer.js';
import { messageOf } from '../errors/message.js';

interface CodexNativeInventory {
  plugins?: Array<{ id?: unknown; name?: unknown }>;
  blockers?: string[];
}

export interface CodexNativeInteropPolicy {
  schema: 'sks.codex-native-interop-policy.v1';
  generated_at: string;
  ok: boolean;
  mode: 'coexist' | 'sks-primary';
  detection: {
    plugin_inventory_ids: string[];
    skill_names: string[];
    preserved_skill_names: string[];
  };
  policy: {
    clobber_user_skills: false;
    clobber_external_route_assets: false;
    explicit_handoff_required: true;
    artifact_names_brand_neutral: true;
  };
  actions: string[];
  blockers: string[];
}

const RESERVED_EXTERNAL_ROUTE_SKILLS = ['ulw-loop', 'ulw-plan', 'start-work'];

interface ConfinedSkillRoot {
  scope: CodexSkillRootScope;
  root: string;
  boundary: string;
}

type SkillScanRootFailureReason =
  | 'leaf_symlink'
  | 'not_directory'
  | 'boundary_missing'
  | 'boundary_symlink'
  | 'boundary_not_directory'
  | 'escape_refused'
  | 'ancestor_symlink'
  | 'ancestor_not_directory'
  | 'inspection_failed'
  | 'readdir_failed';

export async function buildCodexNativeInteropPolicy(input: {
  root: string;
  mode?: 'coexist' | 'sks-primary';
  codexHome?: string;
  inventory?: CodexNativeInventory | unknown;
  reportPath?: string | null;
}): Promise<CodexNativeInteropPolicy> {
  const root = path.resolve(input.root);
  const inventory = normalizeInventory(input.inventory || await buildCodexPluginInventory().catch((err: unknown) => ({ plugins: [], blockers: [messageOf(err)] })));
  const home = path.resolve(process.env.HOME || os.homedir());
  const codexHome = path.resolve(input.codexHome || process.env.CODEX_HOME || path.join(home, '.codex'));
  const codexHomeBoundary = isLexicallyConfined(home, codexHome) ? home : path.dirname(codexHome);
  const skillScan = await discoverSkillNames(currentCodexSkillRoots({ root, home, codexHome }).map((entry) => ({
    ...entry,
    boundary: entry.scope === 'global'
      ? home
      : entry.scope === 'project'
        ? root
        : codexHomeBoundary
  })));
  const skillNames = skillScan.names;
  const pluginIds = (inventory.plugins || []).map((plugin) => `${plugin.id || ''} ${plugin.name || ''}`.toLowerCase()).filter(Boolean);
  const preservedSkillNames = RESERVED_EXTERNAL_ROUTE_SKILLS.filter((name) => skillNames.includes(name));
  const report: CodexNativeInteropPolicy = {
    schema: 'sks.codex-native-interop-policy.v1',
    generated_at: nowIso(),
    ok: skillScan.blockers.length === 0,
    mode: input.mode || 'coexist',
    detection: {
      plugin_inventory_ids: pluginIds,
      skill_names: skillNames,
      preserved_skill_names: preservedSkillNames
    },
    policy: {
      clobber_user_skills: false,
      clobber_external_route_assets: false,
      explicit_handoff_required: true,
      artifact_names_brand_neutral: true
    },
    actions: preservedSkillNames.map((name) => `preserve_existing_skill:${name}`),
    blockers: skillScan.blockers
  };
  const reportPath = input.reportPath === null
    ? null
    : input.reportPath || path.join(root, '.sneakoscope', 'reports', 'codex-native-interop-policy.json');
  if (reportPath) {
    const written = await writeRootConfinedJsonReport({ root, reportPath, value: report });
    if (!written) {
      report.ok = false;
      report.blockers = [...new Set([...report.blockers, 'codex_native_interop_report_path_unsafe'])].sort();
    }
  }
  return report;
}

function normalizeInventory(value: unknown): CodexNativeInventory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { plugins: [], blockers: [] };
  const record = value as { plugins?: unknown; blockers?: unknown };
  return {
    plugins: Array.isArray(record.plugins) ? record.plugins.map((plugin) => plugin && typeof plugin === 'object' ? plugin as { id?: unknown; name?: unknown } : {}) : [],
    blockers: Array.isArray(record.blockers) ? record.blockers.map(String) : []
  };
}

async function discoverSkillNames(roots: ConfinedSkillRoot[]): Promise<{ names: string[]; blockers: string[] }> {
  const names = new Set<string>();
  const blockers = new Set<string>();
  for (const candidate of roots) {
    let inspection;
    try {
      inspection = await inspectConfinedPath(candidate.boundary, candidate.root);
    } catch (error: unknown) {
      blockers.add(unsafeSkillScanRootBlocker(candidate.scope, skillScanRootInspectionFailureReason(error)));
      continue;
    }
    if (!inspection.exists) continue;
    if (inspection.leafSymlink) {
      blockers.add(unsafeSkillScanRootBlocker(candidate.scope, 'leaf_symlink'));
      continue;
    }
    if (!inspection.stat?.isDirectory()) {
      blockers.add(unsafeSkillScanRootBlocker(candidate.scope, 'not_directory'));
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(candidate.root, { withFileTypes: true });
    } catch {
      blockers.add(unsafeSkillScanRootBlocker(candidate.scope, 'readdir_failed'));
      continue;
    }
    for (const entry of entries) if (entry.isDirectory()) names.add(entry.name);
  }
  return { names: [...names].sort(), blockers: [...blockers].sort() };
}

function unsafeSkillScanRootBlocker(scope: CodexSkillRootScope, reason: SkillScanRootFailureReason): string {
  return `unsafe_skill_scan_root:${skillScanRootScopeCode(scope)}:${reason}`;
}

function skillScanRootScopeCode(scope: CodexSkillRootScope): CodexSkillRootScope | 'unknown' {
  if (scope === 'global' || scope === 'project' || scope === 'codex-home') return scope;
  return 'unknown';
}

function skillScanRootInspectionFailureReason(error: unknown): SkillScanRootFailureReason {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'managed_path_boundary_missing') return 'boundary_missing';
  if (code === 'managed_path_boundary_symlink_refused') return 'boundary_symlink';
  if (code === 'managed_path_boundary_not_directory') return 'boundary_not_directory';
  if (code === 'managed_path_escape_refused') return 'escape_refused';
  if (code === 'managed_path_ancestor_symlink_refused') return 'ancestor_symlink';
  if (code === 'managed_path_ancestor_not_directory') return 'ancestor_not_directory';
  return 'inspection_failed';
}
