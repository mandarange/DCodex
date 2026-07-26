#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/pipeline-internals/runtime-core.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context7-evidence-'));
const missionId = 'M-context7-dedupe';
const missionDir = path.join(root, '.sneakoscope', 'missions', missionId);
await fs.mkdir(missionDir, { recursive: true });
const state = { mission_id: missionId };

const falsePositive = await mod.recordContext7Evidence(root, state, {
  tool_name: 'update_plan',
  tool_response: 'This ordinary planning output mentions Context7 resolve-library-id and query-docs.'
});
assertGate(falsePositive === null, 'ordinary tool output must not be recorded as Context7 evidence', falsePositive);

await mod.recordContext7Evidence(root, state, {
  tool_name: 'resolve-library-id',
  source: 'sks context7 evidence',
  library: 'react',
  library_id: '/react/react'
});
await mod.recordContext7Evidence(root, state, {
  tool_name: 'resolve-library-id',
  source: 'sks context7 evidence',
  library: 'react',
  library_id: '/react/react'
});
await mod.recordContext7Evidence(root, state, {
  tool_name: 'query-docs',
  source: 'sks context7 evidence',
  library_id: '/react/react',
  tool_input: { libraryId: '/react/react', query: 'hooks' }
});
await mod.recordContext7Evidence(root, state, {
  tool_name: 'query-docs',
  source: 'sks context7 evidence',
  library_id: '/react/react',
  tool_input: { libraryId: '/react/react', query: 'hooks' }
});
await mod.recordContext7Evidence(root, state, {
  tool_name: 'query-docs',
  source: 'sks context7 evidence',
  library_id: '/react/react',
  tool_input: { libraryId: '/react/react', query: 'server components' }
});

const evidenceFile = path.join(missionDir, 'context7-evidence.jsonl');
const lines = (await fs.readFile(evidenceFile, 'utf8')).split(/\n/).filter(Boolean);
const evidence = await mod.context7Evidence(root, state);
assertGate(lines.length === 3, 'duplicate Context7 evidence records must be collapsed without merging distinct queries', { lines });
assertGate(evidence.ok === true && evidence.resolve === true && evidence.docs === true && evidence.count === 3, 'deduped Context7 evidence must still satisfy docs gate', evidence);

emitGate('context7:evidence-dedupe', { records: lines.length, evidence });
