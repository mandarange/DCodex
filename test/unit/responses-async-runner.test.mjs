import test from 'node:test';
import assert from 'node:assert/strict';
import { runResponsesAsync } from '../../dist/core/agent-bridge/responses-async-runner.js';

const encoder = new TextEncoder();
const frame = event => encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`);
const call = (id = 'original-call', extra = {}) => ({ type: 'function_call', id: `fc-${id}`, call_id: id, name: 'lookup', arguments: '{"key":7}', async: true, ...extra });
const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const done = (item, index = 0) => ({ type: 'response.output_item.done', output_index: index, item });
const completed = (output = []) => ({ type: 'response.completed', response: { status: 'completed', output } });
const response = events => new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(frame(event)); controller.close(); } }));
const tool = execute => ({ name: 'lookup', description: 'Read-only lookup', parameters: { type: 'object', properties: { key: { type: 'integer' } } }, execute });
const defaults = { model: 'gpt-6-astra', prompt: 'Look up key 7 and explain independent arithmetic.', timeoutMs: 1000 };

test('streams independent text while a tool is pending and replays reasoning, original call ID, and actual output', async () => {
  let toolStarted = false;
  let toolSettled = false;
  let release;
  let requests = 0;
  const reasoning = { type: 'reasoning', id: 'reasoning-1', summary: [], encrypted_content: 'opaque-reasoning' };
  const lookup = tool(async (args, { signal }) => {
    assert.deepEqual(args, { key: 7 });
    assert.equal(signal.aborted, false);
    toolStarted = true;
    await new Promise(resolve => { release = resolve; });
    toolSettled = true;
    return { actual: 917 };
  });
  const result = await runResponsesAsync({ ...defaults, effort: 'low', tools: [lookup], request: async body => {
    requests++;
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.tools[0].async, true);
    assert.equal(body.tools[0].strict, false);
    assert.deepEqual(body.tools[0].parameters, lookup.parameters);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.equal(body.previous_response_id, undefined);
    if (requests === 2) {
      assert.equal(toolSettled, true);
      assert.deepEqual(body.input.slice(1), [reasoning, call(), message('Independent work'), { type: 'function_call_output', call_id: 'original-call', output: '{"actual":917}' }]);
      return response([done(message('Actual result: 917')), completed()]);
    }
    let index = 0;
    return new Response(new ReadableStream({ pull(controller) {
      const events = [done(reasoning), { type: 'response.function_call_arguments.delta', delta: '{"key":' }, done(call(), 1), { type: 'response.output_text.delta', delta: 'Independent work' }, done(message('Independent work'), 2), completed()];
      if (index === 2) assert.equal(toolStarted, false, 'partial arguments never execute');
      if (index === 3) {
        assert.equal(toolStarted, true);
        assert.equal(toolSettled, false, 'stream advances before the tool resolves');
      }
      if (index === events.length) { release(); controller.close(); return; }
      controller.enqueue(frame(events[index++]));
    } }, { highWaterMark: 0 }));
  } });
  assert.equal(result.ok, true);
  assert.equal(result.final_text, 'Actual result: 917');
  assert.equal(result.model_async_observed, true);
  assert.equal(result.continued_before_tool_output, true);
  assert.deepEqual(result.tool_calls, [{ call_id: 'original-call', name: 'lookup', async: true, completed: true, output_submitted: true }]);
  assert.equal(result.rounds, 2);
});

test('identical duplicate items execute once and terminal output does not duplicate history', async () => {
  let executions = 0;
  let requests = 0;
  const result = await runResponsesAsync({ ...defaults, tools: [tool(async () => { executions++; return 'real'; })], request: async body => {
    if (++requests === 1) return response([done(call()), done(call()), done(call(), 1), completed([call(), call()])]);
    assert.equal(body.input.filter(item => item.type === 'function_call').length, 1);
    assert.equal(body.input.filter(item => item.type === 'function_call_output').length, 1);
    return response([done(message('real')), completed([message('real')])]);
  } });
  assert.equal(result.ok, true);
  assert.equal(executions, 1);
});

test('conflicting call IDs block without executing twice', async () => {
  let executions = 0;
  const result = await runResponsesAsync({ ...defaults, tools: [tool(async () => { executions++; return 'real'; })], request: async () => response([done(call()), done(call('original-call', { arguments: '{}' }), 1), completed()]) });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('conflicting_call_id'));
  assert.equal(executions, 1);
});

test('unknown tools and execution failures block visibly without exposing exception data', async () => {
  const unknown = await runResponsesAsync({ ...defaults, tools: [], request: async () => response([done(call()), completed()]) });
  assert.ok(unknown.blockers.includes('unknown_tool'));
  const failed = await runResponsesAsync({ ...defaults, tools: [tool(async () => { throw new Error('private-data'); })], request: async () => response([done(call()), completed()]) });
  assert.ok(failed.blockers.includes('tool_execution_failed'));
  assert.equal(JSON.stringify(failed).includes('private-data'), false);
  assert.equal(failed.tool_calls[0].output_submitted, false);
});

test('sync calls finish and submit the actual result but cannot claim async success', async () => {
  let requests = 0;
  const result = await runResponsesAsync({ ...defaults, tools: [tool(async () => 'actual')], request: async body => {
    if (++requests === 1) return response([done(call('sync-call', { async: false })), completed()]);
    assert.equal(body.input.at(-1).output, 'actual');
    return response([done(message('Actual result')), completed()]);
  } });
  assert.equal(result.ok, false);
  assert.equal(result.final_text, 'Actual result');
  assert.equal(result.model_async_observed, false);
  assert.ok(result.blockers.includes('model_async_not_enabled'));
  assert.equal(result.tool_calls[0].output_submitted, true);
});

test('timeout cancels the body and drains pending tool callbacks before returning', async () => {
  let settled = false;
  let cancelled = false;
  let requests = 0;
  const result = await runResponsesAsync({ ...defaults, timeoutMs: 25, tools: [tool(async (_, { signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    settled = true;
    return 'late result';
  })], request: async () => {
    requests++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(frame(done(call()))); }, cancel() { cancelled = true; } }));
  } });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('timeout'));
  assert.equal(settled, true);
  assert.equal(cancelled, true);
  assert.equal(requests, 1);
  assert.equal(result.tool_calls[0].completed, false);
  assert.equal(result.tool_calls[0].output_submitted, false);
});

test('concurrency overflow rejects the fifth call and drains all four active callbacks', async () => {
  let executions = 0;
  let settled = 0;
  const result = await runResponsesAsync({ ...defaults, tools: [tool(async (_, { signal }) => {
    executions++;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    settled++;
    return 'cancelled';
  })], request: async () => response([...Array.from({ length: 5 }, (_, index) => done(call(`call-${index}`), index)), completed()]) });
  assert.ok(result.blockers.includes('tool_concurrency_limit'));
  assert.equal(executions, 4);
  assert.equal(settled, 4);
});

test('a response arriving after timeout is disposed without dispatching its tool', async () => {
  let deliver;
  let cancelled = false;
  const result = await runResponsesAsync({ ...defaults, timeoutMs: 10, tools: [tool(async () => assert.fail('late tools must never run'))], request: () => new Promise(resolve => { deliver = resolve; }) });
  assert.ok(result.blockers.includes('timeout'));
  deliver(new Response(new ReadableStream({ start(controller) { controller.enqueue(frame(done(call()))); }, cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(result.tool_calls.length, 0);
});

test('total calls and rounds are bounded', async () => {
  let requests = 0;
  const limited = await runResponsesAsync({ ...defaults, tools: [tool(async () => 'actual')], request: async () => {
    const round = requests++;
    return response([...Array.from({ length: 4 }, (_, index) => done(call(`call-${round * 4 + index}`), index)), completed()]);
  } });
  assert.ok(limited.blockers.includes('tool_call_limit'));
  assert.equal(limited.tool_calls.length, 16);
  assert.equal(limited.rounds, 5);
  requests = 0;
  const rounds = await runResponsesAsync({ ...defaults, tools: [tool(async () => 'actual')], request: async () => response([done(call(`call-${requests++}`)), completed()]) });
  assert.ok(rounds.blockers.includes('round_limit'));
  assert.equal(rounds.rounds, 6);
  assert.equal(rounds.tool_calls.at(-1).output_submitted, false);
});

test('body and context limits reject oversized data', async () => {
  const large = 'x'.repeat(4 * 1024 * 1024);
  const input = await runResponsesAsync({ ...defaults, prompt: large, tools: [], request: async () => assert.fail('oversized request must not be sent') });
  assert.ok(input.blockers.includes('request_body_limit'));
  const output = await runResponsesAsync({ ...defaults, tools: [], request: async () => response([done(message(large)), completed()]) });
  assert.ok(output.blockers.includes('response_body_limit'));
  const context = await runResponsesAsync({ ...defaults, tools: [tool(async () => large)], request: async () => response([done(call('a')), done(call('b'), 1), completed()]) });
  assert.ok(context.blockers.includes('context_limit'));
});

test('terminal failures, missing done events, and missing final answers block', async () => {
  const incomplete = await runResponsesAsync({ ...defaults, tools: [], request: async () => response([{ type: 'response.incomplete' }]) });
  assert.ok(incomplete.blockers.includes('response_failed_or_incomplete'));
  const truncated = await runResponsesAsync({ ...defaults, tools: [], request: async () => response([done(message('unfinished'))]) });
  assert.ok(truncated.blockers.includes('missing_completed_response'));
  const missingDone = await runResponsesAsync({ ...defaults, tools: [tool(async () => assert.fail('never dispatch terminal-only call'))], request: async () => response([completed([call()])]) });
  assert.ok(missingDone.blockers.includes('function_call_missing_done_event'));
  const missingText = await runResponsesAsync({ ...defaults, tools: [], request: async () => response([completed()]) });
  assert.ok(missingText.blockers.includes('missing_final_text'));
});

test('explicit unfinished call/message statuses prevent execution and final success', async () => {
  let executions = 0;
  const unfinishedCall = await runResponsesAsync({ ...defaults, tools: [tool(async () => { executions++; return 'must not run'; })], request: async () => response([done(call('unfinished', { status: 'incomplete' })), { type: 'response.incomplete' }]) });
  assert.equal(executions, 0);
  assert.ok(unfinishedCall.blockers.includes('output_item_not_completed'));
  let requests = 0;
  const unfinishedMessage = await runResponsesAsync({ ...defaults, tools: [tool(async () => 'actual')], request: async () => ++requests === 1
    ? response([done(call()), completed()])
    : response([done({ ...message('Unfinished answer'), status: 'in_progress' }), completed()]) });
  assert.equal(unfinishedMessage.ok, false);
  assert.equal(unfinishedMessage.final_text, '');
  assert.ok(unfinishedMessage.blockers.includes('output_item_not_completed'));
});
