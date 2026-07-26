#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const mod = await importDist('core/super-search/index.js');
const missionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-super-search-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => new Response(
  `Verified provider-interface fixture content for ${url}. This body is long enough to prove hydrated source handling without relying on external network availability or a discovery snippet.`,
  { status: 200, headers: { 'content-type': 'text/plain' } }
);
try {
  const result = await mod.runSuperSearch({
    missionDir,
    query: 'Node.js package and npm registry docs',
    mode: 'balanced',
    context7: async () => [{
      title: 'Node.js package documentation',
      url: 'https://nodejs.org/api/packages.html',
      snippet: 'official package docs',
      content: 'Verified Context7 documentation content for Node.js package behavior. This materialized source is intentionally meaningful and independent from the npm registry source used by the web adapter.'
    }],
    codexWebSearch: async () => [{ title: 'npm registry', url: 'https://www.npmjs.com/package/npm', snippet: 'registry result' }],
    env: { SKS_CODEX_WEB_SEARCH_AVAILABLE: '1' }
  });

  assertGate(result.proof.provider_independent === true, 'Super-Search proof must be provider-independent', result.proof);
  assertGate(result.proof.xai_runtime_dependency === false, 'Super-Search must not require xAI runtime', result.proof);
  assertGate(result.sources.some((source) => source.acquisition_verdict === 'verified_content'), 'Super-Search must normalize verified source evidence', result.sources);
  assertGate(result.convergence.schema === 'sks.super-search-convergence.v1', 'Super-Search convergence artifact must be typed', result.convergence);
  emitGate('super-search:provider-interface', {
    mode: result.mode,
    sources: result.sources.length,
    verified: result.proof.verified_source_count,
    xai_runtime_dependency: result.proof.xai_runtime_dependency
  });
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(missionDir, { recursive: true, force: true });
}
