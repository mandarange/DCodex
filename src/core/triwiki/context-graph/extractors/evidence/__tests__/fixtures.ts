/**
 * Hermetic fixture helpers for the evidence extractor tests.
 *
 * Every workspace lives under `os.tmpdir()` and is removed by the caller; the
 * real HOME is never touched and no process is ever spawned.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContextGraphExtractionLimits, ContextGraphFragment } from '../../../contracts.js';
import { createEvidenceGraphExtractor } from '../index.js';

export const OBSERVED_AT = '2026-01-02T03:04:05.000Z';

export const LIMITS: ContextGraphExtractionLimits = {
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxNodes: 2000,
  maxEdges: 4000,
  timeoutMs: 5000
};

export const PROOF_CARD_SCHEMA = 'sks.triwiki-proof-card.v1';

export function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-evidence-graph-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const A = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const B = 2;\n');
  return root;
}

export function removeWorkspace(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export function fileSha256(root: string, rel: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
}

export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export function manifestEntry(root: string, rel: string, overrideHash?: string): ManifestEntry {
  const bytes = fs.readFileSync(path.join(root, rel));
  return { path: rel, bytes: bytes.length, sha256: overrideHash ?? crypto.createHash('sha256').update(bytes).digest('hex') };
}

export interface PackInput {
  claims: Array<Record<string, unknown>>;
  entries?: ManifestEntry[];
  relations?: Array<Record<string, unknown>>;
  anchors?: unknown[][];
}

export function writeContextPack(root: string, input: PackInput): void {
  const dir = path.join(root, '.sneakoscope', 'wiki');
  fs.mkdirSync(dir, { recursive: true });
  const pack: Record<string, unknown> = {
    mission: 'project-wiki',
    role: 'worker',
    q3: ['sks'],
    wiki: { schema: 'sks.wiki-coordinate.v1', a: input.anchors ?? [] },
    attention: { use_first: [], hydrate_first: [] },
    claims: input.claims,
    ...(input.relations ? { claim_relations: input.relations } : {}),
    provenance: {
      schema: 'sks.triwiki-context-pack-provenance.v1',
      generated_at: OBSERVED_AT,
      source_manifest: {
        schema: 'sks.triwiki-source-manifest.v1',
        entries: input.entries ?? []
      }
    }
  };
  fs.writeFileSync(path.join(dir, 'context-pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
}

export function writeRawContextPack(root: string, body: string): void {
  const dir = path.join(root, '.sneakoscope', 'wiki');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'context-pack.json'), body);
}

export function proofCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: PROOF_CARD_SCHEMA,
    proof_id: 'proof-abc123',
    subject_type: 'gate',
    subject_id: 'release-gate-ok',
    cache_key: 'cache-key-abc',
    input_hash: 'a'.repeat(64),
    implementation_hash: 'b'.repeat(64),
    gate_impl_hash: 'b'.repeat(64),
    package_lock_hash: 'c'.repeat(64),
    release_gates_hash: 'd'.repeat(64),
    env_allowlist_hash: 'e'.repeat(64),
    tool_versions: { sks: 'pinned' },
    tool_version: 'pinned',
    fixture_version: 'fixture-1',
    result: 'passed',
    reusable: true,
    evidence: { checks: 3 },
    invalidation_reasons: [],
    expires_at: null,
    duration_ms: 12,
    created_at: OBSERVED_AT,
    ...overrides
  };
}

/**
 * Writes a proof card into the bank and returns its workspace-relative POSIX path.
 * `pathSubject` lets a test keep the on-disk path clean while the card body carries
 * a hostile `subject_id`.
 */
export function writeProofCard(
  root: string,
  card: Record<string, unknown>,
  subjectDir = 'gates',
  pathSubject?: string
): string {
  const subjectId = String(pathSubject ?? card.subject_id ?? 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const proofId = String(card.proof_id ?? 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const rel = `.sneakoscope/triwiki/proof-bank/${subjectDir}/${subjectId}/${proofId}.json`;
  const absolute = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(card, null, 2)}\n`);
  return rel;
}

export function writeProofIndex(root: string, proofs: Array<Record<string, unknown>>): void {
  const rel = '.sneakoscope/triwiki/proof-bank/index.json';
  const absolute = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify({ schema: 'sks.triwiki-proof-index.v1', proofs }, null, 2)}\n`);
}

export async function runExtractor(root: string): Promise<ContextGraphFragment> {
  return createEvidenceGraphExtractor().extract({
    root,
    changedPaths: null,
    limits: LIMITS,
    observedAt: OBSERVED_AT
  });
}

export function nodeById(fragment: ContextGraphFragment, predicate: (id: string) => boolean) {
  return fragment.nodes.filter((node) => predicate(node.id));
}

export function edgesOfType(fragment: ContextGraphFragment, type: string) {
  return fragment.edges.filter((edge) => edge.type === type);
}

export function hasIssue(fragment: ContextGraphFragment, code: string): boolean {
  return fragment.issues.some((issue) => issue.code === code);
}
