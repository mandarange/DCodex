#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const budgetMs = Number(process.env.SKS_HOOK_LATENCY_BUDGET_MS || 25);
const readBudget = Number(process.env.SKS_HOOK_LATENCY_READ_BUDGET || 3);
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hook-latency-'));
await fsp.mkdir(path.join(root, '.sneakoscope', 'state'), { recursive: true });

let readCount = 0;
const originalReadFile = fsp.readFile.bind(fsp);
fsp.readFile = async function patchedReadFile(file, ...rest) {
  if (String(file).includes('.sneakoscope')) readCount += 1;
  return originalReadFile(file, ...rest);
};

try {
  const { evaluateStop } = await importDist('core/pipeline-internals/runtime-gates.js');
  const started = performance.now();
  const decision = await evaluateStop(root, {
    mission_id: 'M-light',
    mode: 'ANSWER',
    route: 'Answer',
    route_command: '$Answer',
    stop_gate: 'none',
    reflection_required: false,
    proof_required: false,
    agents_required: false,
    context7_required: false,
    subagents_required: false
  }, { message: 'done' });
  const elapsed = performance.now() - started;
  assertGate(decision === null, 'light stop route must early-exit without a block decision', { decision });
  assertGate(elapsed <= budgetMs, 'light stop route exceeded latency budget', { elapsed_ms: elapsed, budget_ms: budgetMs, read_count: readCount });
  assertGate(readCount <= readBudget, 'light stop route exceeded .sneakoscope read budget', { read_count: readCount, read_budget: readBudget, elapsed_ms: elapsed });
  emitGate('hook:latency-budget', { elapsed_ms: Math.round(elapsed * 100) / 100, read_count: readCount, budget_ms: budgetMs, read_budget: readBudget });
} finally {
  fsp.readFile = originalReadFile;
  fs.rmSync(root, { recursive: true, force: true });
}
