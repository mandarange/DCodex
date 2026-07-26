#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_MAX_PACK_BYTES } from '../core/release/package-size-budget.js';
import { readCurrentNpmPackProof, writeNpmPackProof } from '../core/release/npm-pack-proof.js';
import { assertGate, emitGate, root } from './gate-lib.js';

const MAX_FILES = Number(process.env.SKS_MAX_PACK_FILES || 2100);
const MAX_PACKED = Number(process.env.SKS_MAX_PACK_BYTES || DEFAULT_MAX_PACK_BYTES);
const BUDGET_MS = Number(process.env.SKS_PACK_BUDGET_MS || 30000);

function runNpmPack() {
  const npmCli = process.env.npm_execpath; // set when invoked via `npm run`
  const argv = ['pack', '--dry-run', '--ignore-scripts', '--json'];
  const res = npmCli
    ? spawnSync(process.execPath, [npmCli, ...argv], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    : spawnSync('npm', argv, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return res;
}

function writeReport(report) {
  const out = path.join(root, '.sneakoscope', 'reports', 'npm-publish-performance.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

const existingProof = readCurrentNpmPackProof(root);
let packMs = existingProof.ok && existingProof.proof ? existingProof.proof.pack_ms : 0;
let info = existingProof.ok && existingProof.proof ? existingProof.proof.info : undefined;
if (!info) {
  const t0 = Date.now();
  const res = runNpmPack();
  packMs = Date.now() - t0;
  if (res.status === 0) {
    try {
      const parsed = JSON.parse(res.stdout);
      info = Array.isArray(parsed) ? parsed[0] : parsed;
      if (info) writeNpmPackProof(root, info, packMs);
    } catch {
      info = undefined;
    }
  }
}

if (!info) {
  // Real-check gate: never fail when npm is unreachable / pack unavailable.
  const report = { ok: true, integration_optional: true, reason: 'npm_pack_unavailable' };
  writeReport(report);
  emitGate('publish:dry-run-performance', { integration_optional: true });
  process.exit(0);
}

const report = {
  schema: 'sks.npm-publish-performance.v1',
  ok: info.entryCount <= MAX_FILES && info.size <= MAX_PACKED,
  pack_ms: packMs,
  reused_pack_proof: existingProof.ok,
  slowest_phase: 'pack',
  file_count: info.entryCount,
  packed_bytes: info.size,
  unpacked_bytes: info.unpackedSize,
  over_budget: packMs > BUDGET_MS,
  warnings: packMs > BUDGET_MS ? ['pack_slower_than_budget'] : [],
  blockers: [
    ...(info.entryCount > MAX_FILES ? ['pack_file_count_over_limit'] : []),
    ...(info.size > MAX_PACKED ? ['pack_size_over_limit'] : [])
  ]
};

writeReport(report);

if (report.blockers.length) {
  assertGate(false, 'npm_publish_performance_blockers', { blockers: report.blockers, report });
}

// A slow pack is a WARNING only, not a blocker.
console.log(JSON.stringify(report, null, 2));
process.exit(0);
