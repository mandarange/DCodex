// @ts-nocheck
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot } from './skill-fixture-check-lib.js';
import { importDist } from './gate-lib.js';

const tmp = await makeTempRoot('sks-triwiki-affected-');
await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ scripts: { 'triwiki:affected-graph': 'node fixture.js' } }));
await fs.writeFile(path.join(tmp, 'release-gates.v2.json'), JSON.stringify({
  schema: 'sks.release-gates.v2',
  gates: [{
    id: 'triwiki:affected-graph',
    command: 'npm run triwiki:affected-graph --silent',
    deps: [],
    resource: ['cpu-light'],
    side_effect: 'hermetic',
    timeout_ms: 1000,
    output_contract: 'sks.gate-result.v2',
    cache: { enabled: true, inputs: ['src/core/triwiki/**'] },
    isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
    preset: ['release']
  }]
}, null, 2));
await fs.mkdir(path.join(tmp, 'src/core/triwiki'), { recursive: true });
await fs.writeFile(path.join(tmp, 'src/core/triwiki/a.ts'), 'export const a = 1;\n');
const mod = await importDist('core/triwiki/triwiki-affected-graph.js');
const graph = mod.computeTriWikiAffectedGraph({ root: tmp, changedFiles: ['src/core/triwiki/a.ts'], tier: 'affected' });
assertGate(graph.gates.includes('triwiki:affected-graph'), 'blackbox affected graph must select changed gate', graph);
emitGate('triwiki:affected-graph-blackbox', { gates: graph.gates });
