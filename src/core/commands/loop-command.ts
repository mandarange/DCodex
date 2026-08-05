import { printJson } from '../../cli/output.js';
import { flag } from './command-utils.js';

/**
 * NC-38 / U6 / P3: `$sks-loop` product surface is retired.
 * Persisted goal/loop ownership is Codex native Goal only.
 * qa-loop remains a distinct dogfood route and is not served here.
 */
export async function loopCommand(subcommand: string = 'help', args: string[] = []): Promise<void> {
  const result = {
    schema: 'sks.loop-command.retired.v1',
    ok: false,
    retired: true,
    action: String(subcommand || 'help'),
    blockers: [
      'sks_loop_retired',
      'use_codex_native_goal',
      'qa_loop_remains_separate_dogfood_route'
    ],
    next_action: 'Use Codex native Goal for persisted goals/loops. For UI dogfood use $sks-qa-loop / sks qa-loop.'
  };
  process.exitCode = 2;
  if (flag(args, '--json')) return printJson(result);
  console.error('SKS loop is retired (NC-38). Codex native Goal is the only persisted goal/loop owner.');
  console.error('Use Codex native Goal controls, or sks qa-loop for QA dogfood.');
  console.error(result.next_action);
}
