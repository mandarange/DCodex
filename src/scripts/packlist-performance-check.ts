#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_MAX_PACK_BYTES, DEFAULT_MAX_UNPACKED_BYTES } from '../core/release/package-size-budget.js';
import { npmPackAtomicTempPaths, writeNpmPackProof } from '../core/release/npm-pack-proof.js';
import { analyzeRuntimeScriptPackClosure } from '../core/release/runtime-script-pack-closure.js';
import { assertGate, emitGate, root } from './gate-lib.js';

const MAX_FILES = Number(process.env.SKS_MAX_PACK_FILES || 2100);
const MAX_UNPACKED = Number(process.env.SKS_MAX_UNPACKED_BYTES || DEFAULT_MAX_UNPACKED_BYTES);
// Shared measured budgets stay centralized and intentionally narrow.
const MAX_PACKED = Number(process.env.SKS_MAX_PACK_BYTES || DEFAULT_MAX_PACK_BYTES);
const SURFACE_MAX_PACKED = Number(process.env.SKS_PACKAGE_SURFACE_MAX_PACK_BYTES || 25_000_000);
const SURFACE_MAX_FILES = Number(process.env.SKS_PACKAGE_SURFACE_MAX_FILES || 2500);
const MAX_ATOMIC_TEMP_PACK_ATTEMPTS = 4;

function runNpmPack() {
  const npmCli = process.env.npm_execpath; // set when invoked via `npm run`
  const npmCache = process.env.SKS_RELEASE_NPM_CACHE || path.join(os.tmpdir(), 'sneakoscope-npm-cache');
  fs.mkdirSync(npmCache, { recursive: true });
  const argv = ['pack', '--dry-run', '--ignore-scripts', '--json'];
  const opts = {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      NPM_CONFIG_CACHE: npmCache
    }
  };
  const res = npmCli
    ? spawnSync(process.execPath, [npmCli, ...argv], opts)
    : spawnSync('npm', argv, opts);
  return res;
}

const packStarted = Date.now();
let info;
let atomicTempFiles = [];
let packAttempts = 0;
for (; packAttempts < MAX_ATOMIC_TEMP_PACK_ATTEMPTS; packAttempts += 1) {
  const res = runNpmPack();
  assertGate(res.status === 0, 'npm_pack_failed', { stderr: res.stderr });
  try {
    const parsed = JSON.parse(res.stdout);
    info = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    assertGate(false, 'npm_pack_unparseable', { error: String(err && err.message ? err.message : err) });
  }
  atomicTempFiles = npmPackAtomicTempPaths(info);
  if (atomicTempFiles.length === 0) break;
}
const packMs = Date.now() - packStarted;
assertGate(atomicTempFiles.length === 0, 'npm_pack_atomic_temp_files_present', {
  attempts: packAttempts,
  max_attempts: MAX_ATOMIC_TEMP_PACK_ATTEMPTS,
  atomic_temp_files: atomicTempFiles
});

const files = info.files.map((f) => f.path);
const packProof = writeNpmPackProof(root, info, packMs);
const runtimeManifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-required-scripts.json'), 'utf8'));
const runtimeScriptClosure = analyzeRuntimeScriptPackClosure(root);
const customerPayloadForbidden = [
  'dist/core/telegram/controller.js',
  'dist/core/agents/agent-cleanup-executor.js',
  'dist/core/release/npm-stage-tarball-verifier.js',
  'dist/core/release/npm-stage-tarball-verifier-support.js'
];
assertGate(runtimeManifest.schema === 'sks.runtime-required-scripts.v1' && Array.isArray(runtimeManifest.scripts), 'runtime required scripts manifest invalid', runtimeManifest);
assertGate(runtimeScriptClosure.root_mode === 'manifest_ssot', 'runtime script manifest SSOT disabled', {
  root_mode: runtimeScriptClosure.root_mode
});
assertGate(runtimeScriptClosure.declaration_issues.length === 0, 'runtime script closure declaration invalid', {
  issues: runtimeScriptClosure.declaration_issues
});

assertGate(info.entryCount <= MAX_FILES, 'packlist_file_count_over_limit', { entryCount: info.entryCount, max_files: MAX_FILES });
assertGate(info.unpackedSize <= MAX_UNPACKED, 'packlist_unpacked_over_limit', { unpackedSize: info.unpackedSize, max_unpacked: MAX_UNPACKED });
assertGate(info.size <= MAX_PACKED, 'packlist_packed_over_limit', { size: info.size, max_packed: MAX_PACKED });

assertGate(files.includes('dist/bin/sks.js'), 'packlist_missing_runtime_entry', { missing: 'dist/bin/sks.js' });
for (const entry of runtimeManifest.scripts) {
  assertGate(files.includes(entry.path), 'packlist_missing_runtime_required_script', { missing: entry.path, reason: entry.reason });
}
const packedScripts = files
  .filter((file) => file.startsWith('dist/scripts/') && file.endsWith('.js'))
  .sort();
assertGate(JSON.stringify(packedScripts) === JSON.stringify(runtimeScriptClosure.closure), 'packlist_runtime_script_closure_mismatch', {
  missing: runtimeScriptClosure.closure.filter((file) => !packedScripts.includes(file)),
  unexpected: packedScripts.filter((file) => !runtimeScriptClosure.closure.includes(file))
});
assertGate(files.includes('package.json'), 'packlist_missing_runtime_entry', { missing: 'package.json' });
assertGate(files.includes('README.md'), 'packlist_missing_runtime_entry', { missing: 'README.md' });
assertGate(files.includes('LICENSE'), 'packlist_missing_runtime_entry', { missing: 'LICENSE' });
for (const manifest of ['release-gates.v2.json', 'infra-harness-gates.json', 'runtime-required-scripts.json']) {
  assertGate(files.includes(manifest), 'packlist_missing_runtime_manifest', { missing: manifest });
}
assertGate(files.some((f) => f.startsWith('schemas/')), 'packlist_missing_runtime_entry', { missing: 'schemas/' });
for (const retired of customerPayloadForbidden) {
  assertGate(!files.includes(retired), 'packlist_retired_or_maintainer_only_payload_present', { path: retired });
}

const forbidden = files.filter((f) =>
  f.startsWith('test/') ||
  f.startsWith('src/') ||
  f.includes('/__tests__/') ||
  f.endsWith('.test.js') ||
  f.startsWith('docs/internal/') ||
  f.endsWith('.map') ||
  f.startsWith('.sneakoscope/') ||
  f.endsWith('.tgz') ||
  f.startsWith('coverage/') ||
  /(^|\/)\.env/.test(f)
);
assertGate(forbidden.length === 0, 'packlist_forbidden_files', { forbidden });
assertGate(info.entryCount <= SURFACE_MAX_FILES, 'package_surface_file_count_over_limit', { entryCount: info.entryCount, max_file_count: SURFACE_MAX_FILES });
assertGate(info.size <= SURFACE_MAX_PACKED, 'package_surface_tarball_over_limit', { size: info.size, max_tarball_bytes: SURFACE_MAX_PACKED });

const report = {
  schema: 'sks.packlist-performance.v1',
  ok: true,
  generated_at: new Date().toISOString(),
  entryCount: info.entryCount,
  size: info.size,
  unpackedSize: info.unpackedSize,
  pack_ms: packMs,
  pack_attempts: packAttempts + 1,
  pack_proof_id: packProof.proof_id,
  pack_info_sha256: packProof.info_digest,
  pack_file_list_sha256: packProof.file_list_digest,
  runtime_required_scripts: runtimeManifest.scripts.map((entry) => entry.path),
  runtime_required_missing: runtimeManifest.scripts.filter((entry) => !files.includes(entry.path)).map((entry) => entry.path),
  runtime_script_closure: runtimeScriptClosure.closure,
  customer_payload_forbidden: customerPayloadForbidden,
  max_files: MAX_FILES,
  max_packed: MAX_PACKED,
  max_unpacked: MAX_UNPACKED,
  forbidden: [],
  blockers: []
};
const out = path.join(root, '.sneakoscope', 'reports', 'packlist-performance.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

const surfaceReport = {
  schema: 'sks.package-surface-budget.v1',
  ok: true,
  generated_at: new Date().toISOString(),
  max_tarball_bytes: SURFACE_MAX_PACKED,
  max_file_count: SURFACE_MAX_FILES,
  actual_tarball_bytes: info.size,
  actual_file_count: info.entryCount,
  pack_proof_id: packProof.proof_id,
  pack_info_sha256: packProof.info_digest,
  pack_file_list_sha256: packProof.file_list_digest,
  forbidden_globs: [
    'dist/**/__tests__/**',
    'dist/**/*.test.js',
    '.sneakoscope/**',
    'src/**',
    'test/**'
  ],
  forbidden_findings: forbidden,
  blockers: []
};
fs.writeFileSync(path.join(root, '.sneakoscope', 'reports', 'package-surface-budget.json'), `${JSON.stringify(surfaceReport, null, 2)}\n`);

emitGate('publish:packlist-performance', {
  files: info.entryCount,
  packed_kib: Math.round(info.size / 1024),
  unpacked_mib: +(info.unpackedSize / 1048576).toFixed(2)
});
