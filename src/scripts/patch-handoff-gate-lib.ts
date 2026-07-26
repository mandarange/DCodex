#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from '../core/fsx.js';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

export function writeReport(name, report) {
  const out = path.join(root, '.sneakoscope', 'reports', `${name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  return out;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function makeTempPatchProject(prefix = 'sks-patch-handoff-') {
  const dir = tmpdir(prefix);
  for (let index = 1; index <= 10; index += 1) {
    fs.writeFileSync(path.join(dir, `file-${index}.txt`), `before-${index}\n`);
  }
  return dir;
}

export async function runPatchHandoffRouteBlackbox({ gate, route, routeCommand, reportName }) {
  const tmp = makeTempPatchProject();
  const files = Array.from({ length: 10 }, (_, index) => `file-${index + 1}.txt`);
  const prompt = [
    'Patch exactly these ten independent fixture files with one exclusive write lease per file.',
    ...files.map((file) => `\`${file}\``)
  ].join(' ');
  const orchestrator = await importDist('core/agents/agent-orchestrator.js');
  const result = await orchestrator.runNativeAgentOrchestrator({
    root: tmp,
    prompt,
    route,
    routeCommand,
    routeBlackboxKind: `actual_${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}_command`,
    backend: 'fake',
    mock: true,
    agents: 5,
    concurrency: 4,
    targetActiveSlots: 4,
    desiredWorkItemCount: 10,
    minimumWorkItems: 10,
    writeMode: 'parallel',
    applyPatches: true,
    dryRunPatches: false,
    maxWriteAgents: 5,
    json: true
  });
  const ledgerRoot = path.join(tmp, result.ledger_root);
  const queue = readJson(path.join(ledgerRoot, 'agent-patch-queue.json'));
  const merge = readJson(path.join(ledgerRoot, 'agent-merge-coordinator-report.json'));
  const apply = readJson(path.join(ledgerRoot, 'agent-patch-apply-results.json'));
  const verification = readJson(path.join(ledgerRoot, 'agent-patch-verification-results.json'));
  const rollback = readJson(path.join(ledgerRoot, 'agent-patch-rollback-proof.json'));
  const proof = readJson(path.join(ledgerRoot, 'agent-patch-proof.json'));
  const changedFiles = [...new Set((apply.results || []).flatMap((row) => row.changed_files || []))];
  const writeOwners = new Map();
  for (const entry of queue.entries || []) {
    for (const file of entry.write_paths || []) {
      if (!writeOwners.has(file)) writeOwners.set(file, new Set());
      writeOwners.get(file).add(entry.agent_id);
    }
  }
  const firstParallelWave = Math.max(0, ...(merge.parallel_apply_groups || []).map((group) => (group.entry_ids || []).length));
  const report = {
    schema: 'sks.patch-handoff-route-blackbox.v1',
    ok: result.ok === true && proof.ok === true,
    gate,
    route,
    route_command: routeCommand,
    fixture_root: tmp,
    mission_id: result.mission_id,
    requested_agents: 5,
    requested_work_items: 10,
    write_mode: result.parallel_write_policy?.write_mode,
    apply_patches: result.parallel_write_policy?.apply_patches,
    patch_envelopes_enqueued: queue.entries?.length || 0,
    first_parallel_wave_entry_count: firstParallelWave,
    changed_files: changedFiles,
    duplicate_write_owners: [...writeOwners.entries()].filter(([, owners]) => owners.size > 1).map(([file, owners]) => ({ file, owners: [...owners] })),
    rollback_digest_count: proof.rollback_digest_count,
    verification_ok: verification.ok === true,
    rollback_ok: rollback.ok === true,
    patch_proof_ok: proof.ok === true,
    route_final_proof_ok: result.proof?.ok === true,
    policy_only: false,
    artifacts: {
      queue: path.join(result.ledger_root, 'agent-patch-queue.json'),
      merge: path.join(result.ledger_root, 'agent-merge-coordinator-report.json'),
      apply: path.join(result.ledger_root, 'agent-patch-apply-results.json'),
      verification: path.join(result.ledger_root, 'agent-patch-verification-results.json'),
      rollback: path.join(result.ledger_root, 'agent-patch-rollback-proof.json'),
      proof: path.join(result.ledger_root, 'agent-patch-proof.json')
    },
    result
  };
  writeReport(reportName, report);
  assertGate(result.ok === true, `${gate} route final proof must pass`, report);
  assertGate(queue.entries?.length === 10, `${gate} must enqueue 10 patch envelopes`, report);
  assertGate(firstParallelWave >= 5, `${gate} must prove at least five first-wave disjoint patches`, report);
  assertGate(changedFiles.length >= 5, `${gate} must change at least five files`, report);
  assertGate(report.duplicate_write_owners.length === 0, `${gate} must not let two agents own the same file`, report);
  assertGate(proof.rollback_digest_count >= changedFiles.length, `${gate} must record rollback digests for changed files`, report);
  assertGate(verification.ok === true && verification.results?.length === 10, `${gate} verification results must exist for patches`, report);
  assertGate(rollback.ok === true, `${gate} rollback proof must pass`, report);
  assertGate(proof.ok === true, `${gate} patch proof must pass`, report);
  assertGate(result.proof?.ok === true, `${gate} route final proof must pass`, report);
  emitGate(gate, { mission_id: result.mission_id, changed_files: changedFiles.length, first_parallel_wave: firstParallelWave });
  return report;
}
