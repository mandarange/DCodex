import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

test('MAD retired GLM hint points only to Desktop Bridge routing', async () => {
  const source = await fs.readFile(new URL('../mad-sks-command.ts', import.meta.url), 'utf8')
  assert.match(source, /sks bridge provider configure\|validate\|enable/)
  assert.match(source, /sks bridge catalog sync/)
  assert.match(source, /sks bridge route set-default/)
  assert.doesNotMatch(source, /sks codex-app use-openrouter|sks codex-app set-openrouter-key/)
})
