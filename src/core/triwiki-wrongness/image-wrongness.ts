import path from 'node:path';
import { ensureDir, nowIso, readJson, writeJsonAtomic } from '../fsx.js';
import { missionDir } from '../mission.js';
import { addWrongnessRecord } from './wrongness-ledger.js';
import { deterministicWrongnessId, type WrongnessKind } from './wrongness-schema.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

type JsonRecord = Record<string, unknown>;

export const IMAGE_WRONGNESS_RECORD_SCHEMA = 'sks.image-wrongness.v1';
export const IMAGE_WRONGNESS_INDEX_SCHEMA = 'sks.image-wrongness-index.v1';

export function imageWrongnessIndexPath(root: string): string {
  return path.join(root, '.sneakoscope', 'wiki', 'image-wrongness-index.json');
}

export function missionImageWrongnessLedgerPath(root: string, missionId: string): string {
  return path.join(missionDir(root, missionId), 'image-wrongness-ledger.json');
}

export async function recordImageWrongnessFromValidation(root: string, opts: {
  ledger?: unknown;
  validation?: unknown;
  missionId?: string | null;
  route?: string | null;
  artifact?: string | null;
} = {}) {
  const validation = asRecord(opts.validation);
  const issues = Array.isArray(validation.issues) ? validation.issues.map(String) : [];
  if (validation.ok === true || issues.length === 0) {
    return { created: 0, records: [], wrongness_records: [] };
  }
  const missionId = opts.missionId ?? stringOrNull(asRecord(opts.ledger).mission_id);
  const route = opts.route ?? '$Wiki';
  const artifact = opts.artifact ?? '.sneakoscope/wiki/image-voxel-ledger.json';
  const records = issues.map((issue) => createImageWrongnessRecord({
    id: deterministicWrongnessId(['image_wrongness', missionId, artifact, issue]),
    mission_id: missionId,
    route,
    issue,
    artifact,
    image_id: imageIdFromIssue(issue),
    wrongness_kind: imageWrongnessKindForIssue(issue)
  }));
  await upsertImageWrongnessIndex(root, records);
  if (missionId) await upsertMissionImageWrongness(root, missionId, records);
  const wrongnessRecords = [];
  for (const record of records) {
    const saved = await addWrongnessRecord(root, {
      id: record.wrongness_id,
      mission_id: missionId,
      route,
      wrongness_kind: record.wrongness_kind,
      severity: record.severity,
      claim: { text: `Image evidence validation failed: ${record.issue}` },
      detected_by: { source: 'image_voxel_validate', command: 'sks wiki image-validate', artifact, detail: record.issue },
      root_cause: { category: record.root_cause, explanation: 'Image voxel or visual anchor validation produced negative evidence.' },
      corrective_action: { summary: 'Repair the image ledger, anchors, bbox, dimensions, or relation evidence, then rerun image validation.', required_evidence: [artifact], patch_status: 'pending' },
      avoidance_rule: {
        text: 'Do not rely on visual claims until image anchors, bbox coordinates, dimensions, and relation evidence validate cleanly.',
        applies_to: ['visual', '$Wiki', '$Image-UX-Review', '$PPT', '$GX'],
        severity: record.severity
      },
      links: { artifacts: [artifact] }
    }, { missionId });
    wrongnessRecords.push(saved.record);
  }
  return { created: records.length, records, wrongness_records: wrongnessRecords };
}

export function createImageWrongnessRecord(input: unknown): JsonRecord {
  const row = asRecord(input);
  const issue = String(row.issue || 'image_validation_issue');
  const kind = imageWrongnessKindForIssue(issue);
  return {
    schema: IMAGE_WRONGNESS_RECORD_SCHEMA,
    id: stringOrNull(row.id) || deterministicWrongnessId(['image_wrongness', issue]),
    wrongness_id: deterministicWrongnessId(['wrongness', 'image', row.mission_id, row.artifact, issue]),
    mission_id: stringOrNull(row.mission_id),
    route: stringOrNull(row.route),
    created_at: nowIso(),
    status: 'active',
    issue,
    image_id: stringOrNull(row.image_id),
    anchor_id: anchorIdFromIssue(issue),
    artifact: stringOrNull(row.artifact),
    wrongness_kind: kind,
    severity: kind === 'image_bbox_error' ? 'medium' : 'medium',
    root_cause: rootCauseForImageIssue(issue),
    corrected_anchor: row.corrected_anchor ?? null
  };
}

export function imageWrongnessKindForIssue(issue: string): WrongnessKind {
  if (/bbox|coordinate|dimension/i.test(issue)) return 'image_bbox_error';
  if (/anchor|relation|visual/i.test(issue)) return 'visual_anchor_error';
  if (/stale/i.test(issue)) return 'stale_evidence';
  return 'missing_evidence';
}

async function upsertImageWrongnessIndex(root: string, records: JsonRecord[]): Promise<void> {
  const file = imageWrongnessIndexPath(root);
  const current = await readJson(file, { schema: IMAGE_WRONGNESS_INDEX_SCHEMA, records: [] });
  const nextRecords = upsertRecords(Array.isArray(asRecord(current).records) ? asRecord(current).records as JsonRecord[] : [], records);
  await ensureDir(path.dirname(file));
  await writeJsonAtomic(file, {
    schema: IMAGE_WRONGNESS_INDEX_SCHEMA,
    generated_at: nowIso(),
    records: nextRecords,
    active_ids: nextRecords.filter((record) => record.status === 'active').map((record) => record.id)
  });
}

async function upsertMissionImageWrongness(root: string, missionId: string, records: JsonRecord[]): Promise<void> {
  const file = missionImageWrongnessLedgerPath(root, missionId);
  const current = await readJson(file, { schema: 'sks.image-wrongness-ledger.v1', mission_id: missionId, records: [] });
  const nextRecords = upsertRecords(Array.isArray(asRecord(current).records) ? asRecord(current).records as JsonRecord[] : [], records);
  await ensureDir(path.dirname(file));
  await writeJsonAtomic(file, {
    schema: 'sks.image-wrongness-ledger.v1',
    generated_at: nowIso(),
    mission_id: missionId,
    records: nextRecords
  });
}

function upsertRecords(existing: JsonRecord[], incoming: JsonRecord[]): JsonRecord[] {
  const map = new Map<string, JsonRecord>();
  for (const record of existing) map.set(String(record.id || ''), record);
  for (const record of incoming) map.set(String(record.id || ''), { ...map.get(String(record.id || '')), ...record });
  return Array.from(map.values()).filter((record) => record.id);
}

function rootCauseForImageIssue(issue: string): string {
  if (/stale/i.test(issue)) return 'stale_context';
  if (/bbox|anchor|relation|visual/i.test(issue)) return 'missing_visual_evidence';
  return 'schema_validation_gap';
}

function imageIdFromIssue(issue: string): string | null {
  const match = issue.match(/image(?:_id|_ref|_path|_sha256|_dimensions)?:([^:\s]+)/i);
  return match?.[1] || null;
}

function anchorIdFromIssue(issue: string): string | null {
  const match = issue.match(/anchor(?:_id|_bbox|_image_ref)?:([^:\s]+)/i);
  return match?.[1] || null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
