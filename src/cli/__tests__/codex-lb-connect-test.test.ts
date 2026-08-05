import '../../core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run as runCodexLbCommand } from '../../commands/codex-lb.js';
import { testCodexLbConnection } from '../install-helpers-codex-lb-chain.js';
import { upsertCodexLbCliProviderConfig } from '../install-helpers-codex-lb-config.js';

const API_KEY = 'sk-codex-lb-connect-test-not-real';
const MODEL = 'gpt-5.6-sol';

async function localResponsesServer(
  t: test.TestContext,
  responseBody: Record<string, unknown>
) {
  let requests = 0;
  let requestBody: any = null;
  let requestHeaders: http.IncomingHttpHeaders | null = null;
  const server = http.createServer((request, response) => {
    requests += 1;
    requestHeaders = request.headers;
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/backend-api/codex`,
    requests: () => requests,
    body: () => requestBody,
    headers: () => requestHeaders
  };
}

function readyStatus(baseUrl: string) {
  return {
    base_url: baseUrl,
    provider_contract_ok: true,
    provider_base_url_matches_credential: true
  };
}

test('connect test sends exactly one bounded, non-stored Responses request and returns bounded evidence', async (t) => {
  const fixture = await localResponsesServer(t, {
    id: 'resp_connect_ok',
    status: 'completed',
    model: MODEL,
    error: null,
    output: [{
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'OK' }]
    }],
    usage: {
      input_tokens: 4,
      output_tokens: 3,
      total_tokens: 7,
      output_tokens_details: { reasoning_tokens: 1 }
    }
  });

  const result = await testCodexLbConnection(readyStatus(fixture.baseUrl), {
    baseUrl: fixture.baseUrl,
    apiKey: API_KEY,
    model: MODEL,
    timeoutMs: 1000
  });

  assert.equal(fixture.requests(), 1);
  assert.deepEqual(fixture.body(), {
    model: MODEL,
    input: 'Reply OK.',
    store: false,
    reasoning: { effort: 'low' },
    max_output_tokens: 32
  });
  assert.equal('tools' in fixture.body(), false);
  assert.equal('previous_response_id' in fixture.body(), false);
  assert.equal(fixture.headers()?.authorization, `Bearer ${API_KEY}`);
  assert.equal(fixture.headers()?.['x-codex-lb-api-key'], undefined);
  assert.deepEqual(result, {
    schema: 'sks.codex-lb-connect-test.v1',
    ok: true,
    status: 'connected',
    response_id: 'resp_connect_ok',
    model: MODEL,
    latency_ms: result.latency_ms,
    usage: {
      input_tokens: 4,
      output_tokens: 3,
      total_tokens: 7,
      reasoning_tokens: 1
    },
    result: 'OK',
    result_truncated: false,
    http_status: 200,
    blockers: []
  });
  assert.ok(Number.isInteger(result.latency_ms) && result.latency_ms >= 0);
});

test('connect test consumes the completed response from the real SSE envelope shape', async () => {
  let requests = 0;
  const completed = {
    id: 'resp_connect_sse',
    status: 'completed',
    model: MODEL,
    error: null,
    output: [],
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
  };
  const sse = [
    `data: ${JSON.stringify({ type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } })}`,
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' })}`,
    `data: ${JSON.stringify({ type: 'response.output_text.done', text: 'OK' })}`,
    `data: ${JSON.stringify({ type: 'response.completed', response: completed })}`,
    'data: [DONE]',
    ''
  ].join('\n');

  const result = await testCodexLbConnection(readyStatus('https://lb.example.test/backend-api/codex'), {
    baseUrl: 'https://lb.example.test/backend-api/codex',
    apiKey: API_KEY,
    model: MODEL,
    timeoutMs: 1000,
    fetch: async () => {
      requests += 1;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  });

  assert.equal(requests, 1);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'connected');
  assert.equal(result.response_id, 'resp_connect_sse');
  assert.equal(result.result, 'OK');
  assert.equal(result.usage.total_tokens, 7);
});

test('connect test fails closed after one request when the completed response text is empty', async (t) => {
  const fixture = await localResponsesServer(t, {
    id: 'resp_connect_empty',
    status: 'completed',
    model: MODEL,
    error: null,
    output: [{
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: '   ' }]
    }],
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
  });

  const result = await testCodexLbConnection(readyStatus(fixture.baseUrl), {
    baseUrl: fixture.baseUrl,
    apiKey: API_KEY,
    model: MODEL,
    timeoutMs: 1000
  });

  assert.equal(fixture.requests(), 1);
  assert.equal(result.schema, 'sks.codex-lb-connect-test.v1');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'empty_result');
  assert.equal(result.result, null);
});

test('connect test makes no request when credential binding has drifted', async () => {
  let requests = 0;
  const result = await testCodexLbConnection({
    provider_contract_ok: true,
    provider_base_url_matches_credential: true,
    base_url: 'https://lb.example.test/backend-api/codex'
  }, {
    apiKey: API_KEY,
    model: MODEL,
    credentialBindingBlockers: ['codex_lb_credential_key_fingerprint_mismatch'],
    fetch: async () => {
      requests += 1;
      throw new Error('must not request with drifted credentials');
    }
  });

  assert.equal(requests, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'credential_binding_drift');
  assert.deepEqual(result.blockers, ['codex_lb_credential_key_fingerprint_mismatch']);
});

test('connect test makes no request when the CLI provider is not selected', async () => {
  let requests = 0;
  const result = await testCodexLbConnection({
    ...readyStatus('https://lb.example.test/backend-api/codex'),
    provider: { selected: false }
  }, {
    apiKey: API_KEY,
    model: MODEL,
    requireSelected: true,
    fetch: async () => {
      requests += 1;
      throw new Error('must not request before provider selection');
    }
  });

  assert.equal(requests, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'provider_unselected');
  assert.deepEqual(result.blockers, ['codex_lb_provider_not_selected']);
});

test('codex-lb connect-test command returns the schema and sets a nonzero exit code on failure', async (t) => {
  const fixture = await localResponsesServer(t, {
    id: 'resp_connect_command_empty',
    status: 'completed',
    model: MODEL,
    error: null,
    output: [{ type: 'message', status: 'completed', content: [] }],
    usage: { input_tokens: 4, output_tokens: 0, total_tokens: 4 }
  });
  const codexHome = path.join(String(process.env.HOME), '.codex');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(
    path.join(codexHome, 'config.toml'),
    upsertCodexLbCliProviderConfig(`model = ${JSON.stringify(MODEL)}\n`, {
      remoteBaseUrl: fixture.baseUrl,
      selectGlobally: true
    })
  );
  await fsp.writeFile(
    path.join(codexHome, 'sks-codex-lb.env'),
    `export CODEX_LB_BASE_URL=${JSON.stringify(fixture.baseUrl)}\nexport CODEX_LB_API_KEY=${JSON.stringify(API_KEY)}\n`,
    { mode: 0o600 }
  );

  const priorExitCode = process.exitCode;
  const priorConsoleLog = console.log;
  const output: string[] = [];
  console.log = (...values: any[]) => output.push(values.join(' '));
  t.after(() => {
    console.log = priorConsoleLog;
    process.exitCode = priorExitCode;
  });

  process.exitCode = undefined;
  await runCodexLbCommand('codex-lb', ['connect-test', '--json']);

  assert.equal(fixture.requests(), 1);
  assert.equal(process.exitCode, 1);
  const result = JSON.parse(output.join('\n'));
  assert.equal(result.schema, 'sks.codex-lb-connect-test.v1');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'empty_result');
});

test('codex-lb connect-test command selects a model from the official Codex cache', async (t) => {
  const fixture = await localResponsesServer(t, {
    id: 'resp_connect_cached_model',
    status: 'completed',
    model: MODEL,
    error: null,
    output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] }],
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
  });
  const codexHome = path.join(String(process.env.HOME), '.codex');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(
    path.join(codexHome, 'config.toml'),
    upsertCodexLbCliProviderConfig('', {
      remoteBaseUrl: fixture.baseUrl,
      selectGlobally: true
    })
  );
  await fsp.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'not-api-capable', supported_in_api: false, priority: 0 },
      { slug: MODEL, supported_in_api: true, priority: 1 }
    ]
  }));
  await fsp.writeFile(
    path.join(codexHome, 'sks-codex-lb.env'),
    `export CODEX_LB_BASE_URL=${JSON.stringify(fixture.baseUrl)}\nexport CODEX_LB_API_KEY=${JSON.stringify(API_KEY)}\n`,
    { mode: 0o600 }
  );

  const priorExitCode = process.exitCode;
  const priorConsoleLog = console.log;
  const output: string[] = [];
  console.log = (...values: any[]) => output.push(values.join(' '));
  t.after(() => {
    console.log = priorConsoleLog;
    process.exitCode = priorExitCode;
  });

  process.exitCode = undefined;
  await runCodexLbCommand('codex-lb', ['connect-test', '--json']);

  assert.equal(fixture.requests(), 1);
  assert.equal(process.exitCode, undefined);
  const result = JSON.parse(output.join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.status, 'connected');
  assert.equal(result.model, MODEL);
  assert.equal(result.result, 'OK');
});

test('codex-lb connect-test command honors an explicit bearer compatibility override', async (t) => {
  const fixture = await localResponsesServer(t, {
    id: 'resp_connect_explicit_bearer',
    status: 'completed',
    model: MODEL,
    error: null,
    output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] }],
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
  });
  const codexHome = path.join(String(process.env.HOME), '.codex');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(
    path.join(codexHome, 'config.toml'),
    upsertCodexLbCliProviderConfig(`model = ${JSON.stringify(MODEL)}\n`, {
      remoteBaseUrl: fixture.baseUrl,
      selectGlobally: true
    })
  );
  await fsp.writeFile(
    path.join(codexHome, 'sks-codex-lb.env'),
    `export CODEX_LB_BASE_URL=${JSON.stringify(fixture.baseUrl)}\nexport CODEX_LB_API_KEY=${JSON.stringify(API_KEY)}\n`,
    { mode: 0o600 }
  );

  const priorExitCode = process.exitCode;
  const priorConsoleLog = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = priorConsoleLog;
    process.exitCode = priorExitCode;
  });

  process.exitCode = undefined;
  await runCodexLbCommand('codex-lb', ['connect-test', '--compat-bearer', '--json']);

  assert.equal(process.exitCode, undefined);
  assert.equal(fixture.requests(), 1);
  assert.equal(fixture.headers()?.authorization, `Bearer ${API_KEY}`);
  assert.equal(fixture.headers()?.['x-codex-lb-api-key'], undefined);
});

test('codex-lb connect-test command honors the bearer transport stored by Center setup', async (t) => {
  const fixture = await localResponsesServer(t, {
    id: 'resp_connect_stored_bearer',
    status: 'completed',
    model: MODEL,
    error: null,
    output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] }],
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
  });
  const codexHome = path.join(String(process.env.HOME), '.codex');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(
    path.join(codexHome, 'config.toml'),
    upsertCodexLbCliProviderConfig(`model = ${JSON.stringify(MODEL)}\n`, {
      remoteBaseUrl: fixture.baseUrl,
      selectGlobally: true
    })
  );
  await fsp.writeFile(
    path.join(codexHome, 'sks-codex-lb.env'),
    `export CODEX_LB_BASE_URL=${JSON.stringify(fixture.baseUrl)}\nexport CODEX_LB_API_KEY=${JSON.stringify(API_KEY)}\n`,
    { mode: 0o600 }
  );
  await fsp.writeFile(
    path.join(codexHome, 'sks-codex-lb.json'),
    JSON.stringify({
      schema: 'sks.codex-lb-metadata.v1',
      base_url: fixture.baseUrl,
      gateway_auth_transport: 'authorization-bearer-compat',
      api_key: {
        redacted: true,
        sha256: createHash('sha256').update(API_KEY).digest('hex')
      }
    }),
    { mode: 0o600 }
  );

  const priorExitCode = process.exitCode;
  const priorConsoleLog = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = priorConsoleLog;
    process.exitCode = priorExitCode;
  });

  process.exitCode = undefined;
  await runCodexLbCommand('codex-lb', ['connect-test', '--json']);

  assert.equal(process.exitCode, undefined);
  assert.equal(fixture.requests(), 1);
  assert.equal(fixture.headers()?.authorization, `Bearer ${API_KEY}`);
  assert.equal(fixture.headers()?.['x-codex-lb-api-key'], undefined);
});

test('codex-lb connect-test command rejects an invalid stored transport before any request', async (t) => {
  const fixture = await localResponsesServer(t, {
    id: 'resp_connect_invalid_transport',
    status: 'completed',
    model: MODEL,
    error: null,
    output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] }],
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
  });
  const codexHome = path.join(String(process.env.HOME), '.codex');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(
    path.join(codexHome, 'config.toml'),
    upsertCodexLbCliProviderConfig(`model = ${JSON.stringify(MODEL)}\n`, {
      remoteBaseUrl: fixture.baseUrl,
      selectGlobally: true
    })
  );
  await fsp.writeFile(
    path.join(codexHome, 'sks-codex-lb.env'),
    `export CODEX_LB_BASE_URL=${JSON.stringify(fixture.baseUrl)}\nexport CODEX_LB_API_KEY=${JSON.stringify(API_KEY)}\n`,
    { mode: 0o600 }
  );
  await fsp.writeFile(
    path.join(codexHome, 'sks-codex-lb.json'),
    JSON.stringify({
      schema: 'sks.codex-lb-metadata.v1',
      base_url: fixture.baseUrl,
      gateway_auth_transport: 'unsupported-transport',
      api_key: {
        redacted: true,
        sha256: createHash('sha256').update(API_KEY).digest('hex')
      }
    }),
    { mode: 0o600 }
  );

  const output: string[] = [];
  const priorExitCode = process.exitCode;
  const priorConsoleLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(' '));
  t.after(() => {
    console.log = priorConsoleLog;
    process.exitCode = priorExitCode;
  });

  process.exitCode = undefined;
  await runCodexLbCommand('codex-lb', ['connect-test', '--json']);

  assert.equal(fixture.requests(), 0);
  assert.equal(process.exitCode, 1);
  const result = JSON.parse(output.join('\n'));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'credential_binding_drift');
  assert.deepEqual(result.blockers, ['codex_lb_credential_metadata_invalid']);
});
