import path from 'node:path';
import {
  formatSksConfigAdoptText,
  runSksConfigAdopt,
  type SksConfigAdoptResult
} from './config-adopt.js';

export function usage(command = 'config'): string {
  return `Usage: sks ${command === 'config' ? 'config' : command} adopt [--project-root <path>] [--dry-run] [--json]`;
}

export async function configCommand(
  subcommand = 'adopt',
  args: string[] = []
): Promise<SksConfigAdoptResult | null> {
  if (subcommand !== 'adopt') {
    process.exitCode = 1;
    console.error(usage('config'));
    return null;
  }
  const root = valueAfter(args, '--project-root') || valueAfter(args, '--root') || process.cwd();
  const result = await runSksConfigAdopt({
    root: path.resolve(root),
    dryRun: args.includes('--dry-run')
  });
  if (!result.ok) process.exitCode = 1;
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(formatSksConfigAdoptText(result));
  return result;
}

export async function run(_command: string, args: string[]): Promise<SksConfigAdoptResult | null> {
  const [subcommand = 'adopt', ...rest] = args;
  return configCommand(subcommand, rest);
}

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith('-') ? value : null;
}
