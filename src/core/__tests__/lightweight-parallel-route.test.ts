// First import: this suite spawns real codex/npm processes, which write
// $HOME/.codex/tmp and $HOME/.npm when the default home leaks through.
import './helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareRoute } from '../pipeline-internals/runtime-core.js';
import { COMMAND_CATALOG, routePrompt, routeRequiresSubagents } from '../routes.js';

test('lightweight Wiki stays missionless even when its prompt contains parallel wording', async () => {
  const prompt = '$Wiki audit all wiki files in parallel';
  const route = routePrompt(prompt);
  assert.equal(route?.id, 'Wiki');
  assert.equal(routeRequiresSubagents(route, prompt), false);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-wiki-parallel-lightweight-'));
  try {
    const prepared: any = await prepareRoute(root, prompt, {});
    assert.equal(prepared.route?.id, 'Wiki');
    assert.equal(prepared.mission_id, undefined);
    assert.match(String(prepared.additionalContext || ''), /wiki/i);
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'state', 'current.json')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Computer Use fast lane stays missionless even when its prompt contains parallel wording', async () => {
  const prompt = '$Computer-Use run two independent native app checks in parallel';
  const route = routePrompt(prompt);
  assert.equal(route?.id, 'ComputerUse');
  assert.equal(routeRequiresSubagents(route, prompt), false);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-computer-use-parallel-lightweight-'));
  try {
    const prepared: any = await prepareRoute(root, prompt, {});
    assert.equal(prepared.route?.id, 'ComputerUse');
    assert.equal(prepared.mission_id, undefined);
    assert.match(String(prepared.additionalContext || ''), /Computer Use fast lane/i);
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'state', 'current.json')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('an explicit agents flag materializes the generic official overlay for a specialized route', async () => {
  const prompt = '$DB --agents=2 inspect the migration safely';
  const route = routePrompt(prompt);
  assert.equal(route?.id, 'DB');
  assert.equal(routeRequiresSubagents(route, prompt), true);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-db-explicit-agents-overlay-'));
  try {
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [['db-anchor', 'claim-hash', 'source-hash']], hydrate_first: [['db-anchor', 'code_citations:src/core/db-safety.ts']] }
    }));
    const prepared: any = await prepareRoute(root, prompt, {}, { sessionKey: 'db-explicit-agents' });
    assert.ok(prepared.mission_id);
    const plan = JSON.parse(await fsp.readFile(path.join(root, '.sneakoscope', 'missions', prepared.mission_id, 'subagent-plan.json'), 'utf8'));
    assert.equal(plan.workflow, 'official_codex_subagent');
    assert.equal(plan.requested_subagents, 2);
    assert.equal(plan.requested_subagents_explicit, true);
    assert.equal(plan.triwiki_attention.source, '.sneakoscope/wiki/context-graph.json');
    assert.equal(plan.triwiki_attention.available, false);
    assert.deepEqual(plan.triwiki_attention.anchors, []);
    assert.equal(plan.triwiki_attention.reason, 'context_graph_missing');
    await fsp.access(path.join(root, '.sneakoscope', 'missions', prepared.mission_id, 'subagent-events.jsonl'));
    await fsp.access(path.join(root, '.sneakoscope', 'missions', prepared.mission_id, 'subagent-evidence.json'));
    await fsp.access(path.join(root, '.sneakoscope', 'missions', prepared.mission_id, 'work-order-ledger.json'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Naruto App preparation reuses the session mission, isolates each run, and expands only for explicit --agents', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-session-reuse-'));
  const sessionKey = 'codex-thread-session-reuse';
  try {
    await fsp.mkdir(path.join(root, '.sneakoscope', 'wiki'), { recursive: true });
    await fsp.writeFile(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), JSON.stringify({
      attention: { use_first: [['naruto-anchor', 'claim-hash', 'source-hash']], hydrate_first: [['naruto-anchor', 'code_citations:src/core/routes.ts']] }
    }));
    const first: any = await prepareRoute(root, '$Naruto implement the initial repository change', {}, { sessionKey });
    const dir = path.join(root, '.sneakoscope', 'missions', first.mission_id);
    const firstPlan = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'));
    await fsp.writeFile(path.join(dir, 'subagent-events.jsonl'), '{"hook_event_name":"SubagentStart","agent_id":"old-agent"}\n');
    await fsp.writeFile(path.join(dir, 'subagent-parent-summary.json'), '{"schema":"stale"}\n');
    await fsp.writeFile(path.join(dir, 'naruto-gate.json'), '{"passed":true}\n');

    const second: any = await prepareRoute(root, '$Naruto 20 files cleanup and refactor the repository', {}, { sessionKey });
    const secondPlan = JSON.parse(await fsp.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'));
    const gate = JSON.parse(await fsp.readFile(path.join(dir, 'naruto-gate.json'), 'utf8'));
    assert.equal(second.mission_id, first.mission_id);
    assert.notEqual(secondPlan.workflow_run_id, firstPlan.workflow_run_id);
    assert.equal(secondPlan.requested_subagents, 2);
    assert.equal(secondPlan.requested_subagents_explicit, false);
    assert.equal(secondPlan.session_scope, sessionKey);
    assert.equal(secondPlan.triwiki_attention.source, '.sneakoscope/wiki/context-graph.json');
    assert.equal(secondPlan.triwiki_attention.available, false);
    assert.deepEqual(secondPlan.triwiki_attention.anchors, []);
    assert.equal(secondPlan.triwiki_attention.reason, 'context_graph_missing');
    await fsp.access(path.join(dir, 'work-order-ledger.json'));
    assert.equal(await fsp.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8'), '');
    await assert.rejects(fsp.access(path.join(dir, 'subagent-parent-summary.json')));
    assert.equal(gate.passed, false);
    assert.equal(gate.workflow_run_id, secondPlan.workflow_run_id);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('$DB materializes internal safety artifacts without a public sks db command', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-db-route-only-'));
  try {
    const prepared: any = await prepareRoute(root, '$DB inspect this migration safely', {});
    assert.equal(prepared.route?.id, 'DB');
    const dir = path.join(root, '.sneakoscope', 'missions', prepared.mission_id);
    const scan = JSON.parse(await fsp.readFile(path.join(dir, 'db-safety-scan.json'), 'utf8'));
    const review = JSON.parse(await fsp.readFile(path.join(dir, 'db-review.json'), 'utf8'));
    assert.equal(typeof scan.ok, 'boolean');
    assert.equal(review.scan_ok, scan.ok);
    assert.equal(review.destructive_operation_zero, true);
    assert.equal(COMMAND_CATALOG.some((entry: any) => entry.name === 'db'), false);
    assert.match(String(prepared.additionalContext || ''), /database safety/i);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('$Research preparation describes the three-thread official review and dated paper contract', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-research-official-prepare-'));
  try {
    const prepared: any = await prepareRoute(root, '$Research investigate a bounded mechanism', {});
    const context = String(prepared.additionalContext || '');
    assert.match(context, /exactly three independent official research_reviewer threads/i);
    assert.match(context, /research_synthesizer revision and a fresh three-thread review cycle/i);
    assert.match(context, /\d{4}-\d{2}-\d{2}-[^\s]+-research-paper\.md/i);
    assert.doesNotMatch(context, /every agent effort=xhigh|repeat agent\/debate\/falsification/i);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
