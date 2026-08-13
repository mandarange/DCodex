/**
 * TriWiki proof-bank cards as graph evidence.
 *
 * Health is decided with the shared proof-card helpers, never re-implemented:
 * `classifyTriWikiProofCardSchema` for schema class and `isReusableTriWikiProofCard`
 * for reuse. Only a healthy proof produces a `verified_by` edge. An invalidated,
 * expired, corrupt, or legacy proof produces an `invalidates` edge instead and
 * carries its state in node metadata so a query can exclude it *and* say why.
 */
import { lintWarning, type ContextGraphFreshness, type ContextGraphMetadata, type ContextGraphNodeKind } from '../../contracts.js';
import { contextGraphNodeId, shortDigest } from '../../ids.js';
import { tryNormalizeGraphPath } from '../../paths.js';
import { classifyTriWikiProofCardSchema, isReusableTriWikiProofCard } from '../../../triwiki-proof-card.js';
import { boundedList, boundedText, safeText } from './redaction.js';
import {
  EvidenceFragmentBuilder,
  PROOF_BANK_REL,
  RiskDomainRegistry,
  asRecord,
  asString,
  asStringList,
  readWorkspaceFile,
  statWorkspaceEntry,
  tokenEstimate,
  type EvidenceContext,
  type ProofDiscoveryMode
} from './shared.js';
import { discoverProofRecords, type ProofRecord } from './proof-index.js';

const MAX_DERIVED_INPUTS = 12;
const PLACEHOLDER_HASHES: ReadonlySet<string> = new Set(['', 'unknown', 'legacy-missing', 'none', 'null']);

interface ProofHealth {
  healthy: boolean;
  expired: boolean | null;
  invalidated: boolean;
  schemaClass: 'current' | 'legacy_proof_card_schema' | 'invalid' | 'unread';
  result: string;
  reason: string;
}

export interface ProofEvidenceResult {
  mode: ProofDiscoveryMode;
  proofCount: number;
  healthyCount: number;
}

export function extractProofEvidence(
  builder: EvidenceFragmentBuilder,
  ctx: EvidenceContext,
  risks: RiskDomainRegistry
): ProofEvidenceResult {
  const discovery = discoverProofRecords(ctx);
  for (const skip of discovery.skipped) builder.addSkip(skip);
  for (const [rel, hash] of Object.entries(discovery.inputHashes)) builder.addInputHash(rel, hash);
  if (discovery.mode === 'absent') {
    builder.addIssue(
      lintWarning('extractor_skipped_input', 'TriWiki proof bank is absent; no proof evidence was extracted', {
        path: PROOF_BANK_REL,
        extractor: builder.fragment.extractor
      })
    );
    return { mode: discovery.mode, proofCount: 0, healthyCount: 0 };
  }
  if (discovery.mode === 'scan') {
    builder.addIssue(
      lintWarning('extractor_skipped_input', 'proof index manifest is absent; fell back to a bounded proof-bank directory read', {
        path: PROOF_BANK_REL,
        extractor: builder.fragment.extractor
      })
    );
  }

  let healthyCount = 0;
  for (const record of discovery.records) {
    const health = proofHealth(record, ctx, discovery.mode);
    if (health.healthy) healthyCount += 1;
    const nodeId = addProofNode(builder, record, health, discovery.mode);
    if (!nodeId) continue;
    linkSubject(builder, record, health, nodeId, discovery.mode);
    linkDerivedInputs(builder, ctx, record, nodeId);
    const domainId = risks.note(`proof-subject/${record.subjectType}`, record.subjectType === 'gate' || record.subjectType === 'gate-pack' ? 'high' : 'medium');
    if (domainId) {
      builder.addEdge({
        from: nodeId,
        to: domainId,
        type: 'affected_by',
        confidence: 'manifest',
        provenancePath: record.rel,
        provenanceHash: record.hash
      });
    }
  }
  return { mode: discovery.mode, proofCount: discovery.records.length, healthyCount };
}

function proofHealth(record: ProofRecord, ctx: EvidenceContext, mode: ProofDiscoveryMode): ProofHealth {
  const invalidated = record.invalidationReasons.length > 0 || record.reusable === false;
  if (record.corrupt) {
    return { healthy: false, expired: null, invalidated: true, schemaClass: 'invalid', result: 'unknown', reason: 'corrupt_proof_card' };
  }
  const expired = expiryState(record.expiresAt, ctx);
  if (mode === 'index') {
    const healthy = record.reusable === true && !invalidated && expired === false && record.cardPresent;
    return {
      healthy,
      expired,
      invalidated,
      schemaClass: 'unread',
      result: 'unknown',
      reason: healthy
        ? 'index_reusable'
        : !record.cardPresent
          ? 'proof_card_missing'
          : invalidated
            ? 'invalidated'
            : expired === true
              ? 'expired'
              : 'not_reusable'
    };
  }
  const card = record.card;
  if (!card) {
    return { healthy: false, expired, invalidated: true, schemaClass: 'invalid', result: 'unknown', reason: 'unreadable_proof_card' };
  }
  const schemaClass = classifyTriWikiProofCardSchema(card);
  const result = asString(card.result) ?? 'unknown';
  if (schemaClass !== 'current') {
    return { healthy: false, expired, invalidated, schemaClass, result, reason: schemaClass };
  }
  if (ctx.now === null) {
    return { healthy: false, expired: null, invalidated, schemaClass, result, reason: 'observed_at_unparseable' };
  }
  const reusable = isReusableTriWikiProofCard(card, ctx.now);
  return {
    healthy: reusable,
    expired,
    invalidated,
    schemaClass,
    result,
    reason: reusable ? 'reusable' : invalidated ? 'invalidated' : expired === true ? 'expired' : `not_reusable:${result}`
  };
}

function expiryState(expiresAt: string | null, ctx: EvidenceContext): boolean | null {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return null;
  if (ctx.now === null) return null;
  return parsed <= ctx.now.getTime();
}

function addProofNode(
  builder: EvidenceFragmentBuilder,
  record: ProofRecord,
  health: ProofHealth,
  mode: ProofDiscoveryMode
): string | null {
  const id = contextGraphNodeId({ kind: 'proof', proofId: record.proofId });
  const freshness: ContextGraphFreshness = health.healthy
    ? 'fresh'
    : health.invalidated || health.expired === true || record.corrupt
      ? 'stale'
      : 'unknown';
  const metadata: ContextGraphMetadata = {
    proof_id: boundedText(record.proofId, 80),
    subject_type: boundedText(record.subjectType, 40),
    subject_id: boundedText(record.subjectId, 120),
    discovery: mode,
    card_present: record.cardPresent,
    corrupt: record.corrupt,
    reusable: health.healthy,
    declared_reusable: record.reusable === null ? null : record.reusable,
    expired: health.expired,
    schema_class: health.schemaClass,
    result: boundedText(health.result, 40),
    health_reason: boundedText(health.reason, 80),
    invalidation_reason_count: record.invalidationReasons.length,
    ...(record.invalidationReasons.length ? { invalidation_reasons: boundedList(record.invalidationReasons) } : {}),
    ...(record.cacheKey ? { cache_key_digest: shortDigest(record.cacheKey) } : {}),
    ...proofCardProjection(record)
  };
  const added = builder.addNode(
    {
      id,
      kind: 'proof',
      label: safeText(record.proofId, 80) || id,
      path: record.rel,
      contentHash: record.hash,
      trust: health.healthy ? 0.9 : record.corrupt ? 0.05 : 0.15,
      freshness,
      risk: record.subjectType === 'gate' || record.subjectType === 'gate-pack' ? 'high' : 'medium',
      tokenCost: tokenEstimate(record.proofId.length + record.subjectId.length, 96),
      metadata
    },
    record.rel
  );
  return added ? id : null;
}

/** Bounded projection of a proof card: ids, hashes, counts, statuses. Never the evidence payload. */
function proofCardProjection(record: ProofRecord): ContextGraphMetadata {
  const card = record.card;
  if (!card) return {};
  const raw = card as unknown as Record<string, unknown>;
  const evidence = asRecord(raw.evidence);
  const inputHash = asString(raw.input_hash);
  const implementationHash = asString(raw.gate_impl_hash) ?? asString(raw.implementation_hash);
  const toolVersions = asRecord(raw.tool_versions);
  return {
    evidence_key_count: evidence ? Object.keys(evidence).length : 0,
    tool_version_count: toolVersions ? Object.keys(toolVersions).length : 0,
    ...(inputHash && !PLACEHOLDER_HASHES.has(inputHash) ? { input_hash: inputHash.slice(0, 24) } : {}),
    ...(implementationHash && !PLACEHOLDER_HASHES.has(implementationHash)
      ? { implementation_hash: implementationHash.slice(0, 24) }
      : {}),
    ...(asString(raw.fixture_version) ? { fixture_version: boundedText(raw.fixture_version, 40) } : {})
  };
}

function subjectNodeId(record: ProofRecord): { id: string; kind: ContextGraphNodeKind } | null {
  if (!record.subjectId || record.subjectId === 'unknown') return null;
  switch (record.subjectType) {
    case 'gate':
    case 'gate-pack':
      return { id: contextGraphNodeId({ kind: 'gate', gateId: record.subjectId }), kind: 'gate' };
    case 'module':
      return { id: contextGraphNodeId({ kind: 'module', moduleId: record.subjectId }), kind: 'module' };
    case 'pipeline':
      return { id: contextGraphNodeId({ kind: 'pipeline', pipelineId: record.subjectId }), kind: 'pipeline' };
    default:
      return null;
  }
}

function linkSubject(
  builder: EvidenceFragmentBuilder,
  record: ProofRecord,
  health: ProofHealth,
  proofNodeId: string,
  mode: ProofDiscoveryMode
): void {
  const subject = subjectNodeId(record);
  if (!subject) return;
  builder.addNode(
    {
      id: subject.id,
      kind: subject.kind,
      label: safeText(record.subjectId, 120) || subject.id,
      trust: 0.7,
      freshness: 'unknown',
      risk: subject.kind === 'gate' ? 'high' : 'medium',
      tokenCost: tokenEstimate(record.subjectId.length, 64),
      metadata: { evidence_stub: true, subject_type: boundedText(record.subjectType, 40) }
    },
    record.rel
  );
  if (health.healthy) {
    builder.addEdge({
      from: proofNodeId,
      to: subject.id,
      type: 'verified_by',
      confidence: mode === 'index' ? 'manifest' : 'exact',
      provenancePath: record.rel,
      provenanceHash: record.hash
    });
    return;
  }
  builder.addEdge({
    from: proofNodeId,
    to: subject.id,
    type: 'invalidates',
    confidence: health.invalidated ? 'manifest' : 'observed',
    provenancePath: record.rel,
    provenanceHash: record.hash
  });
}

/**
 * Proof-card `input_paths` / `source_paths` become `derived_from` links into the
 * code graph, so a target must be a code source inventory member: Align's
 * exact-file-coverage invariant equates snapshot `file` nodes with that
 * inventory. Hash-pinned release surfaces (`package_lock_hash` →
 * `package-lock.json`, `release_gates_hash` → `release-gates.v2.json`) are
 * structurally never members — the walk only ingests source-language files — so
 * they are no longer materialized as file stubs at all; their hashes stay
 * readable in the proof card the proof node cites.
 */
function linkDerivedInputs(
  builder: EvidenceFragmentBuilder,
  ctx: EvidenceContext,
  record: ProofRecord,
  proofNodeId: string
): void {
  const raw = record.card as unknown as Record<string, unknown> | null;
  const candidates: string[] = raw ? [...asStringList(raw.input_paths), ...asStringList(raw.source_paths)] : [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.size >= MAX_DERIVED_INPUTS) break;
    const rel = tryNormalizeGraphPath(ctx.root, candidate);
    if (!rel || seen.has(rel)) continue;
    if (!ctx.sourcePaths.has(rel)) continue;
    const stat = statWorkspaceEntry(ctx.root, rel);
    if (!stat || !stat.isFile()) continue;
    seen.add(rel);
    const fileId = contextGraphNodeId({ kind: 'file', path: rel });
    const read = readWorkspaceFile(ctx.root, rel, ctx.limits.maxFileBytes);
    builder.addNode(
      {
        id: fileId,
        kind: 'file',
        label: safeText(rel, 120) || rel,
        path: rel,
        ...(read.ok ? { contentHash: read.value.hash } : {}),
        trust: read.ok ? 0.9 : 0.4,
        freshness: read.ok ? 'fresh' : 'unknown',
        risk: 'low',
        tokenCost: tokenEstimate(stat.size),
        metadata: { evidence_stub: true, source_path: rel }
      },
      record.rel
    );
    builder.addEdge({
      from: proofNodeId,
      to: fileId,
      type: 'derived_from',
      confidence: 'manifest',
      provenancePath: record.rel,
      provenanceHash: record.hash
    });
  }
}
