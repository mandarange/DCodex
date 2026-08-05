import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAllFeatureCompletionReport, buildAllFeaturesSelftest, buildFeatureRegistry, validateFeatureRegistry } from '../../dist/core/feature-registry.js';
import { PACKAGE_VERSION } from '../../dist/core/fsx.js';
import { runFeatureFixture } from '../../dist/core/feature-fixture-runner.js';
import { COMMAND_MANIFEST_LITE } from '../../dist/cli/command-manifest-lite.js';
import { COMMANDS } from '../../dist/cli/command-registry.js';

test('feature registry carries fixture contracts', async () => {
  const registry = await buildFeatureRegistry({ root: process.cwd() });
  const proof = registry.features.find((feature) => feature.id === 'cli-proof');
  assert.equal(proof.fixture.status, 'pass');
  assert.equal(proof.runtime_truth.working_claim_allowed, false);
  assert.equal(proof.runtime_truth.runtime_status, 'not_assessed');
  assert.ok(registry.source_inventory.dollar_commands.includes('$sks-commit'));
  assert.ok(registry.source_inventory.dollar_commands.includes('$sks-commit-and-push'));
  assert.ok(registry.source_inventory.dollar_commands.every((command) => command === '$sks' || command.startsWith('$sks-')));
  for (const feature of registry.features) {
    const commands = new Set(feature.commands || []);
    assert.equal((feature.aliases || []).some((alias) => commands.has(alias)), false, `duplicate command/alias surface: ${feature.id}`);
  }
  const naruto = registry.features.find((feature) => feature.id === 'route-naruto');
  assert.deepEqual(naruto.aliases, ['$sks-work', '$sks-from-chat-img']);
  assert.equal(new Set(registry.source_inventory.app_skill_aliases).size, registry.source_inventory.app_skill_aliases.length);
  assert.ok(registry.source_inventory.cli_command_names.includes('commit'));
  assert.ok(registry.source_inventory.cli_command_names.includes('commit-and-push'));
  assert.ok(registry.source_inventory.cli_command_names.includes('bridge'));
  assert.equal(registry.source_inventory.cli_command_names.includes('codex-lb'), false);
  assert.ok(registry.source_inventory.cli_command_names.includes('mad-sks'));
  assert.ok(registry.source_inventory.cli_command_names.includes('computer-use'));
  assert.ok(registry.source_inventory.cli_command_names.includes('gc'));
  assert.equal(registry.source_inventory.cli_command_names.includes('auth'), false);
  assert.equal(registry.source_inventory.cli_command_names.includes('ux-review'), false);
  assert.equal(registry.source_inventory.cli_command_names.includes('cu'), false);
  assert.equal(registry.source_inventory.cli_command_names.includes('ui'), false);
  assert.equal(registry.source_inventory.cli_command_names.includes('memory'), true);
  assert.deepEqual(
    [...registry.source_inventory.cli_command_names].sort(),
    COMMAND_MANIFEST_LITE.map((entry) => entry.name).sort()
  );
  assert.ok(registry.source_inventory.handler_keys.length > 0);
  assert.deepEqual(
    [...registry.source_inventory.handler_keys].sort(),
    Object.keys(COMMANDS).sort()
  );
  assert.ok(registry.features.some((feature) => feature.id === 'cli-gates'));
  assert.ok(registry.features.some((feature) => feature.id === 'cli-naruto'));
  const bridge = registry.features.find((feature) => feature.id === 'cli-bridge');
  assert.equal(bridge.fixture.kind, 'execute');
  assert.equal(bridge.fixture.quality, 'runtime_verified');
  assert.equal(bridge.fixture.status, 'pass');
  assert.equal(bridge.fixture.command, 'sks bridge status --json');
  assert.deepEqual(bridge.fixture.expected_stdout_fields, {
    schema: 'sks.desktop-bridge-status.v3',
    execution_ok: true,
    'routing.fallback': 'none'
  });
  assert.equal(registry.features.some((feature) => feature.id === 'cli-codex-lb'), false);
  assert.equal(registry.features.some((feature) => feature.id === 'cli-ui'), false);
  const computerUse = registry.features.find((feature) => feature.id === 'cli-computer-use');
  assert.equal(computerUse.fixture.status, 'pass');
  for (const featureId of ['cli-config', 'cli-telegram']) {
    const feature = registry.features.find((entry) => entry.id === featureId);
    assert.equal(feature.fixture.status, 'pass', `${featureId} fixture must be explicitly registered`);
    assert.equal(feature.fixture.quality, 'wiring_only', `${featureId} fixture must not overclaim integration proof`);
  }
  const selftest = buildAllFeaturesSelftest(registry);
  assert.deepEqual(registry.coverage.unmapped.cli_command_names, []);
  assert.deepEqual(registry.coverage.unmapped.handler_keys, []);
  assert.deepEqual(registry.coverage.route_gate_consistency_blockers, []);
  assert.equal(selftest.working_claim_allowed, false);
  assert.equal(selftest.fixtures.ok, true);
  assert.equal(selftest.checks.find((check) => check.id === 'fixture_fallback_removed')?.ok, true);
  assert.equal(selftest.coverage.doc_route_mentions_without_route.includes('$CODEX_HOME'), false);
  const releaseManifest = JSON.parse(fs.readFileSync('release-gates.v2.json', 'utf8'));
  const completion = buildAllFeatureCompletionReport(registry, {
    root: process.cwd(),
    packageJson: { version: PACKAGE_VERSION },
    releaseManifest
  });
  assert.equal(completion.ok, false);
  assert.equal(completion.working_claim_allowed, false);
  assert.ok(completion.unverified.some((row) => row === 'cli-proof:runtime_not_proven'));
});

test('Desktop Bridge feature fixture executes the current V3 no-fallback JSON contract', async () => {
  const registry = await buildFeatureRegistry({ root: process.cwd() });
  const bridge = registry.features.find((feature) => feature.id === 'cli-bridge');
  const result = runFeatureFixture(bridge, {
    root: process.cwd(),
    execute: true,
    commandArgs: ['bridge', 'status', '--json']
  });

  assert.equal(result.root_mode, 'hermetic_temp_project');
  assert.equal(result.execution.ok, true);
  assert.equal(result.execution.stdout_contract.ok, true);
  assert.equal(result.ok, true);
});

test('feature registry does not silently allow unknown uppercase dollar mentions', () => {
  const coverage = validateFeatureRegistry({
    features: [
      {
        id: 'route-fixture',
        source_refs: {
          cli_command_names: [],
          handler_keys: [],
          dollar_commands: ['$Fixture'],
          app_skill_aliases: [],
          skills: []
        }
      }
    ],
    source_inventory: {
      cli_command_names: [],
      handler_keys: [],
      dollar_commands: ['$Fixture'],
      app_skill_aliases: [],
      skills: [],
      doc_route_mentions: ['$FOO_BAR', '$CODEX_HOME', '$HOME', '$SKS_WORKTREE_ROOT', '$XDG_CACHE_HOME']
    }
  });
  assert.ok(coverage.blockers.includes('doc_route_mention_without_route:$FOO_BAR'));
  assert.equal(coverage.doc_route_mentions_without_route.includes('$CODEX_HOME'), false);
  assert.equal(coverage.doc_route_mentions_without_route.includes('$HOME'), false);
  assert.equal(coverage.doc_route_mentions_without_route.includes('$SKS_WORKTREE_ROOT'), false);
  assert.equal(coverage.doc_route_mentions_without_route.includes('$XDG_CACHE_HOME'), false);
});
