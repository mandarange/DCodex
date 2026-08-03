export function flag(args: any = [], name: any) {
  return args.includes(name);
}

export function readOption(args: any = [], name: any, fallback: any = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

export function positionalArgs(args: any = []) {
  const out: any[] = [];
  const valueFlags = new Set([
    '--source',
    '--format',
    '--iterations',
    '--out',
    '--baseline',
    '--candidate',
    '--install-scope',
    '--max-cycles',
    '--cycle-timeout-minutes',
    '--depth',
    '--scope',
    '--transport',
    '--query',
    '--topic',
    '--tokens',
    '--timeout-ms',
    '--sql',
    '--command',
    '--project-ref',
    '--agents',
    '--max-threads',
    '--target-active-slots',
    '--work-items',
    '--minimum-work-items',
    '--max-queue-expansion',
    '--concurrency',
    '--backend',
    '--route',
    '--mission',
    '--mission-id',
    '--profile',
    '--write-mode',
    '--max-write-agents',
    '--service-tier',
    '--worker-placement',
    '--phase',
    '--message',
    '--role',
    '--max-anchors',
    '--lines',
    '--dir'
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('--')) out.push(arg);
  }
  return out;
}
