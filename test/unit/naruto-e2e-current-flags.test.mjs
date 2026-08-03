import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

test('Naruto Codex E2E gate uses only the current official-subagent CLI flags', () => {
  const source = fs.readFileSync(new URL('../../src/scripts/naruto-codex-e2e-check.ts', import.meta.url), 'utf8')
  for (const removed of ['--mock', '--real', '--work-items', '--clones']) {
    assert.doesNotMatch(source, new RegExp(`['\"]${removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]`), removed)
  }
  for (const current of ['--agents', '--max-threads', '--readonly', '--json']) {
    assert.match(source, new RegExp(`['\"]${current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]`), current)
  }
})
