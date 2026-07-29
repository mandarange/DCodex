import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopBridgeError } from './types.js';

export const DESKTOP_BRIDGE_LAUNCHD_LABEL = 'com.sneakoscope.codex-lb-desktop-bridge';

export interface DesktopBridgeLaunchdOptions {
  executablePath: string;
  arguments: readonly string[];
  stdoutPath: string;
  stderrPath: string;
}

export function desktopBridgeLaunchdPlistPath(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${DESKTOP_BRIDGE_LAUNCHD_LABEL}.plist`);
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function assertSafeLaunchdValue(value: string): void {
  if (!value || /[\0\r\n]/.test(value)) throw new DesktopBridgeError('bridge_launchd_value_invalid');
}

export function renderDesktopBridgeLaunchdPlist(options: DesktopBridgeLaunchdOptions): string {
  assertSafeLaunchdValue(options.executablePath);
  if (!path.isAbsolute(options.executablePath)) throw new DesktopBridgeError('bridge_launchd_executable_not_absolute');
  for (const argument of options.arguments) {
    assertSafeLaunchdValue(argument);
    if (
      /^(?:--?(?:(?:api|gateway|access|auth|bearer)[-_]?(?:key|token)|authorization|x-codex-lb-api-key)(?:=|$)|gatewayKey(?:=|$)|(?:CODEX_LB_API_KEY|SKS_CODEX_LB_API_KEY|AUTHORIZATION|ACCESS_TOKEN)=)/i
        .test(argument)
    ) {
      throw new DesktopBridgeError('bridge_launchd_secret_argument_forbidden');
    }
  }
  for (const logPath of [options.stdoutPath, options.stderrPath]) {
    assertSafeLaunchdValue(logPath);
    if (!path.isAbsolute(logPath)) throw new DesktopBridgeError('bridge_launchd_log_path_not_absolute');
  }

  const programArguments = [options.executablePath, ...options.arguments]
    .map((value) => `      <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${DESKTOP_BRIDGE_LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${xml(options.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(options.stderrPath)}</string>
  </dict>
</plist>
`;
}

export async function writeDesktopBridgeLaunchdPlist(
  file: string,
  options: DesktopBridgeLaunchdOptions,
): Promise<void> {
  const contents = renderDesktopBridgeLaunchdPlist(options);
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fsp.rename(temp, file);
    await fsp.chmod(file, 0o600);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}
