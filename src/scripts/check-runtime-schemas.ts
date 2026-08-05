#!/usr/bin/env node
// @ts-nocheck
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const root = process.cwd();
const tsc = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'pipe'
});

const issues = [];
if (tsc.status !== 0) issues.push(`typecheck:${tsc.stderr || tsc.stdout}`.trim());

let validatorsOk = false;
try {
  const proof = await import(pathToFileURL(path.join(root, 'dist', 'core', 'proof', 'proof-schema.js')));
  const evidence = await import(pathToFileURL(path.join(root, 'dist', 'core', 'evidence', 'evidence-schema.js')));
  const voxel = await import(pathToFileURL(path.join(root, 'dist', 'core', 'wiki-image', 'image-voxel-schema.js')));
  const bridge = await import(pathToFileURL(path.join(root, 'dist', 'core', 'codex-lb', 'bridge-runtime-validation.js')));
  validatorsOk = proof.isCompletionProof({
    schema: 'sks.completion-proof.v1',
    mission_id: null,
    route: '$Naruto',
    status: 'verified_partial',
    evidence: {},
    claims: [],
    unverified: [],
    blockers: []
  }) && evidence.isEvidenceRecord({
    schema: 'sks.evidence.v1',
    id: 'EV-TEST',
    mission_id: null,
    kind: 'test',
    source: 'real',
    path: null,
    sha256: null,
    freshness: 'fresh',
    trust: 'high',
    redacted: true,
    issues: []
  }) && voxel.isImageVoxelLedger({
    schema: 'sks.image-voxel-ledger.v1',
    images: [],
    anchors: [],
    relations: []
  })
    && bridge.validateDesktopCapabilityReportV3({ schema: 'sks.desktop-capabilities.v3' }).ok === false
    && bridge.validateDesktopBridgeStatusV3({ schema: 'sks.desktop-bridge-status.v3' }).ok === false;
} catch (err) {
  issues.push(`validator_import:${err.message}`);
}
if (!validatorsOk) issues.push('validator_smoke_failed');

const codexSchemaDir = path.join(root, 'schemas', 'codex');
for (const file of [
  'ux-review-callout-extraction.schema.json',
  'image-ux-issue-ledger.schema.json',
  'completion-proof.schema.json',
  'wrongness-record.schema.json',
  'agent-result.schema.json',
  'computer-use-live-evidence.schema.json',
  'ppt-slide-issue-ledger.schema.json',
  'dfix-diagnosis.schema.json',
  'dfix-patch-plan.schema.json',
  'dfix-verification.schema.json',
  'all-feature-completion.schema.json',
  'non-recursive-pipeline-report.schema.json',
  'desktop-capabilities-v3.schema.json',
  'desktop-bridge-status-v3.schema.json'
]) {
  const full = path.join(codexSchemaDir, file);
  if (!fs.existsSync(full)) {
    issues.push(`codex_schema_missing:${file}`);
    continue;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (parsed.type !== 'object') issues.push(`codex_schema_root_type:${file}`);
  } catch (err) {
    issues.push(`codex_schema_invalid_json:${file}:${err.message}`);
  }
}

try {
  const external = JSON.parse(fs.readFileSync(path.join(codexSchemaDir, 'agent-result.schema.json'), 'utf8'));
  const runtime = await import(pathToFileURL(path.join(root, 'dist', 'core', 'agents', 'agent-output-validator.js')));
  const { $schema, $id, title, ...externalRuntimeShape } = external;
  if ($schema !== 'https://json-schema.org/draft/2020-12/schema') issues.push('agent_result_schema_draft_mismatch');
  if ($id !== 'https://sneakoscope.dev/schemas/codex/agent-result.schema.json') issues.push('agent_result_schema_id_mismatch');
  if (title !== 'SKS Native Agent Result') issues.push('agent_result_schema_title_mismatch');
  if (!isDeepStrictEqual(externalRuntimeShape, runtime.AGENT_RESULT_RUNTIME_SCHEMA)) {
    issues.push('agent_result_runtime_schema_parity_mismatch');
  }
} catch (err) {
  issues.push(`agent_result_runtime_schema_parity_error:${err.message}`);
}

const searchVisibilitySchemaDir = path.join(root, 'schemas', 'search-visibility');
for (const file of [
  'site-inventory.schema.json',
  'finding-ledger.schema.json',
  'gate.schema.json',
  'mutation-plan.schema.json',
  'verification-report.schema.json'
]) {
  const full = path.join(searchVisibilitySchemaDir, file);
  if (!fs.existsSync(full)) {
    issues.push(`search_visibility_schema_missing:${file}`);
    continue;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (parsed.type !== 'object' || !parsed.$id) issues.push(`search_visibility_schema_shape:${file}`);
  } catch (err) {
    issues.push(`search_visibility_schema_invalid_json:${file}:${err.message}`);
  }
}

const result = { schema: 'sks.runtime-schema-check.v1', ok: issues.length === 0, validators_ok: validatorsOk, issues };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
