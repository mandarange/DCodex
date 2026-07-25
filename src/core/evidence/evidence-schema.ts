import { nowIso, randomId } from '../fsx.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

export const EVIDENCE_SCHEMA = 'sks.evidence.v1';
export const EVIDENCE_INDEX_SCHEMA = 'sks.evidence-index.v1';
export const PROJECT_EVIDENCE_INDEX_SCHEMA = 'sks.project-evidence-index.v1';

export const EVIDENCE_KINDS = Object.freeze([
  'agent',
  'image_voxel',
  'db_safety',
  'hook',
  'codex_lb',
  'test',
  'file_change',
  'command',
  'rust',
  'blackbox',
  'proof',
  'route_contract',
  'trust_report',
  'route_gate',
  'ux_review_source_screenshot',
  'ux_review_gpt_image_2_callout',
  'ux_review_callout_extraction',
  'ux_review_patch_result',
  'ux_review_recheck',
  'wrongness',
  'image_wrongness',
  'correction',
  'avoidance_rule',
  'artifact'
] as const);

export const EVIDENCE_SOURCES = Object.freeze([
  'real',
  'mock',
  'static_contract',
  'fixture',
  'blocked'
] as const);

export const EVIDENCE_FRESHNESS = Object.freeze([
  'fresh',
  'stale',
  'unknown'
] as const);

export const EVIDENCE_TRUST = Object.freeze([
  'high',
  'medium',
  'low',
  'blocked'
] as const);

export type EvidenceKind = typeof EVIDENCE_KINDS[number];
export type EvidenceSource = typeof EVIDENCE_SOURCES[number];
export type EvidenceFreshness = typeof EVIDENCE_FRESHNESS[number];
export type EvidenceTrust = typeof EVIDENCE_TRUST[number];

type JsonRecord = Record<string, unknown>;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function evidenceId(kind: unknown = 'artifact') {
  return `EV-${String(kind || 'artifact').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase() || 'ART'}-${randomId(8)}`;
}

export function normalizeEvidenceKind(kind: unknown = 'artifact'): EvidenceKind {
  return isOneOf(EVIDENCE_KINDS, kind) ? kind : 'artifact';
}

export function normalizeEvidenceSource(source: unknown = 'real'): EvidenceSource {
  return isOneOf(EVIDENCE_SOURCES, source) ? source : 'real';
}

export function normalizeEvidenceFreshness(freshness: unknown = 'unknown'): EvidenceFreshness {
  return isOneOf(EVIDENCE_FRESHNESS, freshness) ? freshness : 'unknown';
}

export function normalizeEvidenceTrust(trust: unknown = 'low'): EvidenceTrust {
  return isOneOf(EVIDENCE_TRUST, trust) ? trust : 'low';
}

export function createEvidenceRecord(input: unknown = {}): EvidenceRecord {
  const record = asRecord(input);
  const source = normalizeEvidenceSource(record.source);
  const freshness = normalizeEvidenceFreshness(record.freshness);
  return {
    schema: EVIDENCE_SCHEMA,
    id: stringOrNull(record.id) || evidenceId(record.kind),
    mission_id: stringOrNull(record.mission_id),
    kind: normalizeEvidenceKind(record.kind),
    source,
    path: stringOrNull(record.path),
    sha256: stringOrNull(record.sha256),
    created_at: stringOrNull(record.created_at) || nowIso(),
    freshness,
    trust: normalizeEvidenceTrust(record.trust || trustForEvidence({ source, freshness, blocked: record.blocked })),
    redacted: record.redacted !== false,
    issues: stringList(record.issues)
  };
}

export function trustForEvidence(input: unknown = {}): EvidenceTrust {
  const record = asRecord(input);
  const source = normalizeEvidenceSource(record.source);
  const freshness = normalizeEvidenceFreshness(record.freshness);
  const blocked = Boolean(record.blocked);
  if (blocked || source === 'blocked') return 'blocked';
  if (freshness === 'stale') return 'blocked';
  if (source === 'mock' || source === 'static_contract') return 'low';
  if (source === 'fixture') return 'medium';
  return freshness === 'fresh' ? 'high' : 'medium';
}

export function validateEvidenceRecord(record: unknown = {}) {
  const issues: string[] = [];
  const row = asRecord(record);
  if (row.schema !== EVIDENCE_SCHEMA) issues.push('schema');
  if (!row.id) issues.push('id');
  if (!isOneOf(EVIDENCE_KINDS, row.kind)) issues.push('kind');
  if (!isOneOf(EVIDENCE_SOURCES, row.source)) issues.push('source');
  if (!isOneOf(EVIDENCE_FRESHNESS, row.freshness)) issues.push('freshness');
  if (!isOneOf(EVIDENCE_TRUST, row.trust)) issues.push('trust');
  if (row.path && !row.sha256) issues.push('sha256');
  if ((row.source === 'mock' || row.source === 'static_contract') && row.trust === 'high') issues.push('mock_high_trust');
  if (row.freshness === 'stale' && row.trust !== 'blocked') issues.push('stale_not_blocked');
  return { ok: issues.length === 0, issues };
}


export interface EvidenceRecord {
  schema: typeof EVIDENCE_SCHEMA;
  id: string;
  mission_id: string | null;
  kind: EvidenceKind;
  source: EvidenceSource;
  path: string | null;
  sha256: string | null;
  created_at?: string;
  freshness: EvidenceFreshness;
  trust: EvidenceTrust;
  redacted: boolean;
  issues: string[];
}

export interface EvidenceIndex {
  schema: typeof EVIDENCE_INDEX_SCHEMA;
  generated_at: string;
  mission_id: string | null;
  route: string | null;
  status: import('../trust-kernel/trust-kernel-schema.js').TrustStatus;
  ok: boolean;
  records: EvidenceRecord[];
  issues: string[];
}

export function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<EvidenceRecord>;
  return row.schema === EVIDENCE_SCHEMA
    && typeof row.id === 'string'
    && typeof row.kind === 'string'
    && typeof row.source === 'string'
    && (row.path === null || typeof row.path === 'string')
    && (row.sha256 === null || typeof row.sha256 === 'string')
    && Array.isArray(row.issues);
}
