import { madHighCommand } from '../core/commands/mad-sks-command.js';
import { maybePromptCodexUpdateForLaunch, maybePromptCodexLbSetupForLaunch, maybePromptSksUpdateForLaunch } from '../cli/install-helpers.js';
import { PACKAGE_VERSION } from '../core/fsx.js';

export async function run(_command: any, args: any = []) {
  return madHighCommand(['--mad-sks', ...args], {
    maybePromptSksUpdateForLaunch,
    maybePromptCodexUpdateForLaunch,
    maybePromptCodexLbSetupForLaunch,
    packageVersion: PACKAGE_VERSION
  });
}
