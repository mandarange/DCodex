/**
 * Fail-closed validation for Architecture Map mission artifacts.
 */
import {
  ARCHITECTURE_BASELINE_SCHEMA,
  ARCHITECTURE_INPUT_BUNDLE_SCHEMA,
  ARCHITECTURE_MAP_MANIFEST_SCHEMA,
  ARCHITECTURE_REVIEW_SCHEMA,
  MERMAID_PROJECTION_SCHEMA,
  type ArchitectureBaselineV1,
  type ArchitectureInputBundleV1,
  type ArchitectureReviewV1
} from './contracts.js';
import { verifyArchitectureBaselineSeal } from './baseline.js';

export interface ArchitectureValidationResult {
  readonly ok: boolean;
  readonly blockers: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function validateArchitectureInputBundle(value: unknown): ArchitectureValidationResult {
  const blockers: string[] = [];
  const record = asRecord(value);
  if (!record) return { ok: false, blockers: ['not_an_object'] };
  if (record.schema !== ARCHITECTURE_INPUT_BUNDLE_SCHEMA) blockers.push('schema');
  for (const key of [
    'rootId',
    'graphHash',
    'topologyHash',
    'ssotInventoryHash',
    'voxelContextHash',
    'policyHash',
    'analyzerVersion',
    'serializerVersion',
    'canonicalHash'
  ]) {
    if (typeof record[key] !== 'string' || !(record[key] as string).length) blockers.push(key);
  }
  if (!record.graph || typeof record.graph !== 'object') blockers.push('graph');
  if (!record.worktree || typeof record.worktree !== 'object') blockers.push('worktree');
  return { ok: blockers.length === 0, blockers: Object.freeze(blockers) };
}

export function validateArchitectureBaseline(value: unknown): ArchitectureValidationResult {
  const blockers: string[] = [];
  const record = asRecord(value);
  if (!record) return { ok: false, blockers: ['not_an_object'] };
  if (record.schema !== ARCHITECTURE_BASELINE_SCHEMA) blockers.push('schema');
  if (record.required !== true) blockers.push('required');
  if (record.capturedBeforeMutation !== true) blockers.push('capturedBeforeMutation');
  for (const key of [
    'missionId',
    'worktreeFingerprintHash',
    'graphHash',
    'policyHash',
    'analyzerVersion',
    'serializerVersion',
    'canonicalPayloadHash',
    'seal'
  ]) {
    if (typeof record[key] !== 'string' || !(record[key] as string).length) blockers.push(key);
  }
  if (!Array.isArray(record.findings)) blockers.push('findings');
  if (!record.metrics || typeof record.metrics !== 'object') blockers.push('metrics');
  if (blockers.length === 0) {
    const baseline = value as ArchitectureBaselineV1;
    if (!verifyArchitectureBaselineSeal(baseline)) blockers.push('seal_mismatch');
  }
  return { ok: blockers.length === 0, blockers: Object.freeze(blockers) };
}

export function validateArchitectureReview(value: unknown): ArchitectureValidationResult {
  const blockers: string[] = [];
  const record = asRecord(value);
  if (!record) return { ok: false, blockers: ['not_an_object'] };
  if (record.schema !== ARCHITECTURE_REVIEW_SCHEMA) blockers.push('schema');
  for (const key of [
    'missionId',
    'baselineSeal',
    'baselineHash',
    'afterInputHash',
    'canonicalPayloadHash'
  ]) {
    if (typeof record[key] !== 'string' || !(record[key] as string).length) blockers.push(key);
  }
  if (record.verdict !== 'pass' && record.verdict !== 'block') blockers.push('verdict');
  for (const key of [
    'changedPaths',
    'accountedChangedPaths',
    'unaccountedChangedPaths',
    'newFindings',
    'blockingFindingIds'
  ]) {
    if (!Array.isArray(record[key])) blockers.push(key);
  }
  return { ok: blockers.length === 0, blockers: Object.freeze(blockers) };
}

export function validateMermaidProjection(value: unknown): ArchitectureValidationResult {
  const blockers: string[] = [];
  const record = asRecord(value);
  if (!record) return { ok: false, blockers: ['not_an_object'] };
  if (record.schema !== MERMAID_PROJECTION_SCHEMA) blockers.push('schema');
  for (const key of ['viewId', 'title', 'source', 'contentHash']) {
    if (typeof record[key] !== 'string' || !(record[key] as string).length) blockers.push(key);
  }
  if (record.direction !== 'LR' && record.direction !== 'TD') blockers.push('direction');
  if (!record.accounting || typeof record.accounting !== 'object') blockers.push('accounting');
  return { ok: blockers.length === 0, blockers: Object.freeze(blockers) };
}

export function validateArchitectureMapManifest(value: unknown): ArchitectureValidationResult {
  const blockers: string[] = [];
  const record = asRecord(value);
  if (!record) return { ok: false, blockers: ['not_an_object'] };
  if (record.schema !== ARCHITECTURE_MAP_MANIFEST_SCHEMA) blockers.push('schema');
  for (const key of ['graphHash', 'policyHash', 'serializerVersion']) {
    if (typeof record[key] !== 'string' || !(record[key] as string).length) blockers.push(key);
  }
  if (!Array.isArray(record.views) || record.views.length === 0) blockers.push('views');
  if (!record.projectionAccounting || typeof record.projectionAccounting !== 'object') {
    blockers.push('projectionAccounting');
  }
  return { ok: blockers.length === 0, blockers: Object.freeze(blockers) };
}

export function assertValidInputBundle(bundle: ArchitectureInputBundleV1): void {
  const result = validateArchitectureInputBundle(bundle);
  if (!result.ok) throw new Error(`architecture_input_bundle_invalid: ${result.blockers.join(',')}`);
}

export function assertValidReview(review: ArchitectureReviewV1): void {
  const result = validateArchitectureReview(review);
  if (!result.ok) throw new Error(`architecture_review_invalid: ${result.blockers.join(',')}`);
}
