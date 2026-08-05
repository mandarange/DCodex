import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { runCodexExec } from '../../codex-adapter.js'

test('generic SKS Codex exec strips retired provider credentials after runtime preparation', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-mediated-env-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  let childEnv: NodeJS.ProcessEnv | undefined
  const result = await runCodexExec({
    root,
    prompt: 'synthetic fixture prompt',
    codexBin: '/fixture/codex',
    env: {
      HOME: root,
      CODEX_ACCESS_TOKEN: 'oauth-workspace-token',
      CODEX_LB_API_KEY: 'stale-synthetic-key',
      CODEX_LB_BASE_URL: 'https://stale.example.test/backend-api/codex'
    },
    prepareCodexRuntimeEnvImpl: async ({ env = {} }: { env?: NodeJS.ProcessEnv }) => ({
      ...env,
      CODEX_LB_API_KEY: 'validated-synthetic-key',
      CODEX_LB_BASE_URL: 'https://validated.example.test/backend-api/codex'
    }),
    runProcessImpl: async (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      childEnv = options.env
      return {
        code: 0,
        stdout: '',
        stderr: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        timedOut: false
      }
    }
  })
  assert.equal(result.code, 0)
  assert.equal(childEnv?.CODEX_LB_API_KEY, undefined)
  assert.equal(childEnv?.CODEX_LB_BASE_URL, undefined)
  assert.equal(childEnv?.CODEX_ACCESS_TOKEN, 'oauth-workspace-token')
})
