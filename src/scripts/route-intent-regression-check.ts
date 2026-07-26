#!/usr/bin/env node
// @ts-nocheck
import path from 'node:path'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'
import { writeJsonAtomic } from '../core/fsx.js'

const { routePrompt } = await importDist('core/routes.js')

const cases = [
  { prompt: 'Can you fix the failing tests?', expected: ['Naruto'] },
  { prompt: '고쳐줄 수 있어? 로그인 테스트 깨져', expected: ['Naruto'] },
  { prompt: '이거 왜 안 고쳐져? 수정해줘', expected: ['Naruto'] },
  { prompt: 'How do I fix this myself?', expected: ['Answer'] },
  { prompt: '이 함수 왜 이렇게 동작해? 설명만 해줘', expected: ['Answer'] },
  { prompt: 'README 오타만 고쳐줄래?', expected: ['DFix'] },
  { prompt: '$Super-Search run "npm release notes"', expected: ['SuperSearch'] },
  { prompt: 'site:x.com product launch 찾아줘', expected: ['SuperSearch'] },
  { prompt: 'Supabase RLS 수정해줘', expected: ['DB', 'MadSKS'] },
  { prompt: '커밋하고 푸시해줘', expected: ['CommitAndPush'] }
]

const results = cases.map((row) => {
  const route = routePrompt(row.prompt)
  return {
    prompt: row.prompt,
    expected: row.expected,
    actual: route?.id || null,
    reasons: route?.intent_scores?.reasons || []
  }
})

const failures = results.filter((row) => !row.expected.includes(row.actual))
const report = {
  schema: 'sks.route-intent-regression.v1',
  ok: failures.length === 0,
  generated_at: new Date().toISOString(),
  checked: results.length,
  results,
  blockers: failures.map((row) => `route_intent_mismatch:${row.prompt}`)
}
await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'route-intent-regression.json'), report)
await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'route-regression.json'), report)

assertGate(report.ok, 'route intent regression matrix failed', report)

emitGate('route:intent-regression', {
  checked: results.length,
  results
})
