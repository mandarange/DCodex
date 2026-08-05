import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OpenRouterKeyRecord, OpenRouterKeyResolution } from './openrouter-types.js';
import { redactOpenRouterKey } from '../../security/redact-secrets.js';
import {
  readPrivateCredentialFile,
  writePrivateTextAtomic
} from '../../security/private-credential-file.js';
import {
  inspectConfinedPath,
  isLexicallyConfined,
  removeManagedPathVerified
} from '../../managed-path-safety.js';

export const OPENROUTER_KEY_ENV_NAMES = ['OPENROUTER_API_KEY', 'SKS_OPENROUTER_API_KEY'] as const;

export interface OpenRouterSecretPaths {
  readonly sksHome: string;
  readonly secretDir: string;
  readonly keyPath: string;
  readonly metadataPath: string;
}

export function openRouterSecretPaths(env: NodeJS.ProcessEnv = process.env): OpenRouterSecretPaths {
  const sksHome = path.resolve(env.SKS_HOME || path.join(env.HOME || os.homedir(), '.sneakoscope'));
  const secretDir = path.join(sksHome, 'secrets');
  return {
    sksHome,
    secretDir,
    keyPath: path.join(secretDir, 'openrouter-api-key'),
    metadataPath: path.join(secretDir, 'openrouter-api-key.json')
  };
}

export async function resolveOpenRouterApiKey(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly paths?: OpenRouterSecretPaths;
} = {}): Promise<OpenRouterKeyResolution> {
  const env = input.env || process.env;
  for (const name of OPENROUTER_KEY_ENV_NAMES) {
    const value = String(env[name] || '').trim();
    if (value) {
      return {
        key: value,
        source: 'env',
        env_var: name,
        key_preview: redactOpenRouterKey(value),
        blockers: [],
        warnings: name === 'OPENROUTER_API_KEY' ? [] : ['using_sks_openrouter_api_key_env']
      };
    }
  }
  const stored = await readStoredOpenRouterKey(input.paths || openRouterSecretPaths(env));
  if (stored) {
    return {
      key: stored,
      source: 'user-secret-store',
      key_preview: redactOpenRouterKey(stored),
      blockers: [],
      warnings: []
    };
  }
  return {
    key: null,
    source: null,
    key_preview: null,
    blockers: ['glm_missing_openrouter_key'],
    warnings: []
  };
}

export async function readStoredOpenRouterKey(paths: OpenRouterSecretPaths): Promise<string | null> {
  try {
    const text = (await readPrivateCredentialFile(
      paths.secretDir,
      paths.keyPath,
      'openrouter_api_key'
    )).bytes.toString('utf8');
    const key = text.trim();
    return key || null;
  } catch {
    return null;
  }
}

export async function writeStoredOpenRouterKey(
  value: string,
  input: {
    readonly paths?: OpenRouterSecretPaths;
    readonly nowIso?: () => string;
    readonly previousRecord?: OpenRouterKeyRecord | null;
  } = {}
): Promise<OpenRouterKeyRecord> {
  const key = value.trim();
  if (!key) throw new Error('OpenRouter key is empty.');
  const paths = input.paths || openRouterSecretPaths();
  const nowIso = input.nowIso || (() => new Date().toISOString());
  const timestamp = nowIso();
  const previous = input.previousRecord ?? await readOpenRouterKeyRecord(paths);
  await ensureSecretDir(paths.secretDir);
  await writePrivateTextAtomic(paths.secretDir, paths.keyPath, `${key}\n`, 'openrouter_api_key');
  const record: OpenRouterKeyRecord = {
    schema: 'sks.openrouter-key.v1',
    created_at: previous?.created_at || timestamp,
    updated_at: timestamp,
    key_hash: crypto.createHash('sha256').update(key).digest('hex'),
    key_preview: redactOpenRouterKey(key)
  };
  await writePrivateTextAtomic(
    paths.secretDir,
    paths.metadataPath,
    `${JSON.stringify(record, null, 2)}\n`,
    'openrouter_api_key_metadata'
  );
  return record;
}

export async function readOpenRouterKeyRecord(paths: OpenRouterSecretPaths): Promise<OpenRouterKeyRecord | null> {
  try {
    const text = (await readPrivateCredentialFile(
      paths.secretDir,
      paths.metadataPath,
      'openrouter_api_key_metadata'
    )).bytes.toString('utf8');
    const parsed = JSON.parse(text) as Partial<OpenRouterKeyRecord>;
    if (parsed.schema !== 'sks.openrouter-key.v1' || !parsed.key_hash || !parsed.key_preview) return null;
    return parsed as OpenRouterKeyRecord;
  } catch {
    return null;
  }
}

export async function removeStoredOpenRouterKey(input: {
  readonly paths?: OpenRouterSecretPaths;
  readonly confirmed: boolean;
}): Promise<{
  readonly schema: 'sks.openrouter-key-removal.v1';
  readonly removed: boolean;
  readonly removed_paths: readonly string[];
  readonly blockers: readonly string[];
}> {
  if (input.confirmed !== true) {
    return {
      schema: 'sks.openrouter-key-removal.v1',
      removed: false,
      removed_paths: [],
      blockers: ['openrouter_credential_removal_confirmation_required']
    };
  }
  const paths = input.paths || openRouterSecretPaths();
  const secretDir = path.resolve(paths.secretDir);
  const files = [path.resolve(paths.keyPath), path.resolve(paths.metadataPath)];
  if (files.some((file) => file === secretDir || !isLexicallyConfined(secretDir, file))) {
    return {
      schema: 'sks.openrouter-key-removal.v1',
      removed: false,
      removed_paths: [],
      blockers: ['openrouter_credential_path_outside_secret_store']
    };
  }
  if (new Set(files).size !== files.length) {
    return {
      schema: 'sks.openrouter-key-removal.v1',
      removed: false,
      removed_paths: [],
      blockers: ['openrouter_credential_path_collision']
    };
  }
  const secretDirStat = await fs.lstat(secretDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!secretDirStat) {
    return {
      schema: 'sks.openrouter-key-removal.v1',
      removed: false,
      removed_paths: [],
      blockers: []
    };
  }
  if (!secretDirStat.isDirectory() || secretDirStat.isSymbolicLink()) {
    return {
      schema: 'sks.openrouter-key-removal.v1',
      removed: false,
      removed_paths: [],
      blockers: ['openrouter_credential_secret_store_unsafe']
    };
  }
  const existing: string[] = [];
  for (const file of files) {
    const inspected = await inspectConfinedPath(secretDir, file).catch(() => null);
    if (!inspected) {
      return {
        schema: 'sks.openrouter-key-removal.v1',
        removed: false,
        removed_paths: [],
        blockers: ['openrouter_credential_path_unsafe']
      };
    }
    if (!inspected.exists) continue;
    if (inspected.leafSymlink || !inspected.stat?.isFile()) {
      return {
        schema: 'sks.openrouter-key-removal.v1',
        removed: false,
        removed_paths: [],
        blockers: ['openrouter_credential_path_not_regular_file']
      };
    }
    existing.push(file);
  }
  const removed: string[] = [];
  for (const file of existing) {
    await removeManagedPathVerified(secretDir, file);
    removed.push(file);
  }
  return {
    schema: 'sks.openrouter-key-removal.v1',
    removed: removed.length > 0,
    removed_paths: removed,
    blockers: []
  };
}

async function ensureSecretDir(secretDir: string): Promise<void> {
  await fs.mkdir(secretDir, { recursive: true, mode: 0o700 });
  await fs.chmod(secretDir, 0o700).catch(() => undefined);
}

export async function promptForOpenRouterKeyHidden(): Promise<string | null> {
  const readline = await import('node:readline/promises');
  const { stdin, stdout } = await import('node:process');
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    // Use muted input for hidden key entry
    let key = '';
    const escaped = stdout.isTTY
      ? await new Promise<string>((resolve) => {
          const onData = (char: Buffer) => {
            const c = char.toString();
            if (c === '\r' || c === '\n' || c === '\u0004') {
              stdin.removeListener('data', onData);
              resolve(key);
            } else if (c === '\u0003') {
              stdin.removeListener('data', onData);
              resolve('');
            } else {
              key += c;
            }
          };
          stdin.on('data', onData);
          stdout.write('Enter OpenRouter API key (input hidden): ');
        })
      : await rl.question('Enter OpenRouter API key: ');
    return escaped.trim() || null;
  } finally {
    rl.close();
  }
}
