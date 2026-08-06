import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import {
  DESKTOP_BRIDGE_RELEASE_DEEP_CAPABILITIES,
  DESKTOP_BRIDGE_RELEASE_EVIDENCE_SCHEMA,
  DESKTOP_BRIDGE_RELEASE_PROVIDERS,
  DESKTOP_BRIDGE_PRODUCTION_ADAPTER_RECEIPT_SCHEMA,
  desktopBridgeDeepArtifactManifestSha256,
  desktopBridgeReleaseSourceIdentitySha256
} from '../desktop-bridge-release-evidence.js'
import {
  inspectPhysicalReleaseGates,
  PHYSICAL_RELEASE_EVIDENCE_ARTIFACT_MANIFEST_SCHEMA,
  PHYSICAL_RELEASE_EVIDENCE_CAPTURE_WORKFLOW,
  PHYSICAL_RELEASE_EVIDENCE_MANIFEST,
  PHYSICAL_RELEASE_GATES_SCHEMA,
  physicalGateObservationsSha256,
  physicalReleaseEvidenceArchivePath,
  physicalReleaseEvidenceManifestPath,
  physicalReleaseGateInspectionPath
} from '../physical-release-gates.js'

const TEST_REPOSITORY = 'mandarange/Sneakoscope-Codex'
const TEST_RUN_ID = '987654321'
const TEST_ADAPTER_EXECUTABLE_SHA256 = 'e'.repeat(64)

export function writePhysicalReleaseEvidence(
  root: string,
  version: string,
  sourceCommit: string,
  options: {
    attested?: boolean
    corruptPngCrc?: boolean
    secretArtifact?: boolean
    wrongAdapterManifest?: boolean
    missingGateFlags?: boolean
    coherentSelfDeclaration?: boolean
  } = {}
): { evidenceArchive: string | null; evidenceRunId: string | null; repository: string | null } {
  const evidenceRoot = path.join(root, 'release-evidence', version)
  fs.mkdirSync(evidenceRoot, { recursive: true })
  const capturedAt = new Date().toISOString()
  const sourceIdentity = desktopBridgeReleaseSourceIdentitySha256(version, sourceCommit)
  const receiptId = 'desktop-bridge-adapter-receipt-001'

  const screenshot = validPng(640, 360)
  if (options.corruptPngCrc) screenshot[screenshot.length - 1] = (screenshot[screenshot.length - 1] ?? 0) ^ 0xff
  writeArtifact(evidenceRoot, 'desktop-bridge/native-ui.png', screenshot)

  const deepArtifacts = DESKTOP_BRIDGE_RELEASE_PROVIDERS.flatMap((providerId) =>
    DESKTOP_BRIDGE_RELEASE_DEEP_CAPABILITIES.map((capability) => {
      const artifactPath = `desktop-bridge/deep/${providerId}-${capability}.json`
      const bytes = Buffer.from(`${JSON.stringify({ provider_id: providerId, capability, real: true })}\n`)
      writeArtifact(evidenceRoot, artifactPath, bytes)
      return {
        schema: 'sks.desktop-bridge-deep-artifact.v1',
        provider_id: providerId,
        capability,
        evidence_kind: 'real',
        attempted: true,
        verified: true,
        stale: false,
        fixture: false,
        mock: false,
        synthetic: false,
        producer_receipt_id: receiptId,
        artifact_path: artifactPath,
        artifact_sha256: sha256(bytes)
      }
    }))

  const adapterReceipt = {
    schema: DESKTOP_BRIDGE_PRODUCTION_ADAPTER_RECEIPT_SCHEMA,
    ok: true,
    release_authorizing: true,
    execution_mode: 'production',
    adapter_id: 'desktop-bridge-production-adapter',
    adapter_version: '1.0.0',
    run_id: 'desktop-bridge-run-001',
    receipt_id: receiptId,
    package_version: version,
    source_commit: sourceCommit,
    source_identity_sha256: sourceIdentity,
    provider_ids: [...DESKTOP_BRIDGE_RELEASE_PROVIDERS],
    artifact_manifest_sha256: desktopBridgeDeepArtifactManifestSha256(deepArtifacts),
    executed_at: capturedAt,
    fixture: false,
    mock: false,
    synthetic: false,
    redacted: true,
    secrets_present: false,
    blockers: []
  }
  const adapterBytes = jsonBytes(adapterReceipt)
  writeArtifact(evidenceRoot, 'desktop-bridge/production-adapter-receipt.json', adapterBytes)

  const provider = (providerId: 'codex-lb' | 'openrouter') => ({
    provider_id: providerId,
    enabled: true,
    credential_state: 'ready',
    credential_fingerprint: `sha256:${(providerId === 'codex-lb' ? 'a' : 'b').repeat(64)}`,
    auth_verified: true,
    catalog_verified: true,
    text_response_verified: true,
    no_fallback_verified: true,
    deep_capabilities: [...DESKTOP_BRIDGE_RELEASE_DEEP_CAPABILITIES],
    blockers: []
  })
  const report = {
    schema: DESKTOP_BRIDGE_RELEASE_EVIDENCE_SCHEMA,
    ok: true,
    status: 'passed',
    release_authorizing: true,
    evidence_kind: 'real',
    fixture: false,
    mock: false,
    synthetic: false,
    capture_platform: 'darwin',
    native_runtime: 'desktop-bridge',
    package_version: version,
    source_commit: sourceCommit,
    source_identity_sha256: sourceIdentity,
    captured_at: capturedAt,
    blockers: [],
    providers: {
      'codex-lb': provider('codex-lb'),
      openrouter: provider('openrouter')
    },
    oauth: {
      schema: 'sks.desktop-bridge-oauth-preservation-evidence.v1',
      auth_before_sha256: 'c'.repeat(64),
      auth_after_sha256: 'c'.repeat(64),
      semantic_identity_before_sha256: 'd'.repeat(64),
      semantic_identity_after_sha256: 'd'.repeat(64),
      semantic_identity_preserved: true,
      auth_file_bytes_preserved: true,
      oauth_forwarded_to_provider: false,
      fixture: false,
      mock: false,
      synthetic: false
    },
    websocket: {
      schema: 'sks.desktop-bridge-websocket-release-evidence.v1',
      upgrade_verified: true,
      protocol_verified: true,
      frame_round_trip_verified: true,
      clean_close_verified: true,
      latency_ms: 12,
      fixture: false,
      mock: false,
      synthetic: false
    },
    native_ui: {
      schema: 'sks.desktop-bridge-native-ui-evidence.v1',
      app: 'sks-menubar',
      visible_provider_ids: [...DESKTOP_BRIDGE_RELEASE_PROVIDERS],
      screenshot_path: 'desktop-bridge/native-ui.png',
      screenshot_sha256: sha256(screenshot),
      fixture: false,
      mock: false,
      synthetic: false
    },
    deep_artifacts: deepArtifacts,
    production_adapter: {
      schema: 'sks.desktop-bridge-production-adapter-binding.v1',
      adapter_id: adapterReceipt.adapter_id,
      adapter_version: adapterReceipt.adapter_version,
      run_id: adapterReceipt.run_id,
      receipt_id: receiptId,
      execution_mode: 'production',
      receipt_path: 'desktop-bridge/production-adapter-receipt.json',
      receipt_sha256: sha256(adapterBytes),
      fixture: false,
      mock: false,
      synthetic: false
    }
  }
  const reportBytes = jsonBytes(report)
  writeArtifact(evidenceRoot, 'desktop-bridge/release-evidence.json', reportBytes)

  const performedAt = capturedAt
  const gates = [
    gate(version, sourceCommit, 'update_5001_directory', 'update.json', {
      directories_encountered: 5001,
      update_status: 'succeeded',
      warning_code: 'guidance_scan_truncated',
      false_residue_blockers: 0
    }),
    gate(version, sourceCommit, 'single_menubar_process', 'menubar.json', {
      process_count: 1,
      running_version: version,
      prior_version: '7.6.0',
      process_readback: true
    }),
    gate(version, sourceCommit, 'codex_lb_measured_request', 'codex-lb.json', {
      selected: true,
      measured: true,
      target_matches_configured: true,
      auth_class: 'gateway-key',
      oauth_fallback: false,
      latency_ms: 42
    }),
    gate(version, sourceCommit, 'telegram_cellular_e2e', 'telegram.json', {
      network: 'cellular',
      paired: true,
      allowlisted: true,
      typed_command: true,
      reply_received: true,
      bot_token_recorded: false
    }),
    gate(version, sourceCommit, 'desktop_bridge_live_evidence', 'desktop-bridge/release-evidence.json', {
      release_authorizing: true,
      capture_platform: 'darwin',
      both_providers_verified: true,
      oauth_preserved: true,
      websocket_verified: true,
      native_ui_screenshot_verified: true,
      production_deep_artifacts_verified: true
    })
  ]
  for (const entry of gates) {
    entry.capture_adapter_id = adapterReceipt.adapter_id
    entry.capture_adapter_version = adapterReceipt.adapter_version
    entry.producer_receipt_id = receiptId
    entry.producer_receipt_sha256 = sha256(adapterBytes)
  }
  if (options.missingGateFlags) delete gates[0].fixture
  for (const entry of gates) {
    entry.performed_at = performedAt
    if (entry.id === 'desktop_bridge_live_evidence') entry.artifact_sha256 = sha256(reportBytes)
    else {
      const invocationId = `physical-${entry.id}-001`
      const outputPath = `${path.basename(entry.artifact_path, '.json')}.producer-output.json`
      const output = {
        schema: 'sks.release-physical-gate-producer-output.v1',
        gate_id: entry.id,
        capture_adapter_id: adapterReceipt.adapter_id,
        capture_adapter_version: adapterReceipt.adapter_version,
        producer_receipt_id: receiptId,
        invocation_id: invocationId,
        fixture: false,
        mock: false,
        synthetic: false,
        measurement: producerMeasurement(entry.id, version)
      }
      const outputBytes = jsonBytes(output)
      writeArtifact(evidenceRoot, outputPath, outputBytes)
      const artifact = options.coherentSelfDeclaration
        ? {
          schema: 'sks.release-physical-gate-artifact.v1',
          gate_id: entry.id,
          package_version: version,
          source_commit: sourceCommit,
          capture_adapter_id: adapterReceipt.adapter_id,
          capture_adapter_version: adapterReceipt.adapter_version,
          producer_receipt_id: receiptId,
          fixture: false,
          mock: false,
          synthetic: false,
          observations_sha256: physicalGateObservationsSha256(entry.observations)
        }
        : {
          schema: 'sks.release-physical-gate-artifact.v2',
          gate_id: entry.id,
          package_version: version,
          source_commit: sourceCommit,
          producer: {
            schema: 'sks.release-physical-gate-producer.v1',
            capture_adapter_id: adapterReceipt.adapter_id,
            capture_adapter_version: adapterReceipt.adapter_version,
            receipt_id: receiptId,
            receipt_sha256: sha256(adapterBytes),
            command_id: ({
              update_5001_directory: 'sks.update.physical',
              single_menubar_process: 'sks.menubar.process-readback',
              codex_lb_measured_request: 'sks.codex-lb.measured-request',
              telegram_cellular_e2e: 'sks.telegram.cellular-roundtrip'
            } as Record<string, string>)[entry.id],
            invocation_id: invocationId,
            exit_code: 0,
            started_at: performedAt,
            completed_at: performedAt,
            output_path: outputPath,
            output_sha256: sha256(outputBytes),
            fixture: false,
            mock: false,
            synthetic: false
          },
          ...(options.secretArtifact && entry.id === 'update_5001_directory'
            ? { authorization: 'Bearer sk-test-secret-material' }
            : {})
        }
      const bytes = jsonBytes(artifact)
      writeArtifact(evidenceRoot, entry.artifact_path, bytes)
      entry.artifact_sha256 = sha256(bytes)
    }
  }
  writeArtifact(evidenceRoot, 'physical-gates.json', jsonBytes({
    schema: PHYSICAL_RELEASE_GATES_SCHEMA,
    ok: true,
    release_authorizing: true,
    fixture: false,
    mock: false,
    synthetic: false,
    capture_platform: 'darwin',
    package_version: version,
    source_commit: sourceCommit,
    source_identity_sha256: sourceIdentity,
    capture_adapter_id: adapterReceipt.adapter_id,
    capture_adapter_version: adapterReceipt.adapter_version,
    capture_adapter_receipt_id: receiptId,
    capture_adapter_receipt_sha256: sha256(adapterBytes),
    captured_at: capturedAt,
    blockers: [],
    gates
  }))

  const attested = options.attested !== false
  const evidenceArchive = attested
    ? createAttestedArtifactFixture(root, evidenceRoot, version, sourceCommit, adapterReceipt, sha256(adapterBytes), options)
    : null
  if (attested) installFakeGhAttestationVerifier()

  const inspection = inspectPhysicalReleaseGates({
    root,
    version,
    sourceCommit,
    inspectorPlatform: 'darwin',
    evidenceArchive,
    evidenceRunId: attested ? TEST_RUN_ID : null,
    repository: attested ? TEST_REPOSITORY : null
  })
  const inspectionPath = physicalReleaseGateInspectionPath(root, version)
  fs.mkdirSync(path.dirname(inspectionPath), { recursive: true })
  fs.writeFileSync(inspectionPath, jsonBytes(inspection))
  return {
    evidenceArchive,
    evidenceRunId: attested ? TEST_RUN_ID : null,
    repository: attested ? TEST_REPOSITORY : null
  }
}

function gate(version: string, sourceCommit: string, id: string, artifactPath: string, observations: Record<string, unknown>): any {
  return {
    id,
    ok: true,
    evidence_kind: 'real',
    fixture: false,
    mock: false,
    synthetic: false,
    redacted: true,
    secrets_present: false,
    package_version: version,
    source_commit: sourceCommit,
    reviewer: 'release-maintainer',
    summary: `${id} verified on the required physical environment`,
    artifact_path: artifactPath,
    artifact_sha256: '',
    performed_at: '',
    observations
  }
}

function producerMeasurement(id: string, version: string): Record<string, unknown> {
  if (id === 'update_5001_directory') return {
    directories_scanned: 5001,
    update_exit_code: 0,
    warning_codes: ['guidance_scan_truncated'],
    residue_paths: []
  }
  if (id === 'single_menubar_process') return {
    processes: [{ pid: 4242, role: 'sks-menubar', version }],
    prior_version: '7.6.0',
    readback_source: 'launchctl-and-process-table'
  }
  if (id === 'codex_lb_measured_request') return {
    request_id: 'codex-lb-request-001',
    selected_target: 'codex-lb',
    configured_target: 'codex-lb',
    auth_class: 'gateway-key',
    oauth_header_present: false,
    latency_ms: 42,
    response_sha256: 'f'.repeat(64)
  }
  return {
    pairing_id: 'telegram-pairing-001',
    network_interface_kind: 'cellular',
    pairing_verified: true,
    allowlist_match: true,
    outbound_typed: true,
    inbound_reply_received: true,
    outbound_message_sha256: '1'.repeat(64),
    inbound_reply_sha256: '2'.repeat(64),
    bot_token_captured: false
  }
}

function writeArtifact(root: string, relativePath: string, bytes: Buffer): void {
  const file = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createAttestedArtifactFixture(
  root: string,
  evidenceRoot: string,
  version: string,
  sourceCommit: string,
  adapterReceipt: { adapter_id: string; adapter_version: string; run_id: string; receipt_id: string },
  adapterReceiptSha256: string,
  options: { wrongAdapterManifest?: boolean }
): string {
  const entries = walkFiles(evidenceRoot).map((file) => {
    const bytes = fs.readFileSync(file)
    return {
      path: path.relative(root, file).split(path.sep).join('/'),
      sha256: sha256(bytes),
      bytes: bytes.length
    }
  }).sort((left, right) => left.path.localeCompare(right.path))
  const manifest = {
    schema: PHYSICAL_RELEASE_EVIDENCE_ARTIFACT_MANIFEST_SCHEMA,
    package_version: version,
    source_commit: sourceCommit,
    capture_platform: 'darwin',
    github_repository: TEST_REPOSITORY,
    workflow_path: PHYSICAL_RELEASE_EVIDENCE_CAPTURE_WORKFLOW,
    workflow_run_id: TEST_RUN_ID,
    artifact_name: `physical-release-evidence-${sourceCommit}`,
    capture_adapter: {
      schema: 'sks.release-physical-capture-adapter.v1',
      executable_path: '/usr/local/bin/sks-physical-release-capture',
      executable_sha256: TEST_ADAPTER_EXECUTABLE_SHA256,
      owner_uid: 0,
      adapter_id: options.wrongAdapterManifest ? 'wrong-production-adapter' : adapterReceipt.adapter_id,
      adapter_version: adapterReceipt.adapter_version,
      run_id: adapterReceipt.run_id,
      receipt_id: adapterReceipt.receipt_id,
      receipt_path: 'desktop-bridge/production-adapter-receipt.json',
      receipt_sha256: adapterReceiptSha256
    },
    entries
  }
  fs.writeFileSync(path.join(root, PHYSICAL_RELEASE_EVIDENCE_MANIFEST), jsonBytes(manifest))
  const archive = physicalReleaseEvidenceArchivePath(root, version)
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  const packed = spawnSync('tar', [
    '-czf', archive,
    '-C', root,
    PHYSICAL_RELEASE_EVIDENCE_MANIFEST,
    path.relative(root, evidenceRoot)
  ], { encoding: 'utf8' })
  if (packed.status !== 0) throw new Error(String(packed.stderr || packed.stdout || 'physical evidence fixture archive failed'))
  const sealedManifest = physicalReleaseEvidenceManifestPath(root, version)
  fs.mkdirSync(path.dirname(sealedManifest), { recursive: true })
  fs.renameSync(path.join(root, PHYSICAL_RELEASE_EVIDENCE_MANIFEST), sealedManifest)
  return archive
}

function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name)
    return entry.isDirectory() ? walkFiles(file) : entry.isFile() ? [file] : []
  })
}

function installFakeGhAttestationVerifier(): void {
  if (process.env.SKS_TEST_PHYSICAL_GH_BIN) return
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-gh-'))
  const executable = path.join(bin, 'gh')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
if (args[0] !== 'attestation' || args[1] !== 'verify' || args[2].startsWith('-') || !fs.existsSync(args[2])) process.exit(2)
const manifest = JSON.parse(execFileSync('tar', ['-xOzf', args[2], '${PHYSICAL_RELEASE_EVIDENCE_MANIFEST}'], { encoding: 'utf8' }))
if (value('--repo') !== manifest.github_repository
  || value('--signer-workflow') !== manifest.github_repository + '/' + manifest.workflow_path
  || value('--source-digest') !== manifest.source_commit
  || value('--format') !== 'json') process.exit(3)
process.stdout.write(JSON.stringify([{ verificationResult: { signature: { certificate: {
  runInvocationURI: 'https://github.com/' + manifest.github_repository + '/actions/runs/' + manifest.workflow_run_id + '/attempts/1'
} } } }]))
`)
  fs.chmodSync(executable, 0o755)
  process.env.SKS_TEST_PHYSICAL_GH_BIN = bin
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ''}`
}

function validPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), 8 + data.length)
  return chunk
}

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
