import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { runSearchVisibilityApply, runSearchVisibilityPlan, runSearchVisibilityResearch, runSearchVisibilityStrategy, runSearchVisibilityVerify } from '../index.js';
import { createMission } from '../../mission.js';
import type { SearchVisibilityCliOptions } from '../types.js';

test('offline marketing research, strategy, and include-marketing plan use source-backed artifacts', async () => {
  const root = await makeMarketingRoot();
  const research: any = await runSearchVisibilityResearch('seo', null, options(root, { offline: true }));
  assert.equal(research.ok, true);
  assert.equal(research.external_sources, 0);
  assert.ok(research.internal_sources >= 3);

  const strategy: any = await runSearchVisibilityStrategy('seo', research.mission_id, options(root, { offline: true }));
  assert.equal(strategy.ok, true);

  const plan: any = await runSearchVisibilityPlan('seo', research.mission_id, options(root, { offline: true, includeMarketing: true }));
  assert.equal(plan.ok, true);
  assert.equal(plan.status, 'planned');

  const artifactDir = path.join(root, '.sneakoscope', 'missions', research.mission_id, 'search-visibility');
  const mutationPlan = JSON.parse(await fsp.readFile(path.join(artifactDir, 'mutation-plan.json'), 'utf8'));
  const operationIds = mutationPlan.operations.map((op: any) => op.id);
  assert.ok(operationIds.includes('package-description-update'));
  assert.ok(operationIds.includes('package-keywords-update'));
  assert.ok(operationIds.includes('readme-positioning-block-update'));
  assert.deepEqual([...new Set(mutationPlan.operations.map((op: any) => op.operationType))].sort(), [
    'package-description-update',
    'package-keywords-update',
    'readme-positioning-block-update',
  ].sort());

  const apply: any = await runSearchVisibilityApply('seo', research.mission_id, options(root, { offline: true, includeMarketing: true, apply: true }));
  assert.equal(apply.ok, true, apply.blockers.join(', '));
  assert.equal(apply.status, 'applied');
  assert.equal(apply.applied, 3);
  assert.equal(apply.verification.ok, true);

  const verify: any = await runSearchVisibilityVerify('seo', research.mission_id, options(root, { offline: true }));
  assert.equal(verify.ok, true, verify.blockers.join(', '));
  const updatedPackage = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(updatedPackage.keywords.length <= 20);
  const readme = await fsp.readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /BEGIN SKS SEARCH VISIBILITY MARKETING/);
  const rollback = JSON.parse(await fsp.readFile(path.join(artifactDir, 'rollback-manifest.json'), 'utf8'));
  assert.equal(rollback.operations.length, 3);

  const idempotentPlan: any = await runSearchVisibilityPlan('seo', research.mission_id, options(root, { offline: true, includeMarketing: true }));
  assert.equal(idempotentPlan.ok, true);
  assert.equal(idempotentPlan.operations, 0);
  const idempotentApply: any = await runSearchVisibilityApply('seo', research.mission_id, options(root, { offline: true, includeMarketing: true, apply: true }));
  assert.equal(idempotentApply.ok, true, idempotentApply.blockers.join(', '));
  assert.equal(idempotentApply.applied, 0);
  assert.equal(idempotentApply.verification.ok, true);
});

test('plan include-marketing blocks when strategy artifact is absent', async () => {
  const root = await makeMarketingRoot();
  const research: any = await runSearchVisibilityResearch('seo', null, options(root, { offline: true }));
  const plan: any = await runSearchVisibilityPlan('seo', research.mission_id, options(root, { offline: true, includeMarketing: true }));
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.blockers.includes('marketing_strategy_required_for_include_marketing'));
});

test('latest search visibility lookup ignores newer non-seo missions', async () => {
  const root = await makeMarketingRoot();
  const research: any = await runSearchVisibilityResearch('seo', null, options(root, { offline: true }));
  const strategy: any = await runSearchVisibilityStrategy('seo', research.mission_id, options(root, { offline: true }));
  assert.equal(strategy.ok, true);

  await createMission(root, { mode: 'naruto', prompt: 'newer unrelated mission' });

  const plan: any = await runSearchVisibilityPlan('seo', 'latest', options(root, { offline: true, includeMarketing: true }));
  assert.equal(plan.ok, true, plan.blockers.join(', '));
  assert.equal(plan.mission_id, research.mission_id);
});

async function makeMarketingRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-seo-marketing-flow-'));
  await fsp.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'sneakoscope-fixture',
    version: '0.0.0',
    description: 'Proof-first Codex trust layer for bounded route evidence.',
    keywords: ['sneakoscope', 'codex', 'seo'],
  }, null, 2));
  await fsp.writeFile(path.join(root, 'README.md'), '# Sneakoscope Fixture\n\nUse `sks seo-geo-optimizer` for search visibility proof.\n');
  await fsp.writeFile(path.join(root, 'CHANGELOG.md'), '# Changelog\n');
  await fsp.mkdir(path.join(root, 'src', 'core'), { recursive: true });
  await fsp.writeFile(path.join(root, 'src', 'core', 'routes.ts'), 'export const ROUTES = ["naruto"]\n');
  await fsp.mkdir(path.join(root, 'src', 'core', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(root, 'src', 'core', 'agents', 'agent-orchestrator.ts'), 'export async function runNativeAgentOrchestrator() {}\n');
  await fsp.writeFile(path.join(root, '.sneakoscope', 'reports', 'perf-budget.json'), JSON.stringify({ ok: true, budgets: [{ command: 'doctor', p95_ms: 100 }] }));
  await fsp.writeFile(path.join(root, '.sneakoscope', 'reports', 'super-search-local-http-smoke.json'), JSON.stringify({ ok: true, verified_content: true }));
  return root;
}

function options(root: string, overrides: Partial<SearchVisibilityCliOptions> = {}): SearchVisibilityCliOptions {
  return {
    root,
    url: null,
    target: 'package',
    framework: 'package',
    offline: false,
    strict: false,
    json: true,
    apply: false,
    yes: false,
    allowDirtyTouched: false,
    browser: false,
    includeLlmsTxt: false,
    includeMarketing: false,
    includeCompetitors: false,
    strategyRef: null,
    maxMarketingSources: 4,
    observeQueries: false,
    queryFile: null,
    scope: [],
    ...overrides,
  };
}
