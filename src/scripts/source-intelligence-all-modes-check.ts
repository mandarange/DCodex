#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/source-intelligence/source-intelligence-runner.js');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-source-intelligence-'));
const common = {
  missionDir: dir,
  route: '$Research',
  context7: async () => [{ title: 'docs', url: 'https://docs.example.com' }],
  codexWebSearch: async () => [{ title: 'web', url: 'https://example.com' }],
  env: { SKS_CODEX_WEB_SEARCH_AVAILABLE: '1' }
};
const balanced = await mod.runSourceIntelligence({ ...common, query: 'npm package docs' });
const xSearch = await mod.runSourceIntelligence({ ...common, query: 'site:x.com product launch', xaiDetection: { configured: true, search_capable: true } });
assertGate(balanced.ok === true && balanced.mode === 'super_balanced', 'balanced Super-Search mode must pass with provider-independent proof', balanced);
assertGate(xSearch.ok === false && xSearch.mode === 'x_search' && xSearch.blockers.includes('x_search_parity_not_proven'), 'X mode must not treat discovery-only public X evidence as parity', xSearch);
assertGate(xSearch.parallel.providers_requested.includes('x_public'), 'X public provider must be capability-selected', xSearch.parallel);
emitGate('source-intelligence:all-modes', { modes: [balanced.mode, xSearch.mode], x_parity_claim: 'not_proven_without_real_corpus' });
