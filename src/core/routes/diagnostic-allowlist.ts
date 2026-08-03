import { COMMAND_MANIFEST_BY_NAME } from '../../cli/command-manifest-lite.js';

export function diagnosticPromptAllowedDuringNoQuestions(prompt: string): boolean {
  const text = String(prompt || '').trim();
  if (!text) return false;
  const parsed = parseSksCommand(text);
  if (!parsed) return false;
  const { command, subcommand, args } = parsed;
  const entry = (COMMAND_MANIFEST_BY_NAME as Record<string, { diagnostic?: boolean; readonly?: boolean; allowedDuringActiveRoute?: boolean } | undefined>)[command];
  if (!entry || entry.allowedDuringActiveRoute !== true) return false;
  if (entry.readonly === true && safeDiagnosticSubcommand(command, subcommand, args)) return true;
  return Boolean(entry.diagnostic === true && safeDiagnosticSubcommand(command, subcommand, args));
}

function parseSksCommand(text: string): { command: string; subcommand: string; args: string[] } | null {
  const direct = text.match(/^(?:npx\s+)?sks\s+([a-z0-9][a-z0-9-]*)\b/i);
  if (direct?.[1]) return commandParts(text.slice(direct[0].length).trim(), direct[1]);
  const nodeBin = text.match(/^node\s+\S*(?:^|\/)sks\.js\s+([a-z0-9][a-z0-9-]*)\b/i);
  if (nodeBin?.[1]) return commandParts(text.slice(nodeBin[0].length).trim(), nodeBin[1]);
  return null;
}

function commandParts(rest: string, command: string) {
  const args = rest.split(/\s+/).filter(Boolean);
  const subcommand = args.find((arg) => !arg.startsWith('-')) || '';
  return { command: command.toLowerCase(), subcommand: subcommand.toLowerCase(), args };
}

function safeDiagnosticSubcommand(command: string, subcommand: string, args: readonly string[]) {
  if (args.some((arg) => ['--fix', '--yes', '-y', '--write', '--apply', '--execute', '--force', '--prune'].includes(arg))) return false;
  const allowed: Record<string, readonly string[]> = {
    doctor: ['', 'status', 'check'],
    route: ['', 'status'],
    rollback: ['', 'list', 'status'],
    menubar: ['', 'status'],
    wiki: ['status', 'validate', 'validate-shared'],
    gc: ['stats', 'status'],
    pipeline: ['', 'status'],
    'stop-gate': ['', 'check'],
    status: [''],
    root: [''],
    help: [''],
    version: [''],
    commands: [''],
    usage: [''],
    stats: [''],
    paths: ['', 'status']
  };
  return (allowed[command] || ['']).includes(subcommand);
}
