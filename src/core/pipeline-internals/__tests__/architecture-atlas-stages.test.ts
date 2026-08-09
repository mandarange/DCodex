import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPipelinePlan } from '../runtime-core.js';
import {
  architectureMapGateStatus,
  seedArchitectureMapBaselineArtifacts
} from '../../architecture-map-pipeline.js';
import { CONTEXT_GRAPH_SCHEMA } from '../../triwiki/context-graph/contracts.js';
import { contextGraphSnapshotPath } from '../../triwiki/context-graph/paths.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

function stageIds(plan: any): string[] {
  return (plan?.stages || []).map((stage: any) => String(stage.id));
}

function hasArchitectureMapStages(ids: string[]): boolean {
  return ids.includes('architecture_map_baseline') && ids.includes('architecture_map_review');
}

async function writeMinimalGraph(root: string): Promise<void> {
  const nodes = [
    {
      id: 'module:src/a',
      kind: 'module',
      label: 'src/a',
      trust: 0.9,
      freshness: 'fresh',
      risk: 'low',
      tokenCost: 8,
      metadata: {},
      path: 'src/a.ts'
    },
    {
      id: 'module:src/b',
      kind: 'module',
      label: 'src/b',
      trust: 0.9,
      freshness: 'fresh',
      risk: 'low',
      tokenCost: 8,
      metadata: {},
      path: 'src/b.ts'
    }
  ];
  const edges = [
    {
      id: 'edge:a->b:imports',
      from: 'module:src/a',
      to: 'module:src/b',
      type: 'imports',
      confidence: 'exact',
      provenance: { path: 'src/a.ts', hash: 'abcd', extractor: 'test' },
      observedAt: '2026-01-01T00:00:00.000Z'
    }
  ];
  const snapshot = {
    schema: CONTEXT_GRAPH_SCHEMA,
    schemaRevision: '1.0.0',
    snapshotHash: 'c'.repeat(64),
    nodes,
    edges,
    cycles: [],
    extractors: ['code'],
    nodeCount: nodes.length,
    edgeCount: edges.length
  };
  const file = contextGraphSnapshotPath(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
  await fsp.mkdir(path.join(root, 'config'), { recursive: true });
  await fsp.copyFile(
    path.join(REPO_ROOT, 'config/architecture-map-policy.v1.json'),
    path.join(root, 'config/architecture-map-policy.v1.json')
  );
}

test('Naruto scoped/full plans include architecture map baseline and review stages', () => {
  const plan = buildPipelinePlan({
    route: { id: 'Naruto', command: '$Naruto', mode: 'NARUTO', stopGate: 'naruto-gate.json', requiredSkills: [] },
    task: 'implement architecture map gate wiring across pipeline stages'
  });
  const ids = stageIds(plan);
  assert.equal(hasArchitectureMapStages(ids), true, ids.join(','));
  assert.equal(ids.includes('architecture_preflight'), false);
  assert.equal(ids.includes('architecture_postflight'), false);
});

test('GX and Answer routes stay exempt from architecture map stages', () => {
  const gx = buildPipelinePlan({
    route: { id: 'GX', command: '$GX', mode: 'GX', stopGate: 'none', requiredSkills: [] },
    task: 'render a deterministic visual sheet'
  });
  const answer = buildPipelinePlan({
    route: { id: 'Answer', command: '$Answer', mode: 'ANSWER', stopGate: 'none', requiredSkills: [] },
    task: 'what is architecture map?'
  });
  assert.equal(hasArchitectureMapStages(stageIds(gx)), false);
  assert.equal(hasArchitectureMapStages(stageIds(answer)), false);
});

test('seed + Stop gate materialize baseline and passing after-review', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-amg-'));
  const missionId = 'M-amg-seed';
  const dir = path.join(root, '.sneakoscope/missions', missionId);
  await fsp.mkdir(dir, { recursive: true });
  await writeMinimalGraph(root);
  await fsp.writeFile(
    path.join(dir, 'pipeline-plan.json'),
    `${JSON.stringify({
      architecture_map: {
        baseline_artifact: 'architecture-map-baseline.json',
        review_artifact: 'architecture-map-review.json',
        capsule_artifact: 'architecture-capsule.txt',
        manifest_artifact: 'architecture-map-manifest.json',
        required: true,
        seeded_at: '2026-08-09T00:00:00.000Z'
      },
      route: { id: 'Naruto' }
    }, null, 2)}\n`,
    'utf8'
  );

  const seeded = await seedArchitectureMapBaselineArtifacts({
    root,
    dir,
    missionId,
    routeId: 'Naruto',
    taskProfile: 'high-risk'
  });
  assert.equal(seeded.ok, true, seeded.reason);
  assert.equal(await fsp.access(path.join(dir, 'architecture-map-baseline.json')).then(() => true, () => false), true);

  const gate = await architectureMapGateStatus(root, {
    architecture_map_required: true,
    mission_id: missionId,
    route: 'Naruto'
  });
  assert.equal(gate.ok, true, gate.blockers.join(','));
  assert.equal(await fsp.access(path.join(dir, 'architecture-map-review.json')).then(() => true, () => false), true);
});
