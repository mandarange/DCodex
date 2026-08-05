import { createHash } from 'node:crypto'
import http, { type IncomingMessage, type Server } from 'node:http'
import net, { type AddressInfo, type Socket } from 'node:net'

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

export async function request(input: {
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

export async function websocketRoundTrip(input: {
  port: number
  publicModel: string
  desktopAuthorization: string
  desktopCookie: string
  maskedClientFrame: Buffer
  expectedResponseFrameBytes: number
}): Promise<{ responseHead: string; frames: Buffer }> {
  const holder: { socket: Socket | null } = { socket: null }
  try {
    return await new Promise((resolve, reject) => {
      const client = net.connect({ host: '127.0.0.1', port: input.port })
      holder.socket = client
      const chunks: Buffer[] = []
      let sentFrame = false
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('desktop_bridge_websocket_timeout'))
        client.destroy()
      }, 5_000)
      timer.unref()
      client.once('connect', () => {
        client.write(
          'GET /backend-api/codex/realtime/call-1?token=opaque HTTP/1.1\r\n'
          + `Host: 127.0.0.1:${input.port}\r\n`
          + 'Connection: Upgrade\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
          + 'Sec-WebSocket-Version: 13\r\n'
          + 'Sec-WebSocket-Protocol: codex.realtime.v1\r\n'
          + 'Origin: app://codex\r\n'
          + `X-SKS-Model: ${input.publicModel}\r\n`
          + `Authorization: ${input.desktopAuthorization}\r\n`
          + `Cookie: ${input.desktopCookie}\r\n`
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
          client.write(input.maskedClientFrame)
        }
        const expectedLength = boundary + 4 + input.expectedResponseFrameBytes
        if (boundary < 0 || all.length < expectedLength || settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          responseHead: all.subarray(0, boundary).toString('latin1'),
          frames: all.subarray(boundary + 4)
        })
        client.destroy()
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
