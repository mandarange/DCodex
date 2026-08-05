import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTopLevelTomlString } from '../codex-app/codex-model-catalog.js';

export const CODEX_APP_SERVER_DIRECT_PROVIDER_SELECTION_RETIRED =
  'desktop_bridge_direct_provider_selection_retired';
export const CODEX_APP_SERVER_CONFIG_READ_FAILED =
  'codex_app_server_config_read_failed';

export class CodexAppServerRuntimeEnvError extends Error {
  constructor(readonly code: string, readonly operatorActions: readonly string[] = []) {
    super(operatorActions.length > 0 ? `${code}: ${operatorActions.join(' ')}` : code);
    this.name = 'CodexAppServerRuntimeEnvError';
  }
}

export function desktopBridgeMigrationGuidance(): string[] {
  return [
    'Run `sks bridge ensure --json` to migrate SKS-owned routing to Desktop Bridge.',
    'If the direct provider selection is user-owned, review and remove it manually before retrying.'
  ];
}

export function codexAppServerExecutablePath(input: {
  readonly nodeBin: string;
  readonly home?: string;
  readonly inheritedPath?: string | null;
}): string {
  const home = path.resolve(input.home || process.env.HOME || os.homedir());
  const candidates = [
    path.dirname(path.resolve(input.nodeBin)),
    path.join(home, '.local', 'bin'),
    ...(input.inheritedPath || '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ];
  return [...new Set(candidates
    .map((entry) => String(entry || '').trim())
    .filter((entry) => path.isAbsolute(entry)))]
    .join(path.delimiter);
}

export async function prepareCodexAppServerRuntimeEnv(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly codexHome?: string;
  readonly nodeBin?: string;
  readonly configText?: string;
  readonly readConfigTextImpl?: (file: string) => Promise<string>;
} = {}): Promise<NodeJS.ProcessEnv> {
  const sourceEnv = input.env || process.env;
  const home = path.resolve(input.home || sourceEnv.HOME || os.homedir());
  const codexHome = path.resolve(input.codexHome || sourceEnv.CODEX_HOME || path.join(home, '.codex'));
  let configText = input.configText;
  if (configText === undefined) {
    const configPath = path.join(codexHome, 'config.toml');
    const readConfigText = input.readConfigTextImpl
      ?? ((file: string) => fsp.readFile(file, 'utf8'));
    try {
      configText = await readConfigText(configPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') configText = '';
      else throw new CodexAppServerRuntimeEnvError(CODEX_APP_SERVER_CONFIG_READ_FAILED);
    }
  }
  const selectedProvider = readTopLevelTomlString(configText, 'model_provider');
  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    PATH: codexAppServerExecutablePath({
      nodeBin: input.nodeBin || process.execPath,
      home,
      ...(sourceEnv.PATH === undefined ? {} : { inheritedPath: sourceEnv.PATH })
    })
  };

  delete env.CODEX_LB_API_KEY;
  delete env.CODEX_LB_BASE_URL;
  if (selectedProvider === 'codex-lb' || selectedProvider === 'openrouter') {
    throw new CodexAppServerRuntimeEnvError(
      CODEX_APP_SERVER_DIRECT_PROVIDER_SELECTION_RETIRED,
      desktopBridgeMigrationGuidance()
    );
  }
  return env;
}
