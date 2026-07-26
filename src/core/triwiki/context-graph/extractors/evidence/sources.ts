/**
 * Cited-source nodes for the evidence extractor.
 *
 * A source is a path the context pack cites. Its freshness is decided by
 * comparing the hash the pack sealed into its source manifest against the bytes
 * currently on disk — a mismatch marks the source (and therefore every claim that
 * rests on it) `stale`, which is what stops a stale wiki from being read as fact.
 * Hashing is cached and budget-bounded so one compile never re-reads a file.
 */
import type { Stats } from 'node:fs';
import type { ContextGraphFreshness, ContextGraphMetadata } from '../../contracts.js';
import { contextGraphNodeId, shortDigest } from '../../ids.js';
import { safeText } from './redaction.js';
import {
  CONTEXT_PACK_REL,
  EvidenceFragmentBuilder,
  asArray,
  asRecord,
  asString,
  readWorkspaceFile,
  statWorkspaceEntry,
  tokenEstimate,
  type EvidenceContext
} from './shared.js';

const MAX_DIRECTORY_PROBE = 24;

export interface SourceState {
  id: string;
  freshness: ContextGraphFreshness;
}

/** `path -> sha256` sealed into the context pack provenance manifest. */
export function manifestHashes(pack: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const provenance = asRecord(pack.provenance);
  const manifest = provenance ? asRecord(provenance.source_manifest) : null;
  for (const entry of asArray(manifest?.entries)) {
    const row = asRecord(entry);
    const rel = row ? asString(row.path) : null;
    const hash = row ? asString(row.sha256) : null;
    if (rel && hash) out.set(rel, hash);
  }
  return out;
}

export function hasManifestPrefix(manifest: ReadonlyMap<string, string>, rel: string): boolean {
  const prefix = `${rel}/`;
  for (const key of manifest.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/** Bounded, cached disk hashing so one source is never hashed twice per compile. */
class SourceHasher {
  private readonly cache = new Map<string, string | null>();

  private budget: number;

  constructor(private readonly ctx: EvidenceContext, private readonly builder: EvidenceFragmentBuilder) {
    this.budget = Math.max(0, ctx.limits.maxFiles);
  }

  hash(rel: string): string | null {
    const cached = this.cache.get(rel);
    if (cached !== undefined) return cached;
    if (this.budget <= 0) {
      this.builder.noteCap(CONTEXT_PACK_REL, 'source_hash_budget_exhausted');
      this.cache.set(rel, null);
      return null;
    }
    this.budget -= 1;
    const read = readWorkspaceFile(this.ctx.root, rel, this.ctx.limits.maxFileBytes);
    const value = read.ok ? read.value.hash : null;
    if (!read.ok && read.skip.reason !== 'unreadable') this.builder.addSkip(read.skip);
    this.cache.set(rel, value);
    return value;
  }
}

export class EvidenceSourceGraph {
  private readonly hasher: SourceHasher;

  private readonly states = new Map<string, SourceState>();

  constructor(
    private readonly builder: EvidenceFragmentBuilder,
    private readonly ctx: EvidenceContext,
    private readonly manifest: ReadonlyMap<string, string>,
    private readonly packHash: string
  ) {
    this.hasher = new SourceHasher(ctx, builder);
  }

  /** Materialize the `source` node (and its backing `file` node) for a cited path. */
  ensure(rel: string): SourceState {
    const existing = this.states.get(rel);
    if (existing) return existing;
    const id = contextGraphNodeId({ kind: 'source', sourceHash: shortDigest(`path:${rel}`) });
    const stat = statWorkspaceEntry(this.ctx.root, rel);
    const manifestHash = this.manifest.get(rel) ?? null;
    const isDirectory = Boolean(stat?.isDirectory());
    const diskHash = !stat || isDirectory ? null : this.hasher.hash(rel);
    const freshness = this.freshness({ stat, isDirectory, manifestHash, diskHash, rel });
    const metadata: ContextGraphMetadata = {
      source_path: rel,
      entry_kind: isDirectory ? 'directory' : stat ? 'file' : 'missing',
      manifest_hash_present: manifestHash !== null,
      ...(manifestHash ? { manifest_hash: manifestHash.slice(0, 16) } : {}),
      ...(diskHash ? { disk_hash: diskHash.slice(0, 16) } : {}),
      ...(manifestHash && diskHash ? { hash_match: manifestHash === diskHash } : {})
    };
    this.builder.addNode(
      {
        id,
        kind: 'source',
        label: safeText(rel, 120) || rel,
        path: rel,
        ...(diskHash ? { contentHash: diskHash } : manifestHash ? { contentHash: manifestHash } : {}),
        trust: freshness === 'fresh' ? 0.85 : freshness === 'stale' ? 0.3 : 0.5,
        freshness,
        risk: 'low',
        tokenCost: tokenEstimate(rel.length, 64),
        metadata
      },
      CONTEXT_PACK_REL
    );
    if (!isDirectory && (diskHash || manifestHash)) this.linkBackingFile(id, rel, stat, diskHash, manifestHash);
    const state: SourceState = { id, freshness };
    this.states.set(rel, state);
    return state;
  }

  private linkBackingFile(
    sourceId: string,
    rel: string,
    stat: Stats | null,
    diskHash: string | null,
    manifestHash: string | null
  ): void {
    const fileId = contextGraphNodeId({ kind: 'file', path: rel });
    this.builder.addNode(
      {
        id: fileId,
        kind: 'file',
        label: safeText(rel, 120) || rel,
        path: rel,
        ...(diskHash ? { contentHash: diskHash } : {}),
        trust: diskHash ? 0.9 : 0.4,
        freshness: diskHash ? 'fresh' : 'stale',
        risk: 'low',
        tokenCost: tokenEstimate(stat?.size ?? rel.length),
        metadata: { evidence_stub: true, source_path: rel }
      },
      CONTEXT_PACK_REL
    );
    this.builder.addEdge({
      from: sourceId,
      to: fileId,
      type: 'derived_from',
      confidence: diskHash ? 'exact' : 'manifest',
      provenancePath: rel,
      provenanceHash: diskHash ?? manifestHash ?? this.packHash
    });
  }

  private freshness(input: {
    stat: Stats | null;
    isDirectory: boolean;
    manifestHash: string | null;
    diskHash: string | null;
    rel: string;
  }): ContextGraphFreshness {
    if (!input.stat) return input.manifestHash || hasManifestPrefix(this.manifest, input.rel) ? 'stale' : 'unknown';
    if (input.isDirectory) return this.directoryFreshness(input.rel);
    if (!input.manifestHash || !input.diskHash) return 'unknown';
    return input.diskHash === input.manifestHash ? 'fresh' : 'stale';
  }

  /** A cited directory is fresh only when every manifest member it covers still matches. */
  private directoryFreshness(rel: string): ContextGraphFreshness {
    const prefix = `${rel}/`;
    const members = [...this.manifest.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, MAX_DIRECTORY_PROBE);
    if (!members.length) return 'unknown';
    for (const member of members) {
      const expected = this.manifest.get(member);
      const actual = this.hasher.hash(member);
      if (!expected || !actual) return 'unknown';
      if (actual !== expected) return 'stale';
    }
    return 'fresh';
  }
}
