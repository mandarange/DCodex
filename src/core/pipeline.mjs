import fsp from 'node:fs/promises';
import path from 'node:path';
import { appendJsonl, exists, nowIso, readJson, readText, writeJsonAtomic, writeTextAtomic } from './fsx.mjs';
import { containsUserQuestion, noQuestionContinuationReason } from './no-question-guard.mjs';
import { createMission, missionDir, setCurrent } from './mission.mjs';
import { buildQuestionSchemaForRoute, writeQuestions } from './questions.mjs';
import { sealContract } from './decision-contract.mjs';
import { scanDbSafety } from './db-safety.mjs';
import { writeResearchPlan } from './research.mjs';
import { FROM_CHAT_IMG_CHECKLIST_ARTIFACT, FROM_CHAT_IMG_COVERAGE_ARTIFACT, FROM_CHAT_IMG_QA_LOOP_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS, chatCaptureIntakeText, context7RequirementText, dollarCommand, hasFromChatImgSignal, hasMadSksSignal, noUnrequestedFallbackCodePolicyText, reflectionRequiredForRoute, reasoningInstruction, routeNeedsContext7, routePrompt, routeReasoning, routeRequiresSubagents, stripDollarCommand, stripMadSksSignal, subagentExecutionPolicyText, stackCurrentDocsPolicyText, triwikiContextTracking, triwikiContextTrackingText, triwikiStagePolicyText } from './routes.mjs';
import { TEAM_DECOMPOSITION_ARTIFACT, TEAM_GRAPH_ARTIFACT, TEAM_INBOX_DIR, TEAM_RUNTIME_TASKS_ARTIFACT, teamRuntimePlanMetadata, teamRuntimeRequiredArtifacts, validateTeamRuntimeArtifacts, writeTeamRuntimeArtifacts } from './team-dag.mjs';
import { formatRoleCounts, initTeamLive, parseTeamSpecText } from './team-live.mjs';

export { routePrompt };

const REFLECTION_ARTIFACT = 'reflection.md';
const REFLECTION_GATE = 'reflection-gate.json';
const REFLECTION_MEMORY_PATH = '.sneakoscope/memory/q2_facts/post-route-reflection.md';
const TEAM_SESSION_CLEANUP_ARTIFACT = 'team-session-cleanup.json';
const COMPLIANCE_LOOP_GUARD_ARTIFACT = 'compliance-loop-guard.json';
const HARD_BLOCKER_ARTIFACT = 'hard-blocker.json';
const DEFAULT_COMPLIANCE_LOOP_LIMIT = 3;

function reflectionInstructionText(commandPrefix = 'sks') {
  return `Post-route reflection: full routes load \`reflection\` after work/tests and before final; DFix/Answer/Help/Wiki/SKS discovery are exempt. Write ${REFLECTION_ARTIFACT}; record only real misses/gaps, or no_issue_acknowledged. For lessons, append TriWiki claim rows to ${REFLECTION_MEMORY_PATH}. Run "${commandPrefix} wiki refresh" or pack, validate, then pass ${REFLECTION_GATE}.`;
}

export function promptPipelineContext(prompt, route = routePrompt(prompt)) {
  const required = routeNeedsContext7(route, prompt);
  const reasoning = routeReasoning(route, prompt);
  const fastDesign = route?.id === 'DFix';
  if (fastDesign) return dfixQuickContext(prompt, route);
  if (route?.id === 'Answer') return answerOnlyContext(prompt, route);
  const lines = [
    `SKS skill-first pipeline active. Route: ${route?.command || '$SKS'} (${route?.route || 'general SKS workflow'}).`,
    reasoningInstruction(reasoning),
    'Before work, load the required SKS skill context and follow the route lifecycle instead of treating the command as plain text.',
    'Codex App visibility: briefly surface what SKS is doing before tools run, mirror important worker/tool status to mission artifacts, and keep progress legible to the user.',
    'Hook visibility limit: hooks can inject context/status or block/continue a turn, but they cannot create arbitrary live chat bubbles; use team events, mission files, or normal assistant updates for live transcript details.',
    'Ambiguity gate: every execution route must start with mandatory ambiguity-removal questions before execution. DFix and Answer bypass this gate because they do not start implementation.',
    'Plan-first interaction: when ambiguity questions are required, call the Codex plan tool first so the user sees Ask questions -> Seal decision contract -> Execute/verify as the visible workflow.',
    'Question-shaped directive policy: before using Answer, decide whether a question is a real information request or an implicit instruction/complaint about broken behavior. Rhetorical bug reports, mandatory-policy statements, and "why is this not happening?" execution complaints must route to Team, not Answer.',
    'Best-practice prompt shape: extract Goal, Context, Constraints, and Done-when before implementation; keep questions compact and only ask for answers that can change scope, safety, user-facing behavior, or acceptance criteria.',
    chatCaptureIntakeText(),
    'Default execution routing: general implementation/code-changing prompts promote to Team so the normal path is parallel analysis, TriWiki refresh, debate/consensus, then fresh parallel executors. Answer, DFix, Help, Wiki maintenance, and safety-specific routes are intentional exceptions.',
    'Stance: infer the user intent aggressively from rough wording and local context, but ask short ambiguity-removal questions before work when a missing answer can change the target, scope, safety boundary, or acceptance criteria.',
    subagentExecutionPolicyText(route, prompt),
    noUnrequestedFallbackCodePolicyText(),
    'Design routing: UI/UX reads design.md first; if missing, use design-system-builder from docs/Design-Sys-Prompt.md with plan-tool clarification and a default font recommendation. Existing designs use design-ui-editor plus design-artifact-expert. Image/logo/raster assets use imagegen.',
    triwikiContextTrackingText(),
    triwikiStagePolicyText(),
    stackCurrentDocsPolicyText(),
    'Extract intent, target files/surfaces, constraints, acceptance criteria, risks, and the smallest safe atomic step before acting.',
    'Do not stop at a plan when implementation was requested; continue until the route gate passes or a hard blocker is honestly recorded.',
    context7RequirementText(required),
    'Before final answer, include a user-visible completion summary that explains what changed and how it was verified, then run SKS Honest Mode: verify evidence/tests, state gaps, and confirm the goal is genuinely complete.'
  ];
  if (reflectionRequiredForRoute(route)) lines.push(reflectionInstructionText());
  if (route?.id === 'Team') lines.push(`Team route: scouts, TriWiki refresh, debate, consensus, runtime graph compile with concrete task ids and worker inboxes, close planning agents, fresh executors, review/integration, ${TEAM_SESSION_CLEANUP_ARTIFACT}, reflection, and Honest Mode.`);
  if (route?.id === 'Ralph') lines.push('Ralph route: no implementation until required clarification answers are converted into a sealed decision contract.');
  if (route?.id === 'AutoResearch') lines.push('AutoResearch route: load autoresearch-loop plus seo-geo-optimizer when SEO/GEO, discoverability, README, npm, GitHub stars, ranking, or AI-search visibility is relevant.');
  if (route?.id === 'DB') lines.push('DB route: scan/check database risk first; destructive DB operations remain forbidden.');
  if (route?.id === 'GX') lines.push('GX route: use deterministic vgraph/beta render, validate, drift, and snapshot artifacts.');
  return lines.join('\n');
}

export function dfixQuickContext(prompt, route = routePrompt(prompt)) {
  const task = stripDollarCommand(prompt) || String(prompt || '').trim();
  const routeLabel = route?.command || '$DFix';
  return [
    `DFix ultralight pipeline active. Route: ${routeLabel} (${route?.route || 'fast design/content fix'}).`,
    'Bypass: do not enter the general SKS prompt pipeline, mission creation, ambiguity gate, TriWiki refresh, Context7 routing, subagent orchestration, Ralph, Research, eval, or broad planning.',
    `Task: ${task}`,
    'Task list:',
    '1. Infer the smallest visible design/content target from the request and current files.',
    '2. Inspect only the files needed to locate that target.',
    '3. Apply only the listed design/content edit; for UI/UX micro-edits read design.md when present, and use imagegen for any image/logo/raster asset.',
    '4. Run only cheap verification when useful, such as syntax check, focused test, or local render smoke.',
    '5. Final response: one short completion summary explaining what changed, plus verification or the exact blocker.'
  ].join('\n');
}

export function answerOnlyContext(prompt, route = routePrompt(prompt)) {
  const task = stripDollarCommand(prompt) || String(prompt || '').trim();
  const required = routeNeedsContext7(route, task);
  return [
    `SKS answer-only pipeline active. Route: ${route?.command || '$Answer'} (${route?.route || 'answer-only research'}).`,
    'Intent classification: answer/research question, not implementation. Do not create route mission state, ask ambiguity-gate questions, spawn subagents, continue active Team/Ralph work, or edit files unless the user explicitly asks for implementation.',
    `Question: ${task}`,
    'Evidence flow:',
    '1. Check current repo facts and TriWiki context first; hydrate low-trust wiki claims from source paths before relying on them.',
    '2. Use web search for current, external, or uncertain facts when browsing is available or the user asks for latest/source-backed information.',
    '3. Use Context7 resolve-library-id plus query-docs when the answer depends on package, API, framework, SDK, MCP, or generated documentation behavior.',
    '4. For stack additions or version changes, preserve current-doc findings as high-priority TriWiki claims before recommending syntax or implementation.',
    `5. ${context7RequirementText(required)}`,
    '6. Finish with a clear answer summary plus Honest Mode fact-checking: separate verified facts, source-backed inferences, and remaining uncertainty.',
    'Answer directly and concisely. If the prompt is actually asking for code/work after inspection, state the re-route and use the proper execution pipeline.'
  ].join('\n');
}

export async function prepareRoute(root, prompt, state = {}) {
  const route = routePrompt(prompt);
  const madSksAuthorization = hasMadSksSignal(prompt);
  const task = stripDollarCommand(stripMadSksSignal(prompt)) || stripMadSksSignal(stripDollarCommand(prompt)) || String(prompt || '').trim();
  const explicit = Boolean(dollarCommand(prompt));
  if (!route) return { route: null, additionalContext: promptPipelineContext(prompt, null) };
  if (route.id === 'DFix') return prepareDfixQuickRoute(route, task);
  if (route.id === 'Answer') return prepareAnswerOnlyRoute(route, task);
  if (route.id === 'Wiki') return prepareWikiQuickRoute(route, task);
  const required = routeNeedsContext7(route, prompt);
  const reasoning = routeReasoning(route, prompt);
  const subagentsRequired = routeRequiresSubagents(route, prompt);
  if (route.id !== 'Help') return prepareClarificationGate(root, route, task, required, { ralph: route.id === 'Ralph', madSksAuthorization });
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

async function prepareDfixQuickRoute(route, task) {
  return {
    route,
    additionalContext: dfixQuickContext(task, route)
  };
}

async function prepareAnswerOnlyRoute(route, task) {
  return {
    route,
    additionalContext: answerOnlyContext(task, route)
  };
}

async function prepareWikiQuickRoute(route, task) {
  return {
    route,
    additionalContext: [
      `SKS wiki pipeline active. Route: ${route.command} (${route.route}).`,
      `Task: ${task || 'refresh and validate TriWiki'}`,
      'Run policy: refresh/update/갱신 -> `sks wiki refresh` then validate; prune/clean/정리 -> `sks wiki refresh --prune` or dry-run prune first; pack -> `sks wiki pack` then validate.',
      stackCurrentDocsPolicyText(),
      'Report claims, anchors, trust, validation, and blockers. Do not create mission state, ask ambiguity-gate questions, spawn subagents, or run unrelated work.'
    ].join('\n')
  };
}

export async function activeRouteContext(root, state) {
  if (!state?.route && !state?.mode) return '';
  const id = state.route || state.mode;
  const reasoningNote = state.reasoning_effort ? ` Temporary reasoning remains ${state.reasoning_effort} (${state.reasoning_profile}); return to the default profile after this route completes.` : '';
  if (state.honest_loop_required || /HONEST_LOOPBACK_AFTER_CLARIFICATION/.test(String(state.phase || ''))) {
    return `SKS Honest Mode found unresolved gaps for ${state.route_command || state.route || state.mode}. Do not ask ambiguity questions again. Continue from the sealed decision-contract.json, inspect .sneakoscope/missions/${state.mission_id}/honest-loopback.json, fix gaps, rerun verification, refresh/validate TriWiki, then retry final Honest Mode.${reasoningNote}`;
  }
  if (state.clarification_required && String(state.phase || '').includes('CLARIFICATION_AWAITING_ANSWERS')) return clarificationAwaitingAnswersContext(root, state);
  if (state.clarification_passed && String(state.phase || '').includes('CLARIFICATION_CONTRACT_SEALED')) {
    return `Mandatory ambiguity-removal gate passed for ${state.route_command || state.route || state.mode}. Use the sealed decision-contract.json before executing the route. Before the next route phase, read relevant TriWiki context, hydrate low-trust claims from source, and refresh/validate TriWiki again after new findings or artifact changes. Next atomic action: continue the original route lifecycle with the clarified goal, constraints, non-goals, risk boundary, and test scope.`;
  }
  if (state.mode === 'TEAM') {
    const context7 = state.context7_required && !(await hasContext7DocsEvidence(root, state))
      ? ' Context7 evidence is still required before completion: use resolve-library-id, then query-docs (or legacy get-library-docs).'
      : '';
    const roles = state.role_counts ? ` Role counts: ${formatRoleCounts(state.role_counts)}.` : '';
    return `Active Team mission ${state.mission_id || 'latest'} must keep the user-visible live transcript updated. Agent session budget: ${state.agent_sessions || 3}.${roles} Run scouts, TriWiki refresh, debate, consensus, fresh development, review/integration, then close or account for every Team subagent session and write ${TEAM_SESSION_CLEANUP_ARTIFACT} before reflection/final. After each subagent status/result/handoff, run: sks team event ${state.mission_id || 'latest'} --agent <name> --phase <phase> --message "...". Inspect with sks team log/watch ${state.mission_id || 'latest'}.${reasoningNote}${context7}`;
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
  return prepareClarificationGate(root, route, task, required, { ralph: true });
}

async function prepareClarificationGate(root, route, task, required, opts = {}) {
  const { id, dir, mission } = await createMission(root, { mode: String(route.mode || route.id || 'route').toLowerCase(), prompt: task });
  const schema = buildQuestionSchemaForRoute(route, task);
  if (opts.madSksAuthorization) applyMadSksAuthorizationToSchema(schema);
  await writeQuestions(dir, schema);
  const routeContext = { route: route.id, command: route.command, mode: route.mode, task, required_skills: route.requiredSkills, context7_required: required, original_stop_gate: route.stopGate, clarification_gate: true, mad_sks_authorization: Boolean(opts.madSksAuthorization || route.id === 'MadSKS') };
  await writeJsonAtomic(path.join(dir, 'route-context.json'), routeContext);
  if (!opts.ralph && schema.slots.length === 0) {
    await writeJsonAtomic(path.join(dir, 'answers.json'), schema.inferred_answers || {});
    const result = await sealContract(dir, mission);
    await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'route.clarification.auto_sealed', route: route.id, slots: 0, ok: result.ok });
    await setCurrent(root, routeState(id, route, result.ok ? `${route.mode}_CLARIFICATION_CONTRACT_SEALED` : `${route.mode}_CLARIFICATION_AWAITING_ANSWERS`, required, {
      prompt: task,
      questions_allowed: false,
      implementation_allowed: result.ok,
      clarification_required: false,
      clarification_passed: result.ok,
      ambiguity_gate_required: true,
      ambiguity_gate_passed: result.ok,
      original_stop_gate: route.stopGate,
      stop_gate: route.stopGate
    }));
    return {
      route,
      additionalContext: `${promptPipelineContext(task, route)}

Ambiguity gate auto-sealed for ${route.command}: all contract answers were inferred from the prompt, TriWiki/current-code defaults, and conservative SKS safety policy.
Mission: ${id}
Decision contract: .sneakoscope/missions/${id}/decision-contract.json
Resolved answers: .sneakoscope/missions/${id}/resolved-answers.json
Next atomic action: continue the original route lifecycle with the sealed decision-contract.json.`
    };
  }
  await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: opts.ralph ? 'route.ralph.questions_created' : 'route.clarification.questions_created', route: route.id, slots: schema.slots.length });
  const phase = opts.ralph ? 'RALPH_AWAITING_ANSWERS' : `${route.mode}_CLARIFICATION_AWAITING_ANSWERS`;
  await setCurrent(root, routeState(id, route, phase, required, { prompt: task, questions_allowed: true, implementation_allowed: false, clarification_required: true, ambiguity_gate_required: true, original_stop_gate: route.stopGate, stop_gate: 'clarification-gate' }));
  const answerCommand = opts.ralph
    ? 'sks ralph answer latest answers.json, then run "sks ralph run latest"'
    : 'sks pipeline answer latest answers.json, then continue the original route lifecycle';
  const title = opts.ralph ? 'MANDATORY $Ralph route activated.' : 'MANDATORY ambiguity-removal gate activated.';
  return {
    route,
    additionalContext: `${title}
Mission: ${id}
Route: ${route.command} (${route.route})
Task: ${task}
State: ${phase}
Question file: .sneakoscope/missions/${id}/questions.md
Answer schema: .sneakoscope/missions/${id}/required-answers.schema.json

Do not execute the route yet. Ask the user the required ambiguity-removal questions now. After the user answers, convert the answers to answers.json, run "${answerCommand}".
${context7RequirementText(required)}
${clarificationPlanHint(route, id, opts.ralph)}

Required questions:
${formatRalphQuestions(schema)}`
  };
}

function applyMadSksAuthorizationToSchema(schema = {}) {
  schema.domain_hints = Array.from(new Set([...(schema.domain_hints || []), 'mad-sks']));
  schema.inferred_answers = {
    ...(schema.inferred_answers || {}),
    MAD_SKS_MODE: 'explicit_invocation_only',
    DATABASE_TARGET_ENVIRONMENT: 'main_branch',
    DATABASE_WRITE_MODE: 'mad_sks_full_mcp_write_for_invocation',
    SUPABASE_MCP_POLICY: 'mad_sks_project_scoped_write_for_invocation',
    DESTRUCTIVE_DB_OPERATIONS_ALLOWED: 'mad_sks_scoped_with_table_delete_confirmation',
    DB_BACKUP_OR_BRANCH_REQUIRED: 'recommended_but_not_required_in_mad_sks',
    DB_MAX_BLAST_RADIUS: 'mad_sks_active_invocation_only_table_delete_confirmation_required',
    DB_MIGRATION_APPLY_ALLOWED: 'mad_sks_active_invocation_only',
    DB_READ_ONLY_QUERY_LIMIT: '100'
  };
  schema.inference_notes = {
    ...(schema.inference_notes || {}),
    MAD_SKS_MODE: 'explicit dollar command modifier is the permission boundary',
    DESTRUCTIVE_DB_OPERATIONS_ALLOWED: 'MAD-SKS scoped override with table deletion confirmation'
  };
  schema.slots = (schema.slots || []).filter((slot) => !/^(DB_|DATABASE_|DESTRUCTIVE_DB_|SUPABASE_MCP_POLICY$)/.test(slot.id));
  return schema;
}

async function prepareTeam(root, route, task, required) {
  const spec = parseTeamSpecText(task);
  const cleanTask = spec.prompt || task;
  const fromChatImgRequired = hasFromChatImgSignal(cleanTask);
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
      phases: ['parallel_analysis_scouts', 'triwiki_stage_refresh', 'debate_team', 'triwiki_stage_refresh', 'runtime_task_graph', 'development_team', 'triwiki_stage_refresh', 'review'],
      analysis_team: `Read-only parallel scouting with exactly ${roster.bundle_size} analysis_scout_N agents. Each scout owns one investigation slice and returns TriWiki-ready findings with source paths, risks, and suggested implementation slices.`,
      debate_team: `Read-only role debate with exactly ${roster.bundle_size} participants composed from user, planner, reviewer, and executor voices.`,
      development_team: `Fresh parallel development bundle with exactly ${roster.bundle_size} executor_N developers implementing disjoint slices; validation_team reviews afterward.`
    },
    context_tracking: triwikiContextTracking(),
    team_runtime: teamRuntimePlanMetadata(),
    phases: [
      { id: 'team_roster_confirmation', goal: `Before any implementation, materialize the Team roster from default SKS counts or explicit user counts, write team-roster.json, and surface role counts ${formatRoleCounts(roleCounts)}. Implementation cannot be considered complete unless team-gate.json has team_roster_confirmed=true.`, agents: ['parent_orchestrator'], output: 'team-roster.json' },
      { id: 'parallel_analysis_scouting', goal: `Before scouting, read TriWiki context. ${fromChatImgRequired ? `From-Chat-IMG active: use Computer Use/browser visual inspection, list every visible customer request, match every screenshot image region to attachments, write ${FROM_CHAT_IMG_COVERAGE_ARTIFACT}, ${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}, and ${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}, then require scoped QA-LOOP evidence in ${FROM_CHAT_IMG_QA_LOOP_ARTIFACT} after the customer-request work is done.` : 'From-Chat-IMG inactive: do not assume ordinary images are chat captures.'} Spawn exactly ${roster.bundle_size} read-only analysis_scout_N agents in parallel, using the full available session budget without exceeding ${agentSessions}. Split repo/docs/tests/API/user-flow/risk investigation into independent slices, hydrate relevant low-trust claims from source, and record source-backed findings.`, agents: roster.analysis_team.map((agent) => agent.id), max_parallel_subagents: agentSessions, write_policy: 'read-only' },
      { id: 'triwiki_refresh', goal: `Parent orchestrator updates Team analysis artifacts, then runs ${triwikiContextTracking().refresh_command} or ${triwikiContextTracking().pack_command}, prunes with ${triwikiContextTracking().prune_command} when stale/oversized wiki state would pollute handoffs, and runs ${triwikiContextTracking().validate_command} so the next stage uses current TriWiki context.`, agents: ['parent_orchestrator'], output: '.sneakoscope/wiki/context-pack.json' },
      { id: 'planning_debate', goal: `Before debate, read the refreshed TriWiki pack. Debate team of exactly ${roster.bundle_size} participants maps user inconvenience, options, constraints, affected files, DB/test risk, and tradeoffs while hydrating low-trust claims from source.`, agents: roster.debate_team.map((agent) => agent.id) },
      { id: 'consensus', goal: `Seal one objective with acceptance criteria and disjoint implementation slices, then refresh/validate TriWiki so implementation receives current consensus context.` },
      { id: 'runtime_task_graph_compile', goal: `Compile the agreed Team plan into ${TEAM_GRAPH_ARTIFACT}, ${TEAM_RUNTIME_TASKS_ARTIFACT}, and ${TEAM_DECOMPOSITION_ARTIFACT}; remap symbolic plan nodes to concrete task ids, allocate role/path/domain worker lanes, and write ${TEAM_INBOX_DIR} before executor work starts.`, agents: ['parent_orchestrator'], output: [TEAM_GRAPH_ARTIFACT, TEAM_RUNTIME_TASKS_ARTIFACT, TEAM_DECOMPOSITION_ARTIFACT, TEAM_INBOX_DIR] },
      { id: 'parallel_implementation', goal: `Before implementation, read relevant TriWiki context and current source. Close debate agents, then spawn a fresh ${roster.bundle_size}-person executor development team with non-overlapping write ownership. Refresh TriWiki after implementation changes or blockers.`, agents: roster.development_team.map((agent) => agent.id) },
      { id: 'review_integration', goal: 'Before review and final output, read/validate current TriWiki context, integrate executor output, strict review correctness/DB safety/tests, validate user friction with validation_team, refresh after review findings, and record evidence.', agents: roster.validation_team.map((agent) => agent.id) },
      { id: 'session_cleanup', goal: `Close or account for all Team subagent sessions, finalize live transcript state, and write ${TEAM_SESSION_CLEANUP_ARTIFACT} before reflection or final.`, agents: ['parent_orchestrator'] }
    ],
    live_visibility: {
      markdown: 'team-live.md',
      transcript: 'team-transcript.jsonl',
      dashboard: 'team-dashboard.json',
      cmux: 'CLI Team entrypoints open cmux live lanes for the visible Team agent budget when cmux is available.',
      commands: ['sks team status latest', 'sks team log latest', 'sks team tail latest', 'sks team watch latest', 'sks team lane latest --agent <name> --follow', 'sks team event latest --agent <name> --phase <phase> --message "..."']
    },
    required_artifacts: ['team-roster.json', 'team-analysis.md', ...(fromChatImgRequired ? [FROM_CHAT_IMG_COVERAGE_ARTIFACT, FROM_CHAT_IMG_CHECKLIST_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, FROM_CHAT_IMG_QA_LOOP_ARTIFACT] : []), 'team-consensus.md', ...teamRuntimeRequiredArtifacts(), 'team-review.md', 'team-gate.json', TEAM_SESSION_CLEANUP_ARTIFACT, 'reflection.md', 'reflection-gate.json', 'team-live.md', 'team-transcript.jsonl', 'team-dashboard.json', '.sneakoscope/wiki/context-pack.json', 'context7-evidence.jsonl']
  };
  await writeJsonAtomic(path.join(dir, 'team-plan.json'), plan);
  await writeJsonAtomic(path.join(dir, 'team-roster.json'), { schema_version: 1, mission_id: id, role_counts: roleCounts, agent_sessions: agentSessions, bundle_size: roster.bundle_size, roster, confirmed: true, source: 'default_or_prompt_team_spec' });
  const contextTracking = triwikiContextTracking();
  await writeTextAtomic(path.join(dir, 'team-workflow.md'), `# SKS Team Workflow\n\nTask: ${cleanTask}\n\nAgent session budget: ${agentSessions}\nBundle size: ${roster.bundle_size}\nRole counts: ${formatRoleCounts(roleCounts)}\nReasoning: high for team logic, temporary for this route only.\nContext tracking: ${contextTracking.ssot} SSOT, ${contextTracking.default_pack}; use relevant TriWiki context before every work stage, refresh/validate after findings, and preserve hydratable source anchors.\n\n1. Run exactly ${roster.bundle_size} read-only analysis_scout_N agents and write team-analysis.md.\n2. Refresh/validate TriWiki before debate.\n3. Run exactly ${roster.bundle_size} debate participants, then write consensus and implementation slices.\n4. Compile ${TEAM_GRAPH_ARTIFACT}, ${TEAM_RUNTIME_TASKS_ARTIFACT}, ${TEAM_DECOMPOSITION_ARTIFACT}, and ${TEAM_INBOX_DIR} so worker handoff uses concrete runtime task ids.\n5. Close debate agents before starting a fresh ${roster.bundle_size}-person executor team.\n6. Review, integrate, verify, and record evidence.\n7. Close/clean remaining Team sessions, finalize live transcript state, and write ${TEAM_SESSION_CLEANUP_ARTIFACT} before reflection/final.\n\nNo unrequested fallback implementation code is allowed in any stage, executor lane, review lane, MAD route, or MAD-SKS route. If the requested path cannot be implemented inside the sealed contract, block with evidence instead of adding substitute behavior.\n\nLive visibility:\n- sks team log ${id}\n- sks team tail ${id}\n- sks team watch ${id}\n- sks team lane ${id} --agent analysis_scout_1 --follow\n- sks team event ${id} --agent <name> --phase <phase> --message \"...\"\n`);
  await initTeamLive(id, dir, cleanTask, { agentSessions, roleCounts, roster });
  const runtime = await writeTeamRuntimeArtifacts(dir, plan, {});
  await writeJsonAtomic(path.join(dir, 'team-gate.json'), { passed: false, team_roster_confirmed: true, analysis_artifact: false, triwiki_refreshed: false, triwiki_validated: false, consensus_artifact: false, ...runtime.gate_fields, implementation_team_fresh: false, review_artifact: false, integration_evidence: false, session_cleanup: false, context7_evidence: false, ...(fromChatImgRequired ? { from_chat_img_required: true, from_chat_img_request_coverage: false } : {}) });
  await setCurrent(root, routeState(id, route, 'TEAM_PARALLEL_ANALYSIS_SCOUTING', required, { prompt: cleanTask, agent_sessions: agentSessions, role_counts: roleCounts, team_roster_confirmed: true, team_graph_ready: runtime.ok, context_tracking: 'triwiki', from_chat_img_required: fromChatImgRequired }));
  return routeContext(route, id, cleanTask, required, `Run scouts, refresh/validate TriWiki, debate, close debate agents, form a fresh ${roster.bundle_size}-person executor team, then close/clean Team sessions and write ${TEAM_SESSION_CLEANUP_ARTIFACT} before reflection.`);
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
  return { mission_id: id, route: route.id, route_command: route.command, mode: route.mode, phase, context7_required: context7Required, context7_verified: false, subagents_required: subagentsRequired, subagents_verified: false, reflection_required: reflectionRequiredForRoute(route), visible_progress_required: true, context_tracking: 'triwiki', required_skills: route.requiredSkills, stop_gate: route.stopGate, reasoning_effort: reasoning.effort, reasoning_profile: reasoning.profile, reasoning_temporary: true, ...extra };
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
TriWiki: use only the latest coordinate+voxel-overlay context pack before each route phase, hydrate low-trust claims during the phase, refresh after new findings or artifact changes, and validate before handoffs/final claims. Coordinate-only legacy packs are invalid and must be refreshed before pipeline decisions.
Final closeout: every pipeline final answer must summarize what was done, what changed for the user/repo, what was verified, and any remaining gaps.
${reflectionRequiredForRoute(route) ? `Reflection: ${reflectionInstructionText()}` : 'Reflection: not required for this lightweight route.'}
Reasoning: ${routeReasoning(route, task).effort} temporary; return to default after completion.
Next atomic action: ${next}`
  };
}

async function ralphAwaitingAnswersContext(root, state) {
  const id = state.mission_id;
  if (!id) return '';
  const schema = await readJson(path.join(missionDir(root, id), 'required-answers.schema.json'), null);
  const questionBlock = schema ? `\n\nRequired questions still pending:\n${formatRalphQuestions(schema)}` : '';
  return `Active Ralph mission ${id} is waiting for mandatory clarification answers. If the user answered, write answers.json, run "sks ralph answer ${id} answers.json", then "sks ralph run ${id}". If required answers are missing, use the Codex plan tool first, then ask only those questions. Do not implement outside Ralph.${clarificationPlanHint({ command: '$Ralph', route: 'Ralph mission' }, id, true)}${questionBlock}`;
}

async function clarificationAwaitingAnswersContext(root, state) {
  const id = state.mission_id;
  if (!id) return '';
  const schema = await readJson(path.join(missionDir(root, id), 'required-answers.schema.json'), null);
  const questionBlock = schema ? `\n\nRequired questions still pending:\n${formatRalphQuestions(schema)}` : '';
  return `Active SKS route ${state.route_command || state.route || state.mode} is waiting for mandatory ambiguity-removal answers. If the user answered, write answers.json, run "sks pipeline answer ${id} answers.json", then continue the original route lifecycle. If required answers are missing, use the Codex plan tool first, then ask only those questions. Do not execute the route before this gate passes.${clarificationPlanHint({ command: state.route_command || state.route || '$SKS', route: state.route || state.mode || 'SKS route' }, id, false)}${questionBlock}`;
}

function clarificationPlanHint(route, id, ralph = false) {
  const command = ralph ? `sks ralph answer ${id} answers.json` : `sks pipeline answer ${id} answers.json`;
  return `

Codex plan-tool interaction:
Before asking the user, call update_plan with:
- in_progress: Ask mandatory ambiguity-removal questions for ${route.command || '$SKS'}
- pending: Convert the user's answers to answers.json and run \`${command}\`
- pending: Continue the original route lifecycle with the sealed decision-contract.json
Then ask the questions in one compact message.`;
}

function formatRalphQuestions(schema) {
  return schema.slots.map((s, i) => {
    const options = s.options ? ` Options: ${s.options.join(', ')}.` : '';
    const examples = s.examples ? ` Examples: ${s.examples.join(', ')}.` : '';
    return `${i + 1}. ${s.id}: ${s.question}${options}${examples}`;
  }).join('\n');
}

async function clarificationStopReason(root, state, kind) {
  const id = state?.mission_id || 'latest';
  const routeName = state?.route_command || state?.route || state?.mode || 'route';
  const isRalph = kind === 'ralph';
  const schema = state?.mission_id ? await readJson(path.join(missionDir(root, state.mission_id), 'required-answers.schema.json'), null) : null;
  const questionBlock = schema ? `\n\nRequired questions (reply in chat by slot id):\n${formatRalphQuestions(schema)}` : '';
  const files = state?.mission_id ? `
Question file: .sneakoscope/missions/${state.mission_id}/questions.md
Answer schema: .sneakoscope/missions/${state.mission_id}/required-answers.schema.json` : '';
  const command = isRalph
    ? `sks ralph answer ${id} answers.json, then sks ralph run ${id}`
    : `sks pipeline answer ${id} answers.json, then continue the original ${routeName} route`;
  const title = isRalph
    ? `Ralph mission ${id} is waiting for mandatory clarification answers.`
    : `SKS ${routeName} is waiting for mandatory ambiguity-removal answers.`;
  return `${title}
Do not finish or implement yet. Reprint these questions to the user if they are not already visible.${files}

The user can answer directly in chat as plain text, for example:
GOAL_PRECISE: ...
ACCEPTANCE_CRITERIA:
- ...
NON_GOALS:
- ...

${clarificationPlanHint({ command: routeName, route: routeName }, id, isRalph)}

After the user answers, convert the reply to answers.json and run: ${command}.${questionBlock}`;
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

function reflectionRequiredForState(state = {}) {
  if (state.reflection_required === false) return false;
  if (state.reflection_required === true) return true;
  return reflectionRequiredForRoute(state.route || state.mode || state.route_command);
}

async function reflectionGateStatus(root, state = {}) {
  if (!reflectionRequiredForState(state)) return { ok: true, missing: [] };
  const id = state?.mission_id;
  if (!id) return { ok: false, missing: ['mission_id'] };
  const dir = missionDir(root, id);
  const gate = await readJson(path.join(dir, REFLECTION_GATE), null);
  if (!gate) return { ok: false, missing: [REFLECTION_GATE] };
  const hasArtifact = gate.reflection_artifact === true && await exists(path.join(dir, REFLECTION_ARTIFACT));
  const hasLesson = gate.lessons_recorded === true || (Array.isArray(gate.lessons) && gate.lessons.length > 0);
  const noIssue = gate.no_issue_acknowledged === true;
  const hasMemory = gate.triwiki_recorded === true || gate.memory_recorded === true;
  const missing = [];
  if (gate.passed !== true) missing.push('passed');
  if (!hasArtifact) missing.push(REFLECTION_ARTIFACT);
  if (!hasLesson && !noIssue) missing.push('lessons_recorded_or_no_issue_acknowledged');
  if (hasLesson && !hasMemory) missing.push('triwiki_recorded');
  if (hasMemory && !(await exists(path.join(root, REFLECTION_MEMORY_PATH)))) missing.push(REFLECTION_MEMORY_PATH);
  if (gate.wiki_refreshed_or_packed !== true && gate.triwiki_refreshed !== true) missing.push('wiki_refreshed_or_packed');
  if (gate.wiki_validated !== true) missing.push('wiki_validated');
  missing.push(...await staleReflectionReasons(root, state, gate));
  return { ok: missing.length === 0, missing };
}

async function staleReflectionReasons(root, state = {}, gate = {}) {
  const created = Date.parse(gate.created_at || gate.updated_at || '');
  if (!Number.isFinite(created)) return ['reflection-gate:created_at'];
  const id = state?.mission_id;
  if (!id) return [];
  const dir = missionDir(root, id);
  const missing = [];
  for (const file of gateFilesForState(state).filter((file) => file && !['none', 'honest_mode'].includes(file))) {
    if (await fileUpdatedAfter(path.join(dir, file), created)) missing.push(`${file}:updated_after_reflection`);
  }
  const transcript = await readText(path.join(dir, 'team-transcript.jsonl'), '');
  const newerWorkEvent = transcript
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .find((event) => {
      const ts = Date.parse(event?.ts || '');
      if (!Number.isFinite(ts) || ts <= created) return false;
      return !/^(REFLECTION|HONEST|TEAM_CLEANUP)$/i.test(String(event?.phase || ''));
    });
  if (newerWorkEvent) missing.push('team-transcript.jsonl:work_after_reflection');
  return missing;
}

async function fileUpdatedAfter(file, timeMs) {
  try {
    const stat = await fsp.stat(file);
    return stat.mtimeMs > timeMs + 1000;
  } catch {
    return false;
  }
}

function reflectionStopReason(state = {}, status = {}) {
  const id = state?.mission_id || 'latest';
  const route = String(state.route_command || state.route || state.mode || 'route');
  const missing = status.missing?.length ? ` Missing: ${status.missing.join(', ')}.` : '';
  return `SKS ${route} must run reflection before final. Write .sneakoscope/missions/${id}/${REFLECTION_ARTIFACT}, record real lessons in ${REFLECTION_MEMORY_PATH} when present, refresh/pack and validate TriWiki, then pass .sneakoscope/missions/${id}/${REFLECTION_GATE}.${missing}`;
}

export async function evaluateStop(root, state, payload, opts = {}) {
  const last = extractLastMessage(payload);
  if (state?.mode === 'RALPH' && ['RALPH_PREPARE', 'RALPH_AWAITING_ANSWERS'].includes(state.phase)) {
    if (looksLikeRalphQuestionResponse(last)) return { continue: true };
    return complianceBlock(root, state, await clarificationStopReason(root, state, 'ralph'), { gate: 'clarification' });
  }
  if (state?.clarification_required && String(state.phase || '').includes('CLARIFICATION_AWAITING_ANSWERS')) {
    if (looksLikeRalphQuestionResponse(last)) return { continue: true };
    return complianceBlock(root, state, await clarificationStopReason(root, state, 'route'), { gate: 'clarification' });
  }
  if (state?.mode === 'RALPH' && state.phase === 'DECISION_CONTRACT_SEALED') {
    return complianceBlock(root, state, `Ralph mission ${state.mission_id || 'latest'} has a sealed decision contract but has not run. Continue automatically by running: sks ralph run ${state.mission_id || 'latest'}`, { gate: 'ralph-run' });
  }
  if (state?.mode === 'RALPH' && /^RALPH_PAUSED/.test(String(state.phase || ''))) {
    return complianceBlock(root, state, `Ralph mission ${state.mission_id || 'latest'} paused before completion. Resume with sks ralph run ${state.mission_id || 'latest'} or record a hard blocker in done-gate.json before finishing.`, { gate: 'ralph-paused' });
  }
  if (state?.context7_required && !(await hasContext7DocsEvidence(root, state))) {
    return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} requires Context7 evidence before completion. Use Context7 resolve-library-id, then query-docs (or legacy get-library-docs), so SKS can record context7-evidence.jsonl.`, { gate: 'context7-evidence' });
  }
  if (state?.subagents_required && !(await hasSubagentEvidence(root, state))) {
    return complianceBlock(root, state, `SKS ${state.route_command || state.mode || 'route'} requires subagent execution evidence before completion. Spawn worker/reviewer subagents for disjoint code-changing work, or record explicit evidence that subagents were unavailable or unsafe to split.`, { gate: 'subagent-evidence' });
  }
  if (opts.noQuestion) {
    if (containsUserQuestion(last)) return complianceBlock(root, state, noQuestionContinuationReason(), { gate: 'no-question' });
    const gate = await passedActiveGate(root, state);
    if (gate.ok) {
      const reflection = await reflectionGateStatus(root, state);
      if (!reflection.ok) return complianceBlock(root, state, reflectionStopReason(state, reflection), { gate: 'reflection', missing: reflection.missing });
      return { continue: true };
    }
    const missing = gate.missing?.length ? ` Missing gate fields: ${gate.missing.join(', ')}.` : '';
    return complianceBlock(root, state, `SKS no-question run is not done. Continue autonomously, fix failing checks, update ${gate.file || 'the active gate file'}, and do not ask the user.${missing}`, { gate: gate.file || 'active-gate', missing: gate.missing });
  }
  if (state?.mission_id && state?.stop_gate && !['none', 'honest_mode'].includes(state.stop_gate)) {
    const gate = await passedActiveGate(root, state);
    if (!gate.ok) {
      const missing = gate.missing?.length ? ` Missing gate fields: ${gate.missing.join(', ')}.` : '';
      return complianceBlock(root, state, `SKS ${state.route_command || state.mode} route cannot stop yet. Pass ${gate.file || state.stop_gate} or record a hard blocker with evidence before finishing.${missing}`, { gate: gate.file || state.stop_gate, missing: gate.missing });
    }
  }
  const reflection = await reflectionGateStatus(root, state);
  if (!reflection.ok) return complianceBlock(root, state, reflectionStopReason(state, reflection), { gate: 'reflection', missing: reflection.missing });
  return null;
}

async function complianceBlock(root, state = {}, reason = '', detail = {}) {
  if (!state?.mission_id) return { decision: 'block', reason };
  const dir = missionDir(root, state.mission_id);
  const guardPath = path.join(dir, COMPLIANCE_LOOP_GUARD_ARTIFACT);
  const normalized = normalizeComplianceReason(reason);
  const previous = await readJson(guardPath, {});
  const count = previous.normalized_reason === normalized ? Number(previous.repeat_count || 0) + 1 : 1;
  const limit = complianceLoopLimit();
  const record = {
    schema_version: 1,
    updated_at: nowIso(),
    mission_id: state.mission_id,
    route: state.route_command || state.route || state.mode || null,
    gate: detail.gate || state.stop_gate || null,
    normalized_reason: normalized,
    repeat_count: count,
    limit,
    tripped: count >= limit,
    last_reason: reason,
    missing: Array.isArray(detail.missing) ? detail.missing : []
  };
  await writeJsonAtomic(guardPath, record);
  await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'pipeline.compliance_loop_guard', gate: record.gate, repeat_count: count, limit, tripped: record.tripped, missing: record.missing });
  if (!record.tripped) return { decision: 'block', reason };
  await writeJsonAtomic(path.join(dir, HARD_BLOCKER_ARTIFACT), {
    passed: true,
    created_at: nowIso(),
    reason: 'compliance_loop_guard_tripped',
    route: record.route,
    gate: record.gate,
    repeat_count: count,
    limit,
    original_reason: reason,
    evidence: [
      `${COMPLIANCE_LOOP_GUARD_ARTIFACT}: repeated identical compliance stop reason ${count} time(s)`,
      'Pipeline stopped as a hard blocker instead of looping indefinitely; no completion success is claimed.'
    ]
  });
  await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'pipeline.compliance_loop_guard.tripped', gate: record.gate, repeat_count: count, limit });
  return null;
}

function complianceLoopLimit() {
  const raw = Number.parseInt(process.env.SKS_COMPLIANCE_LOOP_LIMIT || '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_COMPLIANCE_LOOP_LIMIT;
  return Math.max(1, Math.min(20, raw));
}

function normalizeComplianceReason(reason = '') {
  return String(reason || '')
    .replace(/\bM-\d{8}-\d{6}-[a-z0-9]+\b/gi, 'M-*')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, 'TIMESTAMP')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

async function passedActiveGate(root, state) {
  const id = state?.mission_id;
  if (!id) return { ok: false, file: null };
  const files = gateFilesForState(state);
  for (const file of files) {
    const p = path.join(missionDir(root, id), file);
    if (await exists(p)) {
      const gate = await readJson(p, {});
      const missing = [
        ...missingRequiredGateFields(file, state, gate),
        ...await missingRequiredGateArtifacts(root, file, state, gate)
      ];
      if (gate.passed === true && !missing.length) return { ok: true, file };
      if (missing.length) return { ok: false, file, missing };
      return { ok: false, file };
    }
  }
  const hardBlocker = await passedHardBlocker(root, state);
  if (hardBlocker.ok) return hardBlocker;
  return { ok: false, file: files[0] || null };
}

async function passedHardBlocker(root, state) {
  if (!state?.mission_id) return { ok: false };
  const file = 'hard-blocker.json';
  const blocker = await readJson(path.join(missionDir(root, state.mission_id), file), null);
  if (!blocker) return { ok: false };
  return { ok: blocker.passed === true && String(blocker.reason || '').trim() && Array.isArray(blocker.evidence) && blocker.evidence.length > 0, file };
}

function missingRequiredGateFields(file, state, gate = {}) {
  const mode = String(state?.mode || '').toUpperCase();
  if (file === 'team-gate.json' || mode === 'TEAM') {
    const required = ['team_roster_confirmed', 'analysis_artifact', 'triwiki_refreshed', 'triwiki_validated', 'consensus_artifact', 'implementation_team_fresh', 'review_artifact', 'integration_evidence', 'session_cleanup'];
    if (fromChatImgCoverageRequired(state, gate)) required.push('from_chat_img_request_coverage');
    if (teamGraphRequired(state, gate)) required.push('team_graph_compiled', 'runtime_dependencies_concrete', 'worker_inboxes_written', 'write_scope_conflicts_zero', 'task_claim_readiness_checked');
    return required
      .filter((key) => gate[key] !== true);
  }
  if (file === 'qa-gate.json' || mode === 'QALOOP') {
    return ['clarification_contract_sealed', 'qa_report_written', 'qa_ledger_complete', 'checklist_completed', 'safety_reviewed', 'deployed_destructive_tests_blocked', 'credentials_not_persisted', 'ui_computer_use_evidence', 'honest_mode_complete']
      .filter((key) => gate[key] !== true);
  }
  return [];
}

async function missingRequiredGateArtifacts(root, file, state, gate = {}) {
  const mode = String(state?.mode || '').toUpperCase();
  if (file !== 'team-gate.json' && mode !== 'TEAM') return [];
  const missing = [];
  if (gate.team_roster_confirmed === true && !(await exists(path.join(missionDir(root, state.mission_id), 'team-roster.json')))) missing.push('team-roster.json');
  if (teamGraphRequired(state, gate) && gate.team_graph_compiled === true) {
    const validation = await validateTeamRuntimeArtifacts(missionDir(root, state.mission_id));
    if (!validation.ok) missing.push(...validation.issues.map((issue) => `team-runtime:${issue}`));
  }
  if (fromChatImgCoverageRequired(state, gate) && gate.from_chat_img_request_coverage === true) {
    missing.push(...await missingFromChatImgCoverageArtifacts(root, state));
  }
  if (gate.session_cleanup !== true) return missing;
  const cleanup = await readJson(path.join(missionDir(root, state.mission_id), TEAM_SESSION_CLEANUP_ARTIFACT), null);
  if (!cleanup) return [...missing, TEAM_SESSION_CLEANUP_ARTIFACT];
  if (cleanup.passed !== true) missing.push(`${TEAM_SESSION_CLEANUP_ARTIFACT}:passed`);
  if (cleanup.all_sessions_closed !== true && cleanup.outstanding_sessions !== 0) missing.push(`${TEAM_SESSION_CLEANUP_ARTIFACT}:all_sessions_closed`);
  if (cleanup.live_transcript_finalized !== true) missing.push(`${TEAM_SESSION_CLEANUP_ARTIFACT}:live_transcript_finalized`);
  return missing;
}

function fromChatImgCoverageRequired(state = {}, gate = {}) {
  return state?.from_chat_img_required === true || gate?.from_chat_img_required === true;
}

function teamGraphRequired(state = {}, gate = {}) {
  return state?.team_graph_required === true || gate?.team_graph_required === true;
}

async function missingFromChatImgCoverageArtifacts(root, state = {}) {
  const missing = [];
  const id = state?.mission_id;
  if (!id) return [`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:mission_id`];
  const ledger = await readJson(path.join(missionDir(root, id), FROM_CHAT_IMG_COVERAGE_ARTIFACT), null);
  if (!ledger) return [FROM_CHAT_IMG_COVERAGE_ARTIFACT];
  if (ledger.passed !== true) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:passed`);
  for (const key of ['all_chat_requirements_listed', 'all_requirements_mapped_to_work_order', 'all_screenshot_regions_accounted', 'all_attachments_accounted', 'image_analysis_complete', 'verbatim_customer_requests_preserved', 'checklist_updated', 'temp_triwiki_recorded', 'scoped_qa_loop_completed']) {
    if (ledger[key] !== true) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:${key}`);
  }
  if (!Array.isArray(ledger.unresolved_items)) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:unresolved_items`);
  else if (ledger.unresolved_items.length > 0) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:unresolved_items`);
  if (!Array.isArray(ledger.chat_requirements) || ledger.chat_requirements.length === 0) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:chat_requirements`);
  if (!Array.isArray(ledger.work_order_items) || ledger.work_order_items.length === 0) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:work_order_items`);
  if (!Array.isArray(ledger.attachment_matches)) missing.push(`${FROM_CHAT_IMG_COVERAGE_ARTIFACT}:attachment_matches`);
  const checklistName = typeof ledger.checklist_file === 'string' && ledger.checklist_file.trim() ? ledger.checklist_file.trim() : FROM_CHAT_IMG_CHECKLIST_ARTIFACT;
  const checklistPath = path.join(missionDir(root, id), checklistName);
  const checklist = await readText(checklistPath, null).catch(() => null);
  if (typeof checklist !== 'string') missing.push(FROM_CHAT_IMG_CHECKLIST_ARTIFACT);
  else {
    if (!/- \[[ xX]\]\s+\S/.test(checklist)) missing.push(`${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}:checkboxes`);
    if (/- \[ \]\s+\S/.test(checklist)) missing.push(`${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}:unchecked_items`);
    for (const section of ['Customer Requests', 'Image Analysis', 'Work Items', 'QA Loop', 'Verification']) {
      if (!checklist.includes(section)) missing.push(`${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}:${section.toLowerCase().replaceAll(' ', '_')}`);
    }
  }
  const tempWikiName = typeof ledger.temp_triwiki_file === 'string' && ledger.temp_triwiki_file.trim() ? ledger.temp_triwiki_file.trim() : FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT;
  const tempWiki = await readJson(path.join(missionDir(root, id), tempWikiName), null);
  if (!tempWiki) missing.push(FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT);
  else {
    const ttl = Number(tempWiki.expires_after_sessions);
    if (tempWiki.scope !== 'temporary' || tempWiki.storage !== 'triwiki') missing.push(`${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}:scope`);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS) missing.push(`${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}:expires_after_sessions`);
    if (!Array.isArray(tempWiki.claims) || tempWiki.claims.length === 0) missing.push(`${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}:claims`);
  }
  const qaLoopName = typeof ledger.qa_loop_file === 'string' && ledger.qa_loop_file.trim() ? ledger.qa_loop_file.trim() : FROM_CHAT_IMG_QA_LOOP_ARTIFACT;
  const qaLoop = await readJson(path.join(missionDir(root, id), qaLoopName), null);
  if (!qaLoop) missing.push(FROM_CHAT_IMG_QA_LOOP_ARTIFACT);
  else {
    if (qaLoop.passed !== true) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:passed`);
    if (qaLoop.scope !== 'from-chat-img-work-order') missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:scope`);
    if (qaLoop.all_work_order_items_qa_checked !== true) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:all_work_order_items_qa_checked`);
    if (qaLoop.post_fix_verification_complete !== true) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:post_fix_verification_complete`);
    if (Number(qaLoop.unresolved_findings) !== 0) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:unresolved_findings`);
    if (Number(qaLoop.unresolved_fixable_findings) !== 0) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:unresolved_fixable_findings`);
    if (!Array.isArray(qaLoop.evidence) || qaLoop.evidence.length === 0) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:evidence`);
    const coveredWorkItems = new Set(Array.isArray(qaLoop.work_order_item_ids_covered) ? qaLoop.work_order_item_ids_covered.map(String) : []);
    for (const item of Array.isArray(ledger.work_order_items) ? ledger.work_order_items : []) {
      const workId = String(item?.id || '');
      if (workId && !coveredWorkItems.has(workId)) missing.push(`${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}:work_order_item_ids_covered`);
    }
  }
  return missing;
}

function gateFilesForState(state) {
  if (state.stop_gate) return [state.stop_gate];
  if (state.mode === 'RALPH') return ['done-gate.json', 'done-gate.evaluated.json'];
  if (state.mode === 'RESEARCH') return ['research-gate.json', 'research-gate.evaluated.json'];
  if (state.mode === 'TEAM') return ['team-gate.json'];
  if (state.mode === 'AUTORESEARCH') return ['autoresearch-gate.json'];
  if (state.mode === 'DB') return ['db-review.json'];
  if (state.mode === 'GX') return ['gx-gate.json'];
  if (state.mode === 'QALOOP') return ['qa-gate.json'];
  return ['done-gate.json'];
}

function extractLastMessage(payload) {
  return payload.last_assistant_message || payload.assistant_message || payload.message || payload.response || payload.raw || '';
}

function looksLikeRalphQuestionResponse(text) {
  return /(GOAL_PRECISE|ACCEPTANCE_CRITERIA|Ralph|랄프|질문|answers\.json|required-answers|Decision Contract|clarification|모호성|답변)/i.test(String(text || ''));
}
