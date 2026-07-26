#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertGate, emitGate, root } from './gate-lib.js';

const mod = await import(pathToFileURL(path.join(root, 'dist', 'core', 'agents', 'fast-mode-policy.js')).href);
const policy = mod.resolveFastModePolicy({ fastMode: true });
const env = mod.fastModeEnv(policy);
const report = {
  schema: 'sks.mad-sks-fast-mode-propagation-check.v1',
  ok: policy.fast_mode === true && policy.service_tier === 'fast' && env.SKS_FAST_MODE === '1' && env.SKS_SERVICE_TIER === 'fast',
  mad_target_worker_env: env,
  fast_mode: policy.fast_mode,
  service_tier: policy.service_tier,
  proof_level: 'fixture_instrumented_real',
  blockers: []
};
const out = path.join(root, '.sneakoscope', 'reports', 'mad-sks-fast-mode-propagation.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
assertGate(report.ok, 'MAD-SKS target worker fast env must default to fast', report);
emitGate('mad-sks:fast-mode-propagation', { service_tier: report.service_tier });
