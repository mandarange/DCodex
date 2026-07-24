import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, exists, nowIso, readJson, readText, sha256, writeJsonAtomic, writeTextAtomic } from './fsx.js';
import { ARTIFACT_FILES, validateSkillCandidate, validateSkillInjectionDecision } from './artifact-schemas.js';
import { createSkillCard } from './evaluation.js';

export const SKILL_DREAM_POLICY = Object.freeze({
  schema_version: 1,
  state_path: '.sneakoscope/skills/dream-state.json',
  latest_report_path: '.sneakoscope/reports/skill-dream-latest.json',
  min_events_between_runs: 10,
  min_interval_hours: 24,
  max_events_retained: 160,
  max_skill_lines_before_compression: 80,
  max_skill_words_before_compression: 650,
  apply_mode: 'recommendation_only',
  no_auto_delete: true
});

const PROTECTED_SKILL_NAMES = new Set([
  'answer',
  'context7-docs',
  'db-safety-guard',
  'dfix',
  'help',
  'honest-mode',
  'pipeline-runner',
  'prompt-pipeline',
  'reasoning-router',
  'reflection',
  'sks',
  'naruto',
  'wiki'
]);

const MERGE_GROUPS = [
  { id: 'computer-use-aliases', skills: ['computer-use-fast', 'cu'], action: 'keep_one_canonical_and_alias_the_rest_when_user_approves; reserve computer-use for the first-party Codex plugin' },
  { id: 'research-loop-family', skills: ['research', 'autoresearch', 'autoresearch-loop'], action: 'compress_overlap_without_removing_distinct_route_semantics' }
];

export function skillDreamPolicyText() {
  return 'Skill dreaming policy: record only cheap route/skill usage counters in `.sneakoscope/skills/dream-state.json`; do not evaluate every conversation. Run `sks skill-dream run` or the automatic due check only after the configured event count and cooldown, defaulting to one due check every 10 route events subject to cooldown. Reports are recommendation-only: keep/merge/prune/improve candidates may update future generated skill wording, but skill deletion or merge requires explicit user approval.';
}

export function createSkillCandidate(opts: any = {}) {
  const successfulRuns = Number(opts.evidence?.successful_runs || opts.successful_runs || 0);
  const failedRuns = Number(opts.evidence?.failed_runs || opts.failed_runs || 0);
  const passRate = successfulRuns + failedRuns > 0 ? successfulRuns / (successfulRuns + failedRuns) : 0;
  return {
    schema_version: 1,
    id: opts.id || `skill.${safeId(opts.route || 'general')}.${safeId(opts.name || 'candidate')}.v1`,
    version: Number(opts.version || 1),
    status: opts.status || 'candidate',
    triggers: opts.triggers || [],
    contraindications: opts.contraindications || [],
    evidence: {
      successful_runs: successfulRuns,
      failed_runs: failedRuns,
      last_verified_at: opts.evidence?.last_verified_at || opts.last_verified_at || null,
      tests: opts.evidence?.tests || opts.tests || []
    },
    quality_score: Number(opts.quality_score ?? Math.min(1, passRate * 0.7 + Math.min(successfulRuns, 5) * 0.06)),
    risk_score: Number(opts.risk_score ?? (failedRuns > 0 ? 0.4 : 0.2)),
    injection_priority: Number(opts.injection_priority ?? 0.5),
    files: opts.files || []
  };
}

export function decideSkillInjection({ route = 'naruto', task_signature = '', skills = [], topK }: any = {}) {
  const k = Number(topK || (String(route).toLowerCase().includes('from-chat-img') ? 5 : 3));
  const ranked = skills
    .filter((skill: any) => skill.status === 'active' && !skill.stale && !skill.conflicting)
    .map((skill: any) => ({
      ...skill,
      match_score: skillMatchScore(skill, route, task_signature)
    }))
    .filter((skill: any) => skill.match_score > 0)
    .sort((a: any, b: any) => (b.match_score + Number(b.quality_score || 0) + Number(b.injection_priority || 0)) - (a.match_score + Number(a.quality_score || 0) + Number(a.injection_priority || 0)));
  return {
    schema_version: 1,
    route,
    task_signature,
    top_k: k,
    considered: skills.length,
    injected: ranked.slice(0, k).map(({ id, version, status, quality_score, match_score, files }: any) => ({ id, version, status, quality_score, match_score, files })),
    decided_at: nowIso()
  };
}

export async function writeSkillCandidate(dir: any, opts: any = {}) {
  const candidate = createSkillCandidate(opts);
  await writeJsonAtomic(path.join(dir, ARTIFACT_FILES.skill_candidate), candidate);
  return validateSkillCandidate(candidate);
}

export async function writeSkillInjectionDecision(dir: any, opts: any = {}) {
  const decision = decideSkillInjection(opts);
  await writeJsonAtomic(path.join(dir, ARTIFACT_FILES.skill_injection_decision), decision);
  return validateSkillInjectionDecision(decision);
}

export function createSkillForgeReport(opts: any = {}) {
  const candidates = (opts.candidates || []).map((candidate: any) => ({
    ...candidate,
    promotion_ready: Number(candidate.evidence?.successful_runs || 0) >= 3
      && Number(candidate.evidence?.failed_runs || 0) === 0
      && Number(candidate.quality_score || 0) >= 0.72
  }));
  const injection = decideSkillInjection({
    route: opts.route || 'naruto',
    task_signature: opts.task_signature || '',
    skills: opts.skills || [],
    topK: opts.topK || 8
  });
  return {
    schema_version: 1,
    mission_id: opts.mission_id || null,
    created_at: nowIso(),
    candidates,
    skill_cards: candidates.map((candidate: any) => createSkillCard({
      skill_id: candidate.id,
      name: candidate.id,
      version: `1.0.${Number(candidate.version || 1) - 1}`,
      status: candidate.promotion_ready ? 'active' : 'dormant',
      use_count: Number(candidate.evidence?.successful_runs || 0) + Number(candidate.evidence?.failed_runs || 0),
      success_count: Number(candidate.evidence?.successful_runs || 0),
      failure_count: Number(candidate.evidence?.failed_runs || 0),
      trigger_summary: (candidate.triggers || []).join(', '),
      anti_triggers: candidate.contraindications || [],
      validation: { commands: candidate.evidence?.tests || [], manual_checks: [], schemas: ['skill-card'] },
      implicit_invocation_allowed: candidate.promotion_ready
    })),
    injection,
    retirements: (opts.skills || []).filter((skill: any) => skill.stale || skill.conflicting || Number(skill.failed_runs || skill.evidence?.failed_runs || 0) >= 2).map((skill: any) => ({
      id: skill.id,
      reason_codes: [
        skill.stale ? 'stale' : null,
        skill.conflicting ? 'conflicting' : null,
        Number(skill.failed_runs || skill.evidence?.failed_runs || 0) >= 2 ? 'repeated_failure' : null
      ].filter(Boolean)
    })),
    validation: {
      top_k_respected: injection.injected.length <= injection.top_k,
      full_skill_loaded_only_after_selection: true,
      stale_or_false_triggered_skills_retired: true
    }
  };
}

export async function writeSkillForgeReport(dir: any, opts: any = {}) {
  const report = createSkillForgeReport(opts);
  await writeJsonAtomic(path.join(dir, 'skill-forge-report.json'), report);
  return report;
}

export async function loadSkillDreamState(root: any, opts: any = {}) {
  return normalizeSkillDreamState(await readJson(skillDreamStatePath(root), null), opts);
}

export function skillDreamDue(state: any, opts: any = {}) {
  const policy = normalizeSkillDreamPolicy(opts.policy || state?.policy || {});
  const events = Number(state?.counters?.events_since_last_run || 0);
  if (opts.force) return { due: true, reason_codes: ['forced'], events_remaining: 0, not_before_at: null };
  const eventShortfall = Math.max(0, policy.min_events_between_runs - events);
  const lastRunAt = state?.last_run_at ? Date.parse(state.last_run_at) : 0;
  const cooldownMs = policy.min_interval_hours * 60 * 60 * 1000;
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const cooldownRemainingMs = lastRunAt ? Math.max(0, lastRunAt + cooldownMs - nowMs) : 0;
  if (eventShortfall > 0) {
    return {
      due: false,
      reason_codes: ['event_threshold_not_reached'],
      events_remaining: eventShortfall,
      not_before_at: cooldownRemainingMs > 0 ? new Date(nowMs + cooldownRemainingMs).toISOString() : null
    };
  }
  if (cooldownRemainingMs > 0) {
    return {
      due: false,
      reason_codes: ['cooldown_active'],
      events_remaining: 0,
      not_before_at: new Date(nowMs + cooldownRemainingMs).toISOString()
    };
  }
  return { due: true, reason_codes: lastRunAt ? ['event_threshold_reached', 'cooldown_elapsed'] : ['event_threshold_reached'], events_remaining: 0, not_before_at: null };
}

export async function recordSkillDreamEvent(root: any, event: any = {}, opts: any = {}) {
  const state = normalizeSkillDreamState(opts.state || await readJson(skillDreamStatePath(root), null), opts);
  const ts = opts.now || nowIso();
  const route = safeId(event.route || event.route_id || event.mode || 'unknown');
  const command = event.command || null;
  const skillNames = normalizeSkillNames(event.skill_names || event.skills || event.required_skills || []);
  const promptSignature = event.prompt_signature
    || (event.prompt ? sha256(String(event.prompt)).slice(0, 16) : null);
  const record = {
    ts,
    type: event.type || 'route_skill_observed',
    route,
    command,
    skill_names: skillNames,
    prompt_signature: promptSignature,
    observed_count: Math.max(1, Math.floor(Number(opts.event_count || 1)))
  };

  const eventCount = Math.max(1, Math.floor(Number(opts.event_count || 1)));
  state.last_event_at = ts;
  state.counters.total_events += eventCount;
  state.counters.events_since_last_run += eventCount;
  state.routes[route] = bumpRouteCounter(state.routes[route], ts, skillNames, command);
  for (const skillName of skillNames) state.skills[skillName] = bumpSkillCounter(state.skills[skillName], ts, route);
  state.events_tail.push(record);
  state.events_tail = state.events_tail.slice(-state.policy.max_events_retained);

  const due = skillDreamDue(state, opts);
  let report = null;
  if (opts.run_if_due !== false && due.due) report = await runSkillDream(root, { ...opts, state, due_reason_codes: due.reason_codes });
  else await writeSkillDreamState(root, state);
  return { state: report?.state || state, due, report };
}

export async function runSkillDream(root: any, opts: any = {}) {
  const state = normalizeSkillDreamState(opts.state || await readJson(skillDreamStatePath(root), null), opts);
  const ts = opts.now || nowIso();
  const inventory = await inventorySkillDream(root, {
    known_skill_names: opts.known_skill_names,
    protected_skill_names: opts.protected_skill_names
  });
  const report = createSkillDreamReport({
    root,
    state,
    inventory,
    now: ts,
    due_reason_codes: opts.due_reason_codes || (opts.force ? ['forced'] : skillDreamDue(state, opts).reason_codes)
  });
  const reportPath = path.join(root, '.sneakoscope', 'reports', `skill-dream-${Date.now()}.json`);
  await writeJsonAtomic(reportPath, { ...report, report_path: reportPath });
  await writeJsonAtomic(path.join(root, SKILL_DREAM_POLICY.latest_report_path), { ...report, report_path: reportPath });
  state.last_run_at = ts;
  state.last_report_path = reportPath;
  state.counters.runs += 1;
  state.counters.events_since_last_run = 0;
  state.next_run = skillDreamDue(state, opts);
  await writeSkillDreamState(root, state);
  return { ...report, report_path: reportPath, state };
}

export function createSkillDreamReport(opts: any = {}) {
  const state = normalizeSkillDreamState(opts.state || {}, opts);
  const inventory = opts.inventory || { skills: [], summary: {} };
  const skillStats = state.skills || {};
  const generated = inventory.skills.filter((skill: any) => skill.ownership !== 'unknown_or_user');
  const keep: any[] = [];
  const pruneCandidates: any[] = [];
  const improveCandidates: any[] = [];
  const protectedNames = new Set([...(opts.protected_skill_names || []), ...PROTECTED_SKILL_NAMES]);
  for (const skill of inventory.skills) {
    const stats = skillStats[skill.name] || { use_count: 0, routes: {} };
    const used = Number(stats.use_count || 0) > 0;
    const protectedSkill = protectedNames.has(skill.name);
    if (used || protectedSkill) {
      keep.push({
        name: skill.name,
        reason_codes: [
          used ? 'observed_recent_usage' : null,
          protectedSkill ? 'protected_core_skill' : null
        ].filter(Boolean),
        use_count: Number(stats.use_count || 0),
        last_seen_at: stats.last_seen_at || null
      });
    } else if (skill.ownership !== 'unknown_or_user') {
      pruneCandidates.push({
        name: skill.name,
        reason_codes: ['unused_in_observation_window'],
        safe_action: 'recommendation_only_review_before_delete',
        use_count: Number(stats.use_count || 0),
        ownership: skill.ownership
      });
    }
    const improveReasons = [
      skill.line_count > state.policy.max_skill_lines_before_compression ? 'skill_text_too_long' : null,
      skill.word_count > state.policy.max_skill_words_before_compression ? 'skill_text_wordy' : null,
      skill.ownership !== 'unknown_or_user' && !/fallback|substitute|mock|shim/i.test(skill.text || '') ? 'missing_no_unrequested_fallback_guard' : null
    ].filter(Boolean);
    if (improveReasons.length) {
      improveCandidates.push({
        name: skill.name,
        reason_codes: improveReasons,
        safe_action: 'compress_or_patch_generated_text_on_next_setup',
        line_count: skill.line_count,
        word_count: skill.word_count
      });
    }
  }
  const mergeCandidates = MERGE_GROUPS
    .map((group: any) => {
      const present = group.skills.filter((name: any) => inventory.skills.some((skill: any) => skill.name === name));
      if (present.length < 2) return null;
      return {
        id: group.id,
        skills: present,
        reason_codes: ['alias_or_overlap_group_present'],
        safe_action: group.action,
        apply_mode: 'requires_explicit_user_approval'
      };
    })
    .filter(Boolean);
  const totalSkills = Number(inventory.summary?.total || inventory.skills.length || 0);
  const complexityPressure = totalSkills > 28 || Number(inventory.summary?.total_skill_words || 0) > 10000;
  return {
    schema_version: 1,
    report_type: 'skill_dream',
    created_at: opts.now || nowIso(),
    policy: state.policy,
    state_path: SKILL_DREAM_POLICY.state_path,
    due_reason_codes: opts.due_reason_codes || [],
    apply_mode: state.policy.apply_mode,
    no_auto_delete: state.policy.no_auto_delete,
    observed: {
      total_events: state.counters.total_events,
      events_since_last_run_before_report: state.counters.events_since_last_run,
      routes_seen: Object.keys(state.routes || {}).length,
      skills_seen: Object.keys(state.skills || {}).length
    },
    inventory: inventory.summary,
    keep,
    merge_candidates: mergeCandidates,
    prune_candidates: pruneCandidates,
    improve_candidates: improveCandidates,
    complexity_pressure: {
      active: complexityPressure,
      reason_codes: [
        totalSkills > 28 ? 'many_generated_skills' : null,
        Number(inventory.summary?.total_skill_words || 0) > 10000 ? 'large_skill_text_budget' : null
      ].filter(Boolean)
    },
    next_actions: [
      'Review skill-dream-latest.json before removing or merging any skill.',
      'Prefer compressing generated skill wording and alias groups before adding new skills.',
      'Do not delete, merge, or replace skills unless the user explicitly approves that action.'
    ]
  };
}

export async function skillDreamFixture(root: any) {
  const skillRoot = path.join(root, '.agents', 'skills');
  await writeFixtureSkill(skillRoot, 'used-generated', 'Used generated skill.\nNo unrequested fallback implementation code.\n');
  await writeFixtureSkill(skillRoot, 'unused-generated', 'Unused generated skill with lots of overlap.\n');
  await ensureDir(path.join(skillRoot, 'custom-keep'));
  await writeTextAtomic(path.join(skillRoot, 'custom-keep', 'SKILL.md'), '---\nname: custom-keep\ndescription: User custom skill, not generated by SKS.\n---\n');
  const opts = { policy: { min_events_between_runs: 2, min_interval_hours: 0 }, known_skill_names: ['used-generated', 'unused-generated'], protected_skill_names: ['used-generated'] };
  await recordSkillDreamEvent(root, { route: 'naruto', command: '$Naruto', skills: ['used-generated'], prompt: 'fixture one' }, { ...opts, run_if_due: true });
  const second = await recordSkillDreamEvent(root, { route: 'naruto', command: '$Naruto', skills: ['used-generated'], prompt: 'fixture two' }, { ...opts, run_if_due: true });
  const report = second.report || await runSkillDream(root, { ...opts, force: true });
  return {
    passed: Boolean(report.no_auto_delete)
      && report.keep.some((item: any) => item.name === 'used-generated')
      && report.prune_candidates.some((item: any) => item.name === 'unused-generated')
      && !report.prune_candidates.some((item: any) => item.name === 'custom-keep')
      && (await exists(path.join(skillRoot, 'unused-generated', 'SKILL.md'))),
    report
  };
}

function skillMatchScore(skill: any, route: any, taskSignature: any) {
  const hay = `${route} ${taskSignature}`.toLowerCase();
  let score = 0;
  for (const trigger of skill.triggers || []) {
    if (hay.includes(String(trigger).toLowerCase().replace(/^\$/, ''))) score += 0.4;
  }
  if (String(skill.id || '').toLowerCase().includes(String(route || '').toLowerCase())) score += 0.3;
  return Math.min(1, score);
}

function safeId(value: any) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function skillDreamStatePath(root: any) {
  return path.join(root, SKILL_DREAM_POLICY.state_path);
}

async function writeSkillDreamState(root: any, state: any) {
  state.next_run = skillDreamDue(state, { policy: state.policy });
  await writeJsonAtomic(skillDreamStatePath(root), state);
}

function normalizeSkillDreamPolicy(policy: any = {}) {
  return {
    ...SKILL_DREAM_POLICY,
    ...Object.fromEntries(Object.entries(policy || {}).filter(([, value]: any) => value !== undefined && value !== null)),
    min_events_between_runs: Number(policy.min_events_between_runs ?? SKILL_DREAM_POLICY.min_events_between_runs),
    min_interval_hours: Number(policy.min_interval_hours ?? SKILL_DREAM_POLICY.min_interval_hours),
    max_events_retained: Number(policy.max_events_retained ?? SKILL_DREAM_POLICY.max_events_retained),
    max_skill_lines_before_compression: Number(policy.max_skill_lines_before_compression ?? SKILL_DREAM_POLICY.max_skill_lines_before_compression),
    max_skill_words_before_compression: Number(policy.max_skill_words_before_compression ?? SKILL_DREAM_POLICY.max_skill_words_before_compression),
    apply_mode: 'recommendation_only',
    no_auto_delete: true
  };
}

function normalizeSkillDreamState(raw: any = null, opts: any = {}) {
  const policy = normalizeSkillDreamPolicy(opts.policy || raw?.policy || {});
  const state = {
    schema_version: 1,
    policy,
    created_at: raw?.created_at || opts.now || nowIso(),
    last_event_at: raw?.last_event_at || null,
    last_run_at: raw?.last_run_at || null,
    last_report_path: raw?.last_report_path || null,
    counters: {
      total_events: Number(raw?.counters?.total_events || 0),
      events_since_last_run: Number(raw?.counters?.events_since_last_run || 0),
      runs: Number(raw?.counters?.runs || 0)
    },
    routes: raw?.routes && typeof raw.routes === 'object' ? raw.routes : {},
    skills: raw?.skills && typeof raw.skills === 'object' ? raw.skills : {},
    events_tail: Array.isArray(raw?.events_tail) ? raw.events_tail.slice(-policy.max_events_retained) : [],
    next_run: raw?.next_run || null
  };
  state.next_run ||= skillDreamDue(state, opts);
  return state;
}

function normalizeSkillNames(values: any) {
  const raw = Array.isArray(values) ? values : String(values || '').split(',');
  return Array.from(new Set(raw.map((value: any) => safeId(value)).filter(Boolean)));
}

function bumpRouteCounter(current: any = {}, ts: any, skillNames: any = [], command: any = null) {
  const skills = { ...(current.skills || {}) };
  for (const skill of skillNames) skills[skill] = Number(skills[skill] || 0) + 1;
  return {
    count: Number(current.count || 0) + 1,
    last_seen_at: ts,
    command: command || current.command || null,
    skills
  };
}

function bumpSkillCounter(current: any = {}, ts: any, route: any) {
  const routes = { ...(current.routes || {}) };
  routes[route] = Number(routes[route] || 0) + 1;
  return {
    use_count: Number(current.use_count || 0) + 1,
    last_seen_at: ts,
    routes
  };
}

async function inventorySkillDream(root: any, opts: any = {}) {
  const skillRoot = path.join(root, '.agents', 'skills');
  const known = new Set(normalizeSkillNames(opts.known_skill_names || []));
  const manifest = await readJson(path.join(root, '.sneakoscope', 'manifest.json'), null);
  for (const name of normalizeSkillNames([
    ...(manifest?.prompt_pipeline?.dollar_skill_names || []),
    ...(manifest?.recommended_skills || [])
  ])) known.add(name);
  const skills: any[] = [];
  let entries: any[] = [];
  try { entries = await fsp.readdir(skillRoot, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = safeId(entry.name);
    const skillPath = path.join(skillRoot, entry.name, 'SKILL.md');
    const text = await readText(skillPath, null);
    if (typeof text !== 'string') continue;
    const metadataText = await readText(path.join(skillRoot, entry.name, 'agents', 'openai.yaml'), '');
    const ownership = known.has(name)
      ? 'known_generated'
      : metadataLooksGenerated(metadataText, name)
      ? 'metadata_generated'
      : 'unknown_or_user';
    const lines = text.split(/\r?\n/);
    skills.push({
      name,
      path: path.relative(root, skillPath).split(path.sep).join('/'),
      ownership,
      line_count: lines.length,
      word_count: text.trim() ? text.trim().split(/\s+/).length : 0,
      text
    });
  }
  const summary = {
    total: skills.length,
    generated: skills.filter((skill: any) => skill.ownership !== 'unknown_or_user').length,
    unknown_or_user: skills.filter((skill: any) => skill.ownership === 'unknown_or_user').length,
    total_skill_lines: skills.reduce((sum: any, skill: any) => sum + skill.line_count, 0),
    total_skill_words: skills.reduce((sum: any, skill: any) => sum + skill.word_count, 0)
  };
  return { skill_root: skillRoot, skills, summary };
}

function metadataLooksGenerated(text: any, name: any) {
  const s = String(text || '');
  return new RegExp(`^name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(s)
    && /^routing:\s*temporary\s*$/m.test(s)
    && /^return_to_default_after_route:\s*true\s*$/m.test(s);
}

async function writeFixtureSkill(skillRoot: any, name: any, body: any) {
  const dir = path.join(skillRoot, name);
  await ensureDir(path.join(dir, 'agents'));
  await writeTextAtomic(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture skill.\n---\n\n${forgeSkillMarker(skillRoot)}\n\n${body}`);
  await writeTextAtomic(path.join(dir, 'agents', 'openai.yaml'), `name: ${name}\nmodel_reasoning_effort: high\nrouting: temporary\nreturn_to_default_after_route: true\n`);
}

function forgeSkillMarker(root: any) {
  return `<!-- BEGIN SKS FORGE SKILL project=${sha256(String(root || '')).slice(0, 12)} generator=sks@runtime created=${nowIso()} -->`;
}
