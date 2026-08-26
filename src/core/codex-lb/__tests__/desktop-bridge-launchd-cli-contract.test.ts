import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBridgeCommand } from '../../../commands/bridge.js';
import {
  BRIDGE_CLI_BOOLEAN_OPTIONS,
  BRIDGE_CLI_VALUE_OPTIONS,
  DESKTOP_BRIDGE_SUPERVISED_FLAG,
  desktopBridgeServeArguments,
  isBridgeCliOption
} from '../bridge-cli-contract.js';
import { renderDesktopBridgeLaunchdPlist } from '../desktop-bridge/launchd.js';
import { desktopBridgeIsSupervised } from '../desktop-service.js';

const SETTINGS_PATH = '/Users/fixture/.codex/sks/desktop-bridge-settings.json';

function serveStub(calls: string[]): { serve: (options: { settingsPath: string }) => Promise<unknown> } {
  return {
    serve: async (options) => {
      calls.push(String(options?.settingsPath));
      return { schema: 'sks.desktop-bridge-serve.v1', ok: true, status: 'stopped', state: null };
    }
  };
}

/**
 * The regression this whole module exists for. 9.2.3's plist passed
 * `--supervised`; `parseArgs` had never registered it, so every launchd start
 * exited with `bridge_command_unknown_option`, KeepAlive declined to restart a
 * clean exit, and Codex reconnected forever against a dead port. Asserting the
 * argv literal is not enough — it has to survive the real parser.
 */
test('the argv launchd passes to `bridge serve` reaches serve instead of dying in the parser', async () => {
  const argv = desktopBridgeServeArguments(SETTINGS_PATH);
  assert.deepEqual(argv.slice(0, 2), ['bridge', 'serve']);
  const calls: string[] = [];
  const result = await executeBridgeCommand(argv.slice(1), serveStub(calls) as never);
  assert.deepEqual(result.output.blockers, undefined);
  assert.equal(result.exit_code, 0);
  assert.deepEqual(calls, [SETTINGS_PATH]);
});

/** The same argv after a round trip through the plist the installer actually writes. */
test('the serve argv survives the launchd plist it is written into', async () => {
  const plist = renderDesktopBridgeLaunchdPlist({
    executablePath: '/usr/local/bin/node',
    arguments: ['/usr/local/lib/node_modules/sneakoscope/dist/bin/sks.js', ...desktopBridgeServeArguments(SETTINGS_PATH)],
    stdoutPath: '/Users/fixture/.codex/sks/logs/desktop-bridge.out.log',
    stderrPath: '/Users/fixture/.codex/sks/logs/desktop-bridge.err.log'
  });
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  assert.ok(block, 'plist has no ProgramArguments array');
  const programArguments = [...(block[1] as string).matchAll(/<string>([^<]+)<\/string>/g)]
    .map((match) => match[1] as string);
  const serveIndex = programArguments.indexOf('bridge');
  assert.ok(serveIndex > 0, programArguments.join(' '));
  const calls: string[] = [];
  const result = await executeBridgeCommand(programArguments.slice(serveIndex + 1), serveStub(calls) as never);
  assert.equal(result.exit_code, 0);
  assert.deepEqual(calls, [SETTINGS_PATH]);
});

/**
 * Containment, stated directly: the launchd side may only spend options the CLI
 * side has registered. A future flag added to the plist without a table entry
 * fails here rather than in the operator's `desktop-bridge.out.log`.
 */
test('every option in the launchd serve argv is a registered bridge CLI option', () => {
  const options = desktopBridgeServeArguments(SETTINGS_PATH).filter((token) => token.startsWith('--'));
  assert.deepEqual(options, ['--settings', '--json', DESKTOP_BRIDGE_SUPERVISED_FLAG]);
  for (const option of options) assert.equal(isBridgeCliOption(option), true, option);
});

/**
 * The other direction: nothing may sit in the table that the parser cannot
 * consume. A subcommand is free to REFUSE an option it does not take
 * (`bridge_command_option_not_allowed`), but `bridge_command_unknown_option`
 * means the parser itself never learned the flag — which is the failure mode
 * that took the bridge down.
 */
test('the parser accepts every registered option before any subcommand allowlist runs', async () => {
  for (const option of BRIDGE_CLI_BOOLEAN_OPTIONS) {
    const result = await executeBridgeCommand(['status', option], { facade: { execute: async () => ({ schema: 'sks.bridge-operation.v1', ok: true }) } });
    const blockers = (result.output.blockers || []) as string[];
    assert.equal(blockers.includes('bridge_command_unknown_option'), false, option);
  }
  for (const option of BRIDGE_CLI_VALUE_OPTIONS) {
    const result = await executeBridgeCommand(['status', option, 'value'], { facade: { execute: async () => ({ schema: 'sks.bridge-operation.v1', ok: true }) } });
    const blockers = (result.output.blockers || []) as string[];
    assert.equal(blockers.includes('bridge_command_unknown_option'), false, option);
  }
  const unregistered = await executeBridgeCommand(['status', '--not-a-bridge-option'], {});
  assert.deepEqual(unregistered.output.blockers, ['bridge_command_unknown_option']);
});

/**
 * The flag the plist writes and the flag the runtime looks for are one constant,
 * so a supervised bridge cannot both be started with `--supervised` and decide
 * it is unsupervised — which would leave a version-skew exit with nothing
 * standing by to relaunch it.
 */
test('a process started from the launchd argv reports itself supervised', () => {
  const argv = ['/usr/local/bin/node', '/opt/sks/dist/bin/sks.js', ...desktopBridgeServeArguments(SETTINGS_PATH)];
  assert.equal(desktopBridgeIsSupervised({}, argv), true);
  assert.equal(desktopBridgeIsSupervised({}, argv.filter((entry) => entry !== DESKTOP_BRIDGE_SUPERVISED_FLAG)), false);
  assert.equal(desktopBridgeIsSupervised({ XPC_SERVICE_NAME: 'com.sneakoscope.desktop-bridge' }, []), true);
});
