import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySearchVisibility } from '../verifier.js';

const inventory = {
  detected_adapter: { capabilities: { sourceAudit: true } },
} as any;

function context(origin: string | null, offline = false) {
  return {
    root: process.cwd(),
    mode: 'seo',
    target: 'website',
    framework: 'static',
    origin,
    offline,
    strict: true,
  } as const;
}

test('an origin string alone never verifies production or HTTP', async () => {
  let requests = 0;
  const report = await verifySearchVisibility(context('https://example.test/'), inventory, null, {
    fetch: async () => {
      requests += 1;
      throw new Error('network unavailable');
    },
    now: () => new Date('2026-08-02T00:00:00.000Z'),
  });

  assert.equal(requests, 1, 'the verifier must attempt a real HTTP request');
  assert.equal(report.http_verified, false);
  assert.equal(report.production_verified, false);
  assert.equal(report.status, 'verified_partial');
  assert.equal(report.http_evidence.attempted, true);
  assert.equal(report.http_evidence.verified, false);
  assert.equal(report.http_evidence.error, 'request_failed');
  assert.ok(report.unverified.includes('production_http_not_verified'));
});

test('HTTP errors, non-HTML, and content-free HTML cannot verify production', async () => {
  const fixtures = [
    [new Response('<!doctype html><html><body>Not found content</body></html>', { status: 404, headers: { 'content-type': 'text/html' } }), 'http_status_404'],
    [new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }), 'non_html_content_type'],
    [new Response('<!doctype html><html><body>x</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'insufficient_html_content'],
  ] as const;

  for (const [response, expectedError] of fixtures) {
    const report = await verifySearchVisibility(context('https://example.test/'), inventory, null, {
      fetch: async () => response,
      now: () => new Date('2026-08-02T00:00:00.000Z'),
    });
    assert.equal(report.http_verified, false, expectedError);
    assert.equal(report.production_verified, false, expectedError);
    assert.equal(report.http_evidence.error, expectedError);
  }
});

test('production verification requires a successful HTML response with bound evidence and timestamp', async () => {
  const html = '<!doctype html><html><head><title>Verified production page</title></head><body><main>Substantive production content for search visibility.</main></body></html>';
  const report = await verifySearchVisibility(context('https://example.test/'), inventory, null, {
    fetch: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    now: () => new Date('2026-08-02T00:00:00.000Z'),
  });

  assert.equal(report.http_verified, true);
  assert.equal(report.production_verified, true);
  assert.equal(report.status, 'production_verified');
  assert.deepEqual(report.http_evidence, {
    attempted: true,
    verified: true,
    requested_url: 'https://example.test/',
    final_url: 'https://example.test/',
    status_code: 200,
    content_type: 'text/html',
    content_bytes: Buffer.byteLength(html),
    content_sha256: report.http_evidence.content_sha256,
    observed_at: '2026-08-02T00:00:00.000Z',
    error: null,
  });
  assert.match(report.http_evidence.content_sha256 || '', /^[a-f0-9]{64}$/);
  assert.ok(!report.unverified.includes('production_http_not_verified'));
});

test('offline mode performs no request and cannot verify production', async () => {
  let requests = 0;
  const report = await verifySearchVisibility(context('https://example.test/', true), inventory, null, {
    fetch: async () => {
      requests += 1;
      return new Response('<!doctype html><html><body>Should not run</body></html>');
    },
  });
  assert.equal(requests, 0);
  assert.equal(report.http_evidence.attempted, false);
  assert.equal(report.production_verified, false);
});
