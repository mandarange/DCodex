import path from 'node:path';
import { appendJsonl, exists, nowIso, readJson, readText, writeJsonAtomic, writeTextAtomic } from './fsx.mjs';
import { containsUserQuestion, noQuestionContinuationReason } from './no-question-guard.mjs';
import { createMission, missionDir, setCurrent } from './mission.mjs';
import { buildQuestionSchema, writeQuestions } from './questions.mjs';
import { scanDbSafety } from './db-safety.mjs';
import { writeResearchPlan } from './research.mjs';
import { context7RequirementText, dollarCommand, reasoningInstruction, routeNeedsContext7, routePrompt, routeReasoning, routeRequiresSubagents, stripDollarCommand, subagentExecutionPolicyText, triwikiContextTracking, triwikiContextTrackingText } from './routes.mjs';
import { formatRoleCounts, initTeamLive, parseTeamSpecText } from './team-live.mjs';

export { routePrompt };

export function promptPipelineContext(prompt, route = routePrompt(prompt)) {
  const required = routeNeedsContext7(route, prompt);
  const reasoning = routeReasoning(route, prompt);
  const fastDesign = route?.id === 'DF';
  const lines = [
    `SKS skill-first pipeline active. Route: ${route?.command || '$SKS'} (${route?.route || 'general SKS workflow'}).`,
    reasoningInstruction(reasoning),
    'Before work, load the required SKS skill context and follow the route lifecycle instead of treating the command as plain text.',
    'Codex App visibility: briefly surface what SKS is doing before tools run, mirror important worker/tool status to mission artifacts, and keep progress legible to the user.',
    'Stance: infer the user intent aggressively from rough wording and local context, but ask short ambiguity-removal questions before work when a missing answer can change the target, scope, safety boundary, or acceptance criteria.',
    subagentExecutionPolicyText(route, prompt),
    triwikiContextTrackingText(),
    'Extract intent, target files/surfaces, constraints, acceptance criteria, risks, and the smallest safe atomic step before acting.',
    'Do not stop at a plan when implementation was requested; continue until the route gate passes or a hard blocker is honestly recorded.',
    context7RequirementText(required),
    'Before final answer, run SKS Honest Mode: verify evidence/tests, state gaps, and confirm the goal is genuinely complete.'
  ];
  if (fastDesign) lines.push('DF route: make the smallest design/content change, avoid broad loops, and run only cheap verification when useful.');
  if (route?.id === 'Team') lines.push('Team route: parallel analysis scouts first, refresh/validate TriWiki, mirror subagent conversation/status to team-live.md and team-transcript.jsonl, then planning debate, consensus artifact, close planning agents, create a fresh implementation team, review, integrate, and verify.');
  if (route?.id === 'Ralph') lines.push('Ralph route: no implementation until required clarification answers are converted into a sealed decision contract.');
  if (route?.id === 'AutoResearch') lines.push('AutoResearch route: load autoresearch-loop plus seo-geo-optimizer when SEO/GEO, discoverability, README, npm, GitHub stars, ranking, or AI-search visibility is relevant.');
  if (route?.id === 'DB') lines.push('DB route: scan/check database risk first; destructive DB operations remain forbidden.');
  if (route?.id === 'GX') lines.push('GX route: use deterministic vgraph/beta render, validate, drift, and snapshot artifacts.');
  return lines.join('\n');
}

export async function prepareRoute(root, prompt, state = {}) {
  const route = routePrompt(prompt);
  const task = stripDollarCommand(prompt) || String(prompt || '').trim();
  const explicit = Boolean(dollarCommand(prompt));
  if (!route) return { route: null, additionalContext: promptPipelineContext(prompt, null) };
  const required = routeNeedsContext7(route, prompt);
  const reasoning = routeReasoning(route, prompt);
  const subagentsRequired = routeRequiresSubagents(route, prompt);
  if (route.id === 'Ralph') return prepareRalph(root, route, task, required);
  if (route.id === 'Team') return prepareTeam(root, route, task, required);
  if (route.id === 'Research') return prepareResearch(root, route, task, required);
  if (route.id === 'AutoResearch') return prepareAutoResearch(root, route, task, required);
  if (route.id === 'DB') return prepareDb(root, route, task, required);
  if (route.id === 'GX') return prepareGx(root, route, task, required);
  if (explicit || required) return prepareLightRoute(root, route, task, required);
  return {
    route,
    additionalContext: `${promptPipelineContext(prompt, route)}\n\nReasoning: ${reasoning.effort} (${reasoning.reason}); temporary profile ${reasoning.profile}.\nRequired skills: ${route.requiredSkills.join(', ')}.\nSubagents required: ${subagentsRequired ? 'yes' : 'no'}.`
  };
}

export async function activeRouteContext(root, state) {
  if (!state?.route && !state?.mode) return '';
  const id = state.route || state.mode;
  const reasoningNote = state.reasoning_effort ? ` Temporary reasoning remains ${state.reasoning_effort} (${state.reasoning_profile}); return to the default profile after this route completes.` : '';
  if (state.mode === 'TEAM') {
    const context7 = state.context7_required && !(await hasContext7DocsEvidence(root, state))
      ? ' Context7 evidence is still required before completion: use resolve-library-id, then query-docs (or legacy get-library-docs).'
      : '';
    const roles = state.role_counts ? ` Role counts: ${formatRoleCounts(state.role_counts)}.` : '';
    return `Active Team mission ${state.mission_id || 'latest'} must keep the user-visible live transcript updated. Agent session budget: ${state.agent_sessions || 3}.${roles} Run parallel analysis scouts first, refresh and validate TriWiki, run debate team, close it, then start the fresh parallel development team. Context tracking uses TriWiki as SSOT; refresh with sks wiki pack when scout/debate/development handoff context changes. After each subagent status/result/handoff, run: sks team event ${state.mission_id || 'latest'} --agent <name> --phase <phase> --message "...". The user can inspect it with sks team log ${state.mission_id || 'latest'} or sks team watch ${state.mission_id || 'latest'}.${reasoningNote}${context7}`;
  }
  if (state.subagents_required && !(await hasSubagentEvidence(root, state))) {
    return `Active SKS route ${id} requires subagent execution evidence before code-changing work can be considered complete. Spawn worker/reviewer subagents for disjoint write scopes, or record an explicit unavailable/unsplittable subagent evidence event before editing.${reasoningNote}`;
  }
  if (state.mode === 'RALPH' && ['RALPH_PREPARE', 'RALPH_AWAITING_ANSWERS'].includes(state.phase)) return ralphAwaitingAnswersContext(root, state);
  if (state.mode === 'RALPH' && state.phase === 'DECISION_CONTRACT_SEALED') return `Active Ralph mission ${state.mission_id || 'latest'} has a sealed decision contract. Run "sks ralph run ${state.mission_id || 'latest'}" and continue until done-gate.json passes.`;
  if (state.context7_required && !(await hasContext7DocsEvidence(root, state))) {
    return `Active SKS route ${id} still requires Context7 evidence. Use resolve-library-id, then query-docs (or legacy get-library-docs) for relevant docs/APIs before completing.${reasoningNote}`;
  }
  return '';
}

async function prepareRalph(root, route, task, required) {
  const { id, dir } = await createMission(root, { mode: 'ralph', prompt: task });
  const schema = buildQuestionSchema(task);
  await writeQuestions(dir, schema);
  await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'route.ralph.questions_created', slots: schema.slots.length });
  await setCurrent(root, routeState(id, route, 'RALPH_AWAITING_ANSWERS', required, { prompt: task, questions_allowed: true, implementation_allowed: false }));
  return {
    route,
    additionalContext: `MANDATORY $Ralph route activated.
Mission: ${id}
Task: ${task}
State: RALPH_AWAITING_ANSWERS
Question file: .sneakoscope/missions/${id}/questions.md
Answer schema: .sneakoscope/missions/${id}/required-answers.schema.json

Do not implement yet. Ask the user the required clarification questions now. After the user answers, convert the answers to answers.json, run "sks ralph answer latest answers.json", then run "sks ralph run latest".
${context7RequirementText(required)}

Required questions:
${formatRalphQuestions(schema)}`
  };
}

async function prepareTeam(root, route, task, required) {
  const spec = parseTeamSpecText(task);
  const cleanTask = spec.prompt || task;
  const { agentSessions, roleCounts, roster } = spec;
  const { id, dir } = await createMission(root, { mode: 'team', prompt: cleanTask });
  const plan = {
    schema_version: 1,
    mission_id: id,
    task: cleanTask,
    agent_session_count: agentSessions,
    default_agent_session_count: 3,
    role_counts: roleCounts,
    session_policy: `Use at most ${agentSessions} subagent sessions at a time; the parent orchestrator is not counted.`,
    bundle_size: roster.bundle_size,
    roster,
    team_model: {
      phases: ['parallel_analysis_scouts', 'triwiki_refresh', 'debate_team', 'development_team'],
      analysis_team: `Read-only parallel scouting with exactly ${roster.bundle_size} analysis_scout_N agents. Each scout owns one investigation slice and returns TriWiki-ready findings with source paths, risks, and suggested implementation slices.`,
      debate_team: `Read-only role debate with exactly ${roster.bundle_size} participants composed from user, planner, reviewer, and executor voices.`,
      development_team: `Fresh parallel development bundle with exactly ${roster.bundle_size} executor_N developers implementing disjoint slices; validation_team reviews afterward.`
    },
    context_tracking: triwikiContextTracking(),
    phases: [
      { id: 'parallel_analysis_scouting', goal: `Spawn exactly ${roster.bundle_size} read-only analysis_scout_N agents in parallel, using the full available session budget without exceeding ${agentSessions}. Split repo/docs/tests/API/user-flow/risk investigation into independent slices and record source-backed findings.`, agents: roster.analysis_team.map((agent) => agent.id), max_parallel_subagents: agentSessions, write_policy: 'read-only' },
      { id: 'triwiki_refresh', goal: `Parent orchestrator updates Team analysis artifacts, then runs ${triwikiContextTracking().pack_command} and ${triwikiContextTracking().validate_command} so all later handoffs use current TriWiki context.`, agents: ['parent_orchestrator'], output: '.sneakoscope/wiki/context-pack.json' },
      { id: 'planning_debate', goal: `Debate team of exactly ${roster.bundle_size} participants maps user inconvenience, options, constraints, affected files, DB/test risk, and tradeoffs using the refreshed TriWiki context.`, agents: roster.debate_team.map((agent) => agent.id) },
      { id: 'consensus', goal: 'Seal one objective with acceptance criteria and disjoint implementation slices.' },
      { id: 'parallel_implementation', goal: `Close debate agents, then spawn a fresh ${roster.bundle_size}-person executor development team with non-overlapping write ownership.`, agents: roster.development_team.map((agent) => agent.id) },
      { id: 'review_integration', goal: 'Integrate executor output, strict review correctness/DB safety/tests, validate user friction with validation_team, and record evidence.', agents: roster.validation_team.map((agent) => agent.id) }
    ],
    live_visibility: {
      markdown: 'team-live.md',
      transcript: 'team-transcript.jsonl',
      dashboard: 'team-dashboard.json',
      commands: ['sks team status latest', 'sks team log latest', 'sks team tail latest', 'sks team watch latest', 'sks team event latest --agent <name> --phase <phase> --message "..."']
    },
    required_artifacts: ['team-analysis.md', 'team-consensus.md', 'team-review.md', 'team-gate.json', 'team-live.md', 'team-transcript.jsonl', 'team-dashboard.json', '.sneakoscope/wiki/context-pack.json', 'context7-evidence.jsonl']
  };
  await writeJsonAtomic(path.join(dir, 'team-plan.json'), plan);
  const contextTracking = triwikiContextTracking();
  await writeTextAtomic(path.join(dir, 'team-workflow.md'), `# SKS Team Workflow\n\nTask: ${cleanTask}\n\nAgent session budget: ${agentSessions}\nBundle size: ${roster.bundle_size}\nRole counts: ${formatRoleCounts(roleCounts)}\nReasoning: high for team logic, temporary for this route only.\nContext tracking: ${contextTracking.ssot} SSOT, ${contextTracking.default_pack}; refresh with "${contextTracking.pack_command}" and validate with "${contextTracking.validate_command}".\n\n1. Parallel analysis scouts: spawn exactly ${roster.bundle_size} analysis_scout_N read-only agents to investigate independent repo/docs/tests/API/user-flow/risk slices and write source-backed findings into team-analysis.md.\n2. TriWiki refresh: parent orchestrator updates/refreshes ${contextTracking.default_pack} with "${contextTracking.pack_command}" and validates it with "${contextTracking.validate_command}" before debate or implementation handoffs.\n3. Debate team of exactly ${roster.bundle_size} participants maps options, stubborn user friction, and risks using the refreshed TriWiki context.\n4. Consensus artifact seals one objective and implementation slices.\n5. Debate agents are closed.\n6. Fresh development team of exactly ${roster.bundle_size} executor_N developers executes slices in parallel with at most ${agentSessions} subagent sessions at a time.\n7. Every useful subagent status, scout finding, debate result, handoff, review finding, and integration decision is mirrored to team-live.md and team-transcript.jsonl.\n8. Strict review, user-acceptance friction check, and integration evidence are recorded.\n\nLive visibility:\n- sks team log ${id}\n- sks team tail ${id}\n- sks team watch ${id}\n- sks team event ${id} --agent <name> --phase <phase> --message \"...\"\n`);
  await initTeamLive(id, dir, cleanTask, { agentSessions, roleCounts, roster });
  await writeJsonAtomic(path.join(dir, 'team-gate.json'), { passed: false, analysis_artifact: false, triwiki_refreshed: false, triwiki_validated: false, consensus_artifact: false, implementation_team_fresh: false, review_artifact: false, integration_evidence: false, context7_evidence: false });
  await setCurrent(root, routeState(id, route, 'TEAM_PARALLEL_ANALYSIS_SCOUTING', required, { prompt: cleanTask, agent_sessions: agentSessions, role_counts: roleCounts, context_tracking: 'triwiki' }));
  return routeContext(route, id, cleanTask, required, `Run ${roster.bundle_size} parallel analysis_scout_N agents first, write team-analysis.md, refresh and validate TriWiki with "${contextTracking.pack_command}" and "${contextTracking.validate_command}", then run the debate team with ${formatRoleCounts(roleCounts)}, write team-consensus.md, close debate agents, and form a fresh ${roster.bundle_size}-person executor development team.`);
}

async function prepareResearch(root, route, task, required) {
  const { id, dir } = await createMission(root, { mode: 'research', prompt: task });
  await writeResearchPlan(dir, task, {});
  await setCurrent(root, routeState(id, route, 'RESEARCH_PREPARED', required, { prompt: task }));
  return routeContext(route, id, task, required, 'Run sks research run latest, produce research-report.md, novelty-ledger.json, falsification evidence, and pass research-gate.json.');
}

async function prepareAutoResearch(root, route, task, required) {
  const { id, dir } = await createMission(root, { mode: 'autoresearch', prompt: task });
  await writeJsonAtomic(path.join(dir, 'autoresearch-plan.json'), { schema_version: 1, task, loop: ['program', 'hypothesis', 'experiment', 'measure', 'keep_or_discard', 'falsify', 'honest_conclusion'] });
  await writeJsonAtomic(path.join(dir, 'experiment-ledger.json'), { schema_version: 1, entries: [] });
  await writeJsonAtomic(path.join(dir, 'autoresearch-gate.json'), { passed: false, experiment_ledger_present: true, metric_present: false, keep_or_discard_decision: false, falsification_present: false, honest_conclusion: false, context7_evidence: false });
  await setCurrent(root, routeState(id, route, 'AUTORESEARCH_EXPERIMENT_LOOP', required, { prompt: task }));
  return routeContext(route, id, task, required, 'Run the smallest useful experiment loop, update experiment-ledger.json, falsify the result, and pass autoresearch-gate.json.');
}

async function prepareDb(root, route, task, required) {
  const { id, dir } = await createMission(root, { mode: 'db', prompt: task });
  const scan = await scanDbSafety(root).catch((err) => ({ ok: false, findings: [{ id: 'db_scan_failed', severity: 'high', reason: err.message }] }));
  await writeJsonAtomic(path.join(dir, 'db-safety-scan.json'), scan);
  await writeJsonAtomic(path.join(dir, 'db-review.json'), { passed: false, scan_ok: scan.ok, destructive_operation_zero: true, safe_mcp_policy: false, context7_evidence: false, notes: [] });
  await setCurrent(root, routeState(id, route, 'DB_REVIEW_REQUIRED', required, { prompt: task }));
  return routeContext(route, id, task, required, 'Run sks db policy/scan/check as needed, keep DB operations read-only, record safe MCP policy, and pass db-review.json.');
}

async function prepareGx(root, route, task, required) {
  const { id, dir } = await createMission(root, { mode: 'gx', prompt: task });
  await writeJsonAtomic(path.join(dir, 'gx-gate.json'), { passed: false, vgraph_beta_render: false, validation: false, drift_snapshot: false, context7_evidence: false });
  await setCurrent(root, routeState(id, route, 'GX_VALIDATE_REQUIRED', required, { prompt: task }));
  return routeContext(route, id, task, required, 'Run sks gx init/render/validate/drift/snapshot, then pass gx-gate.json.');
}

async function prepareLightRoute(root, route, task, required) {
  const { id, dir } = await createMission(root, { mode: route.id.toLowerCase(), prompt: task });
  await writeJsonAtomic(path.join(dir, 'route-context.json'), { route: route.id, command: route.command, task, required_skills: route.requiredSkills, context7_required: required, context_tracking: triwikiContextTracking(), stop_gate: 'honest_mode' });
  await setCurrent(root, routeState(id, route, 'ROUTE_CONTEXT_READY', required, { prompt: task, stop_gate: 'none' }));
  return routeContext(route, id, task, required, 'Load the route skill context, execute the smallest matching action, and finish with Honest Mode.');
}

function routeState(id, route, phase, context7Required, extra = {}) {
  const reasoning = routeReasoning(route, extra.prompt || '');
  const subagentsRequired = routeRequiresSubagents(route, extra.prompt || '');
  return { mission_id: id, route: route.id, route_command: route.command, mode: route.mode, phase, context7_required: context7Required, context7_verified: false, subagents_required: subagentsRequired, subagents_verified: false, visible_progress_required: true, context_tracking: 'triwiki', required_skills: route.requiredSkills, stop_gate: route.stopGate, reasoning_effort: reasoning.effort, reasoning_profile: reasoning.profile, reasoning_temporary: true, ...extra };
}

function routeContext(route, id, task, required, next) {
  return {
    route,
    additionalContext: `${promptPipelineContext(task, route)}

${route.command} route prepared.
Mission: ${id}
Task: ${task}
Required skills: ${route.requiredSkills.join(', ')}
Stop gate: ${route.stopGate}
Subagents: ${routeRequiresSubagents(route, task) ? 'required before code-changing execution; spawn parallel workers/reviewers with disjoint ownership or record explicit unavailable/unsplittable evidence.' : 'optional'}
Reasoning: ${routeReasoning(route, task).effort} temporary; return to default after completion.
Next atomic action: ${next}`
  };
}

async function ralphAwaitingAnswersContext(root, state) {
  const id = state.mission_id;
  if (!id) return '';
  const schema = await readJson(path.join(missionDir(root, id), 'required-answers.schema.json'), null);
  const questionBlock = schema ? `\n\nRequired questions still pending:\n${formatRalphQuestions(schema)}` : '';
  return `Active Ralph mission ${id} is waiting for mandatory clarification answers. If the user answered, write answers.json, run "sks ralph answer ${id} answers.json", then "sks ralph run ${id}". If required answers are missing, ask only those questions. Do not implement outside Ralph.${questionBlock}`;
}

function formatRalphQuestions(schema) {
  return schema.slots.map((s, i) => {
    const options = s.options ? ` Options: ${s.options.join(', ')}.` : '';
    const examples = s.examples ? ` Examples: ${s.examples.join(', ')}.` : '';
    return `${i + 1}. ${s.id}: ${s.question}${options}${examples}`;
  }).join('\n');
}

export async function recordContext7Evidence(root, state, payload) {
  const stage = context7Stage(payload);
  if (!stage) return null;
  if (!await shouldWritePipelineEvidence(root, state)) return null;
  const record = { ts: nowIso(), stage, tool: context7ToolName(payload), payload_keys: Object.keys(payload || {}).sort() };
  const id = state?.mission_id;
  const file = id ? path.join(missionDir(root, id), 'context7-evidence.jsonl') : path.join(root, '.sneakoscope', 'state', 'context7-evidence.jsonl');
  await appendJsonl(file, record);
  if (id) {
    const evidence = await context7Evidence(root, state);
    await setCurrent(root, { context7_resolved: evidence.resolve, context7_docs: evidence.docs, context7_verified: evidence.ok });
  }
  return record;
}

export async function recordSubagentEvidence(root, state, payload) {
  const stage = subagentStage(payload);
  if (!stage) return null;
  if (!await shouldWritePipelineEvidence(root, state)) return null;
  const record = { ts: nowIso(), stage, tool: subagentToolName(payload), payload_keys: Object.keys(payload || {}).sort() };
  const id = state?.mission_id;
  const file = id ? path.join(missionDir(root, id), 'subagent-evidence.jsonl') : path.join(root, '.sneakoscope', 'state', 'subagent-evidence.jsonl');
  await appendJsonl(file, record);
  if (id) {
    const evidence = await subagentEvidence(root, state);
    await setCurrent(root, { subagents_spawned: evidence.spawn, subagents_reported: evidence.result, subagents_verified: evidence.ok });
  }
  return record;
}

async function shouldWritePipelineEvidence(root, state = {}) {
  if (state?.mission_id) return exists(missionDir(root, state.mission_id));
  return exists(path.join(root, '.sneakoscope', 'state', 'current.json'));
}

function subagentToolName(payload) {
  const obj = payload || {};
  return String(obj.tool_name || obj.name || obj.tool?.name || obj.mcp_tool || obj.command || obj.type || '');
}

function subagentStage(payload) {
  const hay = JSON.stringify(payload || {});
  if (!/(spawn_agent|send_input|wait_agent|close_agent|subagent|worker|explorer)/i.test(hay)) return null;
  if (/subagent[_ -]?unavailable|subagents unavailable|unsafe to split|unsplittable|cannot safely split/i.test(hay)) return 'exception';
  if (/spawn_agent/i.test(hay)) return 'spawn_agent';
  if (/wait_agent|close_agent|completed|final/i.test(hay)) return 'result';
  return 'subagent';
}

export async function subagentEvidence(root, state) {
  const id = state?.mission_id;
  if (!id) return { spawn: false, result: false, exception: false, ok: false, count: 0 };
  const text = await readText(path.join(missionDir(root, id), 'subagent-evidence.jsonl'), '');
  const lines = text.split(/\n/).filter(Boolean);
  let spawn = false;
  let result = false;
  let exception = false;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.stage === 'spawn_agent') spawn = true;
      if (entry.stage === 'result') result = true;
      if (entry.stage === 'exception') exception = true;
    } catch {}
  }
  return { spawn, result, exception, ok: spawn || exception, count: lines.length };
}

export async function hasSubagentEvidence(root, state) {
  return (await subagentEvidence(root, state)).ok;
}

function context7ToolName(payload) {
  const obj = payload || {};
  return String(obj.tool_name || obj.name || obj.tool?.name || obj.mcp_tool || obj.command || obj.type || '');
}

function context7Stage(payload) {
  const hay = JSON.stringify(payload || {});
  if (!/(context7|resolve-library-id|get-library-docs|query-docs)/i.test(hay)) return null;
  if (/resolve-library-id/i.test(hay)) return 'resolve-library-id';
  if (/get-library-docs|query-docs/i.test(hay)) return 'get-library-docs';
  return 'context7';
}

export async function context7Evidence(root, state) {
  const id = state?.mission_id;
  if (!id) return { resolve: false, docs: false, ok: false, count: 0 };
  const text = await readText(path.join(missionDir(root, id), 'context7-evidence.jsonl'), '');
  const lines = text.split(/\n/).filter(Boolean);
  let resolve = false;
  let docs = false;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.stage === 'resolve-library-id') resolve = true;
      if (entry.stage === 'get-library-docs') docs = true;
    } catch {}
  }
  return { resolve, docs, ok: resolve && docs, count: lines.length };
}

export async function hasContext7DocsEvidence(root, state) {
  return (await context7Evidence(root, state)).ok;
}

export async function evaluateStop(root, state, payload, opts = {}) {
  const last = extractLastMessage(payload);
  if (state?.mode === 'RALPH' && ['RALPH_PREPARE', 'RALPH_AWAITING_ANSWERS'].includes(state.phase)) {
    if (looksLikeRalphQuestionResponse(last)) return { continue: true };
    return { decision: 'block', reason: `Ralph mission ${state.mission_id || 'latest'} is waiting for mandatory clarification answers. Do not finish or implement. Ask the generated Ralph questions first.` };
  }
  if (state?.mode === 'RALPH' && state.phase === 'DECISION_CONTRACT_SEALED') {
    return { decision: 'block', reason: `Ralph mission ${state.mission_id || 'latest'} has a sealed decision contract but has not run. Continue automatically by running: sks ralph run ${state.mission_id || 'latest'}` };
  }
  if (state?.mode === 'RALPH' && /^RALPH_PAUSED/.test(String(state.phase || ''))) {
    return { decision: 'block', reason: `Ralph mission ${state.mission_id || 'latest'} paused before completion. Resume with sks ralph run ${state.mission_id || 'latest'} or record a hard blocker in done-gate.json before finishing.` };
  }
  if (state?.context7_required && !(await hasContext7DocsEvidence(root, state))) {
    return { decision: 'block', reason: `SKS ${state.route_command || state.mode || 'route'} requires Context7 evidence before completion. Use Context7 resolve-library-id, then query-docs (or legacy get-library-docs), so SKS can record context7-evidence.jsonl.` };
  }
  if (state?.subagents_required && !(await hasSubagentEvidence(root, state))) {
    return { decision: 'block', reason: `SKS ${state.route_command || state.mode || 'route'} requires subagent execution evidence before completion. Spawn worker/reviewer subagents for disjoint code-changing work, or record explicit evidence that subagents were unavailable or unsafe to split.` };
  }
  if (opts.noQuestion) {
    if (containsUserQuestion(last)) return { decision: 'block', reason: noQuestionContinuationReason() };
    const gate = await passedActiveGate(root, state);
    if (gate.ok) return { continue: true };
    const missing = gate.missing?.length ? ` Missing gate fields: ${gate.missing.join(', ')}.` : '';
    return { decision: 'block', reason: `SKS no-question run is not done. Continue autonomously, fix failing checks, update ${gate.file || 'the active gate file'}, and do not ask the user.${missing}` };
  }
  if (state?.mission_id && state?.stop_gate && state.stop_gate !== 'none') {
    const gate = await passedActiveGate(root, state);
    if (!gate.ok) {
      const missing = gate.missing?.length ? ` Missing gate fields: ${gate.missing.join(', ')}.` : '';
      return { decision: 'block', reason: `SKS ${state.route_command || state.mode} route cannot stop yet. Pass ${gate.file || state.stop_gate} or record a hard blocker with evidence before finishing.${missing}` };
    }
  }
  return null;
}

async function passedActiveGate(root, state) {
  const id = state?.mission_id;
  if (!id) return { ok: false, file: null };
  const files = gateFilesForState(state);
  for (const file of files) {
    const p = path.join(missionDir(root, id), file);
    if (await exists(p)) {
      const gate = await readJson(p, {});
      const missing = missingRequiredGateFields(file, state, gate);
      if (gate.passed === true && !missing.length) return { ok: true, file };
      if (missing.length) return { ok: false, file, missing };
      return { ok: false, file };
    }
  }
  return { ok: false, file: files[0] || null };
}

function missingRequiredGateFields(file, state, gate = {}) {
  const mode = String(state?.mode || '').toUpperCase();
  if (file === 'team-gate.json' || mode === 'TEAM') {
    return ['analysis_artifact', 'triwiki_refreshed', 'triwiki_validated', 'consensus_artifact', 'implementation_team_fresh', 'review_artifact', 'integration_evidence']
      .filter((key) => gate[key] !== true);
  }
  return [];
}

function gateFilesForState(state) {
  if (state.stop_gate) return [state.stop_gate];
  if (state.mode === 'RALPH') return ['done-gate.json', 'done-gate.evaluated.json'];
  if (state.mode === 'RESEARCH') return ['research-gate.json', 'research-gate.evaluated.json'];
  if (state.mode === 'TEAM') return ['team-gate.json'];
  if (state.mode === 'AUTORESEARCH') return ['autoresearch-gate.json'];
  if (state.mode === 'DB') return ['db-review.json'];
  if (state.mode === 'GX') return ['gx-gate.json'];
  return ['done-gate.json'];
}

function extractLastMessage(payload) {
  return payload.last_assistant_message || payload.assistant_message || payload.message || payload.response || payload.raw || '';
}

function looksLikeRalphQuestionResponse(text) {
  return /(GOAL_PRECISE|ACCEPTANCE_CRITERIA|Ralph|랄프|질문|answers\.json|required-answers|Decision Contract|clarification|모호성|답변)/i.test(String(text || ''));
}
