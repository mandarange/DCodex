import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAllFeaturesSelftest, buildFeatureRegistry, validateFeatureRegistry } from '../../dist/core/feature-registry.js';
import { COMMAND_MANIFEST_LITE } from '../../dist/cli/command-manifest-lite.js';
import { COMMANDS } from '../../dist/cli/command-registry.js';

test('feature registry carries fixture contracts', async () => {
  const registry = await buildFeatureRegistry({ root: process.cwd() });
  const proof = registry.features.find((feature) => feature.id === 'cli-proof');
  assert.equal(proof.fixture.status, 'pass');
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
  assert.ok(registry.source_inventory.cli_command_names.includes('codex-lb'));
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
  assert.equal(registry.features.some((feature) => feature.id === 'cli-ui'), false);
  const computerUse = registry.features.find((feature) => feature.id === 'cli-computer-use');
  assert.equal(computerUse.fixture.status, 'pass');
  for (const featureId of ['cli-config', 'cli-telegram']) {
    const feature = registry.features.find((entry) => entry.id === featureId);
    assert.equal(feature.fixture.status, 'pass', `${featureId} fixture must be explicitly registered`);
    assert.equal(feature.fixture.quality, 'wiring_only', `${featureId} fixture must not overclaim integration proof`);
  }
  const selftest = buildAllFeaturesSelftest(registry);
  assert.equal(registry.coverage.ok, true);
  assert.equal(selftest.ok, true);
  assert.equal(selftest.fixtures.ok, true);
  assert.equal(selftest.coverage.doc_route_mentions_without_route.includes('$CODEX_HOME'), false);
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
