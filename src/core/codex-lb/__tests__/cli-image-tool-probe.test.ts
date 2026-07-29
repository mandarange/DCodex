import test from 'node:test'
import assert from 'node:assert/strict'
import { probeCodexLbCliImageGeneration } from '../probes/cli-image-tool-probe.js'

const MODEL = 'gpt-5.6-sol'
const BASE = 'https://lb.example.test/backend-api/codex'
const KEY = 'sk-clb-fixture'

function sseResponse(events: Array<Record<string, unknown>>, status = 200): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}`).join('\n') + '\ndata: [DONE]\n'
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

test('cli image probe verifies a real generation carried by the gateway stream', async () => {
  const calls: Array<{ body: any; auth: string | null }> = []
  const result = await probeCodexLbCliImageGeneration({
    baseUrl: BASE,
    apiKey: KEY,
    model: MODEL,
    fetchImpl: (async (url: any, init: any) => {
      calls.push({ body: JSON.parse(String(init.body)), auth: init.headers.authorization || null })
      return sseResponse([
        { type: 'response.created', response: { id: 'resp_img_1' } },
        { type: 'response.image_generation_call.in_progress' },
        { type: 'response.image_generation_call.partial_image', partial_image_b64: 'aW1n' },
        { type: 'response.image_generation_call.completed', result: 'aW1n' },
        { type: 'response.completed', response: { id: 'resp_img_1', status: 'completed' } }
      ])
    }) as typeof fetch
  })

  assert.equal(result.status, 'image_generated')
  assert.equal(result.ok, true)
  assert.equal(result.tool_accepted, true)
  assert.equal(result.image_event_seen, true)
  assert.equal(result.artifact_materialized, true)
  assert.deepEqual(result.blockers, [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.auth, `Bearer ${KEY}`)
  assert.deepEqual(calls[0]?.body.tools, [{ type: 'image_generation' }])
  assert.deepEqual(calls[0]?.body.tool_choice, { type: 'image_generation' })
  assert.equal(calls[0]?.body.model, MODEL)
})

test('cli image probe names gateway tool rejection instead of a generic failure', async () => {
  const result = await probeCodexLbCliImageGeneration({
    baseUrl: BASE,
    apiKey: KEY,
    model: MODEL,
    fetchImpl: (async () => jsonResponse({
      error: { type: 'invalid_request_error', message: 'Unsupported tool type: image_generation' }
    }, 400)) as typeof fetch
  })

  assert.equal(result.status, 'tool_rejected')
  assert.equal(result.ok, false)
  assert.equal(result.tool_accepted, false)
  assert.deepEqual(result.blockers, ['image_generation_tool_rejected_by_gateway'])
})

test('cli image probe retries without forced tool_choice only when that shape is rejected', async () => {
  let calls = 0
  const result = await probeCodexLbCliImageGeneration({
    baseUrl: BASE,
    apiKey: KEY,
    model: MODEL,
    fetchImpl: (async (_url: any, init: any) => {
      calls += 1
      if (calls === 1) {
        return jsonResponse({
          error: { type: 'invalid_request_error', message: 'tool_choice of type image_generation is not supported' }
        }, 400)
      }
      return sseResponse([
        { type: 'response.completed', response: { id: 'resp_txt', status: 'completed', output: [] } }
      ])
    }) as typeof fetch
  })

  assert.equal(calls, 2)
  assert.equal(result.status, 'tool_accepted')
  assert.equal(result.ok, true)
  assert.equal(result.image_event_seen, false)
  assert.equal(result.forced_tool_choice_used, false)
  assert.deepEqual(result.blockers, [])
})

test('cli image probe reports timeout without claiming capability', async () => {
  const result = await probeCodexLbCliImageGeneration({
    baseUrl: BASE,
    apiKey: KEY,
    model: MODEL,
    timeoutMs: 25,
    fetchImpl: ((_url: any, init: any) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')))
    })) as typeof fetch
  })

  assert.equal(result.status, 'timeout')
  assert.equal(result.ok, false)
  assert.deepEqual(result.blockers, ['image_probe_timeout'])
  assert.equal(result.tool_accepted, false)
})
