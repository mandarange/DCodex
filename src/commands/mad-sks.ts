import { madHighCommand } from '../core/commands/mad-sks-command.js';
import { PACKAGE_VERSION } from '../core/fsx.js';

export async function run(_command: any, args: any = []) {
  return madHighCommand(['--mad-sks', ...args], {
    packageVersion: PACKAGE_VERSION
  });
}
