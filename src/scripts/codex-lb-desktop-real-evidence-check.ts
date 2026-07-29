#!/usr/bin/env node
import path from 'node:path'
import { writeJsonAtomic } from '../core/fsx.js'
import {
  codexLbDesktopStatusV2,
  readCodexLbDesktopDeepEvidence,
  readCodexLbDesktopDeepEvidenceTrustAnchors
} from '../core/codex-lb/desktop-controller.js'
import {
  CODEX_LB_DESKTOP_REAL_EVIDENCE_CHECK_SCHEMA,
  validateCodexLbDesktopRealEvidence
} from '../core/codex-lb/desktop-real-evidence.js'
import { uniqueValues as unique } from '../core/text/strings.js'

const args = process.argv.slice(2)
const evidencePath = readArg('--evidence')
  || process.env.SKS_CODEX_LB_DESKTOP_REAL_EVIDENCE_PATH
  || null
const trustAnchorsPath = readArg('--trust-anchors')
  || process.env.SKS_CODEX_LB_DESKTOP_REAL_EVIDENCE_TRUST_ANCHORS_PATH
  || null
const home = readArg('--home') || process.env.HOME || null
const maxAgeMs = positiveNumber(
  readArg('--max-age-ms') || process.env.SKS_CODEX_LB_DESKTOP_REAL_EVIDENCE_MAX_AGE_MS
)
const reportPath = path.join(
  process.cwd(),
  '.sneakoscope',
  'reports',
  'codex-lb-desktop-real-evidence-check.json'
)

const blockers: string[] = []
let status: Record<string, unknown> | null = null
let result: any

try {
  status = await codexLbDesktopStatusV2({
    ...(home ? { home } : {}),
    networkProbes: false
  })
  const mode = String(status.mode || 'disabled')
  const bridge = asRecord(status.bridge)
  const endpoint = loopbackCodexEndpoint(bridge.listen_origin)
  if (mode !== 'desktop-native-bridge') blockers.push('codex_lb_desktop_real_evidence_native_mode_required')
  if (!endpoint) blockers.push('codex_lb_desktop_real_evidence_loopback_endpoint_missing')
  if (!evidencePath) blockers.push('codex_lb_desktop_real_evidence_path_missing')
  if (!trustAnchorsPath) blockers.push('codex_lb_desktop_real_evidence_trust_anchors_path_missing')

  if (blockers.length || !evidencePath || !trustAnchorsPath || !endpoint) {
    result = missingResult(mode, endpoint, blockers)
  } else {
    const [evidence, trustAnchors] = await Promise.all([
      readCodexLbDesktopDeepEvidence(evidencePath),
      readCodexLbDesktopDeepEvidenceTrustAnchors(trustAnchorsPath)
    ])
    result = validateCodexLbDesktopRealEvidence(evidence, {
      expectedMode: 'desktop-native-bridge',
      expectedEndpoint: endpoint,
      trustAnchors,
      ...(maxAgeMs ? { maxAgeMs } : {})
    })
  }
} catch (error: unknown) {
  result = missingResult(
    String(status?.mode || 'disabled'),
    loopbackCodexEndpoint(asRecord(status?.bridge).listen_origin),
    [safeError(error)]
  )
}

const report = {
  ...result,
  evidence_path: evidencePath ? path.resolve(evidencePath) : null,
  trust_anchors_path: trustAnchorsPath ? path.resolve(trustAnchorsPath) : null,
  actual_status: {
    mode: status?.mode || null,
    bridge_running: asRecord(status?.bridge).running === true,
    oauth_present: asRecord(status?.oauth).present === true,
    built_in_provider_retained: asRecord(status?.provider).built_in === true
  },
  report_path: path.relative(process.cwd(), reportPath).split(path.sep).join('/')
}
await writeJsonAtomic(reportPath, report)
console.log(JSON.stringify(report, null, 2))
if (report.ok !== true) process.exitCode = 1

function missingResult(mode: string, endpoint: string | null, reasons: string[]): Record<string, unknown> {
  return {
    schema: CODEX_LB_DESKTOP_REAL_EVIDENCE_CHECK_SCHEMA,
    ok: false,
    status: 'real_required_missing',
    release_authorizing: false,
    mode,
    endpoint,
    producer_id: null,
    deep_evidence_validation: null,
    required_true_fields: [],
    required_string_fields: [],
    required_array_fields: [],
    verified_fields: [],
    blockers: unique(reasons.length ? reasons : ['codex_lb_desktop_real_evidence_missing']),
    warnings: []
  }
}

function loopbackCodexEndpoint(value: unknown): string | null {
  try {
    const origin = new URL(String(value || ''))
    if (
      origin.protocol !== 'http:'
      || !['127.0.0.1', '::1'].includes(origin.hostname)
      || origin.username
      || origin.password
      || origin.search
      || origin.hash
    ) return null
    return new URL('/backend-api/codex', origin).toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function readArg(name: string): string | null {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : null
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /^[a-z0-9_:-]+$/i.test(message)
    ? message
    : 'codex_lb_desktop_real_evidence_check_failed'
}
