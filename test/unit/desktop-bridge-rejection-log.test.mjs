import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDesktopBridgeRejectionLogger,
  REJECTION_LOG_BURST
} from '../../dist/core/codex-lb/desktop-bridge/rejection-log.js';

function collector(now = () => 1_000) {
  const lines = [];
  const log = createDesktopBridgeRejectionLogger({ write: (line) => lines.push(line), now });
  return { lines, log, parsed: () => lines.map((line) => JSON.parse(line)) };
}

test('a rejected request is recorded at all', () => {
  // The bridge emitted exactly one line in its lifetime — `started` — so a
  // bridge refusing every request looked identical in the logs to a healthy one.
  const { log, parsed } = collector();
  log({ code: 'bridge_codex_session_identity_mismatch', transport: 'http', method: 'POST', url: '/backend-api/codex/responses', status: 409 });
  const rows = parsed();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].schema, 'sks.desktop-bridge-log.v2');
  assert.equal(rows[0].event, 'sks.desktop_bridge.rejected');
  assert.equal(rows[0].code, 'bridge_codex_session_identity_mismatch');
  assert.equal(rows[0].transport, 'http');
  assert.equal(rows[0].method, 'POST');
  assert.equal(rows[0].status, 409);
  assert.equal(rows[0].secret_fields_redacted, true);
});

test('no secret-bearing field is ever written', () => {
  const { log, lines } = collector();
  const capability = 'RsDe39ykmLBbmTeps_QiFtB8QZJuUfiSVQoUZX3exFM';
  log({
    code: 'bridge_origin_forbidden',
    transport: 'http',
    method: 'POST',
    url: `/__sks/client/${capability}/backend-api/codex/responses?access_token=super-secret-token`,
    status: 403
  });
  const line = lines.join('');
  // The client base path IS a capability secret, and a query string can carry a
  // token. Neither may reach a log file that gets pasted into bug reports.
  assert.ok(!line.includes(capability), 'capability segment leaked into the log');
  assert.ok(!line.includes('super-secret-token'), 'query string leaked into the log');
  assert.ok(!line.includes('access_token'), 'query string leaked into the log');
  assert.ok(line.includes('<redacted>'), 'the capability segment should be redacted, not dropped silently');
  assert.ok(line.includes('/backend-api/codex/responses'), 'the useful part of the path should survive');
});

test('a rejection storm stays bounded and reports what it suppressed', () => {
  // A client in a reconnect loop can reject thousands of times a minute; the log
  // must cost a bounded number of lines, not fill the disk.
  let clock = 1_000;
  const { log, parsed } = collector(() => clock);
  for (let index = 0; index < 500; index += 1) {
    log({ code: 'bridge_codex_session_identity_mismatch', transport: 'websocket' });
  }
  assert.equal(parsed().length, REJECTION_LOG_BURST, 'burst allowance must cap the emitted lines');

  clock += 61_000;
  log({ code: 'bridge_codex_session_identity_mismatch', transport: 'websocket' });
  const rows = parsed();
  const summary = rows.find((row) => row.event === 'sks.desktop_bridge.rejected_summary');
  assert.ok(summary, 'a suppressed storm must still be reported');
  assert.equal(summary.code, 'bridge_codex_session_identity_mismatch');
  assert.equal(summary.suppressed, 500 - REJECTION_LOG_BURST);

  // Distinct codes get their own allowance, so one noisy code cannot hide another.
  const before = parsed().length;
  log({ code: 'bridge_provider_route_unavailable', transport: 'http' });
  assert.equal(parsed().length, before + 1);
});

test('a generic upstream failure records the underlying cause', () => {
  // `bridge_upstream_unavailable` is safeBridgeErrorCode's catch-all for any
  // error that is not a DesktopBridgeError, so on its own it names a symptom
  // and leaves the operator with nowhere to go. The originating socket error's
  // own code is appended; those are fixed identifiers carrying no request data.
  const { log, parsed } = collector();
  log({ code: 'bridge_upstream_unavailable:ECONNRESET', transport: 'http', method: 'POST', url: '/backend-api/codex/responses' });
  const row = parsed()[0];
  assert.equal(row.code, 'bridge_upstream_unavailable:ECONNRESET');
  assert.equal(row.transport, 'http');
  assert.equal(row.secret_fields_redacted, true);
});

test('a failing write never propagates out of the logger', () => {
  const log = createDesktopBridgeRejectionLogger({
    write: () => { throw new Error('EPIPE'); }
  });
  assert.doesNotThrow(() => log({ code: 'bridge_origin_forbidden', transport: 'http' }));
});
