import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { assertTestHomeWriteAllowed } from '../fsx.js';
import {
  PrivateCredentialFileError,
  readPrivateCredentialFile,
  writePrivateTextAtomic
} from '../security/private-credential-file.js';

export const TELEGRAM_TOKEN_ENV_NAMES = ['TELEGRAM_BOT_TOKEN', 'SKS_TELEGRAM_BOT_TOKEN'] as const;
export const TELEGRAM_STATE_SCHEMA = 'sks.telegram-state.v1' as const;
export const TELEGRAM_PAIRING_SCHEMA = 'sks.telegram-pairing.v1' as const;
export const TELEGRAM_STATE_MAX_BYTES = 1024 * 1024;

const TELEGRAM_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,128}$/;
const TELEGRAM_TOKEN_MAX_BYTES = 1024;
const TELEGRAM_STATE_LOCK_ATTEMPTS = 200;
const TELEGRAM_STATE_LOCK_RETRY_MS = 25;

export interface TelegramPrivatePaths {
  readonly sksHome: string;
  readonly secretDir: string;
  readonly tokenPath: string;
  readonly stateDir: string;
  readonly statePath: string;
  readonly stateLockPath: string;
}

export interface TelegramPairingState {
  readonly schema: typeof TELEGRAM_PAIRING_SCHEMA;
  readonly code: string;
  readonly expires_at: string;
  readonly used: boolean;
  readonly [key: string]: unknown;
}

export interface TelegramAuthorizedChatState {
  readonly chat_id: number;
  readonly sender_id: number;
  readonly paired_at: string;
  readonly [key: string]: unknown;
}

export interface TelegramConfirmationState {
  readonly nonce: string;
  readonly chat_id: number;
  readonly sender_id: number;
  readonly command: string;
  readonly input_json: string;
  readonly expires_at: string;
  readonly [key: string]: unknown;
}

export interface TelegramStateV1 {
  readonly schema: typeof TELEGRAM_STATE_SCHEMA;
  readonly pairing: TelegramPairingState | null;
  readonly chats: TelegramAuthorizedChatState[];
  readonly confirmations: TelegramConfirmationState[];
  readonly [key: string]: unknown;
}

export interface TelegramBotTokenResolution {
  readonly token: string | null;
  readonly source: 'env' | 'user_secret_file' | null;
  readonly env_var?: string;
}

export function telegramPrivatePaths(env: NodeJS.ProcessEnv = process.env): TelegramPrivatePaths {
  const sksHome = path.resolve(env.SKS_HOME || path.join(env.HOME || os.homedir(), '.sneakoscope'));
  const secretDir = path.join(sksHome, 'secrets');
  const stateDir = path.join(sksHome, 'state');
  return {
    sksHome,
    secretDir,
    tokenPath: path.join(secretDir, 'telegram-bot-token'),
    stateDir,
    statePath: path.join(stateDir, 'telegram.json'),
    stateLockPath: path.join(stateDir, '.telegram.lock')
  };
}

export function isValidTelegramBotToken(value: unknown): boolean {
  return TELEGRAM_TOKEN_PATTERN.test(String(value ?? '').trim());
}

export async function resolveTelegramBotToken(input: {
  env?: NodeJS.ProcessEnv;
  paths?: TelegramPrivatePaths;
} = {}): Promise<TelegramBotTokenResolution> {
  const env = input.env || process.env;
  for (const name of TELEGRAM_TOKEN_ENV_NAMES) {
    const token = String(env[name] || '').trim();
    if (token) {
      if (!isValidTelegramBotToken(token)) throw new Error('telegram_token_invalid');
      return { token, source: 'env', env_var: name };
    }
  }
  const token = await readStoredTelegramToken(input.paths || telegramPrivatePaths(env));
  return token ? { token, source: 'user_secret_file' } : { token: null, source: null };
}

export async function readStoredTelegramToken(
  paths: TelegramPrivatePaths = telegramPrivatePaths()
): Promise<string | null> {
  if (!await validateExistingPrivateDirectories(paths, 'token')) return null;
  try {
    const token = (await readPrivateCredentialFile(
      paths.sksHome,
      paths.tokenPath,
      'telegram_bot_token',
      { maxBytes: TELEGRAM_TOKEN_MAX_BYTES }
    )).bytes.toString('utf8').trim();
    if (!token) return null;
    if (!isValidTelegramBotToken(token)) throw new Error('telegram_token_invalid');
    return token;
  } catch (error: unknown) {
    if (error instanceof PrivateCredentialFileError && error.code === 'missing') return null;
    throw error;
  }
}

export async function storeTelegramToken(
  tokenInput: unknown,
  options: { env?: NodeJS.ProcessEnv; paths?: TelegramPrivatePaths; home?: string } = {}
): Promise<void> {
  const token = String(tokenInput ?? '').trim();
  if (!isValidTelegramBotToken(token)) throw new Error('telegram_token_invalid');
  const paths = resolvePrivatePaths(options);
  await ensureTelegramPrivateDirectories(paths, 'token');
  await writePrivateTextAtomic(paths.sksHome, paths.tokenPath, `${token}\n`, 'telegram_bot_token');
}

export function emptyTelegramState(): TelegramStateV1 {
  return {
    schema: TELEGRAM_STATE_SCHEMA,
    pairing: null,
    chats: [],
    confirmations: []
  };
}

export async function readTelegramState(
  paths: TelegramPrivatePaths = telegramPrivatePaths()
): Promise<TelegramStateV1> {
  if (!await validateExistingPrivateDirectories(paths, 'state')) return emptyTelegramState();
  let bytes: Buffer;
  try {
    bytes = (await readPrivateCredentialFile(
      paths.sksHome,
      paths.statePath,
      'telegram_state',
      { maxBytes: TELEGRAM_STATE_MAX_BYTES }
    )).bytes;
  } catch (error: unknown) {
    if (error instanceof PrivateCredentialFileError && error.code === 'missing') return emptyTelegramState();
    throw error;
  }
  if (bytes.length > TELEGRAM_STATE_MAX_BYTES) throw new Error('telegram_state_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('telegram_state_invalid');
  }
  if (!isTelegramState(parsed)) throw new Error('telegram_state_invalid');
  return parsed;
}

export async function writeTelegramState(
  state: TelegramStateV1,
  paths: TelegramPrivatePaths = telegramPrivatePaths()
): Promise<void> {
  if (!isTelegramState(state)) throw new Error('telegram_state_invalid');
  await ensureTelegramPrivateDirectories(paths, 'state');
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > TELEGRAM_STATE_MAX_BYTES) {
    throw new Error('telegram_state_too_large');
  }
  await writePrivateTextAtomic(
    paths.sksHome,
    paths.statePath,
    serialized,
    'telegram_state'
  );
}

export async function updateTelegramState(
  update: (state: TelegramStateV1) => TelegramStateV1 | Promise<TelegramStateV1>,
  paths: TelegramPrivatePaths = telegramPrivatePaths()
): Promise<TelegramStateV1> {
  await ensureTelegramPrivateDirectories(paths, 'state');
  return withTelegramStateLock(paths, async () => {
    const next = await update(await readTelegramState(paths));
    await writeTelegramState(next, paths);
    return next;
  });
}

export async function issueTelegramPairingCode(
  options: {
    ttlMs?: number;
    now?: number;
    env?: NodeJS.ProcessEnv;
    paths?: TelegramPrivatePaths;
    home?: string;
  } = {}
): Promise<{ code: string; expires_at: string }> {
  const now = options.now ?? Date.now();
  const ttlMs = Math.max(30_000, Math.min(options.ttlMs ?? 5 * 60_000, 15 * 60_000));
  const result = {
    code: `${randomInt(100_000, 1_000_000)}-${randomUUID().slice(0, 4).toUpperCase()}`,
    expires_at: new Date(now + ttlMs).toISOString()
  };
  await updateTelegramState((state) => ({
    ...state,
    pairing: {
      schema: TELEGRAM_PAIRING_SCHEMA,
      ...result,
      used: false
    }
  }), resolvePrivatePaths(options));
  return result;
}

async function withTelegramStateLock<T>(paths: TelegramPrivatePaths, operation: () => Promise<T>): Promise<T> {
  const identity = await acquireTelegramStateLock(paths);
  try {
    return await operation();
  } finally {
    const current = await fs.lstat(paths.stateLockPath).catch(() => null);
    if (current?.isDirectory() && !current.isSymbolicLink()
      && current.dev === identity.dev && current.ino === identity.ino) {
      await fs.rmdir(paths.stateLockPath).catch(() => undefined);
    }
  }
}

async function acquireTelegramStateLock(paths: TelegramPrivatePaths): Promise<{ dev: number; ino: number }> {
  assertTestHomeWriteAllowed(paths.stateLockPath);
  for (let attempt = 0; attempt < TELEGRAM_STATE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(paths.stateLockPath, { mode: 0o700 });
      const created = await inspectPrivateDirectory(paths.stateLockPath, 'telegram_state_lock');
      return { dev: created.dev, ino: created.ino };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
      const current = await fs.lstat(paths.stateLockPath).catch(() => null);
      if (!current) continue;
      if (current.isSymbolicLink() || !current.isDirectory()) {
        throw new Error('telegram_state_lock_unsafe_type');
      }
      const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (expectedUid !== null && current.uid !== expectedUid) {
        throw new Error('telegram_state_lock_owner_mismatch');
      }
      if ((current.mode & 0o777) !== 0o700) throw new Error('telegram_state_lock_mode_not_0700');
    }
    if (attempt + 1 < TELEGRAM_STATE_LOCK_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, TELEGRAM_STATE_LOCK_RETRY_MS));
    }
  }
  throw new Error('telegram_state_lock_timeout');
}

async function ensureTelegramPrivateDirectories(
  paths: TelegramPrivatePaths,
  target: 'token' | 'state'
): Promise<void> {
  await ensurePrivateDirectory(paths.sksHome, 'telegram_sks_home', false);
  await ensurePrivateDirectory(target === 'token' ? paths.secretDir : paths.stateDir, `telegram_${target}_directory`);
}

async function validateExistingPrivateDirectories(
  paths: TelegramPrivatePaths,
  target: 'token' | 'state'
): Promise<boolean> {
  if (!await pathExists(paths.sksHome)) return false;
  await inspectPrivateDirectory(paths.sksHome, 'telegram_sks_home', false);
  const child = target === 'token' ? paths.secretDir : paths.stateDir;
  if (!await pathExists(child)) return false;
  await inspectPrivateDirectory(child, `telegram_${target}_directory`);
  return true;
}

async function ensurePrivateDirectory(directory: string, label: string, requireMode0700 = true): Promise<void> {
  assertTestHomeWriteAllowed(directory);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
  }
  await inspectPrivateDirectory(directory, label, requireMode0700);
}

async function inspectPrivateDirectory(directory: string, label: string, requireMode0700 = true) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label}_unsafe_type`);
  if (requireMode0700 && (stat.mode & 0o777) !== 0o700) throw new Error(`${label}_mode_not_0700`);
  if (!requireMode0700 && (stat.mode & 0o022) !== 0) throw new Error(`${label}_group_or_other_writable`);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) throw new Error(`${label}_owner_mismatch`);
  return stat;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw error;
  }
}

function resolvePrivatePaths(options: {
  env?: NodeJS.ProcessEnv;
  paths?: TelegramPrivatePaths;
  home?: string;
}): TelegramPrivatePaths {
  if (options.paths) return options.paths;
  if (!options.home) return telegramPrivatePaths(options.env || process.env);
  return telegramPrivatePaths({ ...(options.env || process.env), SKS_HOME: undefined, HOME: options.home });
}

function isTelegramState(value: unknown): value is TelegramStateV1 {
  if (!isRecord(value)
    || value.schema !== TELEGRAM_STATE_SCHEMA
    || !Array.isArray(value.chats)
    || !Array.isArray(value.confirmations)) return false;
  if (value.pairing !== null && !isPairing(value.pairing)) return false;
  return value.chats.every((chat) => isRecord(chat)
      && Number.isSafeInteger(chat.chat_id)
      && Number.isSafeInteger(chat.sender_id)
      && typeof chat.paired_at === 'string')
    && value.confirmations.every((confirmation) => isRecord(confirmation)
      && typeof confirmation.nonce === 'string'
      && Number.isSafeInteger(confirmation.chat_id)
      && Number.isSafeInteger(confirmation.sender_id)
      && typeof confirmation.command === 'string'
      && typeof confirmation.input_json === 'string'
      && typeof confirmation.expires_at === 'string');
}

function isPairing(value: unknown): value is TelegramPairingState {
  return isRecord(value)
    && value.schema === TELEGRAM_PAIRING_SCHEMA
    && typeof value.code === 'string'
    && typeof value.expires_at === 'string'
    && typeof value.used === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
