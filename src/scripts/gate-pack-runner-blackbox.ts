// @ts-nocheck
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot } from './skill-fixture-check-lib.js';
import { importDist } from './gate-lib.js';

const tmp = await makeTempRoot('sks-gate-pack-');
await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ version: '4.0.0', scripts: { 'triwiki:proof-card': 'node -e "process.exit(0)"' } }, null, 2));
await fs.writeFile(path.join(tmp, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
await fs.writeFile(path.join(tmp, 'release-gates.v2.json'), JSON.stringify({
  schema: 'sks.release-gates.v2',
  gates: [{
    id: 'triwiki:proof-card',
    command: 'npm run triwiki:proof-card --silent',
    deps: [],
    resource: ['cpu-light'],
    side_effect: 'hermetic',
    timeout_ms: 1000,
    cache: { enabled: true, inputs: ['package.json'] },
    isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
    preset: ['release']
  }]
}, null, 2));
const runner = await importDist('core/release/gate-pack-runner.js');
const report = await runner.executeGatePack({ root: tmp, packId: 'triwiki', mode: 'execute' });
assertGate(report.ok === true && report.executed === 1 && report.proof_paths.length >= 2, 'gate pack blackbox must execute and write gate plus pack proof', report);
emitGate('gate-pack:runner-blackbox', { executed: report.executed, proofs: report.proof_paths.length });
