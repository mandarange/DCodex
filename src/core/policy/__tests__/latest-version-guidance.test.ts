import test from 'node:test';
import assert from 'node:assert/strict';
import { latestVersionGuidanceReport, scanLatestVersionGuidance } from '../latest-version-guidance.js';

test('pinned user guidance is detected in prose', () => {
  const findings = scanLatestVersionGuidance('README.md', [
    'Current release: **SKS 7.3.0**, with the preferred channel at CLI 0.145.0.',
    'Codex remote-control requires Codex CLI 0.130.0+.',
    'Upgrade codex-lb to 1.21.0-beta.3 or later.'
  ].join('\n'));
  assert.equal(findings.length, 3);
  assert.equal(findings[0]?.version, '7.3.0');
  assert.equal(findings[0]?.trigger, 'current release');
  assert.equal(findings[1]?.version, '0.130.0');
  assert.equal(findings[2]?.version, '1.21.0-beta.3');
});

test('latest-stable guidance passes', () => {
  const findings = scanLatestVersionGuidance('README.md', [
    'Use the official latest stable SKS and Codex CLI releases.',
    'Run `sks update-check` and read the capability report; capability probes decide support.'
  ].join('\n'));
  assert.deepEqual(findings, []);
});

test('historical and machine-readable numbers are not user guidance', () => {
  const findings = scanLatestVersionGuidance('docs/notes.md', [
    'Fixed in 4.0.2: the orphan gate purge.',
    'This behavior was released in 3.1.7 and later removed.',
    'The compatibility matrix records 0.133.0 as the minimum supported version.',
    'See CHANGELOG.md for the 7.3.0 entry.'
  ].join('\n'));
  assert.deepEqual(findings, []);
});

test('dates, two-part ranges, and schema ids do not trip the scanner', () => {
  const findings = scanLatestVersionGuidance('docs/notes.md', [
    'Requires node >= 20.11.',
    'The contract id is sks.context-graph.v1 and it is required.',
    'Recommended reading as of 2026-07-27.'
  ].join('\n'));
  assert.deepEqual(findings, []);
});

test('guidance trigger substrings inside paths and names do not trip the scanner', () => {
  const findings = scanLatestVersionGuidance('docs/gate-script-map.md', [
    'Current 8.1.3 classifications live in',
    '`docs/internal/8.1.3-requirement-traceability.md` and',
    '`docs/internal/8.1.3-recommendedness-audit.md`.'
  ].join('\n'));
  assert.deepEqual(findings, []);
});

test('standalone require trigger forms remain blocked', () => {
  const findings = scanLatestVersionGuidance('README.md', [
    'Remote control requires Codex CLI 0.140.0.',
    'Codex CLI 0.141.0 is required for remote control.',
    'Remote control features require Codex CLI 0.142.0.'
  ].join('\n'));
  assert.deepEqual(findings.map((finding) => finding.trigger), ['requires', 'required', 'require']);
});

test('source files are judged by what they print, not by their comments', () => {
  const source = [
    '// Compatibility note: the probe compares against 0.130.0, required for remote-control.',
    "const MIN = '0.130.0';",
    "console.log('Codex remote-control requires Codex CLI 0.140.0+.');"
  ].join('\n');
  const findings = scanLatestVersionGuidance('src/core/x.ts', source, { stringLiteralsOnly: true });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.line, 3);
  assert.equal(findings[0]?.version, '0.140.0');
});

test('a bare version constant with no guidance wording is allowed in source', () => {
  const findings = scanLatestVersionGuidance('src/core/x.ts', "export const MIN_VERSION = '0.133.0';", {
    stringLiteralsOnly: true
  });
  assert.deepEqual(findings, []);
});

test('one historical sentence does not excuse a second version that is real advice', () => {
  const findings = scanLatestVersionGuidance(
    'docs/notes.md',
    'Fixed in 4.0.2. Separately, and unrelated to that change, every operator of this harness must be running at least 9.9.9 before continuing.'
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.version, '9.9.9');
});

test('the report is deterministic and sorted', () => {
  const report = latestVersionGuidanceReport(
    [
      { path: 'b.md', line: 2, version: '1.0.0', trigger: 'requires', excerpt: 'b' },
      { path: 'a.md', line: 9, version: '1.0.0', trigger: 'requires', excerpt: 'a' },
      { path: 'a.md', line: 1, version: '1.0.0', trigger: 'requires', excerpt: 'a' }
    ],
    3,
    ['z.md', 'y.md']
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((finding) => `${finding.path}:${finding.line}`), ['a.md:1', 'a.md:9', 'b.md:2']);
  assert.deepEqual(report.exemptions, ['y.md', 'z.md']);
  assert.equal(latestVersionGuidanceReport([], 3, []).ok, true);
});
