import path from 'node:path';
import { adapterForDetection } from './adapter-registry.js';
import { auditGeo, auditSeo } from './analyzers.js';
import { detectProject, discoverSiteInventory } from './discovery.js';
import { runMarketingResearch, runMarketingStrategy } from './marketing.js';
import { applyMutationPlan, buildMutationPlan, isMarketingMutationPlan, rollbackMutationPlan } from './mutation.js';
import { createSearchVisibilityMission, gateFileForMode, resolveSearchVisibilityMission, routeForMode, type SearchVisibilityMission } from './mission.js';
import { finalizeSearchVisibility, statusForMission, writeAuditArtifacts, writeGate } from './artifacts.js';
import { verifySearchVisibility } from './verifier.js';
import { exists, projectRoot, readJson, readText, sha256, writeJsonAtomic, type JsonData } from '../fsx.js';
import type { EntityFacts, MarketingResearch, MarketingStrategy, MarketingTruthfulnessGate, MutationPlan, ProjectContext, RollbackManifest, SearchVisibilityCliOptions, SearchVisibilityMode, SiteInventory } from './types.js';

export * from './types.js';
export { createSearchVisibilityMission, resolveSearchVisibilityMission } from './mission.js';

export async function runSearchVisibilityResearch(mode: SearchVisibilityMode, missionRef: string | null, options: SearchVisibilityCliOptions): Promise<JsonData> {
  return runMarketingResearch(mode, missionRef, options);
}

export async function runSearchVisibilityStrategy(mode: SearchVisibilityMode, missionRef: string | null, options: SearchVisibilityCliOptions): Promise<JsonData> {
  return runMarketingStrategy(mode, missionRef, options);
}

export async function runSearchVisibilityAudit(mode: SearchVisibilityMode, options: SearchVisibilityCliOptions): Promise<JsonData> {
  const root = await projectRoot(options.root);
  const ctx = context(mode, root, options);
  const mission = await createSearchVisibilityMission(mode, `${mode} audit`, options);
  const detected = await detectProject(ctx);
  const adapter = adapterForDetection(detected);
  const inventory = await adapter.discover(ctx, detected);
  if (mode === 'geo') {
    const geo = await auditGeo(root, inventory);
    const result = await writeAuditArtifacts(ctx, mission, inventory, geo.findings, {
      entityFacts: geo.entityFacts,
      claims: geo.claims,
      crawlers: geo.crawlers,
      answerability: geo.answerability,
    });
    return {
      schema: 'sks.search-visibility.audit-command.v1',
      ok: result.gate.ok,
      mission_id: mission.id,
      route: routeForMode(mode),
      status: result.gate.status,
      artifacts_dir: `.sneakoscope/missions/${mission.id}/search-visibility`,
      findings: geo.findings.length,
      gate: result.gate,
      proof: `.sneakoscope/missions/${mission.id}/completion-proof.json`,
    };
  }
  const findings = await auditSeo(root, inventory);
  const result = await writeAuditArtifacts(ctx, mission, inventory, findings, null);
  return {
    schema: 'sks.search-visibility.audit-command.v1',
    ok: result.gate.ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    status: result.gate.status,
    artifacts_dir: `.sneakoscope/missions/${mission.id}/search-visibility`,
    findings: findings.length,
    gate: result.gate,
    proof: `.sneakoscope/missions/${mission.id}/completion-proof.json`,
  };
}

export async function runSearchVisibilityPlan(mode: SearchVisibilityMode, missionRef: string | null, options: SearchVisibilityCliOptions): Promise<JsonData> {
  if (options.includeMarketing) {
    const existing = await resolveSearchVisibilityMission(options.root, missionRef, mode);
    if (!existing) {
      return {
        schema: 'sks.search-visibility.plan-command.v1',
        ok: false,
        route: routeForMode(mode),
        status: 'blocked',
        operations: 0,
        blockers: ['marketing_strategy_required_for_include_marketing'],
      };
    }
  }
  const mission = await resolveOrAudit(mode, missionRef, options);
  const ctx = context(mode, mission.root, options);
  const inventory = await readJson<SiteInventory>(path.join(mission.artifactDir, 'site-inventory.json'));
  const findingsArtifact = await readJson(path.join(mission.artifactDir, mode === 'seo' ? 'seo-findings.json' : 'geo-findings.json'), {});
  const findings = Array.isArray(findingsArtifact.findings) ? findingsArtifact.findings : [];
  const entityFacts = mode === 'geo'
    ? await readJson(path.join(mission.artifactDir, 'entity-facts.json'), null) as EntityFacts | null
    : null;
  const plan = await buildMutationPlan(mode, mission.id, mission.artifactDir, inventory, findings, options, entityFacts);
  return {
    schema: 'sks.search-visibility.plan-command.v1',
    ok: plan.status !== 'blocked',
    mission_id: mission.id,
    route: routeForMode(mode),
    status: plan.status,
    operations: plan.operations.length,
    blockers: plan.blockers,
    mutation_plan: `search-visibility/mutation-plan.json`,
  };
}

export async function runSearchVisibilityApply(mode: SearchVisibilityMode, missionRef: string | null, options: SearchVisibilityCliOptions): Promise<JsonData> {
  const mission = await resolveOrAudit(mode, missionRef, options);
  const planPath = path.join(mission.artifactDir, 'mutation-plan.json');
  let plan = await readJson(planPath, null);
  if (!plan) {
    const planned = await runSearchVisibilityPlan(mode, mission.id, options);
    plan = await readJson(planPath, null);
    if (!planned.ok && !plan) return { schema: 'sks.search-visibility.apply-command.v1', ok: false, mission_id: mission.id, route: routeForMode(mode), status: 'blocked', blockers: ['mutation_plan_missing'] };
  }
  const applied = await applyMutationPlan(mission.root, mission.id, mission.artifactDir, plan, options);
  const verify = await runSearchVisibilityVerify(mode, mission.id, options);
  return {
    schema: 'sks.search-visibility.apply-command.v1',
    ok: applied.ok && verify.ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    status: applied.status,
    applied: applied.applied,
    blockers: [...applied.blockers, ...((verify.blockers as string[] | undefined) || [])],
    rollback_manifest: 'search-visibility/rollback-manifest.json',
    verification: verify,
  };
}

export async function runSearchVisibilityVerify(mode: SearchVisibilityMode, missionRef: string | null, options: SearchVisibilityCliOptions): Promise<JsonData> {
  const mission = await resolveOrAudit(mode, missionRef, options);
  const plan = await readJson<MutationPlan | null>(path.join(mission.artifactDir, 'mutation-plan.json'), null);
  if (mode === 'seo' && plan && (isMarketingMutationPlan(plan) || await isZeroOperationMarketingPlan(mission, plan))) {
    return verifyMarketingMutationFlow(mode, mission, plan, options);
  }
  const root = mission.root;
  const ctx = context(mode, root, options);
  const inventory = await readJson<SiteInventory>(path.join(mission.artifactDir, 'site-inventory.json'));
  const verification = await verifySearchVisibility(ctx, inventory, mission);
  await writeJsonAtomic(path.join(mission.artifactDir, 'verification-report.json'), verification);
  const findingsArtifact = await readJson(path.join(mission.artifactDir, mode === 'seo' ? 'seo-findings.json' : 'geo-findings.json'), {});
  const findings = Array.isArray(findingsArtifact.findings) ? findingsArtifact.findings : [];
  const gate = await writeGate(ctx, mission, findings, verification, mode === 'geo');
  await finalizeSearchVisibility(ctx, mission, gate, `sks ${mode} verify ${mission.id} --json`);
  return {
    schema: 'sks.search-visibility.verify-command.v1',
    ok: gate.ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    status: gate.status,
    blockers: gate.blockers,
    unverified: gate.unverified,
    gate,
  };
}

export async function runSearchVisibilityStatus(mode: SearchVisibilityMode, missionRef: string | null, options: SearchVisibilityCliOptions): Promise<JsonData> {
  const mission = await resolveSearchVisibilityMission(options.root, missionRef, mode);
  if (!mission) return { schema: 'sks.search-visibility.status-command.v1', ok: false, status: 'missing_mission', route: routeForMode(mode) };
  return statusForMission(mission);
}

export async function runSearchVisibilityRollback(mode: SearchVisibilityMode, missionRef: string | null, options: SearchVisibilityCliOptions): Promise<JsonData> {
  const mission = await resolveSearchVisibilityMission(options.root, missionRef, mode);
  if (!mission) return { schema: 'sks.search-visibility.rollback-command.v1', ok: false, status: 'missing_mission', route: routeForMode(mode) };
  const result = await rollbackMutationPlan(mission.root, mission.artifactDir, options.apply);
  const verify = result.status === 'rolled_back' ? await runSearchVisibilityVerify(mode, mission.id, options) : null;
  return {
    schema: 'sks.search-visibility.rollback-command.v1',
    ok: result.ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    status: result.status,
    rolled_back: result.rolled_back,
    blockers: result.blockers,
    verification: verify,
  };
}

export async function runSearchVisibilityDoctor(mode: SearchVisibilityMode, options: SearchVisibilityCliOptions): Promise<JsonData> {
  const root = await projectRoot(options.root);
  const ctx = context(mode, root, options);
  const detected = await detectProject(ctx);
  return {
    schema: 'sks.search-visibility.doctor-command.v1',
    ok: detected.blockers.length === 0,
    route: routeForMode(mode),
    root,
    adapter: detected.adapterId,
    confidence: detected.confidence,
    capabilities: detected.capabilities,
    blockers: detected.blockers,
    status: detected.blockers.length ? 'blocked' : 'verified_partial',
  };
}

export async function runSearchVisibilityFixture(mode: SearchVisibilityMode, options: SearchVisibilityCliOptions): Promise<JsonData> {
  const root = await projectRoot(options.root);
  const result = await runSearchVisibilityAudit(mode, {
    ...options,
    root,
    target: mode === 'seo' ? 'package' : 'package',
    offline: true,
    strict: true,
  });
  const planned = await runSearchVisibilityPlan(mode, result.mission_id, options);
  return {
    schema: 'sks.search-visibility.fixture-command.v1',
    ok: Boolean(result.ok && planned.ok),
    mission_id: result.mission_id,
    route: routeForMode(mode),
    audit: result,
    plan: planned,
  };
}

function context(mode: SearchVisibilityMode, root: string, options: SearchVisibilityCliOptions): ProjectContext {
  return {
    root,
    mode,
    target: options.target,
    framework: options.framework,
    origin: options.url,
    offline: options.offline,
    strict: options.strict,
  };
}

async function resolveOrAudit(mode: SearchVisibilityMode, missionRef: string | null, options: SearchVisibilityCliOptions): Promise<SearchVisibilityMission> {
  const mission = await resolveSearchVisibilityMission(options.root, missionRef, mode);
  if (mission) return mission;
  const audit = await runSearchVisibilityAudit(mode, options);
  const created = await resolveSearchVisibilityMission(options.root, audit.mission_id, mode);
  if (!created) throw new Error('Search visibility audit did not create a mission');
  return created;
}

async function verifyMarketingMutationFlow(
  mode: SearchVisibilityMode,
  mission: SearchVisibilityMission,
  plan: MutationPlan,
  options: SearchVisibilityCliOptions
): Promise<JsonData> {
  const gateFile = gateFileForMode(mode);
  const required = [
    'search-visibility/marketing-research.json',
    'search-visibility/marketing-source-ledger.json',
    'search-visibility/marketing-claim-ledger.json',
    'search-visibility/marketing-strategy.json',
    'search-visibility/marketing-truthfulness-gate.json',
    'search-visibility/mutation-plan.json',
    'search-visibility/rollback-manifest.json',
  ];
  const requiredStatus = await Promise.all(required.map(async (artifact) => ({
    path: artifact,
    present: await exists(path.join(mission.dir, artifact)),
  })));
  const blockers = requiredStatus.filter((item) => !item.present).map((item) => `missing:${item.path}`);
  const research = await readJson<MarketingResearch | null>(path.join(mission.artifactDir, 'marketing-research.json'), null);
  const strategy = await readJson<MarketingStrategy | null>(path.join(mission.artifactDir, 'marketing-strategy.json'), null);
  const truth = await readJson<MarketingTruthfulnessGate | null>(path.join(mission.artifactDir, 'marketing-truthfulness-gate.json'), null);
  const rollback = await readJson<RollbackManifest | null>(path.join(mission.artifactDir, 'rollback-manifest.json'), null);
  if (!research?.ok) blockers.push('marketing_research_gate_not_passed');
  if (!strategy?.ok) blockers.push('marketing_strategy_gate_not_passed');
  if (!truth?.ok) blockers.push('marketing_truthfulness_gate_not_passed');
  if (rollback?.blockers?.length) blockers.push(...rollback.blockers);
  for (const op of plan.operations) {
    const full = path.join(mission.root, op.path);
    const current = await readText(full, null);
    const currentSha = current == null ? null : sha256(current);
    const rollbackHasOp = Boolean(rollback?.operations?.some((entry) => entry.operation_id === op.id));
    if (!rollbackHasOp && currentSha !== op.proposedSha256) blockers.push(`marketing_operation_not_applied:${op.id}`);
  }
  const unverified = [
    'production_http_not_verified',
    'search_ranking_or_traffic_outcome_not_measured',
    'production URL, browser rendering, Search Console, analytics, ranking, traffic, and AI citation outcomes are not claimed without direct evidence',
  ];
  const ok = blockers.length === 0;
  const verification = {
    schema: 'sks.search-visibility.verification-report.v1',
    generated_at: new Date().toISOString(),
    mission_id: mission.id,
    route: routeForMode(mode),
    status: ok ? 'verified_partial' : 'blocked',
    source_verified: Boolean(research?.ok && strategy?.ok && truth?.ok),
    build_verified: false,
    http_verified: false,
    browser_verified: false,
    production_verified: false,
    http_evidence: {
      attempted: false,
      verified: false,
      requested_url: options.url,
      final_url: null,
      status_code: null,
      content_type: null,
      content_bytes: null,
      content_sha256: null,
      observed_at: null,
      error: 'marketing_flow_does_not_perform_production_http_verification',
    },
    measured_outcome: 'pending',
    checked_artifacts: requiredStatus.map((item) => ({ path: item.path, ok: item.present, message: item.present ? 'present' : 'missing' })),
    blockers,
    unverified,
  };
  await writeJsonAtomic(path.join(mission.artifactDir, 'verification-report.json'), verification);
  const gate = {
    schema: 'sks.search-visibility.gate.v1',
    generated_at: new Date().toISOString(),
    mission_id: mission.id,
    route: routeForMode(mode),
    ok,
    passed: ok,
    status: ok ? 'verified_partial' : 'blocked',
    command_identity: true,
    required_artifacts: [
      ...requiredStatus,
      { path: gateFile, present: true },
      { path: 'completion-proof.json', present: true },
    ],
    unsupported_claims: truth?.unsupported_claims || [],
    blockers,
    unverified,
    completion_proof: `.sneakoscope/missions/${mission.id}/completion-proof.json`,
  };
  await writeJsonAtomic(path.join(mission.dir, gateFile), gate);
  await writeJsonAtomic(path.join(mission.dir, 'completion-proof.json'), {
    schema: 'sks.search-visibility.marketing-completion-proof.v1',
    generated_at: new Date().toISOString(),
    ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    mutation_plan: 'search-visibility/mutation-plan.json',
    rollback_manifest: 'search-visibility/rollback-manifest.json',
    gate: gateFile,
    blockers,
  });
  return {
    schema: 'sks.search-visibility.verify-command.v1',
    ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    status: gate.status,
    blockers,
    unverified,
    gate,
  };
}

async function isZeroOperationMarketingPlan(mission: SearchVisibilityMission, plan: MutationPlan): Promise<boolean> {
  if (plan.mode !== 'seo' || plan.operations.length !== 0) return false;
  const required = [
    'marketing-research.json',
    'marketing-strategy.json',
    'marketing-truthfulness-gate.json',
  ];
  const present = await Promise.all(required.map((artifact) => exists(path.join(mission.artifactDir, artifact))));
  return present.every(Boolean);
}
