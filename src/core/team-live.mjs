import path from 'node:path';
import { appendJsonlBounded, nowIso, readJson, readText, writeJsonAtomic, writeTextAtomic } from './fsx.mjs';
import { triwikiContextTracking, triwikiContextTrackingText } from './routes.mjs';

const MAX_LIVE_BYTES = 192 * 1024;
const DEFAULT_AGENTS = ['parent_orchestrator', 'analysis_scout', 'team_consensus', 'implementation_worker', 'db_safety_reviewer', 'qa_reviewer'];
export const DEFAULT_TEAM_ROLE_COUNTS = { user: 1, planner: 1, reviewer: 1, executor: 3 };
export const DEFAULT_MAX_TEAM_AGENT_SESSIONS = 6;
const ROLE_ALIASES = {
  user: 'user',
  users: 'user',
  customer: 'user',
  customers: 'user',
  client: 'user',
  enduser: 'user',
  stakeholder: 'user',
  planner: 'planner',
  planners: 'planner',
  architect: 'planner',
  architects: 'planner',
  lead: 'planner',
  executor: 'executor',
  executors: 'executor',
  implementer: 'executor',
  implementers: 'executor',
  developer: 'executor',
  developers: 'executor',
  dev: 'executor',
  devs: 'executor',
  reviewer: 'reviewer',
  reviewers: 'reviewer',
  critic: 'reviewer',
  critics: 'reviewer',
  qa: 'reviewer',
  verifier: 'reviewer',
  verifiers: 'reviewer'
};

export function teamLogPaths(dir) {
  return {
    live: path.join(dir, 'team-live.md'),
    transcript: path.join(dir, 'team-transcript.jsonl'),
    dashboard: path.join(dir, 'team-dashboard.json')
  };
}

export function defaultTeamDashboard(id, prompt, opts = {}) {
  const spec = normalizeTeamSpec(opts);
  return {
    schema_version: 1,
    mission_id: id,
    prompt,
    agent_session_count: spec.agentSessions,
    role_counts: spec.roleCounts,
    session_policy: `Use at most ${spec.agentSessions} subagent sessions at a time; parent orchestrator is not counted.`,
    bundle_size: spec.bundleSize,
    roster: spec.roster,
    context_tracking: triwikiContextTracking(),
    updated_at: nowIso(),
    live_files: {
      markdown: 'team-live.md',
      transcript: 'team-transcript.jsonl',
      dashboard: 'team-dashboard.json'
    },
    commands: {
      status: `sks team status ${id}`,
      log: `sks team log ${id}`,
      tail: `sks team tail ${id}`,
      watch: `sks team watch ${id}`,
      event: `sks team event ${id} --agent <agent> --phase <phase> --message "..."`
    },
    agents: Object.fromEntries([...new Set([...DEFAULT_AGENTS, ...spec.roster.all_agents.map((agent) => agent.id)])].map((name) => [name, { status: 'pending', phase: null, last_seen: null }])),
    phases: ['parallel_analysis_scouting', 'triwiki_refresh', 'debate_team', 'triwiki_refresh_after_consensus', 'parallel_development_team', 'triwiki_refresh_after_implementation', 'strict_review_and_user_acceptance', 'session_cleanup'],
    latest_messages: []
  };
}

export function teamLiveMarkdown(id, prompt, opts = {}) {
  const spec = normalizeTeamSpec(opts);
  const contextTracking = triwikiContextTrackingText();
  return `# SKS Team Live Transcript

Mission: ${id}

Agent session budget: ${spec.agentSessions}

Bundle size: ${spec.bundleSize}

Role counts: ${formatRoleCounts(spec.roleCounts)}

Task:
${prompt}

## How to Read

- This file is the Codex App-visible replacement for cmux-style team panes.
- Use at most ${spec.agentSessions} subagent sessions at a time unless the mission is recreated with a different budget.
- Team mode has three bundles: parallel analysis scouts first, debate team second, then fresh parallel development team.
- Use relevant TriWiki context before every stage, hydrate low-trust claims from source during the stage, refresh after findings/artifact changes, and validate before handoffs or final claims.
- Analysis scouts are read-only and split repo, docs, tests, risk, API, and user-flow investigation before the parent refreshes TriWiki for debate.
- executor:N means build N debate participants and then a separate N-person executor development team.
- User personas are intentionally impatient, self-interested, stubborn, low-context, and dislike inconvenience.
- Executors are capable developers with disjoint ownership.
- Reviewers are strict and adversarial about correctness, safety, tests, and evidence.
- Every useful subagent status, debate result, handoff, review finding, and integration decision must be appended here.
- Before reflection/final, close or account for all Team subagent sessions and write team-session-cleanup.json.
- Machine-readable events are mirrored to team-transcript.jsonl.
- Dashboard state is mirrored to team-dashboard.json.
- ${contextTracking}

## Commands

\`\`\`bash
sks team status ${id}
sks team log ${id}
sks team tail ${id}
sks team watch ${id}
sks team event ${id} --agent analysis_scout_1 --phase parallel_analysis_scouting --message "mapped repo slice"
\`\`\`

## Roster

Analysis scouts (${spec.roster.analysis_team.length} scouts):
${spec.roster.analysis_team.map((agent) => `- ${agent.id}: ${agent.persona}`).join('\n')}

Debate team (${spec.roster.debate_team.length} participants):
${spec.roster.debate_team.map((agent) => `- ${agent.id}: ${agent.persona}`).join('\n')}

Development team (${spec.roster.development_team.length} executors):
${spec.roster.development_team.map((agent) => `- ${agent.id}: ${agent.persona}`).join('\n')}

Validation team:
${spec.roster.validation_team.map((agent) => `- ${agent.id}: ${agent.persona}`).join('\n')}

## Live Events
`;
}

export async function initTeamLive(id, dir, prompt, opts = {}) {
  const files = teamLogPaths(dir);
  await writeJsonAtomic(files.dashboard, defaultTeamDashboard(id, prompt, opts));
  await writeTextAtomic(files.live, teamLiveMarkdown(id, prompt, opts));
  await writeTextAtomic(files.transcript, '');
  await appendTeamEvent(dir, { agent: 'parent_orchestrator', phase: 'mission_created', type: 'status', message: 'Team mission created and live transcript initialized.' });
  return files;
}

export function normalizeTeamAgentSessions(value, fallback = 3) {
  const n = Number(value ?? fallback);
  return Math.min(12, Math.max(1, Number.isFinite(n) ? Math.floor(n) : fallback));
}

export function parseTeamSpecArgs(args = []) {
  const cleanArgs = [];
  let roleCounts = { ...DEFAULT_TEAM_ROLE_COUNTS };
  let explicitSession = null;
  let explicitExecutor = false;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const rolePair = parseRolePair(arg);
    if (rolePair) {
      roleCounts[rolePair.role] = rolePair.count;
      if (rolePair.role === 'executor') explicitExecutor = true;
      continue;
    }
    const flagPair = arg.match(/^--([A-Za-z_-]+)=(\d+)$/);
    if (flagPair) {
      const role = normalizeTeamRole(flagPair[1]);
      if (role) {
        roleCounts[role] = normalizeTeamAgentSessions(flagPair[2], roleCounts[role] || 1);
        if (role === 'executor') explicitExecutor = true;
        continue;
      }
    }
    if (/^--(?:max-agents|max-sessions|max-team)$/.test(arg)) {
      explicitSession = DEFAULT_MAX_TEAM_AGENT_SESSIONS;
      if (!explicitExecutor) roleCounts.executor = DEFAULT_MAX_TEAM_AGENT_SESSIONS;
      continue;
    }
    if (/^--(?:agents|sessions|team-size)$/.test(arg)) {
      explicitSession = normalizeTeamAgentSessions(args[i + 1]);
      if (!explicitExecutor) roleCounts.executor = explicitSession;
      i++;
      continue;
    }
    const sessionEq = arg.match(/^--(?:agents|sessions|team-size)=(\d+)$/);
    if (sessionEq) {
      explicitSession = normalizeTeamAgentSessions(sessionEq[1]);
      if (!explicitExecutor) roleCounts.executor = explicitSession;
      continue;
    }
    const flagRole = arg.match(/^--([A-Za-z_-]+)$/);
    const role = flagRole ? normalizeTeamRole(flagRole[1]) : null;
    if (role && args[i + 1] && /^\d+$/.test(String(args[i + 1]))) {
      roleCounts[role] = normalizeTeamAgentSessions(args[i + 1], roleCounts[role] || 1);
      if (role === 'executor') explicitExecutor = true;
      i++;
      continue;
    }
    if (arg === '--json') continue;
    cleanArgs.push(args[i]);
  }
  return { cleanArgs, ...normalizeTeamSpec({ roleCounts, agentSessions: explicitSession }) };
}

export function parseTeamSpecText(text = '') {
  let roleCounts = { ...DEFAULT_TEAM_ROLE_COUNTS };
  let explicitExecutor = false;
  const wantsMaxAgents = /\b(max|maximum|maximal|available agents?)\b|최대|가용가능/i.test(String(text || ''));
  const prompt = String(text || '').replace(/\b([A-Za-z][A-Za-z_-]*):(\d+)\b/g, (token) => {
    const parsed = parseRolePair(token);
    if (!parsed) return token;
    roleCounts[parsed.role] = parsed.count;
    if (parsed.role === 'executor') explicitExecutor = true;
    return '';
  }).replace(/\s+/g, ' ').trim();
  if (wantsMaxAgents && !explicitExecutor) roleCounts.executor = DEFAULT_MAX_TEAM_AGENT_SESSIONS;
  return { prompt, ...normalizeTeamSpec({ roleCounts, agentSessions: wantsMaxAgents ? roleCounts.executor : undefined }) };
}

export function normalizeTeamSpec(opts = {}) {
  const roleCounts = normalizeTeamRoleCounts(opts.roleCounts);
  if (opts.agentSessions !== undefined && (!opts.roleCounts || opts.roleCounts.executor === undefined)) {
    roleCounts.executor = normalizeTeamAgentSessions(opts.agentSessions, roleCounts.executor);
  }
  const bundleSize = normalizeTeamAgentSessions(roleCounts.executor, DEFAULT_TEAM_ROLE_COUNTS.executor);
  const agentSessions = normalizeTeamAgentSessions(opts.agentSessions ?? bundleSize);
  return { agentSessions, bundleSize, roleCounts, roster: buildTeamRoster(roleCounts) };
}

export function normalizeTeamRoleCounts(input = {}) {
  const counts = { ...DEFAULT_TEAM_ROLE_COUNTS };
  for (const [key, value] of Object.entries(input || {})) {
    const role = normalizeTeamRole(key);
    if (role) counts[role] = normalizeTeamAgentSessions(value, counts[role] || 1);
  }
  return counts;
}

export function buildTeamRoster(roleCounts = DEFAULT_TEAM_ROLE_COUNTS) {
  const counts = normalizeTeamRoleCounts(roleCounts);
  const bundleSize = normalizeTeamAgentSessions(counts.executor);
  const debateUsers = numberedAgents('debate_user', counts.user, 'Impatient final user voice: low-context, self-interested, stubborn, dislikes inconvenience, rejects clever work that feels annoying.', 'user');
  const debatePlanners = numberedAgents('debate_planner', counts.planner, 'Pragmatic planner: turns vague intent into one objective, required clarification questions, constraints, acceptance criteria, and disjoint work slices.', 'planner');
  const debateReviewers = numberedAgents('debate_reviewer', counts.reviewer, 'Strict debate reviewer: adversarial about correctness, safety, DB risk, tests, regressions, and unsupported assumptions.', 'reviewer');
  const debateExecutorPool = numberedAgents('debate_executor', bundleSize, 'Capable developer voice in debate: estimates implementation shape, ownership boundaries, dependencies, and risks before coding starts.', 'executor');
  const debateTeam = composeDebateTeam({ users: debateUsers, planners: debatePlanners, reviewers: debateReviewers, executors: debateExecutorPool, bundleSize });
  const analysisScouts = numberedAgents('analysis_scout', bundleSize, 'Read-only analysis scout: quickly maps one independent slice of repo/docs/tests/API risk, records source paths and evidence, and returns TriWiki-ready findings.', 'scout');
  const developmentExecutors = numberedAgents('executor', bundleSize, 'Capable developer executor: owns one disjoint implementation slice and coordinates without reverting others.', 'executor');
  const validationReviewers = numberedAgents('reviewer', counts.reviewer, 'Strict reviewer: adversarial about correctness, safety, DB risk, tests, regressions, and unsupported claims.', 'reviewer');
  const validationUsers = numberedAgents('user', counts.user, 'Impatient final user acceptance persona: low-context, self-interested, stubborn, dislikes inconvenience, rejects clever work that feels annoying.', 'user');
  return {
    role_counts: counts,
    bundle_size: bundleSize,
    analysis_team: analysisScouts.map((agent) => ({ ...agent, write_policy: 'read-only scouting', output: 'team-analysis.md' })),
    debate_team: debateTeam,
    development_team: developmentExecutors.map((agent) => ({ ...agent, write_policy: 'workspace-write with explicit ownership' })),
    validation_team: [
      ...validationReviewers.map((agent) => ({ ...agent, write_policy: 'read-only strict review' })),
      ...validationUsers.map((agent) => ({ ...agent, phase_role: 'acceptance_persona' }))
    ],
    all_agents: [...analysisScouts, ...debateTeam, ...developmentExecutors, ...validationReviewers, ...validationUsers]
  };
}

export function formatRoleCounts(roleCounts = DEFAULT_TEAM_ROLE_COUNTS) {
  const counts = normalizeTeamRoleCounts(roleCounts);
  return Object.entries(counts).map(([role, count]) => `${role}:${count}`).join(' ');
}

function numberedAgents(prefix, count, persona, role = prefix) {
  return Array.from({ length: normalizeTeamAgentSessions(count, 1) }, (_, i) => ({ id: `${prefix}_${i + 1}`, role, index: i + 1, persona }));
}

function composeDebateTeam({ users, planners, reviewers, executors, bundleSize }) {
  const selected = [];
  const used = new Set();
  const add = (agent) => {
    if (!agent || selected.length >= bundleSize || used.has(agent.id)) return;
    selected.push(agent);
    used.add(agent.id);
  };
  add(users[0]);
  add(planners[0]);
  add(executors[0]);
  for (const agent of reviewers) add(agent);
  for (const agent of users.slice(1)) add(agent);
  for (const agent of planners.slice(1)) add(agent);
  for (const agent of executors.slice(1)) add(agent);
  return selected.slice(0, bundleSize);
}

function parseRolePair(token) {
  const match = String(token || '').match(/^([A-Za-z][A-Za-z_-]*):(\d+)$/);
  if (!match) return null;
  const role = normalizeTeamRole(match[1]);
  if (!role) return null;
  return { role, count: normalizeTeamAgentSessions(match[2], DEFAULT_TEAM_ROLE_COUNTS[role] || 1) };
}

function normalizeTeamRole(role) {
  return ROLE_ALIASES[String(role || '').trim().toLowerCase().replace(/[^a-z_-]/g, '')] || null;
}

export async function appendTeamEvent(dir, event) {
  const files = teamLogPaths(dir);
  const record = normalizeEvent(event);
  await appendJsonlBounded(files.transcript, record, 1024 * 1024);
  const dashboard = await readJson(files.dashboard, null);
  if (dashboard) {
    dashboard.updated_at = record.ts;
    dashboard.latest_messages = [...(dashboard.latest_messages || []), record].slice(-20);
    const agent = record.agent || 'unknown';
    dashboard.agents ||= {};
    dashboard.agents[agent] ||= {};
    dashboard.agents[agent].status = record.type || 'active';
    dashboard.agents[agent].phase = record.phase || null;
    dashboard.agents[agent].last_seen = record.ts;
    await writeJsonAtomic(files.dashboard, dashboard);
  }
  const current = await readText(files.live, teamLiveMarkdown('unknown', 'unknown'));
  const line = `\n- ${record.ts} [${record.phase || 'general'}] ${record.agent || 'unknown'}: ${record.message || ''}${record.artifact ? ` (${record.artifact})` : ''}\n`;
  await writeTextAtomic(files.live, trimLiveMarkdown(`${current.trimEnd()}${line}`));
  return record;
}

export async function readTeamDashboard(dir) {
  return readJson(teamLogPaths(dir).dashboard, null);
}

export async function readTeamLive(dir) {
  return readText(teamLogPaths(dir).live, '');
}

export async function readTeamTranscriptTail(dir, count = 20) {
  const text = await readText(teamLogPaths(dir).transcript, '');
  return text.split(/\n/).filter(Boolean).slice(-Math.max(1, Number(count) || 20));
}

function normalizeEvent(event = {}) {
  return {
    ts: event.ts || nowIso(),
    agent: String(event.agent || 'parent_orchestrator'),
    phase: String(event.phase || 'general'),
    type: String(event.type || 'status'),
    message: String(event.message || '').slice(0, 4000),
    artifact: event.artifact ? String(event.artifact) : undefined
  };
}

function trimLiveMarkdown(text) {
  if (Buffer.byteLength(text) <= MAX_LIVE_BYTES) return text.endsWith('\n') ? text : `${text}\n`;
  const marker = '## Live Events\n';
  const i = text.indexOf(marker);
  const head = i >= 0 ? text.slice(0, i + marker.length) : '# SKS Team Live Transcript\n\n## Live Events\n';
  const tail = Buffer.from(text.slice(-MAX_LIVE_BYTES + Buffer.byteLength(head) - 80)).toString('utf8').replace(/^.*?\n/, '');
  return `${head}\n- Older events were compacted; read team-transcript.jsonl for the bounded machine log.\n${tail.endsWith('\n') ? tail : `${tail}\n`}`;
}
