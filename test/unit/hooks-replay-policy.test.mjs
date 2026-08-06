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

test('honest loopback ignores Korean non-blocking boundaries and zero blocker summaries', () => {
  const text = [
    '## 완료 요약',
    '',
    '요청한 UI 변경과 검증을 마쳤습니다.',
    '',
    '## 검증 결과',
    '',
    '- 프로젝트 게이트 `ok=true`, blocker 0건',
    '',
    '## 남은 문제',
    '',
    '없음.',
    '',
    '## 미검증 범위 — 비차단',
    '',
    '- 비차단: 실제 자격증명 입력은 요청 범위 밖의 운영 변경이므로 실행하지 않았습니다.',
    '- 비차단: 전역 설치 앱은 교체하지 않고 격리된 네이티브 앱으로 검증했습니다.',
    '- 비차단: 기존 작업트리를 보존했으며 커밋·푸시·배포하지 않았습니다.',
    '',
    '## SKS 솔직모드',
    '',
    '현재 Proof와 Trust에 blocker 0건이며 증빙 범위만 완료로 주장합니다.'
  ].join('\n');
  assert.deepEqual(honestModeGapLines(text), []);
});

test('honest loopback distinguishes completed missing-field fixes from unresolved work', () => {
  const completed = '- Swift의 누락된 optional 필드와 TypeScript 검증 불일치 해결';
  const unresolved = '- Swift optional 필드 누락 해결 필요';

  assert.deepEqual(honestModeGapLines(completed), []);
  assert.deepEqual(honestModeGapLines(unresolved), [unresolved]);
});

test('honest loopback accepts zero blocker counts with Korean particles', () => {
  const resolved = '현재 Proof와 Trust blocker는 0건입니다. 운영 범위를 완료로 주장하지 않습니다.';
  const unresolved = '현재 Proof와 Trust blocker는 1건입니다.';

  assert.deepEqual(honestModeGapLines(resolved), []);
  assert.deepEqual(honestModeGapLines(unresolved), [unresolved]);
});
