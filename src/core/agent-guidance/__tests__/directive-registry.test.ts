import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAgentGuidance, CANONICAL_DIRECTIVES, extractDirectives } from '../directive-registry.js';
import { renderInitDeepAgentGuidance, renderSharedAgentDirectives } from '../../codex-app/codex-init-deep.js';

const ROWS = [
  { score: 1, dir: '.', file_count: 120, languages: ['ts'], guidance: 'Use local source conventions and keep changes owner-scoped.' },
  { score: 1, dir: 'src/core', file_count: 79, languages: ['ts'], guidance: 'Use local source conventions and keep changes owner-scoped.' },
  { score: 1, dir: 'src/core/release', file_count: 47, languages: ['ts'], guidance: 'High-risk SKS runtime area; hydrate TriWiki/current source before edits.' }
];

test('observations are not directives', () => {
  const directives = extractDirectives([
    '- Files observed: 79',
    '- Languages: md, ts',
    '- Risk: high',
    '- src/core/daemon',
    '- Preserve user-authored content outside managed blocks.'
  ].join('\n'));
  assert.deepEqual(directives, ['Preserve user-authored content outside managed blocks.']);
});

test('a directive repeated across directory blocks is reported', () => {
  const report = analyzeAgentGuidance([
    { path: 'src/core', text: '- Hydrate TriWiki before risky edits.' },
    { path: 'src/cli', text: '- Hydrate TriWiki before risky edits.' }
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.repeated.length, 1);
  assert.deepEqual(report.repeated[0]?.paths, ['src/cli', 'src/core']);
});

test('a narrow restatement alongside its canonical principle is reported', () => {
  const solid = CANONICAL_DIRECTIVES.find((entry) => entry.id === 'solid');
  assert.ok(solid);
  const report = analyzeAgentGuidance([
    { path: 'src/core', text: [`- ${solid!.statement}`, '- Keep modules small and make them reusable.'].join('\n') }
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.subsumed.length, 1);
  assert.equal(report.subsumed[0]?.canonical, solid!.statement);
});

test('two restatements of one principle are reported even without the canonical line', () => {
  const report = analyzeAgentGuidance([
    { path: 'docs', text: ['- Add comments to every function.', '- Write JSDoc for the public surface.'].join('\n') }
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.subsumed.length, 2);
});

test('a single directive stated once anywhere is accepted', () => {
  const report = analyzeAgentGuidance([
    { path: 'ROOT', text: '- Preserve user-authored content outside managed blocks.' },
    { path: 'src/core', text: '- Files observed: 79\n- Risk: high' }
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.blockers));
});

test('the shared block states each canonical principle exactly once', () => {
  const shared = renderSharedAgentDirectives();
  for (const entry of CANONICAL_DIRECTIVES) {
    const occurrences = shared.split(entry.statement).length - 1;
    assert.equal(occurrences, 1, `${entry.id} appears ${occurrences} times`);
  }
});

test('generated init-deep guidance carries no repeated or subsumed directive', () => {
  // The contract the gate enforces: directory blocks describe their directory,
  // the root block states the directives, and nothing is said twice.
  const report = analyzeAgentGuidance(renderInitDeepAgentGuidance(ROWS as never), { sharedScopePath: 'ROOT' });
  assert.equal(report.ok, true, JSON.stringify({ repeated: report.repeated, subsumed: report.subsumed }, null, 2));
});

test('a directory block keeps its own observations and drops shared instructions', () => {
  const blocks = renderInitDeepAgentGuidance(ROWS as never);
  const risky = blocks.find((entry) => entry.path === 'src/core/release');
  assert.ok(risky);
  assert.match(risky!.text, /- Files observed: 47/);
  assert.match(risky!.text, /- Risk: high/);
  assert.equal(extractDirectives(risky!.text).length, 0);
  const plain = blocks.find((entry) => entry.path === 'src/core');
  assert.ok(plain);
  assert.doesNotMatch(plain!.text, /- Risk: high/);
});
