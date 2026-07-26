#!/usr/bin/env node
// @ts-nocheck
// Gate: agent:wiki-context-proof
// Proves the native agent kernel consults the TriWiki context pack (read-only) and
// references it in proof: (1) the read-only pack loader behaves correctly with and
// without a pack, (2) the orchestrator wires loadTriWikiRuntimeContext + writes the
// artifact + passes it to proof, (3) agent-proof-evidence records the wiki proof fields.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, readText, root } from './gate-lib.js';

const triwiki = await importDist('core/triwiki-runtime.js');
const coordinates = await importDist('core/wiki-coordinate.js');
const { loadTriWikiRuntimeContext, triWikiProofRecord, writeTriWikiContextArtifact } = triwiki;

// 1) Absent pack -> graceful fallback (present:false, warning, not consulted).
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-triwiki-empty-'));
const emptyCtx = await loadTriWikiRuntimeContext(emptyRoot);
assertGate(emptyCtx.present === false, 'absent pack must yield present:false', { ctx: emptyCtx });
assertGate(typeof emptyCtx.warning === 'string' && emptyCtx.warning.length > 0, 'absent pack must carry a warning');
assertGate(emptyCtx.context_pack_hash === null && emptyCtx.use_first.length === 0, 'absent pack must have null hash + no use_first');
assertGate(triWikiProofRecord(emptyCtx).triwiki_context_consulted === false, 'absent pack proof must report not consulted');

// 2) Present pack -> consulted with hash + attention rows.
const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-triwiki-pack-'));
const packDir = path.join(packRoot, '.sneakoscope', 'wiki');
fs.mkdirSync(packDir, { recursive: true });
const wiki = coordinates.compactWikiCoordinateIndex(coordinates.buildWikiCoordinateIndex({
  mission: { id: 'project-wiki', coord: { rgba: [48, 132, 212, 240] } },
  claims: [
    { id: 'claim-a', text: 'claim a', status: 'supported', freshness: 'fresh', risk: 'low', trust_score: 0.95 },
    { id: 'claim-b', text: 'claim b', status: 'weak', freshness: 'unknown', risk: 'high', trust_score: 0.5 }
  ],
  maxAnchors: 2
}));
const anchorById = new Map(wiki.a.map((row) => [row[0], row]));
const pack = {
  mission: 'project-wiki',
  attention: {
    mode: 'aggressive_triwiki_active_recall',
    use_first: [['claim-a', anchorById.get('claim-a')?.[1], anchorById.get('claim-a')?.[7]]],
    hydrate_first: [['claim-b', 'risk:high']]
  },
  wiki,
  claims: [{ id: 'claim-a' }, { id: 'claim-b' }],
  trust_summary: { avg: 0.71 }
};
fs.writeFileSync(path.join(packDir, 'context-pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
const ctx = await loadTriWikiRuntimeContext(packRoot);
assertGate(ctx.present === true, 'present pack must yield present:true', { ctx });
assertGate(typeof ctx.context_pack_hash === 'string' && /^[0-9a-f]{64}$/.test(ctx.context_pack_hash), 'present pack must carry a sha256 hash', { hash: ctx.context_pack_hash });
assertGate(ctx.mission === 'project-wiki', 'pack mission must be read', { mission: ctx.mission });
assertGate(ctx.use_first.length === 1 && ctx.hydrate_first.length === 1, 'attention rows must be surfaced', { use: ctx.use_first.length, hyd: ctx.hydrate_first.length });
assertGate(ctx.claim_count === 2 && ctx.anchor_count === 2, 'claim/anchor counts must be read', { claims: ctx.claim_count, anchors: ctx.anchor_count });
const proof = triWikiProofRecord(ctx);
assertGate(proof.triwiki_context_consulted === true && proof.context_pack_hash === ctx.context_pack_hash, 'present pack proof must report consulted + hash');

// 3) Artifact write.
const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-triwiki-ledger-'));
const artifactPath = await writeTriWikiContextArtifact(ledger, ctx);
assertGate(fs.existsSync(artifactPath), 'context artifact must be written');
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
assertGate(artifact.proof?.triwiki_context_consulted === true, 'artifact must embed proof record');

// 4) Kernel + proof wiring (source-level so the consult cannot be silently removed).
const orchestrator = readText('src/core/agents/agent-orchestrator.ts');
assertGate(orchestrator.includes('loadTriWikiRuntimeContext') && orchestrator.includes('writeTriWikiContextArtifact') && orchestrator.includes('triwikiContext'), 'orchestrator must consult TriWiki + write artifact + pass to proof');
const proofSrc = readText('src/core/agents/agent-proof-evidence.ts');
assertGate(proofSrc.includes('triwiki_context_consulted') && proofSrc.includes('context_pack_hash') && proofSrc.includes("triwiki_context: 'agent-triwiki-context.json'"), 'agent-proof-evidence must record the TriWiki proof fields');

for (const dir of [emptyRoot, packRoot, ledger]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const reportDir = path.join(root, '.sneakoscope', 'reports');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'agent-wiki-context-proof.json'), `${JSON.stringify({ schema: 'sks.agent-wiki-context-proof.v1', ok: true, present_pack_hash: ctx.context_pack_hash, use_first: ctx.use_first.length, hydrate_first: ctx.hydrate_first.length }, null, 2)}\n`);
emitGate('agent:wiki-context-proof', { kernel_consults_triwiki: true, proof_records_hash: true });
