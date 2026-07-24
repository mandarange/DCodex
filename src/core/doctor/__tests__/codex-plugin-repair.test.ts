// First import: this suite spawns the real codex binary, which writes
// $HOME/.codex/tmp lock files when the default home leaks through.
import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexPluginInventory } from '../../codex-plugins/codex-plugin-json.js';
import { ensureCodexPlugins } from '../../codex-plugins/codex-plugin-repair.js';

const CODEX_0144_LIST = {
  installed: [
    {
      pluginId: 'browser@openai-bundled',
      name: 'browser',
      marketplaceName: 'openai-bundled',
      version: '26.707.41301',
      installed: true,
      enabled: true,
      source: { source: 'local', path: '/fixture/browser' }
    },
    {
      pluginId: 'chrome@openai-bundled',
      name: 'chrome',
      marketplaceName: 'openai-bundled',
      version: '26.707.41301',
      installed: true,
      enabled: true,
      source: { source: 'local', path: '/fixture/chrome' }
    }
  ],
  available: [
    {
      pluginId: 'computer-use@openai-bundled',
      name: 'computer-use',
      marketplaceName: 'openai-bundled',
      installed: false,
      enabled: false,
      source: { source: 'local', path: '/fixture/computer-use' }
    }
  ]
};

test('Codex 0.144 installed/available plugin manifest is normalized without unsupported detail calls', async () => {
  const inventory = await buildCodexPluginInventory({
    codexBin: null,
    listJson: CODEX_0144_LIST,
    detailJsonSupported: false
  });
  assert.equal(inventory.plugins.length, 3);
  assert.equal(inventory.detail_fetch_count, 0);
  assert.equal(inventory.detail_json_supported, false);
  const chrome = inventory.plugins.find((plugin) => plugin.id === 'chrome@openai-bundled');
  assert.equal(chrome?.installed, true);
  assert.equal(chrome?.enabled, true);
  assert.equal(chrome?.marketplace, 'openai-bundled');
  assert.equal(chrome?.source, 'local');
  const computer = inventory.plugins.find((plugin) => plugin.id === 'computer-use@openai-bundled');
  assert.equal(computer?.installed, false);
  assert.equal(computer?.enabled, false);
});

test('plugin repair runs official add command, rechecks, and requires a new task manifest', async () => {
  const before = await buildCodexPluginInventory({
    codexBin: null,
    listJson: { installed: [], available: CODEX_0144_LIST.available },
    detailJsonSupported: false
  });
  const after = await buildCodexPluginInventory({
    codexBin: null,
    listJson: {
      installed: [{ ...CODEX_0144_LIST.available[0], installed: true, enabled: true }],
      available: []
    },
    detailJsonSupported: false
  });
  let inventoryCall = 0;
  const commands: string[][] = [];
  const result = await ensureCodexPlugins({
    pluginIds: ['computer-use@openai-bundled'],
    apply: true,
    codexBin: '/fixture/codex',
    inventoryFactory: async () => inventoryCall++ === 0 ? before : after,
    run: async (_bin, args) => {
      commands.push(args);
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.rechecked_after_install, true);
  assert.equal(result.requires_new_task, true);
  assert.equal(result.current_task_tool_manifest_verified, false);
  assert.deepEqual(commands, [['plugin', 'add', 'computer-use@openai-bundled', '--json']]);
  assert.ok(result.next_actions.some((line: string) => /new Codex\/Work task/.test(line)));
});

test('plugin repair redacts credentials from process output tails', async () => {
  const inventory = await buildCodexPluginInventory({
    codexBin: null,
    listJson: { installed: [], available: CODEX_0144_LIST.available },
    detailJsonSupported: false
  });
  const secret = 'sk-proj-secret-value-1234567890';
  const basic = 'dXNlcjpwYXNzd29yZA==';
  const cookie = 'opaque-session-secret-123456';
  const custom = 'opaque-secret-value-123456';
  const result = await ensureCodexPlugins({
    pluginIds: ['computer-use@openai-bundled'],
    apply: true,
    codexBin: '/fixture/codex',
    inventoryFactory: async () => inventory,
    run: async () => ({
      code: 1,
      stdout: '',
      stderr: `Authorization: Bearer ${secret}\nAuthorization: Basic ${basic}\nCookie: session=${cookie}\nX-Custom-Auth: ${custom}`
    })
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, new RegExp(basic));
  assert.doesNotMatch(serialized, new RegExp(cookie));
  assert.doesNotMatch(serialized, new RegExp(custom));
  assert.match(serialized, /redacted/i);
});

test('plugin inventory and inventory failures recursively redact manifest and error secrets', async () => {
  const secret = 'sk-proj-secret-value-1234567890';
  const inventory = await buildCodexPluginInventory({
    codexBin: null,
    listJson: {
      installed: [{
        pluginId: 'browser@openai-bundled',
        name: 'browser',
        installed: true,
        enabled: true,
        source: { source: 'local', path: `/tmp/${secret}/browser` },
        http_headers: { 'X-Custom-Auth': secret }
      }]
    },
    detailJsonSupported: false
  });
  assert.doesNotMatch(JSON.stringify(inventory), new RegExp(secret));

  const failed = await ensureCodexPlugins({
    pluginIds: ['browser@openai-bundled'],
    codexBin: '/fixture/codex',
    inventoryFactory: async () => { throw new Error(`inventory failed with ${secret}`); }
  });
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(secret));
  assert.match(JSON.stringify(failed), /redacted/i);
});
