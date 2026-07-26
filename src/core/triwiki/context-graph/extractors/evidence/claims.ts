/**
 * TriWiki context-pack claims and their cited sources.
 *
 * Only what the pack mechanically declares becomes an edge: a claim cites the
 * paths it lists, a source derives from the file it names, and a claim only
 * supports/contradicts/supersedes another claim when the pack itself carries that
 * relation. Prose similarity is never a graph fact.
 */
import { sha256 } from '../../../../fsx.js';
import {
  lintWarning,
  type ContextGraphEdgeType,
  type ContextGraphFreshness,
  type ContextGraphMetadata
} from '../../contracts.js';
import { contextGraphNodeId, shortDigest } from '../../ids.js';
import { tryNormalizeGraphPath } from '../../paths.js';
import { boundedText, safeText } from './redaction.js';
import { EvidenceSourceGraph, hasManifestPrefix, manifestHashes, type SourceState } from './sources.js';
import {
  CONTEXT_PACK_REL,
  EvidenceFragmentBuilder,
  RiskDomainRegistry,
  asArray,
  asFiniteNumber,
  asRecord,
  asString,
  asStringList,
  graphRiskFromBand,
  isRemoteCitation,
  readWorkspaceFile,
  statWorkspaceEntry,
  tokenEstimate,
  type EvidenceContext
} from './shared.js';

const MAX_CLAIMS = 512;
const MAX_CITATIONS_PER_CLAIM = 16;
const MAX_FRESHNESS_WARNINGS = 24;
const DECLARED_RELATION_TYPES: ReadonlySet<string> = new Set(['supports', 'contradicts', 'supersedes']);

const STATUS_TRUST: Readonly<Record<string, number>> = {
  supported: 0.8,
  weak: 0.5,
  stale: 0.3,
  unknown: 0.35,
  unsupported: 0.1,
  conflicted: 0.05
};

interface ClaimRow {
  claimId: string;
  nodeId: string;
  text: string;
  status: string;
  riskBand: string;
  authority: string;
  declaredTrust: number | null;
  declaredFreshness: string | null;
  evidenceCount: number;
  hydrationPath: string | null;
  raw: Record<string, unknown>;
}

export interface ContextPackEvidenceResult {
  packPresent: boolean;
  packHash: string | null;
  claimCount: number;
}

export function extractContextPackEvidence(
  builder: EvidenceFragmentBuilder,
  ctx: EvidenceContext,
  risks: RiskDomainRegistry
): ContextPackEvidenceResult {
  const read = readWorkspaceFile(ctx.root, CONTEXT_PACK_REL, ctx.limits.maxFileBytes);
  if (!read.ok) {
    builder.addSkip(read.skip);
    builder.addIssue(
      lintWarning('extractor_skipped_input', 'TriWiki context pack is absent or unreadable; no claim evidence was extracted', {
        path: CONTEXT_PACK_REL,
        extractor: builder.fragment.extractor
      })
    );
    return { packPresent: false, packHash: null, claimCount: 0 };
  }
  builder.addInputHash(CONTEXT_PACK_REL, read.value.hash);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(read.value.bytes.toString('utf8'));
  } catch {
    parsed = null;
  }
  const pack = asRecord(parsed);
  if (!pack) {
    builder.addSkip({ path: CONTEXT_PACK_REL, reason: 'unreadable', detail: 'context_pack_corrupt' });
    builder.addIssue(
      lintWarning('extractor_skipped_input', 'TriWiki context pack is not decodable JSON; no claim evidence was extracted', {
        path: CONTEXT_PACK_REL,
        extractor: builder.fragment.extractor
      })
    );
    return { packPresent: false, packHash: read.value.hash, claimCount: 0 };
  }

  const packHash = read.value.hash;
  const manifest = manifestHashes(pack);
  const anchors = anchorHydrationPaths(pack);
  const rows = claimRows(pack, anchors);
  const sources = new EvidenceSourceGraph(builder, ctx, manifest, packHash);
  const knownClaims = new Map<string, string>();
  let freshnessWarnings = 0;

  for (const row of rows) knownClaims.set(row.claimId, row.nodeId);

  for (const row of rows) {
    const citations = resolveCitations(ctx, row, manifest);
    const localStates: SourceState[] = [];
    for (const rel of citations.local) {
      const state = sources.ensure(rel);
      localStates.push(state);
      builder.addEdge({
        from: row.nodeId,
        to: state.id,
        type: 'cites',
        confidence: 'manifest',
        provenancePath: CONTEXT_PACK_REL,
        provenanceHash: packHash
      });
      if (state.freshness === 'unknown' && freshnessWarnings < MAX_FRESHNESS_WARNINGS) {
        freshnessWarnings += 1;
        builder.addIssue(
          lintWarning('unknown_freshness', 'cited source has no comparable hash in the pack source manifest', {
            nodeId: state.id,
            path: rel,
            extractor: builder.fragment.extractor
          })
        );
      }
    }
    addClaimNode(builder, risks, row, localStates, citations, packHash);
  }

  addDeclaredRelations(builder, pack, rows, knownClaims, packHash);
  return { packPresent: true, packHash, claimCount: rows.length };
}

function anchorHydrationPaths(pack: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const wiki = asRecord(pack.wiki);
  if (!wiki) return out;
  for (const entry of asArray(wiki.anchors)) {
    const anchor = asRecord(entry);
    const id = anchor ? asString(anchor.id) : null;
    const hydrate = anchor ? asString(anchor.p) : null;
    if (id && hydrate) out.set(id, hydrate);
  }
  for (const entry of asArray(wiki.a)) {
    const row = asArray(entry);
    const id = asString(row[0]);
    const hydrate = asString(row[8]);
    if (id && hydrate && !out.has(id)) out.set(id, hydrate);
  }
  return out;
}

function claimRows(pack: Record<string, unknown>, anchors: Map<string, string>): ClaimRow[] {
  const rows: ClaimRow[] = [];
  const seen = new Set<string>();
  for (const entry of asArray(pack.claims)) {
    if (rows.length >= MAX_CLAIMS) break;
    const claim = asRecord(entry);
    const claimId = claim ? asString(claim.id) : null;
    if (!claim || !claimId || seen.has(claimId)) continue;
    seen.add(claimId);
    const text = asString(claim.text) ?? '';
    const declaredHash = asString(claim.h);
    const claimHash = declaredHash && /^[0-9a-f]{8,64}$/i.test(declaredHash)
      ? declaredHash.toLowerCase()
      : shortDigest(`${claimId}\n${text}`);
    rows.push({
      claimId,
      nodeId: contextGraphNodeId({ kind: 'wiki_claim', claimHash }),
      text,
      status: asString(claim.status) ?? 'unknown',
      riskBand: asString(claim.risk) ?? 'medium',
      authority: asString(claim.authority) ?? asString(claim.source) ?? 'unknown',
      declaredTrust: asFiniteNumber(claim.trust_score ?? claim.trust),
      declaredFreshness: asString(claim.freshness),
      evidenceCount: asFiniteNumber(claim.evidence_count) ?? 0,
      hydrationPath: anchors.get(claimId) ?? null,
      raw: claim
    });
  }
  return rows.sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0));
}

interface ResolvedCitations {
  local: string[];
  remote: number;
  unresolved: number;
}

function resolveCitations(ctx: EvidenceContext, row: ClaimRow, manifest: Map<string, string>): ResolvedCitations {
  const candidates = [
    ...asStringList(row.raw.source_paths),
    ...asStringList(row.raw.file),
    ...asStringList(row.raw.source),
    ...asStringList(row.raw.hydrate),
    ...asStringList(row.raw.evidence_path),
    ...(row.hydrationPath ? [row.hydrationPath] : [])
  ];
  const local = new Set<string>();
  let remote = 0;
  let unresolved = 0;
  for (const candidate of candidates) {
    if (local.size >= MAX_CITATIONS_PER_CLAIM) break;
    if (isRemoteCitation(candidate)) {
      remote += 1;
      continue;
    }
    const rel = tryNormalizeGraphPath(ctx.root, candidate);
    if (!rel) {
      unresolved += 1;
      continue;
    }
    if (!manifest.has(rel) && !hasManifestPrefix(manifest, rel) && !statWorkspaceEntry(ctx.root, rel)) {
      unresolved += 1;
      continue;
    }
    local.add(rel);
  }
  return { local: [...local].sort(), remote, unresolved };
}

function addClaimNode(
  builder: EvidenceFragmentBuilder,
  risks: RiskDomainRegistry,
  row: ClaimRow,
  localStates: readonly SourceState[],
  citations: ResolvedCitations,
  packHash: string
): void {
  const staleSources = localStates.filter((state) => state.freshness === 'stale').length;
  const freshSources = localStates.filter((state) => state.freshness === 'fresh').length;
  const freshness: ContextGraphFreshness =
    staleSources > 0 || row.declaredFreshness === 'stale'
      ? 'stale'
      : localStates.length > 0 && freshSources === localStates.length
        ? 'fresh'
        : 'unknown';

  let trust = row.declaredTrust !== null && row.declaredTrust >= 0 && row.declaredTrust <= 1
    ? row.declaredTrust
    : STATUS_TRUST[row.status] ?? 0.35;
  let basis = row.declaredTrust !== null ? 'declared' : 'status';
  if (freshness === 'stale') {
    trust = Math.min(trust, 0.35);
    basis = 'stale_capped';
  }
  if (localStates.length === 0) {
    trust = Math.min(trust, 0.2);
    basis = 'orphan_capped';
    builder.addIssue(
      lintWarning('orphan_wiki_claim', 'wiki claim carries no resolvable local citation; trust is capped', {
        nodeId: row.nodeId,
        path: CONTEXT_PACK_REL,
        extractor: builder.fragment.extractor
      })
    );
  } else if (localStates.length === 1) {
    trust = Math.min(trust, 0.6);
    if (basis !== 'stale_capped') basis = 'single_source_capped';
    builder.addIssue(
      lintWarning('single_source_low_trust_synthesis', 'wiki claim rests on a single cited source; trust is capped', {
        nodeId: row.nodeId,
        path: CONTEXT_PACK_REL,
        extractor: builder.fragment.extractor
      })
    );
  }

  const metadata: ContextGraphMetadata = {
    claim_id: boundedText(row.claimId, 120),
    text_hash: shortDigest(row.text),
    text_length: row.text.length,
    status: boundedText(row.status, 40),
    risk_band: boundedText(row.riskBand, 40),
    authority: boundedText(row.authority, 60),
    citation_count: localStates.length,
    remote_citation_count: citations.remote,
    unresolved_citation_count: citations.unresolved,
    stale_source_count: staleSources,
    evidence_count: row.evidenceCount,
    trust_basis: basis
  };
  builder.addNode(
    {
      id: row.nodeId,
      kind: 'wiki_claim',
      label: safeText(row.claimId, 120) || row.nodeId,
      path: CONTEXT_PACK_REL,
      contentHash: sha256(`${row.claimId}\n${row.text}`),
      trust,
      freshness,
      risk: graphRiskFromBand(row.riskBand),
      tokenCost: tokenEstimate(row.text.length || row.claimId.length),
      metadata
    },
    CONTEXT_PACK_REL
  );

  const declaredDomain = asString(row.raw.risk_domain) ?? asString(row.raw.domain);
  const domain = declaredDomain
    ? `wiki-domain/${declaredDomain}`
    : ['high', 'critical'].includes(row.riskBand.toLowerCase())
      ? `wiki-risk/${row.riskBand.toLowerCase()}`
      : null;
  if (!domain) return;
  const domainId = risks.note(domain, graphRiskFromBand(row.riskBand));
  if (!domainId) return;
  builder.addEdge({
    from: row.nodeId,
    to: domainId,
    type: 'affected_by',
    confidence: 'manifest',
    provenancePath: CONTEXT_PACK_REL,
    provenanceHash: packHash
  });
}

interface DeclaredRelation {
  from: string;
  to: string;
  type: ContextGraphEdgeType;
}

function addDeclaredRelations(
  builder: EvidenceFragmentBuilder,
  pack: Record<string, unknown>,
  rows: readonly ClaimRow[],
  knownClaims: Map<string, string>,
  packHash: string
): void {
  const declared: DeclaredRelation[] = [];
  const push = (fromClaim: string | null, toClaim: string | null, type: string | null): void => {
    if (!fromClaim || !toClaim || !type || !DECLARED_RELATION_TYPES.has(type)) return;
    const from = knownClaims.get(fromClaim);
    const to = knownClaims.get(toClaim);
    if (!from || !to || from === to) return;
    declared.push({ from, to, type: type as ContextGraphEdgeType });
  };
  for (const entry of [...asArray(pack.claim_relations), ...asArray(pack.claim_edges)]) {
    const relation = asRecord(entry);
    if (!relation) continue;
    push(
      asString(relation.from) ?? asString(relation.source) ?? asString(relation.claim),
      asString(relation.to) ?? asString(relation.target),
      (asString(relation.type) ?? asString(relation.relation))?.toLowerCase() ?? null
    );
  }
  for (const row of rows) {
    for (const type of DECLARED_RELATION_TYPES) {
      for (const target of asStringList(row.raw[type])) push(row.claimId, target, type);
    }
    for (const entry of asArray(row.raw.relations)) {
      const relation = asRecord(entry);
      if (!relation) continue;
      push(
        row.claimId,
        asString(relation.to) ?? asString(relation.target),
        (asString(relation.type) ?? asString(relation.relation))?.toLowerCase() ?? null
      );
    }
  }
  for (const relation of declared) {
    builder.addEdge({
      from: relation.from,
      to: relation.to,
      type: relation.type,
      confidence: 'manifest',
      provenancePath: CONTEXT_PACK_REL,
      provenanceHash: packHash
    });
  }
}
