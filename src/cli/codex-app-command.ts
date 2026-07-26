import { spawn } from 'node:child_process';
import { codexRemoteControlStatus, formatCodexRemoteControlStatus } from '../core/codex-app.js';

export async function codexAppRemoteControlCommand(args: any = [], opts: any = {}) {
  const controlArgs = argsBeforeSeparator(args);
  if (controlArgs.includes('--help') || controlArgs.includes('-h')) {
    console.log(remoteControlHelp());
    return;
  }

  const status = await codexRemoteControlStatus();
  if (controlArgs.includes('--json')) {
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) process.exitCode = 1;
    return;
  }

  if (controlArgs.includes('--status') || controlArgs.includes('--check') || controlArgs.includes('--dry-run')) {
    console.log(formatCodexRemoteControlStatus(status));
    if (!status.ok) process.exitCode = 1;
    return;
  }

  if (!status.ok) {
    console.error(formatCodexRemoteControlStatus(status));
    process.exitCode = 1;
    return;
  }

  const passthrough = stripSeparator(args).map((arg: unknown) => String(arg));
  const spawnFn = opts.spawn || spawn;
  const code = await spawnInherited(spawnFn, status.codex_cli.bin, ['remote-control', ...passthrough], {
    cwd: process.cwd(),
    env: process.env
  });
  if (code) process.exitCode = code;
}

function remoteControlHelp() {
  return [
    'Usage: sks codex-app remote-control [--status|--check|--dry-run|--json] [-- <codex remote-control args>]',
    '',
    'Starts Codex CLI remote-control, the headless remotely controllable app-server entrypoint.',
    'SKS only wraps the first-party command and refuses older Codex CLI versions instead of falling back to app-server internals.'
  ].join('\n');
}

function stripSeparator(args: any = []) {
  const index = args.indexOf('--');
  return index >= 0 ? args.slice(index + 1) : args;
}

function argsBeforeSeparator(args: any = []) {
  const index = args.indexOf('--');
  return index >= 0 ? args.slice(0, index) : args;
}

function spawnInherited(spawnFn: any, command: any, args: any, opts: any) {
  return new Promise<any>((resolve: any) => {
    const child = spawnFn(command, args, { ...opts, stdio: 'inherit' });
    child.on('error', (err: any) => {
      console.error(`codex remote-control failed to start: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code: any) => resolve(code || 0));
  });
}
