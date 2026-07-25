import { searchCommand } from '../core/commands/search-command.js';

export async function run(subcommand: string = 'status', args: string[] = []) {
  return searchCommand(subcommand || 'status', args);
}
