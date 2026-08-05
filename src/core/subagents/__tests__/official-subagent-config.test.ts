import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'
import {
  MANAGED_OFFICIAL_SUBAGENT_ROLES,
  RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES,
  managedAgentRoleContent,
  managedOfficialSubagentRoleContent,
  managedOfficialSubagentRoleOwnsText
} from '../../managed-assets/managed-assets-manifest.js'
import { initProject } from '../../init.js'
import { reconcileRetiredAgentRoleResidue } from '../../agents/agent-role-config.js'
import { pruneStaleGeneratedFiles } from '../../init/skills.js'
import { repairCodexStartupConfig } from '../../doctor/codex-startup-config-repair.js'
import { repairAgentConfigFileReferences } from '../../codex/agent-config-file-repair.js'
import { buildSksCoreSkillManifest, renderCoreSkillTemplate } from '../../codex-native/core-skill-manifest.js'
import { PACKAGE_VERSION, sha256 } from '../../fsx.js'
import {
  installOfficialSubagentAgentConfigs,
  mergeOfficialSubagentConfig,
  officialSubagentConfigOwnershipProof,
  readOfficialSubagentConfig
} from '../official-subagent-config.js'
import {
  buildOfficialSubagentCodexArgs,
  buildOfficialSubagentChildEnv,
  codexAppSessionKey,
  detectCodexAppSession
} from '../official-subagent-runner.js'

test('standalone parent args launch one Sol Max Codex parent with the official thread budget', () => {
  const args = buildOfficialSubagentCodexArgs({
    prompt: 'delegate and wait',
    maxThreads: 12,
    parentSummaryFile: '/tmp/parent-summary.txt'
  })
  assert.deepEqual(args.slice(0, 6), ['exec', '--json', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="max"'])
  assert.ok(args.includes('model_provider="openai"'))
  assert.ok(args.includes('forced_login_method="chatgpt"'))
  assert.ok(args.includes('agents.max_concurrent_threads_per_session=12'))
  assert.ok(args.includes('agents.max_depth=1'))
  assert.ok(args.includes('agents.enabled=true'))
  assert.ok(args.some((arg) => typeof arg === 'string' && arg.includes('features.multi_agent_v2=') && arg.includes('enabled=true')))
  assert.ok(args.includes('agents.default_subagent_model="gpt-5.6-sol"'))
  assert.ok(args.includes('agents.default_subagent_reasoning_effort="high"'))
  assert.equal(args.filter((arg) => arg === 'exec').length, 1)
})

test('Naruto capability branching prefers multi_agent_v2 probes and update CTAs', async () => {
  const { assertNarutoMultiAgentV2Capability, buildCodexCapabilityMatrix } = await import('../../codex-compat/codex-capability-matrix.js')
  const available = buildCodexCapabilityMatrix({
    version: '0.146.0',
    helpText: 'multi_agent_v2 max_concurrent_threads_per_session'
  })
  assert.equal(assertNarutoMultiAgentV2Capability(available).ok, true)
  const missing = buildCodexCapabilityMatrix({
    version: '0.140.0',
    helpText: 'legacy collab only'
  })
  const blocked = assertNarutoMultiAgentV2Capability(missing)
  assert.equal(blocked.ok, false)
  assert.ok(blocked.blockers.includes('update_codex_cli'))
  assert.ok(blocked.guidance.some((line) => /Menu Bar|sks codex update/i.test(line)))
})

test('Codex thread environment selects the in-app path unless standalone is explicit', () => {
  assert.equal(detectCodexAppSession({ CODEX_THREAD_ID: 'thread' }), true)
  assert.equal(detectCodexAppSession({ CODEX_THREAD_ID: 'thread', SKS_NARUTO_STANDALONE_CLI: '1' }), false)
  assert.equal(detectCodexAppSession({ SKS_NARUTO_APP_SESSION: '1' }), true)
  assert.equal(codexAppSessionKey({ CODEX_THREAD_ID: 'thread' }), 'thread')
  assert.equal(codexAppSessionKey({ SKS_NARUTO_APP_SESSION: '1' }), null)
  assert.equal(codexAppSessionKey({ CODEX_THREAD_ID: 'thread', SKS_NARUTO_STANDALONE_CLI: '1' }), null)
})

test('standalone child environment keeps only the official runtime allowlist and launch ownership', () => {
  const allowedHostKeys = [
    'SKS_AGENT_MODE',
    'ACAS_AGENT_SLUG',
    'ACAS_AGENT_WORKSPACE',
    'ALFREDO_AGENT_SOULS_FILE',
    'ACAS_CHROME_PATH',
    'ACAS_HTML_TO_PDF_ENGINE',
    'ACAS_HTML_TO_PDF_ALLOW_CHROME_CLI_FALLBACK'
  ] as const
  const deniedHostKeys = [
    'ACAS_CONNECTION_TOKEN',
    'ACAS_CENTER_BASE_URL',
    'ACAS_CENTRAL_API_BASE',
    'ACAS_EDGE_NODE_SLUG',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'CODEX_LB_API_KEY',
    'SLACK_BOT_TOKEN',
    'HTTPS_PROXY'
  ] as const
  const env = buildOfficialSubagentChildEnv({
    missionId: 'M-isolated-parent',
    workflowRunId: 'run-isolated-parent',
    hostCapabilityLaunchNonce: 'nonce-isolated-parent',
    env: {
      HOME: '/tmp/official-home',
      CODEX_HOME: '/tmp/official-home/.codex',
      PATH: '/usr/bin:/bin',
      OPENAI_API_KEY: 'sk-official-auth',
      CODEX_API_KEY: 'codex-api-auth',
      CODEX_AUTH_TOKEN: 'codex-auth-token',
      OPENAI_ORGANIZATION: 'org-must-not-inherit',
      OPENAI_PROJECT: 'project-must-not-inherit',
      HTTPS_PROXY: 'https://proxy.example.test',
      CODEX_THREAD_ID: 'must-not-inherit-app-session',
      CODEX_LB_API_KEY: 'must-not-inherit-lb-auth',
      AWS_SECRET_ACCESS_KEY: 'must-not-inherit-cloud-auth',
      PROJECT_MCP_ALLOWED: 'must-not-inherit-arbitrary-project-env',
      SKS_AGENT_MODE: '1',
      ACAS_AGENT_SLUG: 'agent-slug',
      ACAS_AGENT_WORKSPACE: '/tmp/agent-workspace',
      ALFREDO_AGENT_SOULS_FILE: '/tmp/souls.json',
      ACAS_CHROME_PATH: '/tmp/chrome',
      ACAS_HTML_TO_PDF_ENGINE: 'chrome',
      ACAS_HTML_TO_PDF_ALLOW_CHROME_CLI_FALLBACK: '1',
      ACAS_CONNECTION_TOKEN: 'must-not-inherit-connection-token',
      ACAS_CENTER_BASE_URL: 'https://center.example.test',
      ACAS_CENTRAL_API_BASE: 'https://central.example.test',
      ACAS_EDGE_NODE_SLUG: 'edge-node',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
      SLACK_BOT_TOKEN: 'slack-secret',
      HTTP_PROXY: 'http://proxy.example.test',
      ALL_PROXY: 'socks5://proxy.example.test'
    }
  })
  assert.equal(env.HOME, '/tmp/official-home')
  assert.equal(env.CODEX_HOME, '/tmp/official-home/.codex')
  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.SKS_NARUTO_STANDALONE_CLI, '0')
  assert.equal(env.SKS_NARUTO_PARENT_LAUNCH, '1')
  assert.equal(env.SKS_NARUTO_PARENT_MISSION_ID, 'M-isolated-parent')
  assert.equal(env.SKS_NARUTO_PARENT_WORKFLOW_RUN_ID, 'run-isolated-parent')
  assert.equal(env.SKS_NARUTO_PARENT_HOST_CAPABILITY_NONCE, 'nonce-isolated-parent')
  assert.deepEqual(allowedHostKeys.map((key) => env[key]), [
    '1',
    'agent-slug',
    '/tmp/agent-workspace',
    '/tmp/souls.json',
    '/tmp/chrome',
    'chrome',
    '1'
  ])
  assert.deepEqual(deniedHostKeys.map((key) => env[key]), Array.from({ length: deniedHostKeys.length }, () => undefined))
  assert.equal(env.CODEX_API_KEY, undefined)
  assert.equal(env.CODEX_AUTH_TOKEN, undefined)
  assert.equal(env.OPENAI_ORGANIZATION, undefined)
  assert.equal(env.OPENAI_PROJECT, undefined)
  assert.equal(env.CODEX_THREAD_ID, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(env.PROJECT_MCP_ALLOWED, undefined)
  assert.equal(env.HTTP_PROXY, undefined)
  assert.equal(env.ALL_PROXY, undefined)
})

test('fresh project config receives the official Codex subagent defaults', () => {
  const text = mergeOfficialSubagentConfig('')
  const parsed = parse(text) as Record<string, any>

  assert.equal(parsed.agents.max_concurrent_threads_per_session, 256)
  assert.equal(parsed.agents.max_depth, 1)
  assert.equal(parsed.agents.enabled, true)
  assert.equal(parsed.agents.interrupt_message, true)
  assert.equal(parsed.agents.default_subagent_model, 'gpt-5.6-sol')
  assert.equal(parsed.agents.default_subagent_reasoning_effort, 'high')
  assert.equal(Object.hasOwn(parsed.agents, 'job_max_runtime_seconds'), false)
  assert.equal(Object.hasOwn(parsed.agents, 'max_threads'), false)
  assert.equal(Object.hasOwn(parsed.agents, 'warn_on_max_threads'), false)
  assert.equal(parsed.features.multi_agent_v2.enabled, true)
  assert.equal(parsed.features.multi_agent_v2.max_concurrent_threads_per_session, 257)
  assert.equal(parsed.features.multi_agent_v2.expose_spawn_agent_model_overrides, true)
})

test('project and inherited user concurrency values are preserved', () => {
  for (const value of [3, 20]) {
    const project = mergeOfficialSubagentConfig(`[agents]\nmax_concurrent_threads_per_session = ${value}\n`)
    assert.equal((parse(project) as Record<string, any>).agents.max_concurrent_threads_per_session, value)

    const inherited = mergeOfficialSubagentConfig('', {
      inheritedText: `[agents]\nmax_concurrent_threads_per_session = ${value}\n`
    })
    const parsed = parse(inherited) as Record<string, any>
    assert.equal(parsed.agents.max_concurrent_threads_per_session, undefined)
    assert.equal(Object.hasOwn(parsed.agents, 'max_concurrent_threads_per_session'), false)
  }
})

test('official config accepts 256 child slots and blocks 257 without silently clamping intent', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-config-hard-cap-'))
  const root = path.join(fixture, 'project')
  const codexHome = path.join(fixture, 'codex-home')
  const configPath = path.join(root, '.codex', 'config.toml')
  await fs.mkdir(path.dirname(configPath), { recursive: true })

  await fs.writeFile(configPath, [
    '[agents]',
    'max_concurrent_threads_per_session = 256',
    '',
    '[features.multi_agent_v2]',
    'enabled = true',
    'max_concurrent_threads_per_session = 257'
  ].join('\n'))
  const accepted = await readOfficialSubagentConfig(root, { codexHome })
  assert.equal(accepted.maxThreads, 256)
  assert.equal(accepted.multiAgentV2.maxConcurrentThreadsPerSession, 257)
  assert.deepEqual(accepted.blockers, [])

  await fs.writeFile(configPath, '[agents]\nmax_concurrent_threads_per_session = 257\n')
  const rejected = await readOfficialSubagentConfig(root, { codexHome })
  assert.equal(rejected.maxThreads, 256)
  assert.ok(rejected.blockers.includes('project_official_subagent_max_threads_exceeds_hard_cap:257:256'))

  assert.throws(
    () => mergeOfficialSubagentConfig('', { defaultMaxThreads: 257 }),
    /max_threads_must_be_integer_1_to_256:257/
  )
})

test('legacy SKS-owned 4/5/6/12 defaults migrate only with proven ownership', () => {
  for (const value of [4, 5, 6, 12]) {
    const userOwned = mergeOfficialSubagentConfig(`[agents]\nmax_threads = ${value}\n`)
    const userParsed = parse(userOwned) as Record<string, any>
    assert.equal(userParsed.agents.max_concurrent_threads_per_session, value)
    assert.equal(Object.hasOwn(userParsed.agents, 'max_threads'), true)

    const sksOwned = mergeOfficialSubagentConfig(`[agents]\nmax_threads = ${value}\n`, { sksOwned: true })
    const ownedParsed = parse(sksOwned) as Record<string, any>
    assert.equal(ownedParsed.agents.max_concurrent_threads_per_session, 256)
    assert.equal(ownedParsed.features.multi_agent_v2.max_concurrent_threads_per_session, 257)
    assert.equal(Object.hasOwn(ownedParsed.agents, 'max_threads'), false)
  }
})

test('SKS-owned 12-child and 13-total defaults migrate together to 256 and 257', () => {
  const source = [
    '# SKS-MANAGED-CODEX-CONFIG',
    '[agents]',
    'max_concurrent_threads_per_session = 12',
    '',
    '[features.multi_agent_v2]',
    'enabled = true',
    'max_concurrent_threads_per_session = 13'
  ].join('\n')
  const owned = parse(mergeOfficialSubagentConfig(source, { sksOwned: true })) as Record<string, any>
  assert.equal(owned.agents.max_concurrent_threads_per_session, 256)
  assert.equal(owned.features.multi_agent_v2.max_concurrent_threads_per_session, 257)

  const unowned = parse(mergeOfficialSubagentConfig(source)) as Record<string, any>
  assert.equal(unowned.agents.max_concurrent_threads_per_session, 12)
  assert.equal(unowned.features.multi_agent_v2.max_concurrent_threads_per_session, 13)
})

test('owned config migration removes only exact legacy agent child tables', () => {
  const source = [
    '# SKS-MANAGED-CODEX-CONFIG',
    '[agents]',
    'max_threads = 4',
    '',
    '[agents.analysis_scout]',
    'description = "operator modified scout"',
    'config_file = "./agents/analysis-scout.toml"',
    'nickname_candidates = ["Scout", "Mapper"]',
    '',
    '[agents.native_agent]',
    'description = "SKS native agent with bounded write capability."',
    'config_file = "/tmp/project/.codex/agents/native-agent-intake.toml"',
    'nickname_candidates = ["Analysis", "Mapper"]',
    '',
    '[agents.team_consensus]',
    'description = "SKS planning/debate agent with bounded write capability."',
    'config_file = "./agents/team-consensus.toml"',
    'nickname_candidates = ["Consensus", "Atlas"]',
    '',
    '[agents.implementation_worker]',
    'description = "SKS bounded implementation worker."',
    'config_file = "./agents/implementation-worker.toml"',
    'nickname_candidates = ["Builder", "Mason"]',
    '',
    '[agents.db_safety_reviewer]',
    'description = "DB safety reviewer with bounded write capability."',
    'config_file = "./agents/db-safety-reviewer.toml"',
    'nickname_candidates = ["Sentinel", "Ledger"]',
    '',
    '[agents.qa_reviewer]',
    'description = "QA reviewer with bounded write capability."',
    'config_file = "./agents/qa-reviewer.toml"',
    'nickname_candidates = ["Verifier", "Reviewer"]',
    ''
  ].join('\n')

  const merged = mergeOfficialSubagentConfig(source, { sksOwned: true })
  const agents = (parse(merged) as Record<string, any>).agents
  assert.equal(agents.max_concurrent_threads_per_session, 256)
  assert.equal(agents.analysis_scout.description, 'operator modified scout')
  for (const name of ['native_agent', 'team_consensus', 'implementation_worker', 'db_safety_reviewer', 'qa_reviewer']) {
    assert.equal(Object.hasOwn(agents, name), false, name)
  }
})

test('SKS config ownership accepts only explicit inventory marker receipt or exact legacy-block proof', () => {
  const inventory = officialSubagentConfigOwnershipProof({
    text: '[agents]\nmax_threads = 4\n',
    manifest: { generated_files: { files: ['.codex/config.toml'] } }
  })
  assert.equal(inventory.owned, true)
  assert.ok(inventory.reasons.includes('generated_file_inventory'))

  const marker = officialSubagentConfigOwnershipProof({
    text: '# SKS-MANAGED-CODEX-CONFIG\n[agents]\nmax_threads = 5\n'
  })
  assert.equal(marker.owned, true)
  assert.ok(marker.reasons.includes('managed_marker_or_hash'))

  const currentReceipt = {
    schema: 'sks.project-migration-receipt.v2',
    status: 'current',
    sks_version: PACKAGE_VERSION,
    installation_epoch_sha256: 'a'.repeat(64),
    blockers: [],
    required_blockers: [],
    update_stages: [{
      id: 'official-subagent-config',
      ok: true,
      status: 'completed',
      managed_keys: ['agents.max_threads']
    }]
  }
  const receipt = officialSubagentConfigOwnershipProof({
    text: '[agents]\nmax_threads = 6\n',
    migrationReceipt: currentReceipt
  })
  assert.equal(receipt.owned, true)
  assert.ok(receipt.reasons.includes('migration_receipt:agents.max_concurrent_threads_per_session'))

  for (const migrationReceipt of [
    { ...currentReceipt, status: 'blocked', blockers: ['migration_failed'] },
    { ...currentReceipt, update_stages: [{ id: 'official-subagent-config', ok: false, status: 'failed', managed_keys: ['agents.max_threads'] }] },
    { ...currentReceipt, update_stages: [{ id: 'official-subagent-config', ok: true, status: 'skipped', managed_keys: ['agents.max_threads'] }] },
    { ...currentReceipt, update_stages: [{ id: 'official-subagent-config', ok: true, status: 'completed', detail: { ok: false, managed_keys: ['agents.max_threads'] } }] }
  ]) {
    const rejected = officialSubagentConfigOwnershipProof({
      text: '[agents]\nmax_threads = 6\n',
      migrationReceipt
    })
    assert.deepEqual(rejected, { owned: false, reasons: [] })
  }

  const exactLegacy = officialSubagentConfigOwnershipProof({
    text: [
      '[agents.native_agent]',
      'description = "SKS native agent with bounded write capability."',
      'config_file = "./agents/native-agent-intake.toml"',
      'nickname_candidates = ["Analysis", "Mapper"]',
      '',
      '[agents.team_consensus]',
      'description = "SKS planning/debate agent with bounded write capability."',
      'config_file = "./agents/team-consensus.toml"',
      'nickname_candidates = ["Consensus", "Atlas"]',
      '',
      '[agents.implementation_worker]',
      'description = "SKS bounded implementation worker."',
      'config_file = "./agents/implementation-worker.toml"',
      'nickname_candidates = ["Builder", "Mason"]',
      ''
    ].join('\n')
  })
  assert.equal(exactLegacy.owned, true)
  assert.ok(exactLegacy.reasons.includes('exact_legacy_managed_blocks:3'))

  const userOwned = officialSubagentConfigOwnershipProof({
    text: '[agents]\nmax_threads = 5\n'
  })
  assert.deepEqual(userOwned, { owned: false, reasons: [] })
})

test('agents parent table is inserted safely before an existing custom child table', () => {
  const merged = mergeOfficialSubagentConfig('[agents.custom]\ndescription = "user role"\n')
  const parsed = parse(merged) as Record<string, any>

  assert.equal(parsed.agents.max_concurrent_threads_per_session, 256)
  assert.equal(parsed.agents.custom.description, 'user role')
  assert.ok(merged.indexOf('[agents]') < merged.indexOf('[agents.custom]'))
})

test('official config merge supports an agents header with an inline comment', () => {
  const source = '# SKS-MANAGED-CODEX-CONFIG\n[agents] # operator note\nmax_threads = 4\n'
  const merged = mergeOfficialSubagentConfig(source, { sksOwned: true })
  const parsed = parse(merged) as Record<string, any>

  assert.equal(parsed.agents.max_concurrent_threads_per_session, 256)
  assert.equal(parsed.agents.max_depth, 1)
  assert.equal(Object.hasOwn(parsed.agents, 'job_max_runtime_seconds'), false)
  assert.equal(parsed.agents.interrupt_message, true)
  assert.match(merged, /\[agents\] # operator note/)
})

test('official doctor repair does not treat generic multi_agent config as SKS ownership', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-config-near-miss-'))
  const configPath = path.join(root, '.codex', 'config.toml')
  const original = '[features]\nmulti_agent = true\n\n[agents]\nmax_threads = 4\n'
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, original)

  const result = await repairAgentConfigFileReferences({ root, apply: true, reportPath: null })
  assert.equal(result.ok, false)
  assert.equal(result.manual_required, true)
  assert.deepEqual(result.ownership_proof, { owned: false, reasons: [] })
  assert.ok(result.blockers.includes('user_owned_file_without_sks_marker'))
  assert.equal(await fs.readFile(configPath, 'utf8'), original)
})

test('official doctor repair backs up invalid project TOML before unmanaged rejection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-config-invalid-doctor-'))
  const configPath = path.join(root, '.codex', 'config.toml')
  const invalid = '[agents\nmax_threads = 4\n'
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, invalid)

  const result = await repairAgentConfigFileReferences({ root, apply: true, reportPath: null })
  assert.equal(result.ok, false)
  assert.equal(result.manual_required, true)
  assert.ok(result.blockers.includes('project_official_subagent_config_toml_parse_failed'))
  assert.ok(result.blockers.includes('user_owned_file_without_sks_marker'))
  assert.ok(result.backup_path)
  assert.equal(await fs.readFile(configPath, 'utf8'), invalid)
  assert.equal(await fs.readFile(String(result.backup_path), 'utf8'), invalid)
})

test('fresh agent install materializes the complete project-scoped custom agent catalog', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-agents-'))
  const legacy = path.join(root, '.codex', 'agents', 'analysis-scout.toml')
  await fs.mkdir(path.dirname(legacy), { recursive: true })
  await fs.writeFile(legacy, 'name = "user_legacy_role"\n')

  const first = await installOfficialSubagentAgentConfigs(root)
  const files = (await fs.readdir(path.dirname(legacy))).sort()
  const expectedRoleFiles = MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.filename).sort()
  assert.deepEqual(files, ['analysis-scout.toml', ...expectedRoleFiles].sort())
  assert.deepEqual(first.created.sort(), expectedRoleFiles.map((filename) => `.codex/agents/${filename}`).sort())
  assert.deepEqual(first.generated_files.sort(), expectedRoleFiles.map((filename) => `.codex/agents/${filename}`).sort())
  assert.equal(await fs.readFile(legacy, 'utf8'), 'name = "user_legacy_role"\n')

  for (const role of MANAGED_OFFICIAL_SUBAGENT_ROLES) {
    const text = await fs.readFile(path.join(root, '.codex', 'agents', role.filename), 'utf8')
    const parsed = parse(text) as Record<string, any>
    assert.equal(parsed.name, role.codex_name)
    assert.equal(parsed.model, role.model)
    assert.equal(parsed.model_reasoning_effort, role.model_reasoning_effort)
    assert.equal(Object.hasOwn(parsed, 'sandbox_mode'), role.sandbox === 'read-only')
    assert.equal(parsed.sandbox_mode, role.sandbox)
  }

  const second = await installOfficialSubagentAgentConfigs(root)
  assert.deepEqual(second.created, [])
  assert.deepEqual(second.updated, [])
  assert.deepEqual(second.existing.sort(), expectedRoleFiles.map((filename) => `.codex/agents/${filename}`).sort())
})

test('retired SKS-owned role sets are removed and modified collisions are quarantined', async () => {
  for (const legacyCount of [4, 5, 6]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `sks-official-agent-legacy-${legacyCount}-`))
    const agentsDir = path.join(root, '.codex', 'agents')
    await fs.mkdir(agentsDir, { recursive: true })
    for (const role of RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES.slice(0, legacyCount)) {
      await fs.writeFile(path.join(agentsDir, role.filename), managedAgentRoleContent(role))
    }
    const modifiedRole = RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES[legacyCount]
    assert.ok(modifiedRole)
    const modifiedPath = path.join(agentsDir, modifiedRole.filename)
    await fs.writeFile(modifiedPath, managedAgentRoleContent(modifiedRole).replace(modifiedRole.description, 'operator modified role'))

    const result = await reconcileRetiredAgentRoleResidue({ root, home: path.join(root, 'home'), fix: true })
    assert.equal(result.ok, true)
    assert.equal(result.removed_count, legacyCount)
    assert.equal(result.quarantined_user_collision_count, 1)
    assert.equal(result.remaining_count, 0)
    for (const role of RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES.slice(0, legacyCount)) {
      await assert.rejects(fs.access(path.join(agentsDir, role.filename)))
    }
    await assert.rejects(fs.access(modifiedPath))
    const quarantined = await findFile(path.join(root, '.sneakoscope', 'quarantine'), modifiedRole.filename)
    assert.ok(quarantined)
    assert.equal(await fs.readFile(quarantined!, 'utf8'), managedAgentRoleContent(modifiedRole).replace(modifiedRole.description, 'operator modified role'))
  }
})

test('retired agent cleanup never follows role roots or role-file symlinks outside their owner root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retired-agent-symlink-root-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retired-agent-symlink-outside-'))
  try {
    const home = path.join(root, 'home')
    const globalAgentsDir = path.join(home, '.codex', 'agents')
    const projectAgentsDir = path.join(root, '.codex', 'agents')
    const role = RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES[0]
    assert.ok(role)
    const outsideRootFile = path.join(outside, 'root-role.toml')
    const outsideLeafFile = path.join(outside, 'leaf-role.toml')
    const rootBytes = Buffer.from(managedAgentRoleContent(role))
    const leafBytes = Buffer.from('name = "customer-external-role"\n')
    await fs.mkdir(path.dirname(globalAgentsDir), { recursive: true })
    await fs.mkdir(projectAgentsDir, { recursive: true })
    await fs.writeFile(outsideRootFile, rootBytes)
    await fs.writeFile(outsideLeafFile, leafBytes)
    await fs.symlink(outside, globalAgentsDir)
    await fs.symlink(outsideLeafFile, path.join(projectAgentsDir, role.filename))

    const result = await reconcileRetiredAgentRoleResidue({ root, home, codexHome: path.join(home, '.codex'), fix: true })
    assert.equal(result.ok, true)
    assert.equal(result.quarantined_user_collision_count, 2)
    assert.deepEqual(await fs.readFile(outsideRootFile), rootBytes)
    assert.deepEqual(await fs.readFile(outsideLeafFile), leafBytes)
    await assert.rejects(fs.lstat(globalAgentsDir))
    await assert.rejects(fs.lstat(path.join(projectAgentsDir, role.filename)))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test('retired agent cleanup covers HOME and global-runtime disabled backups with marker proof', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retired-agent-global-roots-'))
  try {
    const home = path.join(root, 'home')
    const globalRuntimeRoot = path.join(root, 'global-runtime')
    const role = RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES[0]
    assert.ok(role)
    const homeBackupDir = path.join(home, '.codex', 'agents-disabled', 'sks')
    const runtimeBackupDir = path.join(globalRuntimeRoot, '.codex', 'agents-disabled', 'sks')
    const runtimeActiveDir = path.join(globalRuntimeRoot, '.codex', 'agents')
    const managedHomeBackup = path.join(homeBackupDir, `${role.filename}.bak`)
    const managedRuntimeBackup = path.join(runtimeBackupDir, `${role.filename}.legacy.bak`)
    const managedRuntimeActiveBackup = path.join(runtimeActiveDir, `${role.filename}.legacy.bak`)
    const customerBackup = path.join(runtimeBackupDir, `${role.filename.replace(/\.toml$/i, '')}-customer.bak`)
    const customerBytes = Buffer.from('name = "customer-backup"\n')
    await fs.mkdir(homeBackupDir, { recursive: true })
    await fs.mkdir(runtimeBackupDir, { recursive: true })
    await fs.mkdir(runtimeActiveDir, { recursive: true })
    await fs.writeFile(managedHomeBackup, managedAgentRoleContent(role))
    await fs.writeFile(managedRuntimeBackup, managedAgentRoleContent(role))
    await fs.writeFile(managedRuntimeActiveBackup, managedAgentRoleContent(role))
    await fs.writeFile(customerBackup, customerBytes)

    const result = await reconcileRetiredAgentRoleResidue({
      root,
      home,
      codexHome: path.join(home, '.codex'),
      globalRuntimeRoot,
      fix: true
    })
    assert.equal(result.ok, true)
    assert.equal(result.removed_count, 3)
    assert.equal(result.quarantined_user_collision_count, 1)
    await assert.rejects(fs.access(managedHomeBackup))
    await assert.rejects(fs.access(managedRuntimeBackup))
    await assert.rejects(fs.access(managedRuntimeActiveBackup))
    await assert.rejects(fs.access(customerBackup))
    const quarantined = await findFile(path.join(globalRuntimeRoot, '.sneakoscope', 'quarantine'), path.basename(customerBackup))
    assert.ok(quarantined)
    assert.deepEqual(await fs.readFile(quarantined!), customerBytes)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('retired agent cleanup accepts an external CODEX_HOME as its own managed boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retired-agent-external-codex-home-'))
  try {
    const project = path.join(root, 'project')
    const home = path.join(root, 'home')
    const codexHome = path.join(root, 'codex-home')
    const role = RETIRED_MANAGED_AGENT_ROLE_TOMBSTONES[0]
    assert.ok(role)
    const activeRole = path.join(codexHome, 'agents', role.filename)
    const disabledRole = path.join(codexHome, 'agents-disabled', 'sks', `${role.filename}.legacy.bak`)
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(path.dirname(activeRole), { recursive: true })
    await fs.mkdir(path.dirname(disabledRole), { recursive: true })
    await fs.writeFile(activeRole, managedAgentRoleContent(role))
    await fs.writeFile(disabledRole, managedAgentRoleContent(role))

    const result = await reconcileRetiredAgentRoleResidue({ root: project, home, codexHome, fix: true })
    assert.equal(result.ok, true)
    assert.equal(result.removed_count, 2)
    assert.equal(result.remaining_count, 0)
    assert.equal(result.error_count, 0)
    await assert.rejects(fs.access(activeRole))
    await assert.rejects(fs.access(disabledRole))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('marker plus body hash owns generated files and detects user modification', () => {
  for (const role of MANAGED_OFFICIAL_SUBAGENT_ROLES) {
    const managed = managedOfficialSubagentRoleContent(role)
    assert.equal(managedOfficialSubagentRoleOwnsText(managed, role), true)
    assert.equal(managedOfficialSubagentRoleOwnsText(managed.replace(role.model, `${role.model}-changed`), role), false)
  }
})

test('user collisions and invalid TOML are preserved with manual blockers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-agent-collision-'))
  const agentsDir = path.join(root, '.codex', 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  const workerPath = path.join(agentsDir, 'worker.toml')
  const expertPath = path.join(agentsDir, 'expert.toml')
  const customWorker = 'name = "worker"\ndescription = "my custom worker"\n'
  const invalidExpert = 'name = "expert"\ndeveloper_instructions = """\nunterminated\n'
  await fs.writeFile(workerPath, customWorker)
  await fs.writeFile(expertPath, invalidExpert)

  const result = await installOfficialSubagentAgentConfigs(root)
  assert.equal(result.ok, false)
  assert.equal(await fs.readFile(workerPath, 'utf8'), customWorker)
  assert.equal(await fs.readFile(expertPath, 'utf8'), invalidExpert)
  assert.ok(result.manual_blockers.includes('manual_user_owned_official_subagent_collision:.codex/agents/worker.toml'))
  assert.ok(result.manual_blockers.includes('manual_invalid_official_subagent_toml:.codex/agents/expert.toml'))
  assert.equal(result.backups.length, 1)
  assert.equal(await fs.readFile(path.join(root, result.backups[0] || ''), 'utf8'), invalidExpert)
})

test('official config reader resolves project over global and preserves inherited values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-config-read-'))
  const codexHome = path.join(root, 'home', '.codex')
  await fs.mkdir(path.join(root, '.codex'), { recursive: true })
  await fs.mkdir(codexHome, { recursive: true })
  await fs.writeFile(path.join(root, '.codex', 'config.toml'), '[agents]\nmax_depth = 1\n')
  await fs.writeFile(path.join(codexHome, 'config.toml'), '[agents]\nmax_threads = 20\nmax_depth = 3\ninterrupt_message = false\n')

  const config = await readOfficialSubagentConfig(root, { codexHome })
  assert.equal(config.maxThreads, 20)
  assert.equal(config.sources.maxThreads, 'global')
  assert.equal(config.maxDepth, 1)
  assert.equal(config.sources.maxDepth, 'project')
  assert.equal(config.interruptMessage, false)
  assert.equal(config.sources.interruptMessage, 'global')
  assert.deepEqual(config.warnings, ['global_legacy_agents_max_threads_present'])
})

test('max_depth above one is coerced to one and reported as a warning', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-config-depth-warning-'))
  const codexHome = path.join(root, 'home', '.codex')
  await fs.mkdir(path.join(root, '.codex'), { recursive: true })
  await fs.mkdir(codexHome, { recursive: true })
  const original = '[agents]\nmax_threads = 3\nmax_depth = 4\n'
  await fs.writeFile(path.join(root, '.codex', 'config.toml'), original)

  const merged = mergeOfficialSubagentConfig(original)
  assert.equal((parse(merged) as Record<string, any>).agents.max_depth, 4)
  const config = await readOfficialSubagentConfig(root, { codexHome })
  assert.equal(config.maxDepth, 1)
  assert.equal(config.sources.maxDepth, 'default')
  assert.deepEqual(config.warnings, [
    'official_subagent_max_depth_coerced_to_one:4:project',
    'project_legacy_agents_max_threads_present'
  ])
})

test('project setup migrates marker-proven legacy max_threads without requiring a current manifest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-config-marker-migration-'))
  const home = path.join(root, 'home')
  const configPath = path.join(root, '.codex', 'config.toml')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, '# SKS-MANAGED-CODEX-CONFIG\n[agents]\nmax_threads = 4\n')

  const result = await initProject(root, {
    installScope: 'project',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })
  const parsed = parse(await fs.readFile(configPath, 'utf8')) as Record<string, any>
  assert.equal(parsed.agents.max_concurrent_threads_per_session, 256)
  assert.equal(result.codex_config_install.ownership_proof.owned, true)
  assert.ok(result.codex_config_install.ownership_proof.reasons.includes('managed_marker_or_hash'))
})

test('doctor repair migrates an SKS-owned legacy thread value and preserves max_depth above one with a warning', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-config-doctor-migration-'))
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(root, '.codex', 'config.toml')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, '# SKS-MANAGED-CODEX-CONFIG\n[agents]\nmax_threads = 6\nmax_depth = 4\n')

  const result = await repairCodexStartupConfig({ root, apply: true, home, codexHome })
  const parsed = parse(await fs.readFile(configPath, 'utf8')) as Record<string, any>
  assert.equal(result.ok, true)
  assert.equal(parsed.agents.max_concurrent_threads_per_session, 256)
  assert.equal(parsed.agents.max_depth, 4)
  assert.equal(Object.hasOwn(parsed.agents, 'job_max_runtime_seconds'), false)
  assert.equal(parsed.agents.interrupt_message, true)
  assert.ok(result.config_file_repair.warnings.includes('official_subagent_max_depth_coerced_to_one:4:project'))
  assert.deepEqual(
    (await fs.readdir(path.join(root, '.codex', 'agents'))).sort(),
    MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.filename).sort()
  )
})

test('project setup backs up and preserves invalid config TOML without overwriting it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-config-invalid-'))
  const home = path.join(root, 'home')
  const configPath = path.join(root, '.codex', 'config.toml')
  const invalid = '[agents\nmax_threads = 5\n'
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, invalid)

  const result = await initProject(root, {
    installScope: 'project',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })
  assert.equal(result.codex_config_install.status, 'unparseable_config_preserved')
  assert.equal(await fs.readFile(configPath, 'utf8'), invalid)
  assert.equal(await fs.readFile(result.codex_config_install.backup_path, 'utf8'), invalid)
})

test('setup repair preserves current-role collisions and quarantines retired-role collisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-agent-repair-preserve-'))
  const home = path.join(root, 'home')
  const agentsDir = path.join(root, '.codex', 'agents')
  const workerPath = path.join(agentsDir, 'worker.toml')
  const expertPath = path.join(agentsDir, 'expert.toml')
  const legacyPath = path.join(agentsDir, 'analysis-scout.toml')
  const customWorker = 'name = "worker"\ndescription = "custom user worker"\n'
  const invalidExpert = 'name = "expert"\ndeveloper_instructions = """\ninvalid\n'
  const legacy = 'name = "legacy_user_role"\n'
  await fs.mkdir(agentsDir, { recursive: true })
  await fs.writeFile(workerPath, customWorker)
  await fs.writeFile(expertPath, invalidExpert)
  await fs.writeFile(legacyPath, legacy)

  const result = await initProject(root, {
    installScope: 'project',
    localOnly: true,
    repair: true,
    home,
    codexHome: path.join(home, '.codex')
  })
  assert.equal(await fs.readFile(workerPath, 'utf8'), customWorker)
  assert.equal(await fs.readFile(expertPath, 'utf8'), invalidExpert)
  await assert.rejects(fs.access(legacyPath))
  const quarantinedLegacy = await findFile(path.join(root, '.sneakoscope', 'quarantine'), 'analysis-scout.toml')
  assert.ok(quarantinedLegacy)
  assert.equal(await fs.readFile(quarantinedLegacy!, 'utf8'), legacy)
  assert.ok(result.agent_install.manual_blockers.includes('manual_user_owned_official_subagent_collision:.codex/agents/worker.toml'))
  assert.ok(result.agent_install.manual_blockers.includes('manual_invalid_official_subagent_toml:.codex/agents/expert.toml'))
  assert.equal(result.agent_install.backups.length, 1)
})

test('generated Naruto skill describes the official workflow and retired aliases stay absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-skill-copy-'))
  const home = path.join(root, 'home')
  await initProject(root, {
    installScope: 'global',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })

  const agentsRules = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')
  const naruto = await fs.readFile(path.join(home, '.agents', 'skills', 'sks-naruto', 'SKILL.md'), 'utf8')
  await assert.rejects(fs.access(path.join(root, '.agents', 'skills', 'sks-naruto', 'SKILL.md')))
  assert.match(naruto, /Codex official subagent workflow/)
  assert.match(naruto, /--agents N/)
  assert.match(naruto, /later root-owned waves/)
  assert.match(naruto, /max_threads defaults to a 256-child frame budget cap, never a target/)
  assert.match(naruto, /max_depth=1 blocks nested delegation/)
  assert.match(naruto, /Route tiny mechanical and mass shards to Luna Max, broad search and exploration shards to Terra Max, and implementation or judgment to Sol/)
  assert.match(naruto, /sks\.core-engineering-directive\.v1/)
  assert.match(naruto, /subagent-plan\.json/)
  assert.match(naruto, /subagent-parent-summary\.json/)
  assert.doesNotMatch(naruto, /GPT-5\.6 Sol Max|Browser\/Chrome/)
  assert.doesNotMatch(naruto, /verification-summary\.json|five-artifact/)
  assert.doesNotMatch(naruto, /native shadow-clone|up to 100|--backend codex-exec|--clones N/)
  assert.match(agentsRules, /`\$sks-naruto` Codex official subagent workflow/)
  assert.match(agentsRules, /reuse capacity across root-owned waves/)
  assert.match(agentsRules, /Luna Max for tiny mechanical work/)
  assert.match(agentsRules, /Sol High for implementation/)
  assert.match(agentsRules, /Terra Max for read-heavy context/)
  assert.match(agentsRules, /Sol Max only for focused judgment/)
  assert.doesNotMatch(agentsRules, /native agent intake agents|fresh executor team/)
  assert.doesNotMatch(agentsRules, /\$Team|sks team|\$MAD-DB|sks mad-db/)
  for (const name of ['team', 'mad-db', 'swarm', 'shadow-clone', 'kage-bunshin']) {
    await assert.rejects(fs.access(path.join(home, '.agents', 'skills', name, 'SKILL.md')))
  }
})

test('project setup never writes through a project .agents symlink to an external skill root', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-project-skill-root-external-alias-'))
  const root = path.join(fixture, 'project')
  const home = path.join(fixture, 'home')
  const outsideAgents = path.join(fixture, 'outside-agents')
  const marker = path.join(outsideAgents, 'user-owned.txt')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(outsideAgents, { recursive: true })
  await fs.writeFile(marker, 'preserve me\n')
  await fs.symlink(outsideAgents, path.join(root, '.agents'), 'dir')
  const before = await fs.readdir(outsideAgents)

  const result: any = await initProject(root, {
    installScope: 'global',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })

  assert.deepEqual(await fs.readdir(outsideAgents), before)
  assert.equal(await fs.readFile(marker, 'utf8'), 'preserve me\n')
  await assert.rejects(fs.access(path.join(outsideAgents, 'skills')))
  assert.equal((await fs.lstat(path.join(root, '.agents'))).isSymbolicLink(), true)
  assert.equal(result.skill_install.ok, false)
  assert.ok(result.skill_install.project_residue_reconcile.warnings.some((warning: string) => (
    warning.startsWith('retired_skill_cleanup_failed:')
      || warning.startsWith('skill_target_prepare_failed:')
  )))
})

test('project setup accepts exact .agents and skills aliases to the authoritative global skill root without cleanup', async () => {
  for (const aliasKind of ['agents', 'skills'] as const) {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), `sks-project-skill-root-${aliasKind}-alias-`))
    const root = path.join(fixture, 'project')
    const home = path.join(fixture, 'home')
    const globalAgents = path.join(home, '.agents')
    const globalSkills = path.join(globalAgents, 'skills')
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(globalSkills, { recursive: true })
    if (aliasKind === 'agents') {
      await fs.symlink(globalAgents, path.join(root, '.agents'), 'dir')
    } else {
      await fs.mkdir(path.join(root, '.agents'), { recursive: true })
      await fs.symlink(globalSkills, path.join(root, '.agents', 'skills'), 'dir')
    }

    const result: any = await initProject(root, {
      installScope: 'global',
      localOnly: true,
      home,
      codexHome: path.join(home, '.codex')
    })

    assert.equal(result.skill_install.ok, true, aliasKind)
    assert.equal(result.skill_install.project_residue_reconcile, undefined, aliasKind)
    assert.equal(result.created.includes('.agents/skills official residue reconciled'), false, aliasKind)
    assert.equal(
      await fs.realpath(path.join(root, '.agents', 'skills')),
      await fs.realpath(globalSkills),
      aliasKind
    )
    assert.match(
      await fs.readFile(path.join(globalSkills, 'sks-naruto', 'SKILL.md'), 'utf8'),
      /Codex official subagent workflow/,
      aliasKind
    )
  }
})

test('stale generated prune never deletes legacy or user Codex agent files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-agent-prune-'))
  const legacy = path.join(root, '.codex', 'agents', 'analysis-scout.toml')
  await fs.mkdir(path.dirname(legacy), { recursive: true })
  await fs.writeFile(legacy, 'name = "legacy"\n')

  const result = await pruneStaleGeneratedFiles(root, {
    generated_files: { files: ['.codex/agents/analysis-scout.toml'] }
  }, [])
  assert.deepEqual(result.pruned, [])
  assert.equal(await fs.readFile(legacy, 'utf8'), 'name = "legacy"\n')
})

test('global setup quarantines a user-adopted legacy project skill before stale manifest pruning', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-skill-manifest-user-adopted-'))
  const home = path.join(root, 'home')
  const skill = path.join(root, '.agents', 'skills', 'sks-naruto', 'SKILL.md')
  const userText = '---\nname: sks-naruto\ndescription: user-authored replacement\n---\n\nUser content.\n'
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.mkdir(path.join(root, '.sneakoscope'), { recursive: true })
  await fs.writeFile(skill, userText)
  await fs.writeFile(path.join(root, '.sneakoscope', 'manifest.json'), JSON.stringify({
    generated_files: { files: ['.agents/skills/sks-naruto/SKILL.md'] }
  }))

  const result: any = await initProject(root, {
    installScope: 'global',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })

  await assert.rejects(fs.access(skill))
  const quarantined = await findFile(path.join(root, '.sneakoscope', 'quarantine'), 'SKILL.md')
  assert.ok(quarantined)
  assert.equal(await fs.readFile(String(quarantined), 'utf8'), userText)
  assert.equal(result.generated_cleanup.pruned.includes('.agents/skills/sks-naruto/SKILL.md'), false)
  assert.ok(result.skill_install.project_residue_reconcile.quarantined_user_collisions.includes('sks-naruto'))
})

test('project setup quarantines markerless user prose that resembles historical generated skill text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-skill-markerless-generated-prose-'))
  const home = path.join(root, 'home')
  const skill = path.join(root, '.agents', 'skills', 'sks-naruto', 'SKILL.md')
  const userText = [
    '---',
    'name: sks-naruto',
    'description: user-authored workflow notes',
    '---',
    '',
    'Sneakoscope generated is discussed here as ordinary user-authored prose.',
    'Codex App pipeline activation: this sentence is not an ownership marker.',
    'Keep this content.',
    ''
  ].join('\n')
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, userText)

  const result: any = await initProject(root, {
    installScope: 'global',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })

  await assert.rejects(fs.access(skill))
  const quarantined = await findFile(path.join(root, '.sneakoscope', 'quarantine'), 'SKILL.md')
  assert.ok(quarantined)
  assert.equal(await fs.readFile(String(quarantined), 'utf8'), userText)
  assert.ok(result.skill_install.project_residue_reconcile.quarantined_user_collisions.includes('sks-naruto'))
  assert.equal(result.skill_install.project_residue_reconcile.removed.includes('.agents/skills/sks-naruto'), false)
})

test('global setup quarantines a user-authored current official skill before installing the managed copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-current-skill-user-collision-'))
  const home = path.join(root, 'home')
  const skill = path.join(home, '.agents', 'skills', 'sks-answer', 'SKILL.md')
  const userText = '---\nname: sks-answer\ndescription: my user-authored SKS answer helper\n---\n\nKeep this content.\n'
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, userText)

  const result: any = await initProject(root, {
    installScope: 'global',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })

  const installed = await fs.readFile(skill, 'utf8')
  assert.match(installed, /BEGIN SKS MANAGED SKILL/)
  assert.notEqual(installed, userText)
  const quarantined = await findFile(path.join(home, '.sneakoscope', 'quarantine'), 'SKILL.md')
  assert.ok(quarantined)
  assert.equal(await fs.readFile(String(quarantined), 'utf8'), userText)
  assert.ok(result.skill_install.quarantined_user_collisions.includes('sks-answer'))
})

test('global setup quarantines markerless core user bytes before installing the packaged managed core', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-current-core-skill-user-collision-'))
  const home = path.join(root, 'home')
  const skill = path.join(home, '.agents', 'skills', 'sks-naruto', 'SKILL.md')
  const userBytes = Buffer.from([
    '---',
    'name: sks-naruto',
    'description: my markerless user-authored Naruto workflow',
    '---',
    '',
    'Preserve these exact user bytes.\r',
    ''
  ].join('\n'), 'utf8')
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, userBytes)

  const result: any = await initProject(root, {
    installScope: 'global',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })

  const expectedText = renderCoreSkillTemplate('sks-naruto')
  const expected = buildSksCoreSkillManifest('1970-01-01T00:00:00.000Z').skills.find((row) => (
    row.canonical_name === 'sks-naruto'
  ))
  assert.ok(expected)
  const installedBytes = await fs.readFile(skill)
  assert.deepEqual(installedBytes, Buffer.from(expectedText, 'utf8'))
  assert.equal(sha256(installedBytes), expected.content_sha256)

  const quarantined = await findFile(path.join(home, '.sneakoscope', 'quarantine'), 'SKILL.md')
  assert.ok(quarantined)
  assert.deepEqual(await fs.readFile(String(quarantined)), userBytes)
  assert.ok(result.skill_install.quarantined_user_collisions.includes('sks-naruto'))
  assert.equal(result.skill_install.ok, true)
  assert.equal(result.skill_install.core_skill_integrity.ok, true)

  const integrity = JSON.parse(await fs.readFile(
    path.join(home, '.sneakoscope', 'reports', 'core-skill-integrity.json'),
    'utf8'
  ))
  const narutoRow = integrity.rows.find((row: any) => row.canonical_name === 'sks-naruto')
  assert.equal(integrity.ok, true)
  assert.ok(narutoRow)
  assert.equal(narutoRow.after_sha256, expected.content_sha256)
  assert.equal(narutoRow.blocker, null)
})

test('global setup quarantines markerless non-core user prose before installing the managed copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-current-non-core-skill-user-collision-'))
  const home = path.join(root, 'home')
  const skill = path.join(home, '.agents', 'skills', 'sks-release-review', 'SKILL.md')
  const userText = [
    '---',
    'name: sks-release-review',
    'description: my user-authored release helper',
    '---',
    '',
    'Sneakoscope generated is discussed here as ordinary user-authored prose.',
    'Codex App pipeline activation: this sentence is not an ownership marker.',
    'Keep this content.',
    ''
  ].join('\n')
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, userText)

  const result: any = await initProject(root, {
    installScope: 'global',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })

  const installed = await fs.readFile(skill, 'utf8')
  assert.match(installed, /BEGIN SKS MANAGED SKILL/)
  assert.notEqual(installed, userText)
  const quarantined = await findFile(path.join(home, '.sneakoscope', 'quarantine'), 'SKILL.md')
  assert.ok(quarantined)
  assert.equal(await fs.readFile(String(quarantined), 'utf8'), userText)
  assert.ok(result.skill_install.quarantined_user_collisions.includes('sks-release-review'))
})

test('project cleanup treats an official directory name as a collision even when SKILL.md declares another name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-skill-dir-name-collision-'))
  const home = path.join(root, 'home')
  const skill = path.join(root, '.agents', 'skills', 'sks-naruto', 'SKILL.md')
  const userText = '---\nname: custom-helper\ndescription: user-authored helper\n---\n\nCodex App pipeline activation: custom user instructions.\n'
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, userText)

  const result: any = await initProject(root, {
    installScope: 'global',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })

  await assert.rejects(fs.access(skill))
  const quarantined = await findFile(path.join(root, '.sneakoscope', 'quarantine'), 'SKILL.md')
  assert.ok(quarantined)
  assert.equal(await fs.readFile(String(quarantined), 'utf8'), userText)
  assert.ok(result.skill_install.project_residue_reconcile.quarantined_user_collisions.includes('sks-naruto'))
})

test('project cleanup quarantines an official-name skill symlink without following or deleting its target', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-skill-symlink-collision-'))
  const home = path.join(root, 'home')
  const target = path.join(root, 'user-skill-target')
  const targetSkill = path.join(target, 'SKILL.md')
  const link = path.join(root, '.agents', 'skills', 'sks-naruto')
  const userText = '---\nname: custom-helper\ndescription: symlink target owned by user\n---\n\nKeep this content.\n'
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(targetSkill, userText)
  await fs.mkdir(path.dirname(link), { recursive: true })
  await fs.symlink(target, link, 'dir')

  const result: any = await initProject(root, {
    installScope: 'global',
    localOnly: true,
    home,
    codexHome: path.join(home, '.codex')
  })

  await assert.rejects(fs.lstat(link))
  assert.equal(await fs.readFile(targetSkill, 'utf8'), userText)
  const recordFile = await findFile(path.join(root, '.sneakoscope', 'quarantine'), 'quarantine-record.json')
  assert.ok(recordFile)
  const record = JSON.parse(await fs.readFile(String(recordFile), 'utf8'))
  assert.equal((await fs.lstat(record.quarantine_path)).isSymbolicLink(), true)
  assert.ok(result.skill_install.project_residue_reconcile.quarantined_user_collisions.includes('sks-naruto'))
})

async function findFile(root: string, name: string): Promise<string | null> {
  const rows = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const row of rows) {
    const file = path.join(root, row.name)
    if (row.isDirectory()) {
      const nested = await findFile(file, name)
      if (nested) return nested
    } else if (row.name === name) return file
  }
  return null
}
