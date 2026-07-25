/**
 * Streaming Responses payloads do not always close with the output they
 * produced, and the terminal `response.completed` envelope is not a reliable
 * place to read it from.
 *
 * Observed against a `wire_api = "responses"` provider (codex-lb), for both
 * image generation and json_schema structured output: the completed envelope
 * arrives with `output: []` while the real items rode on the preceding
 * `response.output_item.done` events, and a partially generated image also
 * appears on `response.image_generation_call.partial_image`
 * (`partial_image_b64`). Reading only the completed envelope throws away
 * output the provider did send.
 *
 * This module folds the streamed items back into the completed envelope so
 * callers can keep treating the response as a single payload.
 */

export interface StreamedImageOutput {
  readonly id: string | null;
  readonly b64: string;
  /** A partial frame is usable evidence only when no final item arrived. */
  readonly partial: boolean;
}

export function parseResponsesSseEvents(text: string): any[] {
  const events: any[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // A truncated or non-JSON data line carries no payload; skip it.
    }
  }
  return events;
}

/** Completed output items in arrival order, deduplicated by item id. */
export function streamedOutputItems(events: readonly any[]): any[] {
  const byId = new Map<string, any>();
  const anonymous: any[] = [];
  for (const event of events) {
    if (String(event?.type || '') !== 'response.output_item.done') continue;
    const item = event?.item;
    if (!item || typeof item !== 'object') continue;
    const id = item.id ? String(item.id) : '';
    if (id) byId.set(id, item);
    else anonymous.push(item);
  }
  return [...byId.values(), ...anonymous];
}

/** Newest usable image across every event shape, preferring a final item. */
export function findStreamedImageOutput(events: readonly any[]): StreamedImageOutput | null {
  let partial: StreamedImageOutput | null = null;
  let final: StreamedImageOutput | null = null;
  for (const event of events) {
    const type = String(event?.type || '');
    const item = event?.item;
    if (item && String(item.type || '') === 'image_generation_call') {
      const b64 = b64Of(item.result) || b64Of(item.b64_json);
      if (b64) final = { id: item.id || event?.item_id || null, b64, partial: false };
      continue;
    }
    if (/image_generation_call/.test(type)) {
      const b64 = b64Of(event?.result) || b64Of(event?.b64_json);
      if (b64) {
        final = { id: event?.item_id || event?.id || null, b64, partial: false };
        continue;
      }
      const partialB64 = b64Of(event?.partial_image_b64);
      if (partialB64) partial = { id: event?.item_id || null, b64: partialB64, partial: true };
    }
  }
  return final || partial;
}

export function imageGenerationCallOutputs(payload: any): any[] {
  return (Array.isArray(payload?.output) ? payload.output : [])
    .filter((output: any) => String(output?.type || '') === 'image_generation_call');
}

export function hasImageGenerationResult(payload: any): boolean {
  return imageGenerationCallOutputs(payload)
    .some((output: any) => Boolean(b64Of(output?.result) || b64Of(output?.result?.b64_json) || b64Of(output?.b64_json)));
}

export function parseResponsesSsePayload(text: string) {
  const events = parseResponsesSseEvents(text);
  if (!events.length) return null;
  const eventTypes = events.map((event) => event?.type || null);
  const failed = events.find((event) => event?.type === 'response.failed' || event?.response?.status === 'failed');
  if (failed) {
    return {
      object: 'response.sse',
      status: 'failed',
      error: failed?.response?.error || failed?.error || { message: 'responses_sse_failed' },
      events: eventTypes
    };
  }
  const streamedImage = findStreamedImageOutput(events);
  const recovered = recoveredOutput(streamedOutputItems(events), streamedImage);
  const completed = [...events].reverse().find((event) => event?.type === 'response.completed' && event?.response);
  if (completed?.response) {
    const output = Array.isArray(completed.response.output) ? completed.response.output : [];
    if (output.length) {
      // The envelope closed with content; only a missing image is restored,
      // because that is the one item callers cannot proceed without.
      if (hasImageGenerationResult(completed.response) || !streamedImage) return completed.response;
      return {
        ...completed.response,
        output: [...output, streamedImageItem(streamedImage)],
        image_output_recovered_from_stream: true,
        image_output_partial_frame: streamedImage.partial
      };
    }
    if (!recovered.length) return completed.response;
    return {
      ...completed.response,
      output: recovered,
      output_recovered_from_stream: true,
      ...(streamedImage
        ? { image_output_recovered_from_stream: true, image_output_partial_frame: streamedImage.partial }
        : {})
    };
  }
  if (recovered.length) {
    return {
      object: 'response.sse',
      status: 'completed',
      output: recovered,
      output_recovered_from_stream: true,
      ...(streamedImage
        ? { image_output_recovered_from_stream: true, image_output_partial_frame: streamedImage.partial }
        : {}),
      events: eventTypes
    };
  }
  return { object: 'response.sse', status: 'unknown', events: eventTypes };
}

/** The text a json_schema/text response produced, across envelope shapes. */
export function responsesOutputText(payload: any): string {
  const direct = typeof payload?.output_text === 'string' ? payload.output_text : '';
  if (direct) return direct;
  const parts: string[] = [];
  for (const output of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if (typeof content?.text === 'string' && content.text) parts.push(content.text);
    }
  }
  return parts.join('');
}

function recoveredOutput(items: readonly any[], streamedImage: StreamedImageOutput | null): any[] {
  const output = [...items];
  const hasImage = output.some((item) => String(item?.type || '') === 'image_generation_call' && b64Of(item?.result));
  if (streamedImage && !hasImage) output.push(streamedImageItem(streamedImage));
  return output;
}

function streamedImageItem(image: StreamedImageOutput) {
  return {
    id: image.id,
    type: 'image_generation_call',
    status: image.partial ? 'partial' : 'completed',
    result: image.b64
  };
}

function b64Of(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
