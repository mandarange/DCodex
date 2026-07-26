#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess } from '../core/fsx.js'
import { resolveCodexNativeInvocationPlan } from '../core/codex-native/codex-native-invocation-router.js'
import { createCodexNativeRuntimeFixture, withFixtureEnv } from './codex-native-runtime-e2e-fixture.js'
import { messageOf } from '../core/errors/message.js'

export async function runCodexNativeDoctorMadRoutingRealBlackbox(): Promise<void> {
  const fixture = await createCodexNativeRuntimeFixture({
    hook: 'unknown',
    agentType: 'unsupported',
    appHandoff: false,
    imagePathExposure: false,
    mcpCandidates: false,
    codeModeWebSearch: false
  })
  await withFixtureEnv(fixture, async () => {
    const doctor = await runProcess(process.execPath, [path.join(process.cwd(), 'dist', 'bin', 'sks.js'), 'doctor', '--json'], {
      cwd: fixture.root,
      env: fixture.env,
      timeoutMs: 120_000,
      maxOutputBytes: 2 * 1024 * 1024
    }).catch((err: unknown) => ({ code: 1, stdout: '', stderr: messageOf(err), timedOut: false }))
    const parsed = parseDoctorJson(doctor.stdout)
    assertGate(parsed.runtime_readiness, 'doctor JSON runtime readiness missing', { stdout_tail: doctor.stdout.slice(-1000), stderr_tail: doctor.stderr.slice(-1000) })
    assertGate(parsed.runtime_readiness.hook_evidence_policy === 'unknown-do-not-count', 'doctor must report unknown hook evidence does not count', parsed.runtime_readiness)
    assertGate(parsed.runtime_readiness.agent_role_strategy === 'message-role', 'doctor must report message-role fallback', parsed.runtime_readiness)

    const madPlan = await resolveCodexNativeInvocationPlan({
      root: fixture.root,
      missionId: fixture.missionId,
      route: '$MAD',
      desiredCapability: 'hook-evidence'
    })
    assertGate(madPlan.selected_strategy === 'blocked', 'MAD hook evidence must block when hook state is unknown', madPlan)
    assertGate(madPlan.blockers.includes('hook_approval_not_approved'), 'MAD hook blocker missing', madPlan)
    const artifact = path.join(fixture.root, '.sneakoscope', 'missions', fixture.missionId, 'codex-native-invocation-plan.mad.hook-evidence.json')
    assertGate(await fileExists(artifact), 'MAD invocation plan artifact missing', { artifact })
  })
  emitGate('pipeline:codex-native-doctor-mad-routing-real-blackbox')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await runCodexNativeDoctorMadRoutingRealBlackbox()

function parseDoctorJson(stdout: string): Record<string, any> {
  const text = stdout.trim()
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    return start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) as Record<string, any> : {}
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    return stat.isFile()
  } catch {
    return false
  }
}

function assertGate(condition: unknown, message: string, detail: unknown = {}): asserts condition {
  if (condition) return
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2))
  process.exit(1)
}

function emitGate(gate: string): void {
  console.log(JSON.stringify({ schema: 'sks.release-gate.v1', ok: true, gate }, null, 2))
}
