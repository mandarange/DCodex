/**
 * Loader for config/architecture-map-policy.v1.json.
 * Layers/boundaries/thresholds adapted from atlas policy; WO §8 budgets added.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ARCHITECTURE_FINDING_CODES,
  ARCHITECTURE_MAP_POLICY_FILE,
  ARCHITECTURE_MAP_POLICY_SCHEMA,
  type ArchitectureFindingCode,
  type ArchitectureMapProfile
} from './contracts.js';

export const LAYER_EDGE_SEPARATOR = ' -> ';

const LAYER_ID = /^[a-z][a-z0-9_]*$/;
const EXCEPTION_ID = /^[a-z][a-z0-9-]*$/;
const MODULE_ID_SHAPE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export const ARCHITECTURE_MAP_THRESHOLD_KEYS = [
  'max_diagram_nodes',
  'max_diagram_edges',
  'max_diagram_bytes',
  'max_module_fan_out',
  'max_module_fan_in'
] as const;

export type ArchitectureMapThresholdKey = (typeof ARCHITECTURE_MAP_THRESHOLD_KEYS)[number];
export type ArchitectureMapThresholds = { readonly [K in ArchitectureMapThresholdKey]: number };

export interface ArchitectureMapLayer {
  readonly id: string;
  readonly purpose: string;
  readonly modules: readonly string[];
}

export interface ArchitectureMapBoundaryRule {
  readonly from: string;
  readonly to: readonly string[];
}

export interface ArchitectureMapBoundaries {
  readonly mode: 'allow-list';
  readonly allow: readonly ArchitectureMapBoundaryRule[];
}

export interface ArchitectureMapLayerException {
  readonly id: string;
  readonly reason: string;
  readonly edges: readonly string[];
  readonly baseline_module_edges: number;
  readonly ceiling_module_edges: number;
}

export interface ArchitectureMapExceptions {
  readonly mode: 'shrink-only';
  readonly entries: readonly ArchitectureMapLayerException[];
}

export interface ArchitectureMapProfileBudget {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxLabelChars: number;
  readonly tokenBudget: number;
}

export interface ArchitectureMapViewBudget {
  readonly maxNodes: number;
  readonly maxEdges: number;
}

export interface ArchitectureMapPolicy {
  readonly schema: typeof ARCHITECTURE_MAP_POLICY_SCHEMA;
  readonly version: number;
  readonly module_id_source: string;
  readonly layers: readonly ArchitectureMapLayer[];
  readonly boundaries: ArchitectureMapBoundaries;
  readonly thresholds: ArchitectureMapThresholds;
  readonly profiles: Readonly<Record<ArchitectureMapProfile, ArchitectureMapProfileBudget>>;
  readonly absoluteTokenCeiling: number;
  readonly globalAtlasMaxBytes: number;
  readonly missionArtifactsMaxBytes: number;
  readonly accuracyFloors: Readonly<{
    changedPathAccounting: number;
    projectionAccounting: number;
    protectedRelationRecall: number;
    eligibleExtractionSuccess: number;
    deterministicHashRuns: number;
  }>;
  readonly viewBudgets: Readonly<Record<string, ArchitectureMapViewBudget>>;
  readonly blockingCodes: readonly ArchitectureFindingCode[];
  readonly exceptions: ArchitectureMapExceptions;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('architecture_map_policy_not_an_object', where);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('architecture_map_policy_not_an_array', where);
  return value;
}

function asText(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('architecture_map_policy_not_text', where);
  return value;
}

function asCount(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail('architecture_map_policy_not_a_count', `${where} must be a positive safe integer`);
  }
  return value;
}

function asNonNeg(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('architecture_map_policy_not_nonneg', where);
  }
  return value;
}

function assertDistinct(values: readonly string[], code: string, where: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(code, `${where}: ${value}`);
    seen.add(value);
  }
}

export function parseLayerEdge(edge: string): { from: string; to: string } {
  const parts = edge.split(LAYER_EDGE_SEPARATOR);
  const from = parts[0];
  const to = parts[1];
  if (parts.length !== 2 || !from || !to || !LAYER_ID.test(from) || !LAYER_ID.test(to)) {
    fail('architecture_map_policy_malformed_edge', edge);
  }
  return { from, to };
}

function parseLayers(value: unknown): readonly ArchitectureMapLayer[] {
  const rows = asArray(value, 'layers');
  if (!rows.length) fail('architecture_map_policy_no_layers', 'layers');
  const layers: ArchitectureMapLayer[] = [];
  for (const [index, row] of rows.entries()) {
    const where = `layers[${index}]`;
    const record = asRecord(row, where);
    const id = asText(record.id, `${where}.id`);
    if (!LAYER_ID.test(id)) fail('architecture_map_policy_bad_layer_id', id);
    const modules = asArray(record.modules, `${where}.modules`).map((entry, i) => {
      const moduleId = asText(entry, `${where}.modules[${i}]`);
      if (!MODULE_ID_SHAPE.test(moduleId) || moduleId.split('/').includes('..')) {
        fail('architecture_map_policy_bad_module_id', moduleId);
      }
      return moduleId;
    });
    if (!modules.length) fail('architecture_map_policy_empty_layer', where);
    assertDistinct(modules, 'architecture_map_policy_duplicate_module', where);
    layers.push(
      Object.freeze({
        id,
        purpose: asText(record.purpose, `${where}.purpose`),
        modules: Object.freeze(modules)
      })
    );
  }
  assertDistinct(
    layers.map((layer) => layer.id),
    'architecture_map_policy_duplicate_layer',
    'layers'
  );
  assertDistinct(
    layers.flatMap((layer) => layer.modules),
    'architecture_map_policy_module_in_two_layers',
    'layers'
  );
  return Object.freeze(layers);
}

function parseBoundaries(value: unknown, layerIds: ReadonlySet<string>): ArchitectureMapBoundaries {
  const record = asRecord(value, 'boundaries');
  if (record.mode !== 'allow-list') fail('architecture_map_policy_bad_boundary_mode', String(record.mode));
  const rules = asArray(record.allow, 'boundaries.allow').map((row, index) => {
    const where = `boundaries.allow[${index}]`;
    const rule = asRecord(row, where);
    const from = asText(rule.from, `${where}.from`);
    if (!layerIds.has(from)) fail('architecture_map_policy_unknown_layer', from);
    const to = asArray(rule.to, `${where}.to`).map((entry, i) => {
      const target = asText(entry, `${where}.to[${i}]`);
      if (!layerIds.has(target)) fail('architecture_map_policy_unknown_layer', target);
      return target;
    });
    return Object.freeze({ from, to: Object.freeze(to) });
  });
  assertDistinct(
    rules.map((rule) => rule.from),
    'architecture_map_policy_duplicate_boundary',
    'boundaries.allow'
  );
  return Object.freeze({ mode: 'allow-list' as const, allow: Object.freeze(rules) });
}

function parseThresholds(value: unknown): ArchitectureMapThresholds {
  const record = asRecord(value, 'thresholds');
  return Object.freeze({
    max_diagram_nodes: asCount(record.max_diagram_nodes, 'thresholds.max_diagram_nodes'),
    max_diagram_edges: asCount(record.max_diagram_edges, 'thresholds.max_diagram_edges'),
    max_diagram_bytes: asCount(record.max_diagram_bytes, 'thresholds.max_diagram_bytes'),
    max_module_fan_out: asCount(record.max_module_fan_out, 'thresholds.max_module_fan_out'),
    max_module_fan_in: asCount(record.max_module_fan_in, 'thresholds.max_module_fan_in')
  });
}

function parseProfileBudget(value: unknown, where: string): ArchitectureMapProfileBudget {
  const record = asRecord(value, where);
  return Object.freeze({
    maxNodes: asCount(record.maxNodes, `${where}.maxNodes`),
    maxEdges: asCount(record.maxEdges, `${where}.maxEdges`),
    maxLabelChars: asCount(record.maxLabelChars, `${where}.maxLabelChars`),
    tokenBudget: asNonNeg(record.tokenBudget, `${where}.tokenBudget`)
  });
}

function parseProfiles(value: unknown): ArchitectureMapPolicy['profiles'] {
  const record = asRecord(value, 'profiles');
  const keys: ArchitectureMapProfile[] = ['global', 'planning', 'implementation', 'review', 'protected'];
  const out = {} as Record<ArchitectureMapProfile, ArchitectureMapProfileBudget>;
  for (const key of keys) {
    if (!(key in record)) fail('architecture_map_policy_missing_profile', key);
    out[key] = parseProfileBudget(record[key], `profiles.${key}`);
  }
  return Object.freeze(out);
}

function parseExceptions(
  value: unknown,
  layerIds: ReadonlySet<string>,
  allowed: ReadonlySet<string>
): ArchitectureMapExceptions {
  const record = asRecord(value, 'exceptions');
  if (record.mode !== 'shrink-only') fail('architecture_map_policy_bad_exception_mode', String(record.mode));
  const claimed = new Set<string>();
  const entries = asArray(record.entries, 'exceptions.entries').map((row, index) => {
    const where = `exceptions.entries[${index}]`;
    const entry = asRecord(row, where);
    const id = asText(entry.id, `${where}.id`);
    if (!EXCEPTION_ID.test(id)) fail('architecture_map_policy_bad_exception_id', id);
    const edges = asArray(entry.edges, `${where}.edges`).map((item, i) => {
      const text = asText(item, `${where}.edges[${i}]`);
      const edge = parseLayerEdge(text);
      if (!layerIds.has(edge.from) || !layerIds.has(edge.to)) {
        fail('architecture_map_policy_unknown_layer', text);
      }
      if (allowed.has(text)) fail('architecture_map_policy_exception_already_allowed', text);
      if (claimed.has(text)) fail('architecture_map_policy_edge_claimed_twice', text);
      claimed.add(text);
      return text;
    });
    const baseline = asCount(entry.baseline_module_edges, `${where}.baseline_module_edges`);
    const ceiling = asCount(entry.ceiling_module_edges, `${where}.ceiling_module_edges`);
    if (ceiling > baseline) fail('architecture_map_policy_ceiling_above_baseline', where);
    return Object.freeze({
      id,
      reason: asText(entry.reason, `${where}.reason`),
      edges: Object.freeze(edges),
      baseline_module_edges: baseline,
      ceiling_module_edges: ceiling
    });
  });
  assertDistinct(
    entries.map((entry) => entry.id),
    'architecture_map_policy_duplicate_exception',
    'exceptions.entries'
  );
  return Object.freeze({ mode: 'shrink-only' as const, entries: Object.freeze(entries) });
}

function parseBlockingCodes(value: unknown): readonly ArchitectureFindingCode[] {
  if (value === undefined) return Object.freeze([...ARCHITECTURE_FINDING_CODES]);
  const known = new Set<string>(ARCHITECTURE_FINDING_CODES);
  const codes = asArray(value, 'blockingCodes').map((entry, i) => {
    const code = asText(entry, `blockingCodes[${i}]`);
    if (!known.has(code)) fail('architecture_map_policy_unknown_blocking_code', code);
    return code as ArchitectureFindingCode;
  });
  return Object.freeze(codes);
}

function parseViewBudgets(value: unknown): Readonly<Record<string, ArchitectureMapViewBudget>> {
  if (value === undefined) return Object.freeze({});
  const record = asRecord(value, 'viewBudgets');
  const out: Record<string, ArchitectureMapViewBudget> = {};
  for (const [viewId, budget] of Object.entries(record)) {
    const row = asRecord(budget, `viewBudgets.${viewId}`);
    out[viewId] = Object.freeze({
      maxNodes: asCount(row.maxNodes, `viewBudgets.${viewId}.maxNodes`),
      maxEdges: asCount(row.maxEdges, `viewBudgets.${viewId}.maxEdges`)
    });
  }
  return Object.freeze(out);
}

function parseAccuracyFloors(value: unknown): ArchitectureMapPolicy['accuracyFloors'] {
  const defaults = {
    changedPathAccounting: 1,
    projectionAccounting: 1,
    protectedRelationRecall: 1,
    eligibleExtractionSuccess: 0.995,
    deterministicHashRuns: 3
  };
  if (value === undefined) return Object.freeze(defaults);
  const record = asRecord(value, 'accuracyFloors');
  return Object.freeze({
    changedPathAccounting: asNonNeg(record.changedPathAccounting ?? 1, 'accuracyFloors.changedPathAccounting'),
    projectionAccounting: asNonNeg(record.projectionAccounting ?? 1, 'accuracyFloors.projectionAccounting'),
    protectedRelationRecall: asNonNeg(
      record.protectedRelationRecall ?? 1,
      'accuracyFloors.protectedRelationRecall'
    ),
    eligibleExtractionSuccess: asNonNeg(
      record.eligibleExtractionSuccess ?? 0.995,
      'accuracyFloors.eligibleExtractionSuccess'
    ),
    deterministicHashRuns: asCount(record.deterministicHashRuns ?? 3, 'accuracyFloors.deterministicHashRuns')
  });
}

export function parseArchitectureMapPolicy(value: unknown): ArchitectureMapPolicy {
  const record = asRecord(value, 'policy');
  if (record.schema !== ARCHITECTURE_MAP_POLICY_SCHEMA) {
    fail('architecture_map_policy_schema_mismatch', String(record.schema));
  }
  const layers = parseLayers(record.layers);
  const layerIds = new Set(layers.map((layer) => layer.id));
  const boundaries = parseBoundaries(record.boundaries, layerIds);
  const allowed = new Set(
    boundaries.allow.flatMap((rule) =>
      rule.to.map((target) => `${rule.from}${LAYER_EDGE_SEPARATOR}${target}`)
    )
  );
  return Object.freeze({
    schema: ARCHITECTURE_MAP_POLICY_SCHEMA,
    version: typeof record.version === 'number' ? record.version : 1,
    module_id_source: asText(record.module_id_source, 'module_id_source'),
    layers,
    boundaries,
    thresholds: parseThresholds(record.thresholds),
    profiles: parseProfiles(record.profiles),
    absoluteTokenCeiling: asNonNeg(record.absoluteTokenCeiling ?? 3200, 'absoluteTokenCeiling'),
    globalAtlasMaxBytes: asCount(record.globalAtlasMaxBytes ?? 1572864, 'globalAtlasMaxBytes'),
    missionArtifactsMaxBytes: asCount(record.missionArtifactsMaxBytes ?? 358400, 'missionArtifactsMaxBytes'),
    accuracyFloors: parseAccuracyFloors(record.accuracyFloors),
    viewBudgets: parseViewBudgets(record.viewBudgets),
    blockingCodes: parseBlockingCodes(record.blockingCodes),
    exceptions: parseExceptions(record.exceptions, layerIds, allowed)
  });
}

export function loadArchitectureMapPolicy(root: string): ArchitectureMapPolicy {
  if (typeof root !== 'string' || !root) fail('architecture_map_policy_root_missing', 'root');
  const file = path.join(root, ...ARCHITECTURE_MAP_POLICY_FILE.split('/'));
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail('architecture_map_policy_unreadable', `${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (error) {
    fail('architecture_map_policy_invalid_json', `${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseArchitectureMapPolicy(json);
}

export function moduleLayerMap(policy: ArchitectureMapPolicy): Map<string, string> {
  const map = new Map<string, string>();
  for (const layer of policy.layers) {
    for (const moduleId of layer.modules) map.set(moduleId, layer.id);
  }
  return map;
}

export function allowedLayerEdges(policy: ArchitectureMapPolicy): Set<string> {
  const allowed = new Set<string>();
  for (const rule of policy.boundaries.allow) {
    for (const target of rule.to) allowed.add(`${rule.from}${LAYER_EDGE_SEPARATOR}${target}`);
  }
  for (const entry of policy.exceptions.entries) {
    for (const edge of entry.edges) allowed.add(edge);
  }
  return allowed;
}

export function severityForCode(
  policy: ArchitectureMapPolicy,
  code: ArchitectureFindingCode
): 'blocking' | 'warning' | 'info' {
  if (policy.blockingCodes.includes(code)) return 'blocking';
  if (code === 'insufficient_graph') return 'blocking';
  return 'warning';
}

/** Resolve the policy layer id for a module directory (exact match, then longest prefix). */
export function layerForModule(policy: ArchitectureMapPolicy, moduleDir: string): string | null {
  const exact = moduleLayerMap(policy).get(moduleDir);
  if (exact) return exact;
  let best: { id: string; length: number } | null = null;
  for (const layer of policy.layers) {
    for (const moduleId of layer.modules) {
      if (moduleDir === moduleId || moduleDir.startsWith(`${moduleId}/`)) {
        if (!best || moduleId.length > best.length) best = { id: layer.id, length: moduleId.length };
      }
    }
  }
  return best?.id ?? null;
}

export function isAllowedLayerEdge(policy: ArchitectureMapPolicy, fromLayer: string, toLayer: string): boolean {
  if (fromLayer === toLayer) return true;
  return allowedLayerEdges(policy).has(`${fromLayer}${LAYER_EDGE_SEPARATOR}${toLayer}`);
}
