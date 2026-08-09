/**
 * Architecture Map Gate (AMG) / Architecture Delta Review (ADR) pipeline helpers.
 * Keeps mission baseline/review Stop checks out of runtime-core.ts.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exists, nowIso, readJson, writeJsonAtomic } from './fsx.js';
import {
  ARCHITECTURE_CAPSULE_ARTIFACT,
  ARCHITECTURE_MAP_BASELINE_ARTIFACT,
  ARCHITECTURE_MAP_MANIFEST_ARTIFACT,
  ARCHITECTURE_MAP_REVIEW_ARTIFACT,
  bindArchitectureMapBaseline,
  buildAfterReview,
  sealBaseline,
  validateArchitectureMapBaselineArtifact,
  validateArchitectureMapReviewArtifact
} from './architecture-map-review.js';
import type { ArchitectureBaselineV1, ArchitectureReviewV1 } from './triwiki/context-graph/architecture/contracts.js';
import { readContextGraphSnapshot } from './triwiki/context-graph/store/snapshot-store.js';

export { ARCHITECTURE_MAP_REVIEW_ARTIFACT };

export const ARCHITECTURE_MAP_BASELINE_STAGE = 'architecture_map_baseline';
export const ARCHITECTURE_MAP_REVIEW_STAGE = 'architecture_map_review';

const ARCHITECTURE_MAP_EXEMPT_ROUTES = new Set([
  'Answer',
  'DFix',
  'Help',
  'Wiki',
  'Goal',
  'GX',
  'DB'
]);

export interface ArchitectureMapPlanBinding {
  readonly baseline_artifact: string;
  readonly review_artifact: string;
  readonly capsule_artifact: string;
  readonly manifest_artifact: string;
  readonly required: true;
  readonly seeded_at: string;
}

export function routeNeedsArchitectureMap(route: { id?: string } | null | undefined): boolean {
  const id = String(route?.id || '');
  if (!id) return false;
  if (ARCHITECTURE_MAP_EXEMPT_ROUTES.has(id)) return false;
  return true;
}

export function createArchitectureMapPlanBinding(): ArchitectureMapPlanBinding {
  return Object.freeze({
    baseline_artifact: ARCHITECTURE_MAP_BASELINE_ARTIFACT,
    review_artifact: ARCHITECTURE_MAP_REVIEW_ARTIFACT,
    capsule_artifact: ARCHITECTURE_CAPSULE_ARTIFACT,
    manifest_artifact: ARCHITECTURE_MAP_MANIFEST_ARTIFACT,
    required: true,
    seeded_at: nowIso()
  });
}

export function planStagesArchitectureMap(plan: any): boolean {
  return Array.isArray(plan?.stages)
    && plan.stages.some((stage: any) =>
      String(stage?.id || '') === ARCHITECTURE_MAP_BASELINE_STAGE
      && !['skipped', 'not_applicable'].includes(String(stage?.status || ''))
    );
}

export async function seedArchitectureMapPlanBinding(dir: string, plan: any): Promise<any> {
  if (!planStagesArchitectureMap(plan)) return plan;
  plan.architecture_map = createArchitectureMapPlanBinding();
  await writeJsonAtomic(path.join(dir, 'pipeline-plan.json'), plan);
  return plan;
}

export interface SeedArchitectureMapBaselineInput {
  readonly root: string;
  readonly dir: string;
  readonly missionId: string;
  readonly routeId: string;
  readonly taskProfile?: string;
}

/**
 * Seal mission architecture-map-baseline.json (+ capsule/manifest) before mutation.
 * Fail-closed when the context-graph snapshot is missing: Stop then reports
 * architecture_map_baseline_missing rather than inventing an empty graph.
 */
/** writePipelinePlan hook: seal baseline when the plan bound Architecture Map. */
export async function maybeSeedArchitectureMapForPlan(input: {
  readonly root: string;
  readonly dir: string;
  readonly plan: any;
  readonly missionId?: string;
  readonly taskProfile?: string;
}): Promise<void> {
  if (!input.plan?.architecture_map || !input.missionId) return;
  await seedArchitectureMapBaselineArtifacts({
    root: input.root,
    dir: input.dir,
    missionId: String(input.missionId),
    routeId: String(input.plan.route?.id || input.plan.route?.command || 'SKS'),
    taskProfile: String(input.taskProfile || input.plan.task_profile || '')
  });
}

export async function seedArchitectureMapBaselineArtifacts(
  input: SeedArchitectureMapBaselineInput
): Promise<{ ok: boolean; reason?: string; baselinePath?: string }> {
  const baselinePath = path.join(input.dir, ARCHITECTURE_MAP_BASELINE_ARTIFACT);
  if (await exists(baselinePath)) return { ok: true, baselinePath };

  const load = await readContextGraphSnapshot(input.root);
  if (load.status !== 'ok' || !load.snapshot) {
    return { ok: false, reason: load.blocker || 'architecture_map_graph_unavailable' };
  }

  const sealed = sealBaseline({
    missionId: input.missionId,
    routeId: input.routeId,
    snapshot: load.snapshot,
    policyRoot: input.root,
    capturedAt: nowIso(),
    ...(input.taskProfile ? { taskProfile: input.taskProfile } : {})
  });

  await fsp.mkdir(input.dir, { recursive: true });
  await writeJsonAtomic(baselinePath, sealed.baseline);
  await writeJsonAtomic(path.join(input.dir, ARCHITECTURE_MAP_MANIFEST_ARTIFACT), sealed.manifest);
  await writeArchitectureMapCapsule(input.dir, sealed.capsule.text);
  return { ok: true, baselinePath };
}

/**
 * Build architecture-map-review.json from the sealed baseline vs current graph.
 * Invoked at Stop evaluation when the review artifact is still missing.
 */
export async function ensureArchitectureMapReviewArtifacts(input: {
  readonly root: string;
  readonly dir: string;
  readonly missionId: string;
  readonly routeId?: string;
}): Promise<{ ok: boolean; reason?: string; reviewPath?: string }> {
  const reviewPath = path.join(input.dir, ARCHITECTURE_MAP_REVIEW_ARTIFACT);
  if (await exists(reviewPath)) return { ok: true, reviewPath };

  const baselinePath = path.join(input.dir, ARCHITECTURE_MAP_BASELINE_ARTIFACT);
  if (!(await exists(baselinePath))) {
    return { ok: false, reason: 'architecture_map_baseline_missing' };
  }
  const baseline = await readJson<ArchitectureBaselineV1>(baselinePath, null as any);
  if (!baseline) return { ok: false, reason: 'architecture_map_baseline_unreadable' };

  const load = await readContextGraphSnapshot(input.root);
  if (load.status !== 'ok' || !load.snapshot) {
    return { ok: false, reason: load.blocker || 'architecture_map_graph_unavailable' };
  }

  const built = buildAfterReview({
    missionId: input.missionId,
    ...(input.routeId ? { routeId: input.routeId } : {}),
    baseline,
    afterSnapshot: load.snapshot,
    policyRoot: input.root,
    generatedAt: nowIso()
  });

  await fsp.mkdir(input.dir, { recursive: true });
  await writeJsonAtomic(reviewPath, built.review);
  await writeJsonAtomic(path.join(input.dir, ARCHITECTURE_MAP_MANIFEST_ARTIFACT), built.manifest);
  await writeArchitectureMapCapsule(input.dir, built.capsule.text);
  await writeJsonAtomic(path.join(input.dir, 'architecture-map-delta.json'), built.delta);
  return { ok: true, reviewPath };
}

export async function architectureMapGateStatus(
  root: string,
  state: any = {}
): Promise<{ ok: boolean; blockers: string[]; not_applicable?: boolean }> {
  if (state?.architecture_map_required !== true) return { ok: true, blockers: [] };
  const missionId = state?.mission_id;
  if (!missionId) return { ok: false, blockers: ['architecture_map_mission_missing'] };
  const dir = path.join(root, '.sneakoscope/missions', missionId);
  const plan = await readJson<any>(path.join(dir, 'pipeline-plan.json'), null);
  if (!plan?.architecture_map) return { ok: true, blockers: [], not_applicable: true };

  // Best-effort ADR materialization so Stop validates a real review, not a
  // missing-file forever when the agent forgot the stage.
  if (await exists(path.join(dir, ARCHITECTURE_MAP_BASELINE_ARTIFACT))) {
    await ensureArchitectureMapReviewArtifacts({
      root,
      dir,
      missionId,
      routeId: String(plan?.route?.id || state?.route || '')
    });
  }

  const blockers: string[] = [];
  const baselinePath = path.join(dir, ARCHITECTURE_MAP_BASELINE_ARTIFACT);
  const reviewPath = path.join(dir, ARCHITECTURE_MAP_REVIEW_ARTIFACT);

  if (!(await exists(baselinePath))) {
    blockers.push('architecture_map_baseline_missing');
  } else {
    const baseline = await readJson<ArchitectureBaselineV1>(baselinePath, null as any);
    const validation = validateArchitectureMapBaselineArtifact(baseline);
    if (!validation.ok) blockers.push('architecture_map_baseline_invalid', ...validation.blockers.map((b) => `baseline:${b}`));
    else {
      const binding = bindArchitectureMapBaseline({ baseline: baseline!, missionId });
      if (!binding.ok) blockers.push(...binding.blockers.map((b) => `architecture_map_baseline_${b}`));
      if (baseline && baseline.capturedBeforeMutation !== true) blockers.push('architecture_map_baseline_late');
    }
  }

  if (!(await exists(reviewPath))) {
    blockers.push('architecture_map_review_missing');
  } else {
    const review = await readJson<ArchitectureReviewV1>(reviewPath, null as any);
    const validation = validateArchitectureMapReviewArtifact(review);
    if (!validation.ok) blockers.push('architecture_map_review_invalid', ...validation.blockers.map((b) => `review:${b}`));
    else if (review?.verdict !== 'pass') {
      blockers.push('architecture_map_review_blocked');
      if (Array.isArray(review?.unaccountedChangedPaths) && review.unaccountedChangedPaths.length) {
        blockers.push('architecture_map_unaccounted_changed_file');
      }
      for (const id of review?.blockingFindingIds || []) blockers.push(`architecture_map_finding:${id}`);
    }
  }

  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export async function writeArchitectureMapCapsule(
  dir: string,
  text: string
): Promise<string> {
  const file = path.join(dir, ARCHITECTURE_CAPSULE_ARTIFACT);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return file;
}
