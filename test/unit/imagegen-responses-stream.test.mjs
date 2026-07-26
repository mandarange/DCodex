import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponsesSsePayload } from '../../dist/core/responses-stream.js';

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n');
}

// Shape observed from a live `wire_api = "responses"` codex-lb provider: the
// terminal envelope closes with an empty output array while the image rides on
// the preceding output_item.done. Reading only the envelope reported
// missing_b64_image_output for a response that did contain an image.
test('an image on output_item.done survives a completed envelope with empty output', () => {
  const payload = parseResponsesSsePayload(sse([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', item: { id: 'ig_1', type: 'image_generation_call', status: 'in_progress' } },
    { type: 'response.output_item.done', item: { id: 'ig_1', type: 'image_generation_call', status: 'generating', result: 'QUJD' } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { total_tokens: 7 } } }
  ]));
  assert.equal(payload.id, 'resp_1');
  assert.equal(payload.usage.total_tokens, 7);
  assert.equal(payload.image_output_recovered_from_stream, true);
  assert.equal(payload.image_output_provenance, 'response.output_item.done');
  assert.equal(payload.image_output_partial_frame, false);
  assert.equal(payload.output.length, 1);
  assert.equal(payload.output[0].type, 'image_generation_call');
  assert.equal(payload.output[0].result, 'QUJD');
});

test('a partial frame is recorded as provenance but never promoted to completed output', () => {
  const partialOnly = parseResponsesSsePayload(sse([
    { type: 'response.image_generation_call.partial_image', item_id: 'ig_2', partial_image_b64: 'UEFSVA==' },
    { type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [] } }
  ]));
  assert.deepEqual(partialOnly.output, []);
  assert.equal(partialOnly.image_output_partial_frame, true);
  assert.equal(partialOnly.partial_image_output_present, true);
  assert.equal(partialOnly.image_output_recovered_from_stream, undefined);

  const finalWins = parseResponsesSsePayload(sse([
    { type: 'response.image_generation_call.partial_image', item_id: 'ig_2', partial_image_b64: 'UEFSVA==' },
    { type: 'response.output_item.done', item: { id: 'ig_2', type: 'image_generation_call', result: 'RklOQUw=' } },
    { type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [] } }
  ]));
  assert.equal(finalWins.output[0].result, 'RklOQUw=');
  assert.equal(finalWins.image_output_partial_frame, false);
  assert.equal(finalWins.image_output_provenance, 'response.output_item.done');
});

test('a partial-only stream without a terminal event remains incomplete', () => {
  const payload = parseResponsesSsePayload(sse([
    { type: 'response.image_generation_call.partial_image', item_id: 'ig_partial', partial_image_b64: 'UEFSVA==' }
  ]));
  assert.equal(payload.status, 'unknown');
  assert.equal(payload.output, undefined);
  assert.equal(payload.image_output_partial_frame, true);
  assert.equal(payload.partial_image_output_present, true);
});

test('a completed envelope that already carries the image is left alone', () => {
  const payload = parseResponsesSsePayload(sse([
    { type: 'response.output_item.done', item: { id: 'ig_3', type: 'image_generation_call', result: 'QUJD' } },
    { type: 'response.completed', response: { id: 'resp_3', status: 'completed', output: [{ id: 'ig_3', type: 'image_generation_call', result: 'QUJD' }] } }
  ]));
  assert.equal(payload.output.length, 1);
  assert.equal(payload.image_output_recovered_from_stream, undefined);
});

// Same empty-envelope shape for json_schema structured output, which is how the
// callout extractor reads the generated image back into an issue ledger.
test('structured-output text on output_item.done survives an empty completed envelope', () => {
  const payload = parseResponsesSsePayload(sse([
    { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"colors":["blue"]}' }] } },
    { type: 'response.completed', response: { id: 'resp_5', status: 'completed', output: [] } }
  ]));
  assert.equal(payload.output_recovered_from_stream, true);
  assert.equal(payload.output[0].content[0].text, '{"colors":["blue"]}');
});

test('structured-output text plus a partial image recovers only text from a completed stream', () => {
  const payload = parseResponsesSsePayload(sse([
    { type: 'response.output_item.done', item: { id: 'msg_partial_completed', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"issues":[]}' }] } },
    { type: 'response.image_generation_call.partial_image', item_id: 'ig_partial_completed', partial_image_b64: 'UEFSVA==' },
    { type: 'response.completed', response: { id: 'resp_partial_completed', status: 'completed', output: [] } }
  ]));
  assert.equal(payload.output_recovered_from_stream, true);
  assert.equal(payload.output[0].content[0].text, '{"issues":[]}');
  assert.equal(payload.image_output_partial_frame, true);
  assert.equal(payload.partial_image_output_present, true);
  assert.equal(payload.image_output_recovered_from_stream, undefined);
  assert.equal(payload.image_output_provenance, undefined);
});

test('structured-output text plus a partial image recovers only text without a terminal event', () => {
  const payload = parseResponsesSsePayload(sse([
    { type: 'response.output_item.done', item: { id: 'msg_partial_open', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"issues":["contrast"]}' }] } },
    { type: 'response.image_generation_call.partial_image', item_id: 'ig_partial_open', partial_image_b64: 'UEFSVA==' }
  ]));
  assert.equal(payload.status, 'completed');
  assert.equal(payload.output_recovered_from_stream, true);
  assert.equal(payload.output[0].content[0].text, '{"issues":["contrast"]}');
  assert.equal(payload.image_output_partial_frame, true);
  assert.equal(payload.partial_image_output_present, true);
  assert.equal(payload.image_output_recovered_from_stream, undefined);
  assert.equal(payload.image_output_provenance, undefined);
});

test('a failed stream reports the provider error instead of a recovered image', () => {
  const payload = parseResponsesSsePayload(sse([
    { type: 'response.output_item.done', item: { id: 'ig_4', type: 'image_generation_call', result: 'QUJD' } },
    { type: 'response.failed', response: { status: 'failed', error: { message: 'proxy_overloaded' } } }
  ]));
  assert.equal(payload.status, 'failed');
  assert.equal(payload.error.message, 'proxy_overloaded');
});
