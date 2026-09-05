import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { runSearchVisibilityCommand } from '../seo-command.js';

test('seo-geo-optimizer research and strategy actions are wired through the CLI command', async () => {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  const root = await makeMarketingRoot();

  const research: any = await runSearchVisibilityCommand('seo', ['research', '--root', root, '--offline', '--json'], 'seo-geo-optimizer');
  assert.equal(research.ok, true);
  assert.equal(process.exitCode, undefined);

  const strategy: any = await runSearchVisibilityCommand('seo', ['strategy', research.mission_id, '--root', root, '--offline', '--json'], 'seo-geo-optimizer');
  assert.equal(strategy.ok, true);
  assert.equal(process.exitCode, undefined);
  const strategyArtifact = JSON.parse(await fsp.readFile(path.join(root, '.sneakoscope', 'missions', research.mission_id, 'search-visibility', 'marketing-strategy.json'), 'utf8'));
  assert.ok(strategyArtifact.strategy_quality.score >= 80);
  assert.equal(strategyArtifact.strategy_quality.unsupported_claims, 0);
  assert.equal(strategyArtifact.strategy_quality.blockers.length, 0);
  assert.ok(Array.isArray(strategyArtifact.competitor_contrast));
  process.exitCode = previousExit;
});

test('seo-geo-optimizer plan --include-marketing blocks without creating strategy fallback', async () => {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  const root = await makeMarketingRoot();

  const research: any = await runSearchVisibilityCommand('seo', ['research', '--root', root, '--offline', '--json'], 'seo-geo-optimizer');
  const plan: any = await runSearchVisibilityCommand('seo', ['plan', research.mission_id, '--root', root, '--mode', 'seo', '--include-marketing', '--offline', '--json'], 'seo-geo-optimizer');
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.blockers.includes('marketing_strategy_required_for_include_marketing'));
  await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'missions', research.mission_id, 'search-visibility', 'marketing-strategy.json')));
  process.exitCode = previousExit;
});

test('seo-geo-optimizer apply --include-marketing ignores stale full SEO gate blockers and verifies marketing gate', async () => {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  const root = await makeMarketingRoot();

  const research: any = await runSearchVisibilityCommand('seo', ['research', '--root', root, '--offline', '--json'], 'seo-geo-optimizer');
  const strategy: any = await runSearchVisibilityCommand('seo', ['strategy', research.mission_id, '--root', root, '--offline', '--json'], 'seo-geo-optimizer');
  assert.equal(strategy.ok, true);
  const plan: any = await runSearchVisibilityCommand('seo', ['plan', research.mission_id, '--root', root, '--mode', 'seo', '--include-marketing', '--offline', '--json'], 'seo-geo-optimizer');
  assert.equal(plan.ok, true);
  await fsp.writeFile(path.join(root, '.sneakoscope', 'missions', research.mission_id, 'seo-gate.json'), JSON.stringify({
    schema: 'sks.search-visibility.gate.v1',
    ok: false,
    passed: false,
    blockers: ['missing:search-visibility/adapter-detection.json'],
  }, null, 2));

  const apply: any = await runSearchVisibilityCommand('seo', ['apply', research.mission_id, '--root', root, '--mode', 'seo', '--include-marketing', '--apply', '--offline', '--json'], 'seo-geo-optimizer');
  assert.equal(apply.ok, true, apply.blockers.join(', '));
  assert.equal(apply.status, 'applied');
  assert.equal(apply.verification.ok, true);
  assert.equal(process.exitCode, undefined);
  process.exitCode = previousExit;
});

async function makeMarketingRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-seo-marketing-command-'));
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
