import path from 'node:path'
import os from 'node:os'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import { repairAgentRoleConfigs } from '../agents/agent-role-config.js'
import { MANAGED_OFFICIAL_SUBAGENT_ROLES } from '../managed-assets/managed-assets-manifest.js'
import { agentRolePayloadFor, probeCodexAgentTypeSupport } from './codex-agent-type-probe.js'
import type { CodexAgentRolePayload, CodexAgentTypeProbe } from './codex-app-types.js'
import { messageOf } from '../errors/message.js'

const OFFICIAL_ROLES = MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.codex_name)

interface CodexAgentRoleSyncReport {
  schema: 'sks.codex-agent-role-sync.v1'
  generated_at: string
  ok: boolean
  apply: boolean
  agent_type_supported: boolean
  fallback: CodexAgentRolePayload['strategy']
  strategy: CodexAgentRolePayload['strategy']
  probe_artifact_path: string
  clobbered_user_roles: false
  codex_home: string
  official_roles: string[]
  directive_roles: string[]
  role_payloads: Record<string, CodexAgentRolePayload>
  agent_type_probe: CodexAgentTypeProbe
  created: string[]
  updated: string[]
  base_repair: unknown
  blockers: string[]
}

export async function syncCodexAgentRoles(input: {
  root: string
  apply?: boolean
  codexHome?: string
  agentTypeSupported?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<CodexAgentRoleSyncReport> {
  const root = path.resolve(input.root)
  const env = input.env || process.env
  const codexHome = input.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const baseRepair = await repairAgentRoleConfigs({
    root,
    apply: input.apply === true,
    codexHome,
    reportPath: path.join(root, '.sneakoscope', 'reports', 'agent-role-config-repair.json')
  }).catch((err: unknown) => ({ ok: false, blockers: [messageOf(err)] }))
  const agentTypeProbe = input.agentTypeSupported === undefined
    ? await probeCodexAgentTypeSupport(root, { env }).catch((err: unknown) => ({
      schema: 'sks.codex-agent-type-probe.v1' as const,
      generated_at: nowIso(),
      ok: false,
      supported: false,
      source: 'unknown' as const,
      spawn_tool_name: 'unknown' as const,
      schema_path: null,
      evidence: [],
      blockers: [messageOf(err)],
      warnings: ['agent_type_probe_failed_message_role_fallback']
    }))
    : {
      schema: 'sks.codex-agent-type-probe.v1' as const,
      generated_at: nowIso(),
      ok: true,
      supported: input.agentTypeSupported,
      source: 'fixture' as const,
      spawn_tool_name: input.agentTypeSupported ? 'spawn_agent' as const : 'unknown' as const,
      schema_path: input.agentTypeSupported ? 'input.agentTypeSupported' : null,
      evidence: [`input.agentTypeSupported=${input.agentTypeSupported}`],
      blockers: [],
      warnings: []
    }
  const rolePayloads = Object.fromEntries(OFFICIAL_ROLES.map((role) => [role, agentRolePayloadFor(role, agentTypeProbe)]))
  const created = stringList(baseRepair, 'created')
  const updated = stringList(baseRepair, 'repaired')
  const report: CodexAgentRoleSyncReport = {
    schema: 'sks.codex-agent-role-sync.v1',
    generated_at: nowIso(),
    ok: recordOk(baseRepair) !== false && agentTypeProbe.ok !== false,
    apply: input.apply === true,
    agent_type_supported: agentTypeProbe.supported,
    fallback: agentTypeProbe.supported ? 'agent_type' : 'message-role',
    strategy: agentTypeProbe.supported ? 'agent_type' : 'message-role',
    probe_artifact_path: '.sneakoscope/reports/codex-agent-type-probe.json',
    clobbered_user_roles: false,
    codex_home: codexHome,
    official_roles: [...OFFICIAL_ROLES],
    directive_roles: [],
    role_payloads: rolePayloads as Record<string, CodexAgentRolePayload>,
    agent_type_probe: agentTypeProbe,
    created,
    updated,
    base_repair: baseRepair,
    blockers: blockersOf(baseRepair)
  }
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'codex-agent-role-sync.json'), report).catch(() => undefined)
  return report
}

function blockersOf(value: unknown): string[] {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { blockers?: unknown }).blockers)
    ? ((value as { blockers: unknown[] }).blockers).map((item) => String(item)).filter(Boolean)
    : []
}

function recordOk(value: unknown): boolean | undefined {
  return Boolean(value) && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean'
    ? (value as { ok: boolean }).ok
    : undefined
}

function stringList(value: unknown, key: string): string[] {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[key])
    ? ((value as Record<string, unknown>)[key] as unknown[]).map(String).filter(Boolean)
    : []
}
