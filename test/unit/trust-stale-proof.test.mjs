import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { latestTrustReport } from '../../dist/core/trust-kernel/trust-report.js';

test('trust report blocks when proof is older than latest route event', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-trust-stale-proof-'));
  await writeTrustFixture(root, {
    missionId: 'M-stale-proof',
    proofAt: '2026-05-18T00:00:00.000Z',
    eventAt: '2026-05-18T00:01:00.000Z',
    evidenceAt: '2026-05-18T00:02:00.000Z',
    contractAt: '2026-05-18T00:03:00.000Z',
    reportAt: '2026-05-18T00:04:00.000Z'
  });

  const report = await latestTrustReport(root, 'M-stale-proof');
  assert.equal(report.ok, false);
  assert.equal(report.status, 'blocked');
  assert.ok(report.issues.includes('stale_proof'));
});

test('trust report blocks stale evidence index, contract, and report ordering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-trust-stale-ordering-'));
  await writeTrustFixture(root, {
    missionId: 'M-stale-ordering',
    proofAt: '2026-05-18T00:04:00.000Z',
    eventAt: '2026-05-18T00:03:00.000Z',
    evidenceAt: '2026-05-18T00:02:00.000Z',
    contractAt: '2026-05-18T00:01:00.000Z',
    reportAt: '2026-05-18T00:00:00.000Z'
  });

  const report = await latestTrustReport(root, 'M-stale-ordering');
  assert.equal(report.ok, false);
  assert.equal(report.status, 'blocked');
  assert.ok(report.issues.includes('stale_evidence_index'));
  assert.ok(report.issues.includes('stale_route_contract'));
  assert.ok(report.issues.includes('stale_trust_report'));
});

test('trust report remains current after non-mutating stop-hook events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-trust-stop-events-'));
  const missionId = 'M-stop-events';
  await writeTrustFixture(root, {
    missionId,
    proofAt: '2026-05-18T00:04:00.000Z',
    eventAt: '2026-05-18T00:03:00.000Z',
    evidenceAt: '2026-05-18T00:05:00.000Z',
    contractAt: '2026-05-18T00:06:00.000Z',
    reportAt: '2026-05-18T00:07:00.000Z'
  });
  await fs.appendFile(path.join(root, '.sneakoscope', 'missions', missionId, 'events.jsonl'), [
    { ts: '2026-05-18T00:08:00.000Z', type: 'triwiki.agents_md_projected' },
    { ts: '2026-05-18T00:09:00.000Z', type: 'pipeline.compliance_loop_guard' }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');

  const report = await latestTrustReport(root, missionId);
  assert.equal(report.ok, true);
  assert.equal(report.status, 'verified_partial');
  assert.deepEqual(report.issues, []);
});

async function writeTrustFixture(root, { missionId, proofAt, eventAt, evidenceAt, contractAt, reportAt }) {
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'events.jsonl'), `${JSON.stringify({ ts: eventAt, type: 'route.event' })}\n`);
  await fs.writeFile(path.join(dir, 'completion-proof.json'), `${JSON.stringify({
    schema: 'sks.completion-proof.v1',
    version: '1.0.0',
    generated_at: proofAt,
    mission_id: missionId,
    route: '$Naruto',
    status: 'verified_partial',
    summary: {},
    evidence: {},
    claims: [],
    unverified: [],
    blockers: []
  }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'evidence-index.json'), `${JSON.stringify({
    schema: 'sks.evidence-index.v1',
    generated_at: evidenceAt,
    mission_id: missionId,
    route: '$Naruto',
    status: 'verified_partial',
    ok: true,
    records: [],
    issues: []
  }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'route-completion-contract.json'), `${JSON.stringify({
    schema: 'sks.route-completion-contract.v1',
    version: '1.0.0',
    generated_at: contractAt,
    mission_id: missionId,
    route: '$Naruto',
    required: { completion_proof: true },
    evidence: {},
    status: 'verified_partial',
    validation: { ok: true, status: 'verified_partial', issues: [] }
  }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'trust-report.json'), `${JSON.stringify({
    schema: 'sks.trust-report.v1',
    version: '1.0.0',
    generated_at: reportAt,
    ok: true,
    mission_id: missionId,
    route: '$Naruto',
    status: 'verified_partial',
    proof_status: 'verified_partial',
    evidence_status: 'verified_partial',
    route_contract_status: 'verified_partial',
    issues: [],
    blockers: []
  }, null, 2)}\n`);
}
