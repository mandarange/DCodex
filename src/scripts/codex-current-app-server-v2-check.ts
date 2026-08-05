#!/usr/bin/env node
import { assertGate, emitGate, readText } from './gate-lib.js';
import { createCodexAppServerV2Client, currentTimeResponse } from '../core/codex-control/codex-app-server-v2-client.js';
import { CURRENT_CODEX_RELEASE_MANIFEST } from '../core/codex-compat/codex-release-manifest.js';

const requireReal = process.argv.includes('--require-real') || process.env.SKS_REQUIRE_CODEX_CURRENT_APP_SERVER === '1';
const clientSource = readText('src/core/codex-control/codex-app-server-v2-client.ts');
const schema = readText('schemas/codex/app-server-0.146/codex_app_server_protocol.v2.schemas.json');

assertGate(clientSource.includes('resolveCodexRuntime'), 'app-server-v2 client must use the shared Codex runtime resolver');
assertGate(clientSource.includes('currentTime/read'), 'app-server-v2 client must implement currentTime/read server request handling');
assertGate(clientSource.includes("request('thread/list'"), 'app-server-v2 client must wrap native thread/list');
assertGate(clientSource.includes("request('thread/read'"), 'app-server-v2 client must wrap native thread/read');
assertGate(clientSource.includes('searchThreads'), 'app-server-v2 client must expose search over native thread list searchTerm');
assertGate(schema.includes('"thread/list"'), 'generated 0.146.0 schema must contain thread/list');
assertGate(schema.includes('"thread/read"'), 'generated 0.146.0 schema must contain thread/read');
assertGate(schema.includes('"searchTerm"'), 'generated 0.146.0 schema must contain ThreadListParams.searchTerm');
assertGate(schema.includes('"ThreadSearchResult"'), 'generated 0.146.0 schema must contain ThreadSearchResult');

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
      runtimeIdentity.version === CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion,
      `app-server-v2 require-real must resolve Codex ${CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion}`,
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
  thread_search_method: schema.includes('"thread/search"'),
  thread_search_via_list_search_term: true,
  real_probe: realProbe
});
