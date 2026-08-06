#!/usr/bin/env node
import { createHash } from 'node:crypto'
import http, {
  Agent,
  type IncomingMessage,
  type Server
} from 'node:http'
import { performance } from 'node:perf_hooks'
import {
  DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
  desktopBridgeClientPath,
  selectAvailableDesktopBridgePort,
  startDesktopBridge,
  stopDesktopBridge,
  type DesktopBridgeConfig,
  type DesktopBridgeHandle
} from '../core/codex-lb/desktop-bridge/index.js'
import { assertGate, emitGate } from './gate-lib.js'

const HTTP_WARMUP_SAMPLES = 30
const HTTP_MEASURED_SAMPLES = 160
const SSE_WARMUP_SAMPLES = 20
const SSE_MEASURED_SAMPLES = 100
const HTTP_P50_BUDGET_MS = 2
const HTTP_P95_BUDGET_MS = 5
const SSE_FIRST_BYTE_P95_BUDGET_MS = 10
const PUBLIC_MODEL = 'desktop-bridge-latency-model'
const CATALOG_GENERATION = 'desktop-bridge-latency-catalog'
const POLICY_GENERATION = 'desktop-bridge-latency-policy'
const CREDENTIAL_GENERATION = 'desktop-bridge-latency-credential'
const CREDENTIAL_FINGERPRINT = 'desktop-bridge-latency-fingerprint'
const PROVIDER_SECRET = 'latency-probe-provider-secret'
const CLIENT_CAPABILITY = Buffer.alloc(32, 0x47).toString('base64url')
const CLIENT_CAPABILITY_SHA256 = createHash('sha256').update(CLIENT_CAPABILITY).digest('hex')

const upstream = http.createServer((request, response) => {
  request.resume()
  if (request.url === '/v1/latency/headers') {
    response.writeHead(204, {
      'cache-control': 'no-store',
      'x-sks-latency-probe': 'headers'
    })
    response.end()
    return
  }
  if (request.url === '/v1/latency/sse') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store'
    })
    response.write('data: ready\n\n')
    response.end()
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end('{"error":"not_found"}')
})

const upstreamPort = await listen(upstream)
const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1')
let bridge: DesktopBridgeHandle | null = null
const directAgent = new Agent({ keepAlive: true, maxSockets: 1 })
const bridgeAgent = new Agent({ keepAlive: true, maxSockets: 1 })

let report: Record<string, unknown>
try {
  bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort), { writeState: false })

  await warmup('/v1/latency/headers', HTTP_WARMUP_SAMPLES, false)
  const httpOverhead = await pairedOverhead('/v1/latency/headers', HTTP_MEASURED_SAMPLES, false)

  await warmup('/v1/latency/sse', SSE_WARMUP_SAMPLES, true)
  const sseFirstByteOverhead = await pairedOverhead('/v1/latency/sse', SSE_MEASURED_SAMPLES, true)

  const httpP50 = percentile(httpOverhead, 0.50)
  const httpP95 = percentile(httpOverhead, 0.95)
  const sseFirstByteP95 = percentile(sseFirstByteOverhead, 0.95)
  const httpP50Ok = httpP50 < HTTP_P50_BUDGET_MS
  const httpP95Ok = httpP95 < HTTP_P95_BUDGET_MS
  const sseFirstByteP95Ok = sseFirstByteP95 < SSE_FIRST_BYTE_P95_BUDGET_MS
  const ok = httpP50Ok && httpP95Ok && sseFirstByteP95Ok

  report = {
    schema: 'sks.desktop-bridge-latency-check.v1',
    ok,
    execution_class: 'localhost_paired_benchmark',
    remote_network_included: false,
    samples: {
      http_headers_only: HTTP_MEASURED_SAMPLES,
      sse_first_byte: SSE_MEASURED_SAMPLES
    },
    measured_ms: {
      http_headers_only_overhead_p50: rounded(httpP50),
      http_headers_only_overhead_p95: rounded(httpP95),
      sse_first_byte_overhead_p95: rounded(sseFirstByteP95)
    },
    budgets_ms: {
      http_headers_only_overhead_p50_lt: HTTP_P50_BUDGET_MS,
      http_headers_only_overhead_p95_lt: HTTP_P95_BUDGET_MS,
      sse_first_byte_overhead_p95_lt: SSE_FIRST_BYTE_P95_BUDGET_MS
    },
    blockers: [
      ...(httpP50Ok ? [] : ['desktop_bridge_http_overhead_p50_exceeded']),
      ...(httpP95Ok ? [] : ['desktop_bridge_http_overhead_p95_exceeded']),
      ...(sseFirstByteP95Ok ? [] : ['desktop_bridge_sse_first_byte_overhead_p95_exceeded'])
    ]
  }
} finally {
  directAgent.destroy()
  bridgeAgent.destroy()
  if (bridge) await stopDesktopBridge(bridge).catch(() => undefined)
  await close(upstream).catch(() => undefined)
}

assertGate(report.ok === true, 'codex-lb Desktop bridge latency budget failed', report)
emitGate('desktop-bridge:latency', {
  execution_class: report.execution_class,
  remote_network_included: report.remote_network_included,
  samples: report.samples,
  measured_ms: report.measured_ms,
  budgets_ms: report.budgets_ms
})

async function warmup(pathname: string, count: number, firstByte: boolean): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await requestLatency(upstreamPort, pathname, directAgent, firstByte, false)
    await requestLatency(bridgePort, pathname, bridgeAgent, firstByte, true)
  }
}

async function pairedOverhead(
  pathname: string,
  count: number,
  firstByte: boolean
): Promise<number[]> {
  const samples: number[] = []
  for (let index = 0; index < count; index += 1) {
    let directMs: number
    let bridgeMs: number
    if (index % 2 === 0) {
      directMs = await requestLatency(upstreamPort, pathname, directAgent, firstByte, false)
      bridgeMs = await requestLatency(bridgePort, pathname, bridgeAgent, firstByte, true)
    } else {
      bridgeMs = await requestLatency(bridgePort, pathname, bridgeAgent, firstByte, true)
      directMs = await requestLatency(upstreamPort, pathname, directAgent, firstByte, false)
    }
    samples.push(Math.max(0, bridgeMs - directMs))
  }
  return samples
}

async function requestLatency(
  port: number,
  pathname: string,
  agent: Agent,
  firstByte: boolean,
  throughBridge: boolean
): Promise<number> {
  const startedAt = performance.now()
  return new Promise<number>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: throughBridge ? desktopBridgeClientPath(CLIENT_CAPABILITY, pathname) : pathname,
      method: 'GET',
      agent,
      headers: throughBridge
        ? {
            origin: 'app://codex',
            authorization: 'Bearer desktop-oauth-redacted',
            cookie: 'desktop-session=redacted',
            'x-sks-model': PUBLIC_MODEL
          }
        : undefined
    })
    request.once('error', reject)
    request.once('response', (response) => {
      measureResponse(response, startedAt, firstByte).then(resolve, reject)
    })
    request.end()
  })
}

async function measureResponse(
  response: IncomingMessage,
  startedAt: number,
  firstByte: boolean
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let measuredAt: number | null = firstByte ? null : performance.now()
    response.once('error', reject)
    response.on('data', () => {
      if (measuredAt === null) measuredAt = performance.now()
    })
    response.once('end', () => {
      if (measuredAt === null) {
        reject(new Error('desktop_bridge_latency_first_byte_missing'))
        return
      }
      resolve(measuredAt - startedAt)
    })
    response.resume()
  })
}

function bridgeConfig(listenPort: number, upstreamPort: number): DesktopBridgeConfig {
  const baseUrl = `http://127.0.0.1:${upstreamPort}`
  return {
    listenHost: '127.0.0.1',
    listenPort,
    providerRegistry: {
      schema: 'sks.desktop-bridge-provider-registry.v1',
      generation: 'desktop-bridge-latency-registry',
      created_at: '2026-08-05T00:00:00.000Z',
      providers: {
        'codex-lb': {
          provider_id: 'codex-lb', enabled: true, base_url: baseUrl,
          allowed_origins: [new URL(baseUrl).origin], auth_transport: 'x-codex-lb-api-key',
          credential_state: 'ready', credential_fingerprint: CREDENTIAL_FINGERPRINT,
          credential_generation: CREDENTIAL_GENERATION, source_catalog_generation: CATALOG_GENERATION
        },
        openrouter: {
          provider_id: 'openrouter', enabled: false, base_url: 'https://openrouter.ai/api/v1',
          allowed_origins: ['https://openrouter.ai'], auth_transport: 'openrouter-bearer',
          credential_state: 'not_configured', credential_fingerprint: null,
          credential_generation: 'desktop-bridge-latency-openrouter-credential', source_catalog_generation: null
        }
      }
    },
    routePolicy: {
      schema: 'sks.bridge-routing-policy.v1', default_provider_id: 'codex-lb', fallback: 'none',
      model_routes: { [PUBLIC_MODEL]: { provider_id: 'codex-lb', upstream_model: PUBLIC_MODEL } },
      catalog_generation: CATALOG_GENERATION, policy_generation: POLICY_GENERATION,
      changed_at: '2026-08-05T00:00:00.000Z'
    },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId,
      value: providerId === 'codex-lb' ? PROVIDER_SECRET : 'unused-openrouter-secret',
      source: 'latency-check',
      fingerprint: providerId === 'codex-lb' ? CREDENTIAL_FINGERPRINT : 'unused-openrouter-fingerprint',
      generation: expectedGeneration
    }),
    clientCapabilitySha256: CLIENT_CAPABILITY_SHA256,
    allowedPathPrefixes: DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
    allowedOrigins: ['app://codex'],
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 10_000
  }
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index] ?? Number.POSITIVE_INFINITY
}

function rounded(value: number): number {
  return Number(value.toFixed(3))
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('desktop_bridge_latency_upstream_port_missing')
  return address.port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
