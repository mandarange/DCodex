#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveProviderContext } from '../core/provider/provider-context.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-context-'))
const codexHome = path.join(root, '.codex')
await fs.mkdir(codexHome, { recursive: true })

const codexLbConfig = [
  'model_provider = "codex-lb"',
  '',
  '[model_providers.codex-lb]',
  'name = "codex-lb"',
  'base_url = "https://lb.example.test"',
  'wire_api = "responses"',
  'env_key = "CODEX_LB_API_KEY"',
  'requires_openai_auth = false',
  ''
].join('\n')
await fs.writeFile(path.join(codexHome, 'config.toml'), codexLbConfig)
const configOnlyLb = await resolveProviderContext({
  root,
  codexHome,
  env: { HOME: root, CODEX_LB_API_KEY: 'lb-fixture' } as any,
  route: '$Naruto',
  serviceTier: 'fast'
})

await fs.writeFile(path.join(codexHome, 'config.toml'), codexLbConfig.replace('model_provider = "codex-lb"', 'model_provider = "openai"'))
const openaiSelected = await resolveProviderContext({
  root,
  codexHome,
  env: { HOME: root, OPENAI_API_KEY: 'sk-fixture', CODEX_LB_API_KEY: 'lb-fixture' } as any,
  route: '$Doctor',
  serviceTier: 'fast'
})

await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "codex-lb"\n')
const malformed = await resolveProviderContext({
  root,
  codexHome,
  env: { HOME: root } as any,
  route: '$Naruto',
  serviceTier: 'standard'
})

const checks = {
  config_only_codex_lb: configOnlyLb.provider === 'codex-lb' && configOnlyLb.confidence === 'high' && configOnlyLb.source === 'config',
  config_env_key_recorded: configOnlyLb.signals.codex_lb_env_key === 'CODEX_LB_API_KEY',
  openai_selected_with_lb_available: openaiSelected.provider === 'openai' && openaiSelected.signals.codex_lb_available === true,
  malformed_unknown: malformed.provider === 'unknown' && malformed.warnings.includes('codex_lb_provider_config_missing_or_invalid')
}
const ok = Object.values(checks).every(Boolean)

emit({
  schema: 'sks.provider-context-config-toml-check.v1',
  ok,
  checks,
  cases: { configOnlyLb, openaiSelected, malformed },
  blockers: ok ? [] : Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
})

function emit(report: Record<string, unknown>) {
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}
