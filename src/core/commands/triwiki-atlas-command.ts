/**
 * Read-only Architecture Map (Atlas) diagnostics for `sks triwiki`.
 *
 * Inspection only: nothing here builds, repairs, or refreshes the map.
 * Global rebuild is owned by `sks align run`; mission before/after is owned by
 * the pipeline lifecycle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { flag, readOption } from '../../cli/args.js';
import {
  ARCHITECTURE_MAP_MANIFEST_SCHEMA,
  ARCHITECTURE_MAP_VIEW_IDS,
  GLOBAL_ARCHITECTURE_MAP_VIEW_IDS,
  type ArchitectureMapViewId
} from '../triwiki/context-graph/architecture/contracts.js';
import { ARCHITECTURE_MAP_DIR_REL } from '../triwiki/context-graph/store/architecture-map-store.js';

export const TRIWIKI_ATLAS_SUBCOMMANDS = [
  'atlas-status',
  'atlas-lint',
  'atlas-list',
  'atlas-show',
  'atlas-why'
] as const;

export type TriWikiAtlasSubcommand = (typeof TRIWIKI_ATLAS_SUBCOMMANDS)[number];

const REPAIR_COMMAND = 'sks align run';
const VIEW_ID_SET = new Set<string>(ARCHITECTURE_MAP_VIEW_IDS);
const GLOBAL_VIEW_ID_SET = new Set<string>(GLOBAL_ARCHITECTURE_MAP_VIEW_IDS);

export function isTriWikiAtlasSubcommand(value: unknown): value is TriWikiAtlasSubcommand {
  return typeof value === 'string' && (TRIWIKI_ATLAS_SUBCOMMANDS as readonly string[]).includes(value);
}

interface ManifestViewRow {
  readonly viewId: string;
  readonly contentHash: string;
  readonly byteLength: number;
}

interface ManifestDoc {
  readonly schema?: string;
  readonly missionId?: string | null;
  readonly graphHash?: string;
  readonly policyHash?: string;
  readonly topologyHash?: string;
  readonly inputBundleHash?: string;
  readonly analyzerVersion?: string;
  readonly serializerVersion?: string;
  readonly views?: readonly ManifestViewRow[];
  readonly projectionAccounting?: Record<string, unknown>;
  readonly canonicalHash?: string;
  readonly sourceBinding?: Record<string, string>;
}

interface FindingDoc {
  readonly id?: string;
  readonly code?: string;
  readonly severity?: string;
  readonly subjectIds?: readonly string[];
  readonly evidenceIds?: readonly string[];
  readonly ruleId?: string;
  readonly disposition?: string;
  readonly message?: string;
}

function mapRoot(root: string): string {
  return path.join(root, ...ARCHITECTURE_MAP_DIR_REL.split('/'));
}

function missionMapRoot(root: string, missionId: string): string {
  return path.join(root, '.sneakoscope', 'missions', missionId, 'architecture-map');
}

function resolveMapDir(root: string, args: string[]): { dir: string; mode: 'global' | 'mission'; missionId: string | null } {
  const missionId = readOption(args, '--mission', '') || null;
  if (missionId) {
    return { dir: missionMapRoot(root, missionId), mode: 'mission', missionId };
  }
  return { dir: mapRoot(root), mode: 'global', missionId: null };
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function loadManifest(dir: string): { ok: boolean; manifest: ManifestDoc | null; path: string } {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { ok: false, manifest: null, path: file };
  const manifest = readJsonFile<ManifestDoc>(file);
  return { ok: Boolean(manifest && manifest.schema === ARCHITECTURE_MAP_MANIFEST_SCHEMA), manifest, path: file };
}

function loadFindings(dir: string): FindingDoc[] {
  const file = path.join(dir, 'findings.json');
  const doc = readJsonFile<{ findings?: FindingDoc[] }>(file);
  return Array.isArray(doc?.findings) ? doc.findings : [];
}

function countBySeverity(findings: readonly FindingDoc[]): { blocking: number; warning: number; info: number } {
  let blocking = 0;
  let warning = 0;
  let info = 0;
  for (const finding of findings) {
    if (finding.severity === 'blocking') blocking += 1;
    else if (finding.severity === 'warning') warning += 1;
    else info += 1;
  }
  return { blocking, warning, info };
}

function graphFreshness(root: string, manifest: ManifestDoc | null): 'fresh' | 'stale' | 'missing' {
  if (!manifest) return 'missing';
  // The snapshot hash comes from the index meta, not from the 58 MB JSON
  // snapshot. It is the same value, written by the same compile, and ADR §6
  // makes the meta the authority for it — parsing the whole graph to reach one
  // field is the cost the v2 store exists to remove.
  const metaPath = path.join(root, '.sneakoscope', 'wiki', 'context-graph.meta.json');
  if (!fs.existsSync(metaPath)) return 'missing';
  const meta = readJsonFile<{ snapshotHash?: string }>(metaPath);
  const expected = String(meta?.snapshotHash || '');
  const observed = String(manifest.graphHash || manifest.sourceBinding?.graphHash || '');
  if (!expected || !observed) return 'missing';
  return expected === observed ? 'fresh' : 'stale';
}

async function atlasStatus(
  root: string,
  args: string[]
): Promise<{ result: unknown; ok: boolean; lines: string[] }> {
  const resolved = resolveMapDir(root, args);
  const loaded = loadManifest(resolved.dir);
  const findings = loaded.manifest ? loadFindings(resolved.dir) : [];
  const severity = countBySeverity(findings);
  const freshness = graphFreshness(root, loaded.manifest);
  const ok = loaded.ok && freshness === 'fresh' && severity.blocking === 0;
  const result = {
    schema: 'sks.triwiki-atlas-status.v1',
    ok,
    mode: resolved.mode,
    mission_id: resolved.missionId,
    manifest_schema: loaded.manifest?.schema ?? null,
    graph_hash: loaded.manifest?.graphHash ?? null,
    policy_hash: loaded.manifest?.policyHash ?? null,
    generated_from: loaded.manifest?.canonicalHash ?? null,
    freshness,
    view_count: loaded.manifest?.views?.length ?? 0,
    blocking_count: severity.blocking,
    warning_count: severity.warning,
    projection_accounting: loaded.manifest?.projectionAccounting ?? null,
    next_action: ok ? null : REPAIR_COMMAND,
    repair_command: REPAIR_COMMAND
  };
  const lines = [
    `Architecture map (${resolved.mode}): ${ok ? 'ok' : 'blocked'}`,
    `Freshness: ${freshness}`,
    `Views: ${result.view_count}; blocking=${severity.blocking} warning=${severity.warning}`,
    ...(ok ? [] : [`Repair: ${REPAIR_COMMAND}`])
  ];
  return { result, ok, lines };
}

async function atlasLint(
  root: string,
  args: string[]
): Promise<{ result: unknown; ok: boolean; lines: string[] }> {
  const resolved = resolveMapDir(root, args);
  const loaded = loadManifest(resolved.dir);
  const errors: string[] = [];
  if (!loaded.manifest) errors.push('manifest_missing');
  else {
    if (loaded.manifest.schema !== ARCHITECTURE_MAP_MANIFEST_SCHEMA) errors.push('schema');
    if (!loaded.manifest.graphHash) errors.push('graph_hash');
    if (!loaded.manifest.policyHash) errors.push('policy_hash');
    if (!Array.isArray(loaded.manifest.views) || loaded.manifest.views.length === 0) errors.push('views');
    if (!loaded.manifest.projectionAccounting) errors.push('projection_accounting');
    for (const view of loaded.manifest.views ?? []) {
      if (!VIEW_ID_SET.has(view.viewId)) errors.push(`unknown_view:${view.viewId}`);
      const viewPath = path.join(resolved.dir, 'views', `${view.viewId}.mmd`);
      if (!fs.existsSync(viewPath)) {
        errors.push(`missing_view_file:${view.viewId}`);
        continue;
      }
      const text = fs.readFileSync(viewPath, 'utf8');
      if (!text.startsWith('%% GENERATED BY SKS')) errors.push(`header:${view.viewId}`);
      if (!/\bflowchart (TD|LR)\b/.test(text)) errors.push(`grammar:${view.viewId}`);
      if (/\/Users\/|\/home\/|C:\\\\/.test(text)) errors.push(`absolute_path:${view.viewId}`);
      const rel = path.relative(resolved.dir, viewPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) errors.push(`path_escape:${view.viewId}`);
    }
  }
  const freshness = graphFreshness(root, loaded.manifest);
  if (freshness !== 'fresh') errors.push(`freshness_${freshness}`);
  const ok = errors.length === 0;
  const result = {
    schema: 'sks.triwiki-atlas-lint.v1',
    ok,
    mode: resolved.mode,
    mission_id: resolved.missionId,
    error_count: errors.length,
    errors,
    repair_command: REPAIR_COMMAND
  };
  return {
    result,
    ok,
    lines: [
      `Architecture map lint: ${ok ? 'ok' : 'blocked'} (${errors.length} errors)`,
      ...errors.slice(0, 20).map((error) => `- ${error}`),
      ...(ok ? [] : [`Repair: ${REPAIR_COMMAND}`])
    ]
  };
}

async function atlasList(
  root: string,
  args: string[]
): Promise<{ result: unknown; ok: boolean; lines: string[] }> {
  const resolved = resolveMapDir(root, args);
  const loaded = loadManifest(resolved.dir);
  if (!loaded.manifest) {
    return {
      result: {
        schema: 'sks.triwiki-atlas-list.v1',
        ok: false,
        error_code: 'manifest_missing',
        repair_command: REPAIR_COMMAND
      },
      ok: false,
      lines: ['Architecture map list: manifest_missing', `Repair: ${REPAIR_COMMAND}`]
    };
  }
  const views = (loaded.manifest.views ?? []).map((view) => {
    const rel = `${ARCHITECTURE_MAP_DIR_REL}/views/${view.viewId}.mmd`;
    const abs = path.join(resolved.dir, 'views', `${view.viewId}.mmd`);
    let direction: string | null = null;
    let nodeCount = 0;
    let edgeCount = 0;
    if (fs.existsSync(abs)) {
      const text = fs.readFileSync(abs, 'utf8');
      direction = text.match(/\bflowchart (TD|LR)\b/)?.[1] ?? null;
      nodeCount = [...text.matchAll(/^\s*[A-Za-z0-9_]+\[/gm)].length;
      edgeCount = [...text.matchAll(/-->/g)].length;
    }
    return {
      view_id: view.viewId,
      path: rel,
      direction,
      node_count: nodeCount,
      edge_count: edgeCount,
      byte_count: view.byteLength,
      hash: view.contentHash
    };
  });
  const result = {
    schema: 'sks.triwiki-atlas-list.v1',
    ok: true,
    mode: resolved.mode,
    mission_id: resolved.missionId,
    views
  };
  return {
    result,
    ok: true,
    lines: views.map(
      (view) =>
        `${view.view_id}  ${view.direction ?? '?'}  nodes=${view.node_count} edges=${view.edge_count} bytes=${view.byte_count} ${view.hash.slice(0, 12)}`
    )
  };
}

async function atlasShow(
  root: string,
  args: string[]
): Promise<{ result: unknown; ok: boolean; lines: string[] }> {
  const viewId = args.find((arg) => !arg.startsWith('-')) ?? '';
  if (!viewId || !VIEW_ID_SET.has(viewId)) {
    return {
      result: {
        schema: 'sks.triwiki-atlas-show.v1',
        ok: false,
        error_code: 'invalid_view_id',
        allowed: [...ARCHITECTURE_MAP_VIEW_IDS]
      },
      ok: false,
      lines: [
        'Usage: sks triwiki atlas-show <view-id> [--mission <id>] [--format mermaid|json]',
        `Allowed: ${ARCHITECTURE_MAP_VIEW_IDS.join(', ')}`
      ]
    };
  }
  if (!GLOBAL_VIEW_ID_SET.has(viewId) && !readOption(args, '--mission', '')) {
    return {
      result: {
        schema: 'sks.triwiki-atlas-show.v1',
        ok: false,
        error_code: 'mission_view_requires_mission',
        view_id: viewId
      },
      ok: false,
      lines: [`View ${viewId} is mission-scoped; pass --mission <id>`]
    };
  }
  const format = readOption(args, '--format', 'mermaid') || 'mermaid';
  const resolved = resolveMapDir(root, args);
  const viewPath = path.join(resolved.dir, 'views', `${viewId}.mmd`);
  const confined = path.relative(resolved.dir, viewPath);
  if (confined.startsWith('..') || path.isAbsolute(confined)) {
    return {
      result: { schema: 'sks.triwiki-atlas-show.v1', ok: false, error_code: 'path_escape' },
      ok: false,
      lines: ['Architecture map show blocked: path_escape']
    };
  }
  if (!fs.existsSync(viewPath)) {
    return {
      result: {
        schema: 'sks.triwiki-atlas-show.v1',
        ok: false,
        error_code: 'view_missing',
        view_id: viewId,
        repair_command: REPAIR_COMMAND
      },
      ok: false,
      lines: [`Architecture map show: view_missing (${viewId})`, `Repair: ${REPAIR_COMMAND}`]
    };
  }
  const text = fs.readFileSync(viewPath, 'utf8');
  if (format === 'json') {
    const result = {
      schema: 'sks.triwiki-atlas-show.v1',
      ok: true,
      view_id: viewId as ArchitectureMapViewId,
      format: 'json',
      path: `${ARCHITECTURE_MAP_DIR_REL}/views/${viewId}.mmd`,
      text
    };
    return { result, ok: true, lines: [JSON.stringify(result, null, 2)] };
  }
  return {
    result: {
      schema: 'sks.triwiki-atlas-show.v1',
      ok: true,
      view_id: viewId,
      format: 'mermaid',
      path: `${ARCHITECTURE_MAP_DIR_REL}/views/${viewId}.mmd`,
      text
    },
    ok: true,
    lines: [text.trimEnd()]
  };
}

async function atlasWhy(
  root: string,
  args: string[]
): Promise<{ result: unknown; ok: boolean; lines: string[] }> {
  const findingId = args.find((arg) => !arg.startsWith('-')) ?? '';
  const missionId = readOption(args, '--mission', '');
  if (!findingId || !missionId) {
    return {
      result: { schema: 'sks.triwiki-atlas-why.v1', ok: false, error_code: 'usage' },
      ok: false,
      lines: ['Usage: sks triwiki atlas-why <finding-id> --mission <id> [--json]']
    };
  }
  const resolved = resolveMapDir(root, [`--mission`, missionId]);
  const findings = loadFindings(resolved.dir);
  const finding = findings.find((entry) => entry.id === findingId) ?? null;
  if (!finding) {
    return {
      result: {
        schema: 'sks.triwiki-atlas-why.v1',
        ok: false,
        error_code: 'finding_not_found',
        finding_id: findingId,
        mission_id: missionId
      },
      ok: false,
      lines: [`Architecture map why: finding_not_found (${findingId})`]
    };
  }
  const result = {
    schema: 'sks.triwiki-atlas-why.v1',
    ok: true,
    finding_id: finding.id,
    code: finding.code ?? null,
    severity: finding.severity ?? null,
    subject: finding.subjectIds ?? [],
    evidence_path: finding.evidenceIds ?? [],
    before: null,
    after: null,
    policy_rule: finding.ruleId ?? null,
    exception: finding.disposition ?? null,
    inspect_nodes: finding.subjectIds ?? [],
    message: finding.message ?? null
  };
  return {
    result,
    ok: true,
    lines: [
      `${finding.id}: ${finding.code ?? 'unknown'} (${finding.severity ?? 'info'})`,
      ...(finding.subjectIds?.length ? [`Subject: ${finding.subjectIds.join(', ')}`] : []),
      ...(finding.message ? [finding.message] : [])
    ]
  };
}

/** Dispatch an `atlas-*` subcommand. Returns the JSON-shaped result for the caller to print. */
export async function triwikiAtlasCommand(
  root: string,
  sub: TriWikiAtlasSubcommand,
  args: string[]
): Promise<{ result: unknown; ok: boolean; lines: string[]; exitCode: number }> {
  let answer: { result: unknown; ok: boolean; lines: string[] };
  if (sub === 'atlas-status') answer = await atlasStatus(root, args);
  else if (sub === 'atlas-lint') answer = await atlasLint(root, args);
  else if (sub === 'atlas-list') answer = await atlasList(root, args);
  else if (sub === 'atlas-show') answer = await atlasShow(root, args);
  else answer = await atlasWhy(root, args);

  const usageFailed =
    typeof answer.result === 'object' &&
    answer.result !== null &&
    'error_code' in answer.result &&
    (answer.result as { error_code?: string }).error_code === 'usage';
  const invalidView =
    typeof answer.result === 'object' &&
    answer.result !== null &&
    'error_code' in answer.result &&
    (answer.result as { error_code?: string }).error_code === 'invalid_view_id';
  const exitCode = answer.ok ? 0 : usageFailed || invalidView ? 2 : 1;
  return { ...answer, exitCode };
}
