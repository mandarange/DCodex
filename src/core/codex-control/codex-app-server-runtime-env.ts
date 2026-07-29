import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTopLevelTomlString } from '../codex-app/codex-model-catalog.js';
import {
  loadCodexLbEnv,
  type CodexLbEnvLoadResult
} from '../codex-lb/codex-lb-env.js';

export const CODEX_APP_SERVER_PROVIDER_CREDENTIALS_UNAVAILABLE =
  'codex_app_server_provider_credentials_unavailable';
export const CODEX_APP_SERVER_CONFIG_READ_FAILED =
  'codex_app_server_config_read_failed';

export class CodexAppServerRuntimeEnvError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CodexAppServerRuntimeEnvError';
  }
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
  readonly loadCodexLbEnvImpl?: (options: Record<string, unknown>) => Promise<CodexLbEnvLoadResult>;
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

  if (selectedProvider !== 'codex-lb') {
    delete env.CODEX_LB_API_KEY;
    delete env.CODEX_LB_BASE_URL;
    return env;
  }

  const load = input.loadCodexLbEnvImpl || loadCodexLbEnv;
  let loaded: CodexLbEnvLoadResult | null = null;
  try {
    loaded = await load({
      home,
      processEnv: {},
      envPath: path.join(codexHome, 'sks-codex-lb.env'),
      metadataPath: path.join(codexHome, 'sks-codex-lb.json')
    });
  } catch {
    throw new CodexAppServerRuntimeEnvError(
      CODEX_APP_SERVER_PROVIDER_CREDENTIALS_UNAVAILABLE
    );
  }
  if (!loaded?.configured || !loaded.secret_api_key || !loaded.base_url) {
    throw new CodexAppServerRuntimeEnvError(
      CODEX_APP_SERVER_PROVIDER_CREDENTIALS_UNAVAILABLE
    );
  }
  env.CODEX_LB_API_KEY = loaded.secret_api_key;
  env.CODEX_LB_BASE_URL = loaded.base_url;
  return env;
}
