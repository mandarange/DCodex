import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createResponsesTransport } from '../../dist/core/agent-bridge/responses-transport.js';
import { runResponsesAsync } from '../../dist/core/agent-bridge/responses-async-runner.js';

const call = { type: 'function_call', status: 'completed', call_id: 'original-call', name: 'lookup', arguments: '{}', async: true };
const message = { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'actual 917' }] };
const done = item => ({ type: 'response.output_item.done', output_index: 0, item });
const completed = (id, output = []) => ({ type: 'response.completed', response: { id, status: 'completed', output } });
const tool = execute => ({ name: 'lookup', description: 'Fixture lookup', parameters: { type: 'object', properties: {} }, execute });

async function fixture(t, { onHttp, onWs, rejectUpgrade } = {}) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!onHttp) { res.writeHead(500).end(); return; }
    const events = onHttp(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (rejectUpgrade) { socket.end(`HTTP/1.1 ${rejectUpgrade} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    wss.handleUpgrade(req, socket, head, ws => onWs(ws, req));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const transport = createResponsesTransport({
    endpoint: `http://127.0.0.1:${server.address().port}/responses`, upstreamModel: 'gpt-6-astra',
    headers: { 'x-sks-model': 'codex-lb:gpt-6-astra' }, handshakeTimeoutMs: 500,
  });
  t.after(async () => {
    transport.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return transport;
}

const run = (transport, execute = async () => '917', extra = {}) => runResponsesAsync({
  model: 'codex-lb:gpt-6-astra', prompt: 'Look up the real value', tools: [tool(execute)],
  timeoutMs: 1500, request: transport.request, ...extra,
});

test('WS reuses one connection and sends original call output with incremental continuation', async t => {
  const bodies = [];
  const transport = await fixture(t, { onWs(ws, req) {
    assert.equal(req.headers['x-sks-model'], 'codex-lb:gpt-6-astra');
    ws.on('message', raw => {
      const body = JSON.parse(raw); bodies.push(body);
      const events = bodies.length === 1 ? [done(call), completed('resp_1', [call])] : [done(message), completed('resp_2', [message])];
      for (const event of events) ws.send(JSON.stringify(event));
    });
  } });
  const result = await run(transport);
  assert.equal(result.ok, true);
  assert.equal(result.final_text, 'actual 917');
  assert.equal(bodies[0].model, 'gpt-6-astra');
  assert.equal(bodies[0].type, 'response.create');
  assert.equal(bodies[0].stream, undefined);
  assert.equal(bodies[0].tools[0].async, true);
  assert.equal(bodies[1].previous_response_id, 'resp_1');
  assert.deepEqual(bodies[1].input, [{ type: 'function_call_output', call_id: 'original-call', output: '917' }]);
  assert.equal(transport.report.websocket_connections, 1);
  assert.equal(transport.report.websocket_requests, 2);
  assert.equal(transport.report.incremental_continuations, 1);
  assert.equal(transport.report.http_requests, 0);
});

test('rejected WS upgrade uses HTTP with full context and no duplicate tool execution', async t => {
  let requests = 0; let executions = 0;
  const transport = await fixture(t, { rejectUpgrade: 503, onHttp(body) {
    requests++;
    assert.equal(body.model, 'codex-lb:gpt-6-astra');
    assert.equal(body.previous_response_id, undefined);
    if (requests === 1) return [done(call), completed('http_1', [call])];
    assert.equal(body.input[0].content, 'Look up the real value');
    assert.equal(body.input.at(-1).call_id, 'original-call');
    return [done(message), completed('http_2')];
  } });
  assert.equal((await run(transport, async () => { executions++; return '917'; })).ok, true);
  assert.equal(executions, 1);
  assert.equal(transport.report.fallback_reason, 'websocket_upgrade_503');
  assert.equal(transport.report.http_requests, 2);
});

test('closure between completed responses recovers over HTTP using full history', async t => {
  let released; const closed = new Promise(resolve => { released = resolve; });
  let executions = 0;
  const transport = await fixture(t, { onWs(ws) {
    ws.once('close', released);
    ws.once('message', () => {
      ws.send(JSON.stringify(done(call))); ws.send(JSON.stringify(completed('ws_1', [call]))); ws.close();
    });
  }, onHttp(body) {
    assert.equal(body.previous_response_id, undefined);
    assert.deepEqual(body.input, [{ role: 'user', content: 'Look up the real value' }, call, { type: 'function_call_output', call_id: 'original-call', output: '917' }]);
    return [done(message), completed('http_2')];
  } });
  const result = await run(transport, async () => { executions++; await closed; return '917'; });
  assert.equal(result.ok, true);
  assert.equal(executions, 1);
  assert.equal(transport.report.websocket_requests, 1);
  assert.equal(transport.report.http_requests, 1);
});

test('interruption after send fails visibly without replaying the model request or tool', async t => {
  let executions = 0;
  const transport = await fixture(t, { onWs(ws) {
    ws.once('message', () => { ws.send(JSON.stringify(done(call))); setTimeout(() => ws.terminate(), 20); });
  } });
  const result = await run(transport, async () => { executions++; return '917'; });
  assert.equal(result.ok, false);
  assert.equal(executions, 1);
  assert.equal(transport.report.http_requests, 0);
  assert.equal(transport.report.failure, 'websocket_interrupted_after_send');
});

test('WS cancellation drains tools and never falls back', async t => {
  let settled = false;
  const transport = await fixture(t, { onWs(ws) { ws.once('message', () => ws.send(JSON.stringify(done(call)))); } });
  const result = await run(transport, async (_, { signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    settled = true; return 'cancelled';
  }, { timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(settled, true);
  assert.equal(transport.report.http_requests, 0);
  assert.equal(transport.report.failure, 'transport_cancelled');
});

test('authentication rejection is surfaced without HTTP fallback', async t => {
  const transport = await fixture(t, { rejectUpgrade: 401 });
  const result = await run(transport);
  assert.equal(result.ok, false);
  assert.equal(transport.report.failure, 'websocket_upgrade_401');
  assert.equal(transport.report.http_requests, 0);
});
