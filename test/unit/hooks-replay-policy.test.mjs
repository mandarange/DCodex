import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHookPayload, honestModeGapLines } from '../../dist/core/hooks-runtime.js';

test('shared hook runtime blocks destructive DB pre-tool payload', async () => {
  const result = await evaluateHookPayload('pre-tool', {
    tool_input: { command: 'psql -c "DROP TABLE users"' }
  }, { root: process.cwd(), state: {} });
  assert.equal(result.decision, 'block');
});

test('MAD-SKS pre-tool guard allows Sneakoscope source-project edits under source exception', async () => {
  const result = await evaluateHookPayload('pre-tool', {
    cwd: process.cwd(),
    tool_input: { command: 'nl -ba src/core/hooks-runtime.ts' }
  }, {
    root: process.cwd(),
    state: { mode: 'MADSKS', phase: 'MADSKS_SCOPED_PERMISSION_ACTIVE' }
  });
  assert.equal(result.continue, true);
  assert.equal(result.decision, undefined);
});

test('honest loopback ignores resolved empty-gap summary lines', () => {
  const text = [
    '**완료 요약**',
    '0.9.13 release contract를 검증하고 proof를 갱신했습니다.',
    '**SKS Honest Mode**',
    '- proof validation: `verified`, `unverified: []`, `blockers: []`',
    '- 미해결 gap: 없음, sealed 0.9.13 contract 기준.',
    '- Unresolved gaps for the 0.9.13 sealed contract: none.'
  ].join('\n');
  assert.deepEqual(honestModeGapLines(text), []);
});

test('honest loopback accepts a Markdown remaining-gaps heading followed by none', () => {
  const text = [
    '## 완료 요약',
    '',
    '요청한 변경과 검증을 마쳤습니다.',
    '',
    '## 남은 문제',
    '',
    '없음.',
    '',
    '## SKS 솔직모드',
    '',
    '검증 근거와 결과가 일치합니다.'
  ].join('\n');
  assert.deepEqual(honestModeGapLines(text), []);
});
