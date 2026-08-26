import { DesktopBridgeError } from './desktop-bridge/types.js';

/**
 * The one option table the `sks bridge` CLI and the launchd plist both read.
 *
 * 9.2.3 shipped a plist that always passed `--supervised` and a parser that had
 * never registered it. The per-subcommand allowlist for `serve` DID permit the
 * flag — two hand-written tables that had to agree, and only one of them was
 * consulted first. So launchd started the service, `parseArgs` threw
 * `bridge_command_unknown_option` before any subcommand was reached, KeepAlive
 * declined to restart a process that had exited cleanly, and Codex reconnected
 * forever against a dead loopback port. The operator saw "update succeeded" and
 * a bridge that was never up.
 *
 * A flag reaches the CLI only by being listed here, and `desktopBridgeServeArguments`
 * refuses to emit one that is not — the divergence cannot be written again.
 */
export const DESKTOP_BRIDGE_SUPERVISED_FLAG = '--supervised' as const;

export const BRIDGE_CLI_BOOLEAN_OPTIONS = [
  '--json',
  '--strict',
  '--require-ready',
  '--api-key-stdin',
  '--confirm',
  DESKTOP_BRIDGE_SUPERVISED_FLAG
] as const;

export const BRIDGE_CLI_VALUE_OPTIONS = ['--level', '--host', '--settings', '--set'] as const;

export type BridgeCliBooleanOption = typeof BRIDGE_CLI_BOOLEAN_OPTIONS[number];
export type BridgeCliValueOption = typeof BRIDGE_CLI_VALUE_OPTIONS[number];

export function isBridgeCliBooleanOption(value: string): value is BridgeCliBooleanOption {
  return (BRIDGE_CLI_BOOLEAN_OPTIONS as readonly string[]).includes(value);
}

export function isBridgeCliValueOption(value: string): value is BridgeCliValueOption {
  return (BRIDGE_CLI_VALUE_OPTIONS as readonly string[]).includes(value);
}

export function isBridgeCliOption(value: string): boolean {
  return isBridgeCliBooleanOption(value) || isBridgeCliValueOption(value);
}

/**
 * The argv the launchd plist passes after the interpreter and the CLI entry.
 *
 * `--supervised` marks the process as launchd-owned, which is what lets a
 * version-skew exit be safe: something is standing by to relaunch it. The
 * runtime detector reads the same constant, so the flag the plist writes and
 * the flag `desktopBridgeIsSupervised` looks for cannot drift apart either.
 *
 * The check below is not defensive coding against user input — this argv is a
 * literal. It is the assertion that keeps a future flag from being added here
 * without being registered above, where the failure would otherwise be a
 * service that exits at every launchd start with only a log line to say so.
 */
export function desktopBridgeServeArguments(settingsPath: string): string[] {
  const argv = [
    'bridge',
    'serve',
    '--settings',
    settingsPath,
    '--json',
    DESKTOP_BRIDGE_SUPERVISED_FLAG
  ];
  const unregistered = argv.filter((token) => token.startsWith('--') && !isBridgeCliOption(token));
  if (unregistered.length) {
    throw new DesktopBridgeError(`bridge_serve_option_unregistered:${unregistered.join(',')}`);
  }
  return argv;
}
