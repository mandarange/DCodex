#!/usr/bin/env node
import { assertGate, emitGate, readText } from './gate-lib.js';
import { createCodexAppServerV2Client, currentTimeResponse } from '../core/codex-control/codex-app-server-v2-client.js';
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../core/codex-compat/codex-runtime-contract.js';
import { detectCodexCurrentCapability } from '../core/codex-control/codex-current-capability.js';

const requireReal = process.argv.includes('--require-real') || process.env.SKS_REQUIRE_CODEX_CURRENT_APP_SERVER === '1';
const clientSource = readText('src/core/codex-control/codex-app-server-v2-client.ts');
const capability = await detectCodexCurrentCapability({ root: process.cwd(), requireReal: true });

assertGate(clientSource.includes('resolveCodexRuntime'), 'app-server-v2 client must use the shared Codex runtime resolver');
assertGate(clientSource.includes('currentTime/read'), 'app-server-v2 client must implement currentTime/read server request handling');
assertGate(clientSource.includes("request('thread/list'"), 'app-server-v2 client must wrap native thread/list');
assertGate(clientSource.includes("request('thread/read'"), 'app-server-v2 client must wrap native thread/read');
assertGate(clientSource.includes('searchThreads'), 'app-server-v2 client must expose search over native thread list searchTerm');
assertGate(capability.ok, 'resolved Codex runtime must generate a compatible App Server schema', capability);
assertGate(capability.probe_mode === 'real-schema', 'App Server compatibility must use runtime-generated schema evidence', capability);
assertGate(capability.feature_states.native_thread_list_search_schema.supported, 'runtime schema must expose thread list/read/search', capability);
assertGate(capability.feature_states.plugin_catalog_refresh_schema.supported, 'runtime schema must expose portable plugin catalog operations', capability);

const deterministic = currentTimeResponse(new Date('2026-06-23T00:00:00.000Z'));
assertGate(deterministic.utcIso === '2026-06-23T00:00:00.000Z', 'currentTime/read UTC ISO must be deterministic');
assertGate(deterministic.unixTimeSeconds === 1782172800, 'currentTime/read seconds must be Unix UTC seconds');
assertGate(deterministic.timezone === 'UTC', 'currentTime/read canonical timezone must be UTC');

let realProbe: Record<string, unknown> | null = null;
if (requireReal) {
  const { client, runtimeIdentity } = await createCodexAppServerV2Client({ requestedBy: 'codex-current-app-server-v2-check' });
  try {
    await client.initialize();
    const list = await client.listThreads({ limit: 1, useStateDbOnly: true });
    realProbe = {
      runtime_version: runtimeIdentity.version,
      runtime_sha256: runtimeIdentity.sha256,
      list_returned_object: Boolean(list && typeof list === 'object')
    };
    assertGate(
      runtimeIdentity.version === CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion,
      `app-server-v2 require-real must resolve Codex ${CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion}`,
      realProbe
    );
    assertGate(realProbe.list_returned_object === true, 'app-server-v2 require-real thread/list must return an object', realProbe);
  } finally {
    await client.close();
  }
}

emitGate('codex:current:app-server-v2', {
  current_time_handler: true,
  thread_list: true,
  thread_read: true,
  generated_schema_sha256: capability.generated_schema_sha256,
  thread_search_via_list_search_term: true,
  real_probe: realProbe
});
