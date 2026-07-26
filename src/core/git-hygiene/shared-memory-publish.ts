import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists, nowIso, readJson, sha256, writeJsonAtomic } from '../fsx.js';
import { readImageVoxelLedger } from '../wiki-image/image-voxel-ledger.js';
import { readWrongnessLedger } from '../triwiki-wrongness/wrongness-ledger.js';
import { createWrongnessRecord, type WrongnessRecord } from '../triwiki-wrongness/wrongness-schema.js';
import { listSharedFiles } from './git-status.js';
import { ensureGitPolicy, ensureSharedMemoryDirs, readGitPolicy, type SksGitPolicy } from './git-policy.js';
import { isMockPositiveSharedClaim, redactSharedRecord, sharedRecordHasSecret } from './shared-memory-security.js';
import { validateGitPolicy, validateSharedMemoryManifest, validateSharedRecordFile } from './validators.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

type JsonRecord = Record<string, unknown>;

export interface SharedPublishOptions {
  redact?: boolean;
  target?: 'wiki' | 'wrongness' | 'all';
}

export interface SharedPublishResult {
  schema: 'sks.shared-memory-publish.v1';
  ok: boolean;
  target: 'wiki' | 'wrongness' | 'all';
  written: string[];
  skipped: string[];
  blockers: string[];
  indexes?: SharedIndexResult;
}

export interface SharedIndexResult {
  schema: 'sks.shared-memory-index.v1';
  ok: boolean;
  indexes: string[];
  claims: number;
  wrongness: number;
  image_voxels: number;
  avoidance_rules: number;
}

export async function publishSharedMemory(root: string, opts: SharedPublishOptions = {}): Promise<SharedPublishResult> {
  const target = opts.target || 'all';
  const policy = await ensureGitPolicy(root, { write: true });
  const written: string[] = [];
  const skipped: string[] = [];
  const blockers: string[] = [];
  if (target === 'wiki' || target === 'all') {
    const wiki = await publishWikiClaims(root, policy, opts);
    written.push(...wiki.written);
    skipped.push(...wiki.skipped);
    blockers.push(...wiki.blockers);
    const voxels = await publishImageVoxels(root, policy, opts);
    written.push(...voxels.written);
    skipped.push(...voxels.skipped);
    blockers.push(...voxels.blockers);
  }
  if (target === 'wrongness' || target === 'all') {
    const wrongness = await publishWrongness(root, policy, opts);
    written.push(...wrongness.written);
    skipped.push(...wrongness.skipped);
    blockers.push(...wrongness.blockers);
  }
  const indexes = blockers.length ? undefined : await rebuildSharedIndexes(root);
  return {
    schema: 'sks.shared-memory-publish.v1',
    ok: blockers.length === 0,
    target,
    written: [...new Set(written)].sort(),
    skipped: [...new Set(skipped)].sort(),
    blockers: [...new Set(blockers)].sort(),
    ...(indexes ? { indexes } : {})
  };
}

export async function rebuildSharedIndexes(root: string): Promise<SharedIndexResult> {
  await ensureSharedMemoryDirs(root);
  const files = await listSharedFiles(root);
  const claims: JsonRecord[] = [];
  const wrongness: JsonRecord[] = [];
  const voxels: JsonRecord[] = [];
  const avoidance: JsonRecord[] = [];
  for (const relPath of files.filter((file) => file.endsWith('.json'))) {
    const row = await readJson<JsonRecord | null>(path.join(root, relPath), null);
    if (!row || typeof row !== 'object') continue;
    if (row.schema === 'sks.triwiki-claim-record.v1') claims.push(row);
    if (row.schema === 'sks.triwiki-wrongness-record.v1') wrongness.push(row);
    if (row.schema === 'sks.image-voxel-record.v1') voxels.push(row);
    if (row.schema === 'sks.avoidance-rule-record.v1') avoidance.push(row);
  }
  const generatedAt = nowIso();
  const projectIndex = {
    schema: 'sks.shared-memory-project-index.v1',
    generated_at: generatedAt,
    claims: claims.map((record) => ({
      id: record.id,
      status: record.status,
      source: record.source,
      text_hash: record.text_hash,
      path: record.path
    })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    image_voxels: voxels.map((record) => ({
      id: record.id,
      image_asset_id: record.image_asset_id,
      anchor_id: record.anchor_id,
      path: record.path
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  };
  const wrongnessIndex = {
    schema: 'sks.shared-wrongness-index.v1',
    generated_at: generatedAt,
    wrongness: wrongness.map((record) => {
      const source = asRecord(record.wrongness);
      return {
        id: record.id,
        status: source.status,
        severity: source.severity,
        wrongness_kind: source.wrongness_kind,
        mission_id: source.mission_id,
        route: source.route,
        avoidance_rule_id: record.avoidance_rule_id
      };
    }).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    avoidance_rules: avoidance.map((record) => ({
      id: record.id,
      wrongness_id: record.wrongness_id,
      text_hash: record.text_hash
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  };
  const projectPath = '.sneakoscope/wiki/indexes/project-index.json';
  const wrongnessPath = '.sneakoscope/wiki/indexes/wrongness-index.json';
  await writeJsonAtomic(path.join(root, projectPath), projectIndex);
  await writeJsonAtomic(path.join(root, wrongnessPath), wrongnessIndex);
  return {
    schema: 'sks.shared-memory-index.v1',
    ok: true,
    indexes: [projectPath, wrongnessPath],
    claims: claims.length,
    wrongness: wrongness.length,
    image_voxels: voxels.length,
    avoidance_rules: avoidance.length
  };
}

export async function validateSharedMemory(root: string): Promise<{ schema: 'sks.shared-memory-validation.v1'; ok: boolean; checked: number; issues: string[]; files: string[] }> {
  const policy = await readGitPolicy(root);
  const issues: string[] = [];
  const files = await listSharedFiles(root);
  const policyValidation = validateGitPolicy(await readJson(path.join(root, '.sneakoscope', 'git-policy.json'), null));
  const manifestValidation = validateSharedMemoryManifest(await readJson(path.join(root, '.sneakoscope', 'shared-memory-manifest.json'), null));
  for (const issue of policyValidation.issues) issues.push(`git-policy:${issue}`);
  for (const issue of manifestValidation.issues) issues.push(`shared-memory-manifest:${issue}`);
  let checked = policyValidation.checked + manifestValidation.checked;
  for (const relPath of files.filter((file) => file.endsWith('.json'))) {
    if (relPath.endsWith('git-policy.json') || relPath.endsWith('shared-memory-manifest.json')) continue;
    checked += 1;
    const validation = await validateSharedRecordFile(path.join(root, relPath), policy);
    if (!validation.ok) issues.push(`${relPath}:${validation.issues.join('|')}`);
    const text = await fsp.readFile(path.join(root, relPath), 'utf8').catch(() => '');
    if (sharedRecordHasSecret(text)) issues.push(`${relPath}:secret`);
  }
  return {
    schema: 'sks.shared-memory-validation.v1',
    ok: issues.length === 0,
    checked,
    issues: [...new Set(issues)].sort(),
    files
  };
}

export async function publishPlan(root: string): Promise<JsonRecord> {
  const policy = await ensureGitPolicy(root, { write: true });
  const files = await listSharedFiles(root);
  return {
    schema: 'sks.git-publish-plan.v1',
    generated_at: nowIso(),
    mode: policy.mode,
    shared_memory_track: policy.shared_memory.track,
    generated_indexes_ignored: policy.shared_memory.generated_ignore,
    local_runtime_ignored: policy.local_runtime.ignore,
    current_shared_files: files,
    commands: [
      'sks git doctor --fix',
      'sks wiki publish latest --shared',
      'sks wrongness publish latest --shared',
      'sks wiki rebuild-index --json',
      'sks wiki validate-shared --json',
      'sks git precommit --json'
    ]
  };
}

export async function sharedMemorySummary(root: string): Promise<JsonRecord> {
  const validation = await validateSharedMemory(root);
  const indexes = await rebuildSharedIndexes(root);
  return {
    schema: 'sks.shared-memory-summary.v1',
    generated_at: nowIso(),
    ok: validation.ok && indexes.ok,
    files: validation.files.length,
    validation,
    indexes
  };
}

async function publishWikiClaims(root: string, policy: SksGitPolicy, opts: SharedPublishOptions): Promise<Pick<SharedPublishResult, 'written' | 'skipped' | 'blockers'>> {
  const packPath = path.join(root, '.sneakoscope', 'wiki', 'context-pack.json');
  if (!(await exists(packPath))) return { written: [], skipped: [], blockers: ['context_pack_missing'] };
  const pack = await readJson<JsonRecord>(packPath);
  const claims = Array.isArray(pack.claims) ? pack.claims : [];
  const written: string[] = [];
  const skipped: string[] = [];
  const blockers: string[] = [];
  for (const raw of claims) {
    const claim = asRecord(raw);
    const id = stableId('claim', claim.id || claim.text || JSON.stringify(claim));
    const record = prepareRecord({
      schema: 'sks.triwiki-claim-record.v1',
      id,
      generated_at: nowIso(),
      source: '.sneakoscope/wiki/context-pack.json',
      path: `.sneakoscope/wiki/records/claims/${id}.json`,
      status: String(claim.status || 'verified_partial'),
      text_hash: sha256(String(claim.text || JSON.stringify(claim))),
      claim
    }, opts);
    const blocked = sharedRecordBlocker(record, policy);
    if (blocked) {
      skipped.push(id);
      blockers.push(`${id}:${blocked}`);
      continue;
    }
    const relPath = `.sneakoscope/wiki/records/claims/${id}.json`;
    await writeJsonAtomic(path.join(root, relPath), record);
    written.push(relPath);
  }
  return { written, skipped, blockers };
}

async function publishWrongness(root: string, policy: SksGitPolicy, opts: SharedPublishOptions): Promise<Pick<SharedPublishResult, 'written' | 'skipped' | 'blockers'>> {
  const ledgers = [await readWrongnessLedger(root, null)];
  const latestMission = await latestMissionId(root);
  if (latestMission) ledgers.push(await readWrongnessLedger(root, latestMission));
  const records = dedupeWrongness(ledgers.flatMap((ledger) => ledger.records || []));
  const written: string[] = [];
  const skipped: string[] = [];
  const blockers: string[] = [];
  for (const record of records) {
    const id = stableId('wrongness', record.id);
    const wrapper = prepareRecord({
      schema: 'sks.triwiki-wrongness-record.v1',
      id,
      generated_at: nowIso(),
      source: record.mission_id ? `.sneakoscope/missions/${record.mission_id}/wrongness-ledger.json` : '.sneakoscope/wiki/wrongness-ledger.json',
      path: `.sneakoscope/wiki/wrongness/${id}.json`,
      avoidance_rule_id: record.avoidance_rule.id || stableId('avoid', `${record.id}:${record.avoidance_rule.text}`),
      wrongness: record
    }, opts);
    const blocked = sharedRecordBlocker(wrapper, policy);
    if (blocked) {
      skipped.push(id);
      blockers.push(`${id}:${blocked}`);
      continue;
    }
    const relPath = `.sneakoscope/wiki/wrongness/${id}.json`;
    await writeJsonAtomic(path.join(root, relPath), wrapper);
    written.push(relPath);
    const ruleId = stableId('avoid', record.avoidance_rule.id || `${record.id}:${record.avoidance_rule.text}`);
    const ruleRecord = prepareRecord({
      schema: 'sks.avoidance-rule-record.v1',
      id: ruleId,
      generated_at: nowIso(),
      source: relPath,
      path: `.sneakoscope/wiki/avoidance-rules/${ruleId}.json`,
      wrongness_id: id,
      text_hash: sha256(record.avoidance_rule.text || record.id),
      rule: record.avoidance_rule
    }, opts);
    const ruleBlocked = sharedRecordBlocker(ruleRecord, policy);
    if (ruleBlocked) {
      skipped.push(ruleId);
      blockers.push(`${ruleId}:${ruleBlocked}`);
      continue;
    }
    const rulePath = `.sneakoscope/wiki/avoidance-rules/${ruleId}.json`;
    await writeJsonAtomic(path.join(root, rulePath), ruleRecord);
    written.push(rulePath);
  }
  return { written, skipped, blockers };
}

async function publishImageVoxels(root: string, policy: SksGitPolicy, opts: SharedPublishOptions): Promise<Pick<SharedPublishResult, 'written' | 'skipped' | 'blockers'>> {
  const ledgerPath = path.join(root, '.sneakoscope', 'wiki', 'image-voxel-ledger.json');
  if (!(await exists(ledgerPath))) return { written: [], skipped: ['image_voxel_ledger_missing'], blockers: [] };
  const ledger = await readImageVoxelLedger(root, ledgerPath);
  const images = Array.isArray(ledger.images) ? ledger.images : [];
  const anchors = Array.isArray(ledger.anchors) ? ledger.anchors : [];
  const imagesById = new Map<string, JsonRecord>(images.map((image: unknown) => {
    const row = asRecord(image);
    return [String(row.id || ''), row];
  }));
  const written: string[] = [];
  const skipped: string[] = [];
  const blockers: string[] = [];
  for (const anchor of anchors.map(asRecord)) {
    const imageId = String(anchor.image_id || anchor.imageId || '');
    const image = imagesById.get(imageId);
    if (!image) {
      skipped.push(String(anchor.id || 'unknown-anchor'));
      blockers.push(`${anchor.id || 'unknown-anchor'}:missing_image`);
      continue;
    }
    const anchorId = stableId('anchor', anchor.id || `${imageId}:${JSON.stringify(anchor.bbox || [])}`);
    const assetId = stableId('image', imageId);
    const id = `${assetId}-${anchorId}`;
    const record = prepareRecord({
      schema: 'sks.image-voxel-record.v1',
      id,
      generated_at: nowIso(),
      source: '.sneakoscope/wiki/image-voxel-ledger.json',
      path: `.sneakoscope/wiki/image-voxels/${assetId}/${anchorId}.json`,
      image_asset_id: assetId,
      source_image_id: imageId,
      anchor_id: anchorId,
      image,
      anchor
    }, opts);
    const blocked = sharedRecordBlocker(record, policy);
    if (blocked) {
      skipped.push(id);
      blockers.push(`${id}:${blocked}`);
      continue;
    }
    const relPath = `.sneakoscope/wiki/image-voxels/${assetId}/${anchorId}.json`;
    await writeJsonAtomic(path.join(root, relPath), record);
    written.push(relPath);
  }
  return { written, skipped, blockers };
}

export async function readSharedWrongnessRecords(root: string): Promise<WrongnessRecord[]> {
  const dir = path.join(root, '.sneakoscope', 'wiki', 'wrongness');
  const records: WrongnessRecord[] = [];
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return records;
  }
  for (const name of entries.filter((entry) => entry.endsWith('.json')).sort()) {
    const row = await readJson<JsonRecord | null>(path.join(dir, name), null);
    if (!row) continue;
    if (row.schema === 'sks.triwiki-wrongness-record.v1' && row.wrongness) records.push(createWrongnessRecord(row.wrongness));
    else records.push(createWrongnessRecord(row));
  }
  return records;
}

function prepareRecord<T>(record: T, opts: SharedPublishOptions): T {
  return opts.redact ? redactSharedRecord(record) : record;
}

function sharedRecordBlocker(record: unknown, policy: SksGitPolicy): string | null {
  if (policy.security.block_secret_patterns && sharedRecordHasSecret(record)) return 'secret';
  if (policy.security.block_mock_real_confusion && isMockPositiveSharedClaim(record)) return 'mock_positive_claim';
  return null;
}

function stableId(prefix: string, value: unknown): string {
  const raw = String(value || prefix);
  const slug = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
  return slug || `${prefix}-${sha256(raw).slice(0, 12)}`;
}

function dedupeWrongness(records: readonly WrongnessRecord[]): WrongnessRecord[] {
  const byId = new Map<string, WrongnessRecord>();
  for (const record of records) byId.set(record.id, record);
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

async function latestMissionId(root: string): Promise<string | null> {
  const dir = path.join(root, '.sneakoscope', 'missions');
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  return entries.filter((name) => name.startsWith('M-')).sort().at(-1) || null;
}
