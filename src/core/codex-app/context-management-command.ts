import fs from 'node:fs/promises';
import { codexUserConfigPath } from './codex-model-catalog.js';
import { writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { contextManagementValue, setContextManagement } from '../codex/context-management.js';

export async function contextManagementCommand(args: string[], options: { home?: string; env?: NodeJS.ProcessEnv } = {}) {
  const configPath = codexUserConfigPath(options);
  const action = args[0] || 'status';
  try {
    if (!['status', 'on', 'off'].includes(action) || args.slice(1).some(arg => arg !== '--json')) throw new Error('context_management_invalid_arguments');
    let exists = true;
    const before = await fs.readFile(configPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; exists = false; return ''; });
    let after = before;
    let changed = false;
    if (action !== 'status') {
      const next = setContextManagement(before, action === 'on');
      const write = await writeCodexConfigGuarded({
        configPath, before, cause: 'context-management', removeTopLevelModeLocks: false,
        verifyUnchangedBeforeWrite: true, expectedBeforeExists: exists, mutate: () => next,
      });
      if (!write.ok) throw new Error(`context_management_write_${write.status}`);
      after = await fs.readFile(configPath, 'utf8');
      if (contextManagementValue(after) !== (action === 'on')) throw new Error('context_management_readback_mismatch');
      changed = write.changed;
    }
    const value = contextManagementValue(after);
    return { schema: 'sks.context-management.v1', ok: true, enabled: value === true, configured: value !== undefined,
      default_enabled: true, changed, config_path: configPath,
      message: 'Applies to new tasks on supported Codex clients with eligible ChatGPT sign-in. API-key and custom-provider sessions may not activate it.' };
  } catch {
    return { schema: 'sks.context-management.v1', ok: false, enabled: null, config_path: configPath,
      message: 'Could not read or update the setting. Check the Codex configuration; existing content was not replaced without validation.' };
  }
}
