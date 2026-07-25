import type { CommandManifestLiteEntry } from './command-manifest-lite.js';

export interface CommandHelpResult {
  readonly ok: true;
  readonly status: 'help';
  readonly action: 'help';
  readonly command: string;
}

/**
 * `--help`/`-h`/`help` is a read-only request for usage text. It must never
 * reach a command's side effects, wait on the migration lock, or be answered
 * with a failing exit code.
 *
 * `--help`/`-h` are unambiguous wherever they appear. Bare `help` counts only
 * in the subcommand position so an arbitrary value elsewhere — a commit message
 * of "help", for example — cannot bypass the gates.
 */
export function isHelpRequest(args: readonly string[]): boolean {
  return args.includes('--help')
    || args.includes('-h')
    || String(args[0] || '').toLowerCase() === 'help';
}

/**
 * Usage text derived from the command manifest. Commands with a richer surface
 * export their own `usage()`; this is the floor every command gets for free, so
 * a missing per-command help text degrades to a description rather than to
 * running the command.
 */
export function renderManifestHelp(command: string, entry: CommandManifestLiteEntry | undefined): string {
  if (!entry) return `Usage: sks ${command}\n\nNo manifest entry is registered for this command.`;
  const lines = [`Usage: sks ${entry.name} [options]`, '', entry.summary];
  const notes: string[] = [];
  if (entry.deprecated) notes.push('deprecated — kept only for compatibility');
  if (entry.maturity !== 'stable') notes.push(`maturity: ${entry.maturity}`);
  if (entry.readonly) notes.push('read-only: does not mutate project or Codex state');
  if (entry.diagnostic) notes.push('diagnostic');
  notes.push(`risk: ${entry.risk}`, `latency: ${entry.latency}`);
  lines.push('', ...notes.map((note) => `  ${note}`));
  const flags = ['  --help, -h    Print this usage without running the command.'];
  if (entry.supportsJson) flags.push('  --json        Emit the machine-readable result.');
  lines.push('', 'Options:', ...flags);
  lines.push('', 'Run `sks commands` for the full command list.');
  return lines.join('\n');
}

export function helpResult(command: string): CommandHelpResult {
  return { ok: true, status: 'help', action: 'help', command };
}
