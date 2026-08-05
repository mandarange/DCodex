import path from 'node:path';
import { ensureDir, PACKAGE_VERSION, writeJsonAtomic } from '../fsx.js';
import { contextCapsule } from '../triwiki-attention.js';
import { sealTriWikiContextPack, validateTriWikiContextPackProvenance } from '../triwiki-provenance.js';
import { validateWikiCoordinateIndex } from '../wiki-coordinate.js';
import type { CodePack, CodePackEntry } from './code-pack.js';

export const CODE_NAVIGATION_CONTEXT_PACK_SCHEMA = 'sks.code-navigation-context-pack.v1' as const;

function claimFromEntry(entry: CodePackEntry) {
  return {
    id: entry.id,
    text: entry.text,
    source: 'context-graph:code',
    source_paths: entry.citations.map((citation) => citation.path),
    status: entry.freshness === 'fresh' ? 'supported' : entry.freshness,
    authority: 'code',
    freshness: entry.freshness,
    risk: 'low',
    tokenCost: entry.token_cost,
    evidence_count: entry.citations.length,
    trust_score: entry.trust_score
  };
}

export function buildCodeNavigationContextPack(input: {
  root: string;
  codePack: CodePack;
  snapshotHash: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  extractorRevisions: Array<{ id: string; revision: string }>;
}) {
  const sourceClaims = input.codePack.entries.map(claimFromEntry);
  const capsule = contextCapsule({
    mission: { id: 'project-code-navigation', coord: { rgba: { r: 42, g: 118, b: 214, a: 255 } } },
    role: 'code-navigation',
    contractHash: input.snapshotHash,
    claims: sourceClaims,
    q4: {
      mode: 'repository-code-navigation-only',
      package: PACKAGE_VERSION,
      hydrate: 'exact-file-line-first'
    },
    q3: ['sks', 'code-navigation', 'source-only', 'file-symbol-line-relations'],
    budget: {
      maxClaims: 24,
      maxWikiAnchors: 32,
      maxAttentionUse: 8,
      maxAttentionHydrate: 8,
      codePackTokenBudget: input.codePack.token_budget,
      includeTrustSummary: true,
      verboseClaims: true
    },
    codePackEntries: input.codePack.entries,
    wrongnessByModule: {}
  });
  const claimsById = new Map(sourceClaims.map((claim) => [claim.id, claim]));
  const claims = (capsule.claims || []).map((claim: any) => {
    const source = claimsById.get(String(claim?.id || ''));
    if (!source) return claim;
    // The generic TriWiki capsule suppresses negative phrasing for ordinary
    // recall. A code-navigation index must instead preserve source-derived text
    // byte-for-byte: "do not" in a comment is program meaning, not priming.
    const exact = {
      ...claim,
      text: source.text,
      source: source.source,
      source_paths: source.source_paths,
      freshness: source.freshness,
      trust_score: source.trust_score
    };
    delete (exact as any).text_policy;
    return exact;
  });
  return sealTriWikiContextPack({
    schema: CODE_NAVIGATION_CONTEXT_PACK_SCHEMA,
    mode: 'repository_code_navigation_only',
    source_policy: {
      included: ['repository source-code bytes', 'source comments and docstrings', 'AST declarations and relations'],
      excluded: ['prior TriWiki memory', 'wrongness memory', 'mission prompts', 'ordinary documentation', 'external documentation', 'LLM inference', 'release proof cards'],
      full_rebuild: true,
      incremental_reuse: false
    },
    index: {
      exhaustive_artifact: '.sneakoscope/wiki/context-graph.json',
      inventory_artifact: '.sneakoscope/wiki/code-navigation-manifest.json',
      attention_projection_bounded: true,
      snapshot_hash: input.snapshotHash,
      code_pack_digest: input.codePack.index_digest,
      source_file_count: input.fileCount,
      symbol_count: input.symbolCount,
      edge_count: input.edgeCount,
      extractors: input.extractorRevisions
    },
    ...capsule,
    claims
  }, { root: input.root });
}

export function validateCodeNavigationContextPack(pack: any, root: string) {
  const coordinate = validateWikiCoordinateIndex(pack?.wiki || {}, { root, claims: pack?.claims });
  const provenance = validateTriWikiContextPackProvenance(pack, { root });
  const issues: any[] = [
    ...coordinate.issues,
    ...provenance.issues,
    ...(pack?.schema === CODE_NAVIGATION_CONTEXT_PACK_SCHEMA ? [] : [{ id: 'code_navigation_context_pack_schema', severity: 'error' }]),
    ...(pack?.mode === 'repository_code_navigation_only' ? [] : [{ id: 'code_navigation_context_pack_mode', severity: 'error' }]),
    ...(pack?.source_policy?.full_rebuild === true && pack?.source_policy?.incremental_reuse === false
      ? []
      : [{ id: 'code_navigation_source_policy', severity: 'error' }]),
    ...(Array.isArray(pack?.claims) ? [] : [{ id: 'code_navigation_claims_missing', severity: 'error' }]),
    ...(Array.isArray(pack?.attention?.use_first) && Array.isArray(pack?.attention?.hydrate_first)
      ? []
      : [{ id: 'code_navigation_attention_missing', severity: 'error' }])
  ];
  return { ok: issues.length === 0, checked: coordinate.checked, issues };
}

export async function writeCodeNavigationContextPack(root: string, pack: any) {
  const validation = validateCodeNavigationContextPack(pack, root);
  const file = path.join(root, '.sneakoscope', 'wiki', 'context-pack.json');
  if (!validation.ok) return { ok: false, written: false, path: file, validation };
  await ensureDir(path.dirname(file));
  await writeJsonAtomic(file, pack);
  return { ok: true, written: true, path: file, validation };
}
