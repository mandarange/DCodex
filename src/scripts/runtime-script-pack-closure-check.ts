#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MAX_PACK_BYTES, DEFAULT_MAX_UNPACKED_BYTES } from '../core/release/package-size-budget.js';
import { analyzeRuntimeScriptPackClosure } from '../core/release/runtime-script-pack-closure.js';
import { assertGate, emitGate, root } from './gate-lib.js';

const MAX_FILES = Number(process.env.SKS_MAX_PACK_FILES || 2100);
const MAX_PACKED = Number(process.env.SKS_MAX_PACK_BYTES || DEFAULT_MAX_PACK_BYTES);
const MAX_UNPACKED = Number(process.env.SKS_MAX_UNPACKED_BYTES || DEFAULT_MAX_UNPACKED_BYTES);

const analysis = analyzeRuntimeScriptPackClosure(root);
assertGate(analysis.root_mode === 'manifest_ssot', 'runtime_script_manifest_ssot_disabled', {
  root_mode: analysis.root_mode
});
assertGate(analysis.declaration_issues.length === 0, 'runtime_script_allowlist_declaration_invalid', {
  issues: analysis.declaration_issues
});
assertGate(analysis.missing_references.length === 0, 'runtime_script_reference_missing', {
  missing_references: analysis.missing_references
});
assertGate(analysis.uncovered_dynamic_references.length === 0, 'runtime_script_dynamic_reference_uncovered', {
  uncovered: analysis.uncovered_dynamic_references
});
assertGate(analysis.stale_dynamic_reference_policies.length === 0, 'runtime_script_dynamic_reference_policy_stale', {
  stale: analysis.stale_dynamic_reference_policies
});
assertGate(analysis.missing_from_allowlist.length === 0, 'runtime_script_allowlist_missing_closure', {
  missing: analysis.missing_from_allowlist
});
assertGate(analysis.stale_allowlist_entries.length === 0, 'runtime_script_allowlist_stale_entries', {
  stale: analysis.stale_allowlist_entries
});
assertGate(analysis.unclassified_reference_roots.length === 0, 'runtime_script_reference_source_unclassified', {
  unclassified: analysis.unclassified_reference_roots
});

const npmCache = process.env.SKS_RELEASE_NPM_CACHE || path.join(os.tmpdir(), 'sneakoscope-npm-cache');
fs.mkdirSync(npmCache, { recursive: true });
const npmCli = process.env.npm_execpath;
const args = ['pack', '--dry-run', '--ignore-scripts', '--json'];
const options = {
  cwd: root,
  encoding: 'utf8' as const,
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, npm_config_cache: npmCache, NPM_CONFIG_CACHE: npmCache }
};
const packed = npmCli
  ? spawnSync(process.execPath, [npmCli, ...args], options)
  : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
assertGate(packed.status === 0, 'runtime_script_pack_dry_run_failed', { stderr: packed.stderr || '', stdout: packed.stdout || '' });

let info: any = null;
try {
  const parsed = JSON.parse(packed.stdout || 'null');
  info = Array.isArray(parsed) ? parsed[0] : parsed;
} catch (error) {
  assertGate(false, 'runtime_script_pack_dry_run_unparseable', { error: String(error) });
}
assertGate(Boolean(info && Array.isArray(info.files)), 'runtime_script_pack_dry_run_missing_info');

const packedScripts = info.files
  .map((entry: any) => String(entry.path || ''))
  .filter((file: string) => file.startsWith('dist/scripts/') && file.endsWith('.js'))
  .sort();
assertGate(JSON.stringify(packedScripts) === JSON.stringify(analysis.closure), 'runtime_script_packed_closure_mismatch', {
  missing: analysis.closure.filter((file) => !packedScripts.includes(file)),
  unexpected: packedScripts.filter((file: string) => !analysis.closure.includes(file))
});
assertGate(Number(info.entryCount) <= MAX_FILES, 'runtime_script_pack_file_count_over_limit', { actual: info.entryCount, limit: MAX_FILES });
assertGate(Number(info.size) <= MAX_PACKED, 'runtime_script_pack_packed_bytes_over_limit', { actual: info.size, limit: MAX_PACKED });
assertGate(Number(info.unpackedSize) <= MAX_UNPACKED, 'runtime_script_pack_unpacked_bytes_over_limit', { actual: info.unpackedSize, limit: MAX_UNPACKED });

const report = {
  ...analysis,
  ok: true,
  generated_at: new Date().toISOString(),
  pack: {
    filename: info.filename,
    entry_count: info.entryCount,
    packed_bytes: info.size,
    unpacked_bytes: info.unpackedSize,
    max_files: MAX_FILES,
    max_packed_bytes: MAX_PACKED,
    max_unpacked_bytes: MAX_UNPACKED
  },
  blockers: []
};
const output = path.join(root, '.sneakoscope', 'reports', 'runtime-script-pack-closure.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
emitGate('publish:runtime-script-closure', {
  candidates: analysis.candidates.length,
  packed_scripts: analysis.closure.length,
  excluded_scripts: analysis.excluded.length,
  closure_sha256: analysis.closure_sha256,
  dynamic_reference_warnings: analysis.dynamic_reference_warnings.length
});
