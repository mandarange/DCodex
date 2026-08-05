#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server
} from 'node:http'
import net, { type AddressInfo, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
  desktopBridgeStatePath,
  selectAvailableDesktopBridgePort,
  startDesktopBridge,
  stopDesktopBridge,
  type DesktopBridgeConfig,
  type DesktopBridgeProviderAuthTransport,
  type DesktopBridgeHandle
} from '../core/codex-lb/desktop-bridge/index.js'
import { assertGate, emitGate } from './gate-lib.js'

const providerSecret = 'desktop-bridge-provider-secret'
const publicModel = 'desktop-bridge-check-model'
const catalogGeneration = 'desktop-bridge-check-catalog'
const policyGeneration = 'desktop-bridge-check-policy'
const credentialGeneration = 'desktop-bridge-check-credential'
const credentialFingerprint = 'desktop-bridge-check-fingerprint'
const desktopAuthorization = 'Bearer desktop-oauth-secret'
const desktopCookie = 'desktop=session-secret'
const upstreamObservations: {
  sse?: IncomingHttpHeaders
  multipart?: IncomingHttpHeaders
  http?: IncomingHttpHeaders
  websocket?: IncomingHttpHeaders
} = {}
let sseRequestBody = Buffer.alloc(0)
let multipartRequestBody = Buffer.alloc(0)
let sseEnded = false

const upstream = http.createServer((request, response) => {
  if (request.url === '/backend-api/codex/responses?stream=1') {
    upstreamObservations.sse = request.headers
    request.on('data', (chunk: Buffer) => {
      sseRequestBody = Buffer.concat([sseRequestBody, chunk])
    })
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      location: `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}/backend-api/codex/call-1?token=opaque`,
      authorization: 'Bearer reflected-secret',
      'set-cookie': 'remote=session-secret',
      'x-codex-lb-api-key': 'response-secret'
    })
    response.write('data: first\n\n')
    setTimeout(() => {
      sseEnded = true
      response.end('data: second\n\n')
    }, 60)
    return
  }

  if (request.url === '/backend-api/files') {
    upstreamObservations.multipart = request.headers
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      multipartRequestBody = Buffer.concat(chunks)
      response.writeHead(200, {
        'content-type': 'application/json',
        authorization: 'Bearer reflected-secret',
        'set-cookie': 'remote=session-secret',
        'x-codex-lb-api-key': 'response-secret'
      })
      response.end('{"ok":true}')
    })
    return
  }

  if (request.url === '/v1/responses') {
    upstreamObservations.http = request.headers
    request.resume()
    request.once('end', () => {
      response.writeHead(200, {
        'content-type': 'application/json',
        authorization: 'Bearer reflected-secret',
        'set-cookie': 'remote=session-secret',
        'x-codex-lb-api-key': 'response-secret'
      })
      response.end('{"transport":"authorization-bearer"}')
    })
    return
  }

  request.resume()
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end('{"error":"not_found"}')
})

const clientPayload = Buffer.from([1, 2, 3, 4])
const mask = Buffer.from([5, 6, 7, 8])
const maskedPayload = Buffer.from(clientPayload.map((value, index) => value ^ (mask[index % 4] || 0)))
const maskedClientFrame = Buffer.concat([Buffer.from([0x82, 0x84]), mask, maskedPayload])
const serverBinaryFrame = Buffer.concat([Buffer.from([0x82, clientPayload.length]), clientPayload])
const serverCloseFrame = Buffer.from([0x88, 0x05, 0x03, 0xe8, 0x62, 0x79, 0x65])
let receivedClientFrame = Buffer.alloc(0)
upstream.on('upgrade', (request, socket, head) => {
  upstreamObservations.websocket = request.headers
  const accept = createHash('sha1')
    .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + 'Sec-WebSocket-Protocol: codex.realtime.v1\r\n'
    + 'Set-Cookie: forbidden=secret\r\n'
    + 'X-Codex-LB-Api-Key: forbidden-response-secret\r\n'
    + '\r\n'
  )
  const consume = (chunk: Buffer): void => {
    receivedClientFrame = Buffer.concat([receivedClientFrame, chunk])
    if (receivedClientFrame.length >= maskedClientFrame.length) {
      socket.write(serverBinaryFrame)
      socket.end(serverCloseFrame)
    }
  }
  if (head.length) consume(head)
  socket.on('data', consume)
})

const upstreamPort = await listen(upstream)
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-desktop-bridge-gate-'))
const home = path.join(temporaryRoot, 'home')
await fs.mkdir(path.join(home, '.codex'), { recursive: true })

let preferredBridge: DesktopBridgeHandle | null = null
let bearerBridge: DesktopBridgeHandle | null = null
let preferredPort = 0
let stateSecretSafe = false
let stateRemovedOnStop = false
let sseResult: Awaited<ReturnType<typeof request>> | null = null
let multipartResult: Awaited<ReturnType<typeof request>> | null = null
let httpResult: Awaited<ReturnType<typeof request>> | null = null
let webSocketResult: Awaited<ReturnType<typeof websocketRoundTrip>> | null = null
let firstSseChunkBeforeEnd = false

try {
  preferredPort = await selectAvailableDesktopBridgePort('127.0.0.1')
  const statePath = desktopBridgeStatePath(home)
  preferredBridge = await startDesktopBridge(
    bridgeConfig(preferredPort, upstreamPort, 'x-codex-lb-api-key'),
    { statePath }
  )
  const stateText = await fs.readFile(statePath, 'utf8')
  stateSecretSafe = !stateText.includes(providerSecret)
    && !stateText.includes(desktopAuthorization)
    && !stateText.includes(desktopCookie)

  sseResult = await request({
    port: preferredPort,
    path: '/backend-api/codex/responses?stream=1',
    method: 'POST',
    headers: clientHeaders({
      'content-type': 'application/json',
      origin: 'app://codex'
    }),
    chunks: [Buffer.from(JSON.stringify({ model: publicModel, stream: true }))],
    onData: () => {
      if (!sseEnded) firstSseChunkBeforeEnd = true
    }
  })

  const multipartPayload = Buffer.concat([
    Buffer.from('--boundary\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\n\r\n'),
    Buffer.alloc(256 * 1024, 0xa5),
    Buffer.from('\r\n--boundary--\r\n')
  ])
  multipartResult = await request({
    port: preferredPort,
    path: '/backend-api/files',
    method: 'POST',
    headers: clientHeaders({
      'content-type': 'multipart/form-data; boundary=boundary',
      'content-length': String(multipartPayload.length),
      origin: 'app://codex'
    }),
    chunks: [
      multipartPayload.subarray(0, 77_777),
      multipartPayload.subarray(77_777)
    ]
  })

  webSocketResult = await websocketRoundTrip(preferredPort)
  await stopDesktopBridge(preferredBridge)
  preferredBridge = null
  stateRemovedOnStop = await fs.access(statePath).then(() => false, () => true)

  const bearerPort = await selectAvailableDesktopBridgePort('127.0.0.1')
  bearerBridge = await startDesktopBridge(
    bridgeConfig(bearerPort, upstreamPort, 'authorization-bearer'),
    { writeState: false }
  )
  httpResult = await request({
    port: bearerPort,
    path: '/v1/responses',
    method: 'POST',
    headers: clientHeaders({
      'content-type': 'application/json',
      origin: 'app://codex'
    }),
    chunks: [Buffer.from(JSON.stringify({ model: publicModel, input: 'hello' }))]
  })
} finally {
  if (preferredBridge) await stopDesktopBridge(preferredBridge).catch(() => undefined)
  if (bearerBridge) await stopDesktopBridge(bearerBridge).catch(() => undefined)
  await close(upstream).catch(() => undefined)
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}

const sseHeaders = upstreamObservations.sse || {}
const multipartHeaders = upstreamObservations.multipart || {}
const httpHeaders = upstreamObservations.http || {}
const websocketHeaders = upstreamObservations.websocket || {}
const sseVerified = sseResult?.status === 200
  && sseResult.body.toString('utf8') === 'data: first\n\ndata: second\n\n'
  && firstSseChunkBeforeEnd
  && sseRequestBody.toString('utf8') === JSON.stringify({ model: publicModel, stream: true })
  && sseResult.headers.location === `ws://127.0.0.1:${preferredPort}/backend-api/codex/call-1?token=opaque`
const multipartVerified = multipartResult?.status === 200
  && multipartResult.body.toString('utf8') === '{"ok":true}'
  && createHash('sha256').update(multipartRequestBody).digest('hex') === multipartResult.requestBodySha256
const webSocketVerified = Boolean(webSocketResult
  && /101 Switching Protocols/.test(webSocketResult.responseHead)
  && /Sec-WebSocket-Protocol: codex\.realtime\.v1/i.test(webSocketResult.responseHead)
  && !/Set-Cookie|X-Codex-LB-Api-Key/i.test(webSocketResult.responseHead)
  && webSocketResult.frames.equals(Buffer.concat([serverBinaryFrame, serverCloseFrame]))
  && receivedClientFrame.subarray(0, maskedClientFrame.length).equals(maskedClientFrame))
const preferredAuthVerified = sseHeaders['x-codex-lb-api-key'] === providerSecret
  && sseHeaders.authorization === undefined
  && sseHeaders.cookie === undefined
  && multipartHeaders['x-codex-lb-api-key'] === providerSecret
  && multipartHeaders.authorization === undefined
  && multipartHeaders.cookie === undefined
  && websocketHeaders['x-codex-lb-api-key'] === providerSecret
  && websocketHeaders.authorization === undefined
  && websocketHeaders.cookie === undefined
const bearerAuthVerified = httpResult?.status === 200
  && httpResult.body.toString('utf8') === '{"transport":"authorization-bearer"}'
  && httpHeaders.authorization === `Bearer ${providerSecret}`
  && httpHeaders['x-codex-lb-api-key'] === undefined
  && httpHeaders.cookie === undefined
const responseHeadersRedacted = [sseResult, multipartResult, httpResult].every((result) => (
  result !== null
  && result.headers.authorization === undefined
  && result.headers['set-cookie'] === undefined
  && result.headers['x-codex-lb-api-key'] === undefined
))

const report = {
  schema: 'sks.codex-lb-desktop-bridge-check.v1',
  ok: sseVerified
    && multipartVerified
    && webSocketVerified
    && preferredAuthVerified
    && bearerAuthVerified
    && responseHeadersRedacted
    && stateSecretSafe
    && stateRemovedOnStop,
  http: bearerAuthVerified,
  sse: sseVerified,
  multipart: multipartVerified,
  websocket: webSocketVerified,
  x_codex_lb_api_key_transport: preferredAuthVerified,
  authorization_bearer_transport: bearerAuthVerified,
  response_headers_redacted: responseHeadersRedacted,
  public_state_secret_safe: stateSecretSafe,
  public_state_removed_on_stop: stateRemovedOnStop,
  blockers: [
    ...(sseVerified ? [] : ['desktop_bridge_sse_round_trip_failed']),
    ...(multipartVerified ? [] : ['desktop_bridge_multipart_round_trip_failed']),
    ...(webSocketVerified ? [] : ['desktop_bridge_websocket_round_trip_failed']),
    ...(preferredAuthVerified ? [] : ['desktop_bridge_preferred_auth_transport_failed']),
    ...(bearerAuthVerified ? [] : ['desktop_bridge_authorization_bearer_transport_failed']),
    ...(responseHeadersRedacted ? [] : ['desktop_bridge_response_secret_header_leaked']),
    ...(stateSecretSafe ? [] : ['desktop_bridge_public_state_contains_secret']),
    ...(stateRemovedOnStop ? [] : ['desktop_bridge_state_not_removed_on_stop'])
  ]
}

assertGate(report.ok, 'codex-lb Desktop bridge gate failed', report)
emitGate('codex-lb:desktop-bridge', {
  http: report.http,
  sse: report.sse,
  multipart: report.multipart,
  websocket: report.websocket,
  provider_auth_transports: [
    'x-codex-lb-api-key',
    'authorization-bearer'
  ],
  response_headers_redacted: report.response_headers_redacted,
  public_state_secret_safe: report.public_state_secret_safe
})

function bridgeConfig(
  listenPort: number,
  remotePort: number,
  authTransport: DesktopBridgeProviderAuthTransport
): DesktopBridgeConfig {
  const baseUrl = `http://127.0.0.1:${remotePort}/backend-api/codex`
  return {
    listenHost: '127.0.0.1',
    listenPort,
    providerRegistry: {
      schema: 'sks.desktop-bridge-provider-registry.v1',
      generation: 'desktop-bridge-check-registry',
      created_at: '2026-08-05T00:00:00.000Z',
      providers: {
        'codex-lb': {
          provider_id: 'codex-lb', enabled: true, base_url: baseUrl,
          allowed_origins: [new URL(baseUrl).origin], auth_transport: authTransport,
          credential_state: 'ready', credential_fingerprint: credentialFingerprint,
          credential_generation: credentialGeneration, catalog_generation: catalogGeneration
        },
        openrouter: {
          provider_id: 'openrouter', enabled: false, base_url: 'https://openrouter.ai/api/v1',
          allowed_origins: ['https://openrouter.ai'], auth_transport: 'openrouter-bearer',
          credential_state: 'not_configured', credential_fingerprint: null,
          credential_generation: 'desktop-bridge-check-openrouter-credential', catalog_generation: null
        }
      }
    },
    routePolicy: {
      schema: 'sks.bridge-routing-policy.v1', default_provider_id: 'codex-lb', fallback: 'none',
      model_routes: { [publicModel]: { provider_id: 'codex-lb', upstream_model: publicModel } },
      catalog_generation: catalogGeneration, policy_generation: policyGeneration,
      changed_at: '2026-08-05T00:00:00.000Z'
    },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId,
      value: providerId === 'codex-lb' ? providerSecret : 'unused-openrouter-secret',
      source: 'release-check',
      fingerprint: providerId === 'codex-lb' ? credentialFingerprint : 'unused-openrouter-fingerprint',
      generation: expectedGeneration
    }),
    allowedPathPrefixes: DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
    allowedOrigins: ['app://codex'],
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 10_000
  }
}

function clientHeaders(additional: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return {
    authorization: desktopAuthorization,
    cookie: desktopCookie,
    'x-codex-lb-api-key': 'client-forged-key',
    'x-sks-model': publicModel,
    ...additional
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function request(input: {
  port: number
  path: string
  method?: string
  headers?: http.OutgoingHttpHeaders
  chunks?: readonly Buffer[]
  onData?: (chunk: Buffer) => void
}): Promise<{
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
  requestBodySha256: string
}> {
  const requestBody = Buffer.concat([...(input.chunks || [])])
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1',
      port: input.port,
      path: input.path,
      method: input.method || 'GET',
      headers: input.headers
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        input.onData?.(chunk)
      })
      response.once('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        requestBodySha256: createHash('sha256').update(requestBody).digest('hex')
      }))
    })
    client.once('error', reject)
    for (const chunk of input.chunks || []) client.write(chunk)
    client.end()
  })
}

async function websocketRoundTrip(port: number): Promise<{ responseHead: string; frames: Buffer }> {
  const holder: { socket: Socket | null } = { socket: null }
  try {
    return await new Promise((resolve, reject) => {
      const client = net.connect({ host: '127.0.0.1', port })
      holder.socket = client
      const chunks: Buffer[] = []
      let sentFrame = false
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('desktop_bridge_websocket_timeout'))
        client?.destroy()
      }, 5_000)
      timer.unref()
      client.once('connect', () => {
        client?.write(
          'GET /backend-api/codex/realtime/call-1?token=opaque HTTP/1.1\r\n'
          + `Host: 127.0.0.1:${port}\r\n`
          + 'Connection: Upgrade\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
          + 'Sec-WebSocket-Version: 13\r\n'
          + 'Sec-WebSocket-Protocol: codex.realtime.v1\r\n'
          + 'Origin: app://codex\r\n'
          + `X-SKS-Model: ${publicModel}\r\n`
          + `Authorization: ${desktopAuthorization}\r\n`
          + `Cookie: ${desktopCookie}\r\n`
          + 'X-Codex-LB-Api-Key: client-forged-key\r\n'
          + '\r\n'
        )
      })
      client.on('data', (chunk) => {
        chunks.push(chunk)
        const all = Buffer.concat(chunks)
        const boundary = all.indexOf('\r\n\r\n')
        if (boundary >= 0 && !sentFrame) {
          sentFrame = true
          client?.write(maskedClientFrame)
        }
        const expectedLength = boundary + 4 + serverBinaryFrame.length + serverCloseFrame.length
        if (boundary < 0 || all.length < expectedLength || settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          responseHead: all.subarray(0, boundary).toString('latin1'),
          frames: all.subarray(boundary + 4)
        })
        client?.destroy()
      })
      client.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      client.once('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('desktop_bridge_websocket_closed_before_complete'))
      })
    })
  } finally {
    holder.socket?.destroy()
  }
}
