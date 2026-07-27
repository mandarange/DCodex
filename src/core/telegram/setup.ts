import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorCodeOf } from '../errors/message.js';
import {
  ensureDir,
  globalSksRoot,
  nowIso,
  readJson,
  runProcess,
  sha256,
  which,
  writeBinaryAtomic,
  writeJsonAtomic
} from '../fsx.js';
import {
  REMOTE_MACHINE_REGISTRY_SCHEMA,
  REMOTE_SESSION_INDEX_SCHEMA,
  RemoteCodexSessionBindingStore,
  remoteCodexSessionBindingsPath,
  remoteMachineRegistryPath,
  remoteSessionIndexPath,
  validateAllowedRoot,
  validateRemoteMachineRegistry,
  validateRemoteSessionIndex,
  type RemoteCodexSessionBindingV1,
  type RemoteMachineRegistryV1,
  type RemoteMachineV1,
  type RemoteSessionIndexV1
} from '../remote/index.js';
import { probeTelegramBotReadiness, TelegramBotApiClient, TelegramBotApiError } from './bot-api.js';
import { isPositiveTelegramId, telegramTokenFingerprint, validateTelegramBotToken } from './config.js';
import { telegramHubPaths } from './hub.js';
import { TelegramOwnerConflictError, TelegramOwnerLock } from './owner-lock.js';
import type { TelegramHubConfigV1, TelegramUpdate } from './types.js';

const KEYCHAIN_SERVICE = 'com.sneakoscope.telegram.bot';
const KEYCHAIN_WRITER_SWIFT = `import Foundation
import Security
let a=CommandLine.arguments[1],s=CommandLine.arguments[2]
guard let k=String(data:FileHandle.standardInput.readDataToEndOfFile(),encoding:.utf8)?.trimmingCharacters(in:.whitespacesAndNewlines),!k.isEmpty else{exit(64)}
let q:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrAccount as String:a,kSecAttrService as String:s]
let v:[String:Any]=[kSecValueData as String:Data(k.utf8)]
var r=SecItemUpdate(q as CFDictionary,v as CFDictionary)
if r==errSecItemNotFound{var n=q;n[kSecValueData as String]=Data(k.utf8);r=SecItemAdd(n as CFDictionary,nil)}
if r != errSecSuccess{FileHandle.standardError.write(Data("keychain_status=\\(r)\\n".utf8));exit(1)}`;

export interface TelegramSetupInput {
  readonly token: string;
  readonly projectRoot: string;
  readonly pairedChatId?: string | null;
  readonly pairedUserId?: string | null;
  readonly resetSession?: boolean;
  readonly globalRoot?: string;
  readonly api?: TelegramBotApiClient;
  readonly keychainWriter?: (token: string, service: string, account: string) => Promise<void>;
  readonly keychainReader?: (service: string, account: string) => Promise<string | null>;
  readonly keychainDeleter?: (service: string, account: string) => Promise<void>;
  readonly hostname?: string;
  readonly account?: string;
}

export interface TelegramSetupResult {
  readonly schema: 'sks.telegram-setup.v1';
  readonly ok: true;
  readonly bot: {
    readonly id: string | null;
    readonly username: string | null;
  };
  readonly pairing: {
    readonly chat_id: string;
    readonly user_id: string;
    readonly detected: boolean;
  };
  readonly machine_id: string;
  readonly project_id: string;
  readonly project_root: string;
  readonly session_id: string;
  readonly codex_thread_id: string | null;
  readonly codex_thread_state: 'pending_first_turn' | 'ready';
  readonly token_storage: 'macos-keychain';
  readonly config_path: string;
  readonly machine_registry_path: string;
  readonly session_index_path: string;
}

export async function setupTelegramLocalCoding(input: TelegramSetupInput): Promise<TelegramSetupResult> {
  const token = validateTelegramBotToken(input.token.trim());
  const explicitPair = normalizeExplicitPair(input.pairedChatId, input.pairedUserId);
  const projectRoot = await canonicalProjectRoot(input.projectRoot);
  const rootIssue = validateAllowedRoot(projectRoot);
  if (rootIssue) throw new Error(`telegram_project_root_invalid:${rootIssue}`);
  const globalRoot = path.resolve(input.globalRoot ?? globalSksRoot());
  const setupOwner = new TelegramOwnerLock({
    lockPath: telegramHubPaths(globalRoot).owner,
    tokenFingerprint: telegramTokenFingerprint(token)
  });
  try {
    await setupOwner.acquire();
  } catch (error: unknown) {
    if (error instanceof TelegramOwnerConflictError) {
      throw new Error('telegram_hub_must_be_stopped_before_setup');
    }
    throw error;
  }
  try {
    return await setupTelegramLocalCodingLocked(input, token, explicitPair, projectRoot, globalRoot);
  } finally {
    await setupOwner.release();
  }
}

async function setupTelegramLocalCodingLocked(
  input: TelegramSetupInput,
  token: string,
  explicitPair: { readonly chatId: string; readonly userId: string } | null,
  projectRoot: string,
  globalRoot: string
): Promise<TelegramSetupResult> {
  const api = input.api ?? new TelegramBotApiClient(token, { timeoutMs: 12_000, maxRetries: 0 });
  const readiness = await probeTelegramBotReadiness(api).catch(throwTelegramSetupApiError);
  if (readiness.webhook_configured) {
    throw new Error('telegram_webhook_conflict:remove_webhook_before_long_polling');
  }
  const detectedPair = explicitPair === null
    ? await detectPrivateStart(api, readiness.bot.username, false).catch(throwTelegramSetupApiError)
    : null;
  const pairing = explicitPair ?? detectedPair!;
  const account = input.account?.trim() || process.env.USER || os.userInfo().username || 'sks';
  const hostname = input.hostname ?? os.hostname();
  const machineId = `local-${sha256(hostname).slice(0, 12)}`;
  const projectId = `project-${sha256(projectRoot).slice(0, 12)}`;
  const sessionId = `telegram-${sha256(`${machineId}:${projectId}`).slice(0, 12)}`;
  const bindingPath = remoteCodexSessionBindingsPath(projectRoot);
  const machinePath = remoteMachineRegistryPath(globalRoot);
  const indexPath = remoteSessionIndexPath(projectRoot);
  const configPath = telegramHubPaths(globalRoot).config;
  const stateSnapshots = await Promise.all([
    snapshotSetupFile(bindingPath),
    snapshotSetupFile(machinePath),
    snapshotSetupFile(indexPath),
    snapshotSetupFile(configPath)
  ]);
  const keychainWriter = input.keychainWriter ?? writeTelegramKeychain;
  const keychainReader = input.keychainReader
    ?? (input.keychainWriter ? async () => null : readTelegramKeychain);
  const keychainDeleter = input.keychainDeleter
    ?? (input.keychainWriter
      ? async () => { throw new Error('telegram_keychain_rollback_unavailable'); }
      : deleteTelegramKeychain);
  const previousToken = await keychainReader(KEYCHAIN_SERVICE, account);
  const bindingStore = new RemoteCodexSessionBindingStore(bindingPath);
  const existingBinding = await bindingStore.find(sessionId);
  let credentialWriteAttempted = false;
  try {
    credentialWriteAttempted = true;
    await keychainWriter(token, KEYCHAIN_SERVICE, account);
    const binding: RemoteCodexSessionBindingV1 = existingBinding && input.resetSession !== true
      ? existingBinding
      : await bindingStore.upsert({
          session_id: sessionId,
          machine_id: machineId,
          project_id: projectId,
          project_root: projectRoot,
          codex_thread_id: null,
          last_turn_id: null,
          last_turn_status: null
        });

    const registry = await upsertLocalMachine(machinePath, {
      id: machineId,
      display_name: `This Mac (${hostname})`.slice(0, 120),
      transport: 'local',
      allowed_roots: [projectRoot],
      enabled: true
    });
    await upsertLocalTarget(indexPath, registry, {
      machine_id: machineId,
      project_id: projectId,
      project_root: projectRoot
    });

    const config: TelegramHubConfigV1 = {
      schema: 'sks.telegram-config.v1',
      bot_token_ref: { type: 'keychain', service: KEYCHAIN_SERVICE, account },
      paired_chat_ids: [pairing.chatId],
      paired_user_ids: [pairing.userId],
      long_poll_timeout_sec: 25,
      owner_stale_ms: 60_000,
      protect_content: true,
      silent_notifications: false
    };
    await writeJsonAtomic(configPath, config);
    if (detectedPair) {
      await acknowledgePrivateStart(api, detectedPair.updateId).catch(throwTelegramSetupApiError);
    }

    return {
      schema: 'sks.telegram-setup.v1',
      ok: true,
      bot: readiness.bot,
      pairing: {
        chat_id: pairing.chatId,
        user_id: pairing.userId,
        detected: explicitPair === null
      },
      machine_id: machineId,
      project_id: projectId,
      project_root: projectRoot,
      session_id: sessionId,
      codex_thread_id: binding.codex_thread_id,
      codex_thread_state: binding.codex_thread_id ? 'ready' : 'pending_first_turn',
      token_storage: 'macos-keychain',
      config_path: configPath,
      machine_registry_path: machinePath,
      session_index_path: indexPath
    };
  } catch (error: unknown) {
    const rollbackErrors: string[] = [];
    for (const snapshot of [...stateSnapshots].reverse()) {
      await restoreSetupFile(snapshot).catch((rollbackError: unknown) => {
        rollbackErrors.push(publicSetupError(rollbackError));
      });
    }
    if (credentialWriteAttempted) {
      const restoreCredential = previousToken === null
        ? keychainDeleter(KEYCHAIN_SERVICE, account)
        : keychainWriter(previousToken, KEYCHAIN_SERVICE, account);
      await restoreCredential.catch((rollbackError: unknown) => {
        rollbackErrors.push(publicSetupError(rollbackError));
      });
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`telegram_setup_rollback_failed:${publicSetupError(error)}:${rollbackErrors.join(',')}`);
    }
    throw error;
  }
}

export async function detectPrivateStart(
  api: Pick<TelegramBotApiClient, 'getUpdates'>,
  botUsername: string | null = null,
  consume = true
): Promise<{
  readonly chatId: string;
  readonly userId: string;
  readonly updateId: number;
}> {
  const updates = await api.getUpdates({ timeout: 0, allowed_updates: ['message'] });
  const candidates = updates.filter((update) => isPrivateStart(update, botUsername));
  const identities = new Set(candidates.map((update) => (
    `${String(update.message!.chat.id)}:${String(update.message!.from!.id)}`
  )));
  if (identities.size > 1) {
    throw new Error('telegram_pairing_ambiguous:retry_with_explicit_private_chat_and_user_ids');
  }
  const match = candidates.at(-1);
  if (!match?.message?.from) {
    throw new Error('telegram_pairing_start_not_found:send_/start_to_the_bot_then_retry');
  }
  if (consume) await acknowledgePrivateStart(api, match.update_id);
  return {
    chatId: String(match.message.chat.id),
    userId: String(match.message.from.id),
    updateId: match.update_id
  };
}

async function acknowledgePrivateStart(api: Pick<TelegramBotApiClient, 'getUpdates'>, updateId: number): Promise<void> {
  await api.getUpdates({
    offset: updateId + 1,
    timeout: 0,
    allowed_updates: ['message']
  });
}

export async function writeTelegramKeychain(token: string, service: string, account: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('telegram_keychain_requires_macos');
  const swift = await which('swift').catch(() => null) || '/usr/bin/swift';
  const result = await runProcess(swift, ['-e', KEYCHAIN_WRITER_SWIFT, account, service], {
    input: `${token}\n`,
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024
  });
  if (result.code !== 0 || result.timedOut) throw new Error('telegram_keychain_store_failed');
}

export async function readTelegramKeychain(service: string, account: string): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('telegram_keychain_requires_macos');
  const result = await runProcess('/usr/bin/security', [
    'find-generic-password', '-w', '-s', service, '-a', account
  ], { timeoutMs: 5_000, maxOutputBytes: 8 * 1024 });
  if (result.code === 44) return null;
  if (result.code !== 0 || result.timedOut) throw new Error('telegram_keychain_snapshot_failed');
  return validateTelegramBotToken(result.stdout.trim());
}

export async function deleteTelegramKeychain(service: string, account: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('telegram_keychain_requires_macos');
  const result = await runProcess('/usr/bin/security', [
    'delete-generic-password', '-s', service, '-a', account
  ], { timeoutMs: 5_000, maxOutputBytes: 8 * 1024 });
  if (result.code !== 0 && result.code !== 44) throw new Error('telegram_keychain_delete_failed');
  if (result.timedOut) throw new Error('telegram_keychain_delete_failed');
}

interface TelegramSetupFileSnapshot {
  readonly file: string;
  readonly contents: Buffer | null;
  readonly mode: number | null;
}

async function snapshotSetupFile(file: string): Promise<TelegramSetupFileSnapshot> {
  const stat = await fsp.lstat(file).catch((error: unknown) => {
    if (errorCodeOf(error) === 'ENOENT') return null;
    throw error;
  });
  if (stat === null) return { file, contents: null, mode: null };
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('telegram_setup_state_snapshot_invalid');
  return {
    file,
    contents: await fsp.readFile(file),
    mode: stat.mode & 0o777
  };
}

async function restoreSetupFile(snapshot: TelegramSetupFileSnapshot): Promise<void> {
  if (snapshot.contents === null) {
    await fsp.unlink(snapshot.file).catch((error: unknown) => {
      if (errorCodeOf(error) !== 'ENOENT') throw error;
    });
    return;
  }
  await writeBinaryAtomic(snapshot.file, snapshot.contents, {
    ...(snapshot.mode === null ? {} : { mode: snapshot.mode })
  });
}

function publicSetupError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/(?:\/Users|\/home)\/[^\s]+/g, '[path-redacted]')
    .replace(/[:,]+/g, '_')
    .slice(0, 160);
}

async function upsertLocalMachine(file: string, machine: RemoteMachineV1): Promise<RemoteMachineRegistryV1> {
  await ensureDir(path.dirname(file));
  const raw = await readJson<unknown>(file, null);
  let registry: RemoteMachineRegistryV1;
  if (raw === null) {
    registry = { schema: REMOTE_MACHINE_REGISTRY_SCHEMA, machines: [] };
  } else {
    const validated = validateRemoteMachineRegistry(raw);
    if (!validated.ok || !validated.registry) {
      throw new Error(`remote_machine_registry_invalid:${validated.issues.join(',')}`);
    }
    registry = validated.registry;
  }
  const machines = [...registry.machines];
  const index = machines.findIndex((candidate) => candidate.id === machine.id);
  if (index >= 0) {
    const current = machines[index]!;
    if (current.transport !== 'local') throw new Error('remote_local_machine_id_conflict');
    machines[index] = {
      ...machine,
      allowed_roots: [...new Set([...current.allowed_roots, ...machine.allowed_roots])]
    };
  }
  else machines.push(machine);
  const next = { schema: REMOTE_MACHINE_REGISTRY_SCHEMA, machines } satisfies RemoteMachineRegistryV1;
  const validation = validateRemoteMachineRegistry(next);
  if (!validation.ok || !validation.registry) throw new Error(`remote_machine_registry_invalid:${validation.issues.join(',')}`);
  await writeJsonAtomic(file, validation.registry);
  return validation.registry;
}

async function upsertLocalTarget(
  file: string,
  registry: RemoteMachineRegistryV1,
  target: RemoteSessionIndexV1['targets'][number]
): Promise<RemoteSessionIndexV1> {
  await ensureDir(path.dirname(file));
  const raw = await readJson<unknown>(file, null);
  let index: RemoteSessionIndexV1;
  if (raw === null) {
    index = { schema: REMOTE_SESSION_INDEX_SCHEMA, targets: [] };
  } else {
    const validated = validateRemoteSessionIndex(raw, registry);
    if (!validated.ok || !validated.index) {
      throw new Error(`remote_session_index_invalid:${validated.issues.join(',')}`);
    }
    index = validated.index;
  }
  const targets = [...index.targets];
  const found = targets.findIndex((candidate) => candidate.machine_id === target.machine_id && candidate.project_id === target.project_id);
  if (found >= 0) targets[found] = target;
  else targets.push(target);
  const next = { schema: REMOTE_SESSION_INDEX_SCHEMA, targets } satisfies RemoteSessionIndexV1;
  const validation = validateRemoteSessionIndex(next, registry);
  if (!validation.ok || !validation.index) throw new Error(`remote_session_index_invalid:${validation.issues.join(',')}`);
  await writeJsonAtomic(file, validation.index);
  return validation.index;
}

async function canonicalProjectRoot(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error('telegram_project_root_must_be_absolute');
  const fsp = await import('node:fs/promises');
  const resolved = await fsp.realpath(path.resolve(value)).catch(() => null);
  if (!resolved) throw new Error('telegram_project_root_unreadable');
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('telegram_project_root_not_directory');
  return resolved;
}

function normalizeExplicitPair(chatId: string | null | undefined, userId: string | null | undefined): {
  readonly chatId: string;
  readonly userId: string;
} | null {
  const chat = String(chatId ?? '').trim();
  const user = String(userId ?? '').trim();
  if (!chat && !user) return null;
  if (!isPositiveTelegramId(chat) || !isPositiveTelegramId(user)) {
    throw new Error('telegram_pairing_ids_must_be_positive_private_ids');
  }
  return { chatId: chat, userId: user };
}

function isPrivateStart(update: TelegramUpdate, botUsername: string | null): boolean {
  const message = update.message;
  if (!message || message.chat.type !== 'private' || !message.from) return false;
  const command = /^\/start(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(String(message.text || '').trim());
  if (!command) return false;
  const addressedBot = command[1];
  return !addressedBot || (botUsername !== null && addressedBot.toLowerCase() === botUsername.toLowerCase());
}

function throwTelegramSetupApiError(error: unknown): never {
  if (error instanceof TelegramBotApiError && (error.errorCode === 401 || error.errorCode === 404)) {
    throw new Error('telegram_bot_auth_failed');
  }
  if (error instanceof TelegramBotApiError && error.errorCode === 409) {
    throw new Error('telegram_409_conflict:stop_other_poller_and_retry');
  }
  throw error;
}

export function telegramSetupKeychainReference(account = process.env.USER || os.userInfo().username || 'sks') {
  return { type: 'keychain' as const, service: KEYCHAIN_SERVICE, account };
}

export function telegramSetupTimestamp(): string {
  return nowIso();
}
