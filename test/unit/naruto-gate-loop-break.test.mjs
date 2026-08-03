import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('parent_model_match false is not a hard naruto stop field', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'src/core/pipeline-internals/runtime-gates.ts'), 'utf8')
  assert.match(source, /parent_model_match is advisory/)
  assert.doesNotMatch(source, /if \(gate\.parent_model_match === false\) required\.push\('parent_model_match'\)/)
  assert.match(source, /Do not invalidate reflection for Naruto\/runtime evidence gates/)
})

test('honest loopback attempts are bounded in hooks-runtime', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'src/core/hooks-runtime/stop-finalization.ts'), 'utf8')
  assert.match(source, /MAX_HONEST_LOOPBACK_ATTEMPTS = 2/)
  assert.match(source, /honest_loop_attempt_count/)
  assert.match(source, /stop_with_terminal_blocker_or_record_hard_blocker/)
})
