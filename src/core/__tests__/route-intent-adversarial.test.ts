import test from 'node:test'
import assert from 'node:assert/strict'
import { hasFromChatImgSignal, hasMadSksSignal, routePrompt, stripMadSksSignal } from '../routes.js'

const cases = [
  { prompt: 'Can you fix the failing tests?', expected: ['Naruto'] },
  { prompt: '고쳐줄 수 있어? 로그인 테스트 깨져', expected: ['Naruto'] },
  { prompt: '이거 왜 안 고쳐져? 수정해줘', expected: ['Naruto'] },
  { prompt: 'How do I fix this myself?', expected: ['Answer'] },
  { prompt: '이 함수 왜 이렇게 동작해? 설명만 해줘', expected: ['Answer'] },
  { prompt: 'README 오타만 고쳐줄래?', expected: ['DFix'] },
  { prompt: '$Super-Search run "npm release notes"', expected: ['SuperSearch'] },
  { prompt: '$sks-super-search run "npm release notes"', expected: ['SuperSearch'] },
  { prompt: '$sks-from-chat-img 채팅 스크린샷 요청을 구현해줘', expected: ['Naruto'] },
  { prompt: '$sks-mad-sks $sks-naruto implement the approved change', expected: ['Naruto'] },
  { prompt: 'site:x.com product launch 찾아줘', expected: ['SuperSearch'] },
  { prompt: 'Supabase RLS 수정해줘', expected: ['DB', 'MadSKS'] },
  { prompt: 'DB 스키마 수정해줘', expected: ['DB'] },
  {
    prompt: '[Root orchestrator Sol Max DAG 분해, 계약 확정, 통합, 최종 판정 Judgment lane Sol Max 아키텍처, 디버깅, 보안, DB, 릴리스, 모호한 작업 Implementation lane Sol High 일반 UI·backend·logic·native 구현 Context/tool lane Terra Max 대형 문서·로그·저장소 탐색, Browser, Computer Use, Image 실행 Mechanical lane Luna Max tiny·short-context·명확한 완료 조건·강한 자동 검증이 있는 작업] 이거대로 반영해줘',
    expected: ['Naruto']
  },
  {
    prompt: 'sks 의 모든 달러 커맨드에는 sks- 라는 접두사 붙여서 보이게해주고 레거시 커맨드 중복커맨드는 제거되게해줘 sks update나 sks doctor --fix 시',
    expected: ['Naruto']
  },
  { prompt: '커밋하고 푸시해줘', expected: ['CommitAndPush'] }
] as const

test('adversarial route-intent matrix stays stable', () => {
  for (const row of cases) {
    const route = routePrompt(row.prompt)
    assert.ok(route, `missing route for ${row.prompt}`)
    assert.ok(row.expected.some((expected) => expected === route.id), `${row.prompt} routed to ${route.id}, expected ${row.expected.join(' or ')}`)
  }
})

test('namespaced visual and MAD modifier signals preserve their specialized behavior', () => {
  assert.equal(hasFromChatImgSignal('$sks-from-chat-img 채팅 스크린샷을 처리해줘'), true)
  assert.equal(hasMadSksSignal('$sks-mad-sks $sks-naruto implement the approved change'), true)
  assert.equal(stripMadSksSignal('$sks-mad-sks $sks-naruto implement the approved change'), '$sks-naruto implement the approved change')
})
