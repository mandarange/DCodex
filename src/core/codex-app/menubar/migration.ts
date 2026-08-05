import os from 'node:os';
import path from 'node:path';
import { nowIso, readText, runProcess, sha256, which, writeTextAtomic } from '../../fsx.js';
import {
  ensureConfinedDirectory,
  inspectConfinedPath,
  removeManagedPathVerified
} from '../../managed-path-safety.js';

const RETIRED_REMOTE_BRIDGE_LABEL = 'com.sneakoscope.telegram-hub';

export interface RetiredRemoteBridgeCleanupResult {
  readonly schema: 'sks.retired-remote-bridge-cleanup.v1';
  readonly ok: boolean;
  readonly status: 'absent' | 'removed' | 'preserved_collision' | 'blocked' | 'not_macos';
  readonly launch_agent_path: string;
  readonly service: string;
  readonly detected: boolean;
  readonly removed: boolean;
  readonly stopped: boolean;
  readonly blockers: string[];
  readonly warnings: string[];
}

export interface RetiredRemoteBridgeBindingCleanupResult {
  readonly schema: 'sks.retired-remote-bridge-bindings-cleanup.v1';
  readonly ok: boolean;
  readonly status: 'absent' | 'no_match' | 'quarantined' | 'preserved_collision' | 'blocked';
  readonly binding_path: string;
  readonly quarantine_path: string | null;
  readonly retired_binding_count: number;
  readonly preserved_binding_count: number;
  readonly blockers: string[];
  readonly warnings: string[];
}

export async function cleanupRetiredRemoteBridgeLaunchAgent(opts: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  uid?: number;
  run?: typeof runProcess;
} = {}): Promise<RetiredRemoteBridgeCleanupResult> {
  const env = opts.env || process.env;
  const home = path.resolve(opts.home || env.HOME || os.homedir());
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const domain = `gui/${uid}`;
  const service = `${domain}/${RETIRED_REMOTE_BRIDGE_LABEL}`;
  const launchAgentPath = path.join(home, 'Library', 'LaunchAgents', `${RETIRED_REMOTE_BRIDGE_LABEL}.plist`);
  const base = {
    schema: 'sks.retired-remote-bridge-cleanup.v1' as const,
    launch_agent_path: launchAgentPath,
    service
  };
  if (process.platform !== 'darwin' && !opts.force) {
    return {
      ...base, ok: true, status: 'not_macos', detected: false, removed: false,
      stopped: false, blockers: [], warnings: []
    };
  }
  if (home === path.parse(home).root) {
    return {
      ...base, ok: false, status: 'blocked', detected: false, removed: false,
      stopped: false, blockers: ['retired_remote_bridge_home_root_refused'], warnings: []
    };
  }

  const launchctl = env.SKS_MENUBAR_LAUNCHCTL
    || await which('launchctl').catch(() => null)
    || '/bin/launchctl';
  const run = opts.run || runProcess;
  const inspected = await inspectConfinedPath(home, launchAgentPath).catch(() => null);
  if (!inspected) {
    return {
      ...base, ok: false, status: 'blocked', detected: true, removed: false,
      stopped: false, blockers: ['retired_remote_bridge_path_inspection_failed'], warnings: []
    };
  }
  if (inspected.exists && (inspected.leafSymlink || !inspected.stat?.isFile())) {
    return {
      ...base, ok: true, status: 'preserved_collision', detected: true, removed: false,
      stopped: false, blockers: [], warnings: ['retired_remote_bridge_unmanaged_path_preserved']
    };
  }

  const source = inspected.exists ? await readText(launchAgentPath, '') : '';
  if (inspected.exists && !isManagedRetiredRemoteBridgeLaunchAgent(source)) {
    return {
      ...base, ok: true, status: 'preserved_collision', detected: true, removed: false,
      stopped: false, blockers: [], warnings: ['retired_remote_bridge_unmanaged_file_preserved']
    };
  }

  const probe = await run(launchctl, ['print', service], {
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024
  }).catch((error: unknown) => processFailure(error));
  const serviceLoaded = probe.code === 0;
  const serviceAbsent = probe.code !== 0 && launchdServiceAbsent(probe);
  if (!serviceLoaded && !serviceAbsent) {
    return {
      ...base, ok: false, status: 'blocked', detected: inspected.exists, removed: false,
      stopped: false, blockers: ['retired_remote_bridge_probe_failed'], warnings: []
    };
  }
  if (!inspected.exists && serviceAbsent) {
    return {
      ...base, ok: true, status: 'absent', detected: false, removed: false,
      stopped: false, blockers: [], warnings: []
    };
  }

  const attempts = serviceLoaded
    ? [await run(launchctl, ['bootout', service], {
        timeoutMs: 5_000,
        maxOutputBytes: 16 * 1024
      }).catch((error: unknown) => processFailure(error))]
    : [];
  // `launchctl print` is the authoritative loaded-state probe for this exact
  // label. On macOS, booting out an existing plist by path after that probe
  // has already proved the service absent can fail with error 5/113. Treating
  // that redundant failure as a stop failure prevents removal of the verified
  // retired plist and blocks every later Menu Bar repair.
  if (serviceLoaded && inspected.exists) {
    attempts.push(await run(launchctl, ['bootout', domain, launchAgentPath], {
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024
    }).catch((error: unknown) => processFailure(error)));
  }
  const stopped = attempts.some((result) => result.code === 0);
  const alreadyAbsent = attempts.length === 0
    || attempts.every((result) => result.code !== 0 && launchdServiceAbsent(result));
  if (!stopped && !alreadyAbsent) {
    return {
      ...base, ok: false, status: 'blocked', detected: true, removed: false,
      stopped: false, blockers: ['retired_remote_bridge_bootout_failed'], warnings: []
    };
  }

  try {
    if (inspected.exists) await removeManagedPathVerified(home, launchAgentPath);
  } catch {
    return {
      ...base, ok: false, status: 'blocked', detected: true, removed: false,
      stopped, blockers: ['retired_remote_bridge_plist_remove_failed'], warnings: []
    };
  }
  return {
    ...base, ok: true, status: 'removed', detected: true, removed: inspected.exists,
    stopped, blockers: [], warnings: []
  };
}

export async function quarantineRetiredRemoteBridgeBindings(
  projectRoot: string
): Promise<RetiredRemoteBridgeBindingCleanupResult> {
  const root = path.resolve(projectRoot);
  const bindingPath = path.join(root, '.sneakoscope', 'remote', 'codex-session-bindings.json');
  const base = {
    schema: 'sks.retired-remote-bridge-bindings-cleanup.v1' as const,
    binding_path: bindingPath
  };
  if (root === path.parse(root).root) {
    return {
      ...base, ok: false, status: 'blocked', quarantine_path: null,
      retired_binding_count: 0, preserved_binding_count: 0,
      blockers: ['retired_remote_bridge_project_root_refused'], warnings: []
    };
  }
  const inspected = await inspectConfinedPath(root, bindingPath).catch(() => null);
  if (!inspected) {
    return {
      ...base, ok: false, status: 'blocked', quarantine_path: null,
      retired_binding_count: 0, preserved_binding_count: 0,
      blockers: ['retired_remote_bridge_binding_inspection_failed'], warnings: []
    };
  }
  if (!inspected.exists) {
    return {
      ...base, ok: true, status: 'absent', quarantine_path: null,
      retired_binding_count: 0, preserved_binding_count: 0,
      blockers: [], warnings: []
    };
  }
  if (inspected.leafSymlink || !inspected.stat?.isFile()) {
    return {
      ...base, ok: true, status: 'preserved_collision', quarantine_path: null,
      retired_binding_count: 0, preserved_binding_count: 0,
      blockers: [], warnings: ['retired_remote_bridge_binding_unmanaged_path_preserved']
    };
  }

  const source = await readText(bindingPath, '');
  let document: { schema?: unknown; bindings?: unknown };
  try {
    document = JSON.parse(source) as { schema?: unknown; bindings?: unknown };
  } catch {
    return {
      ...base, ok: true, status: 'preserved_collision', quarantine_path: null,
      retired_binding_count: 0, preserved_binding_count: 0,
      blockers: [], warnings: ['retired_remote_bridge_binding_invalid_json_preserved']
    };
  }
  if (document.schema !== 'sks.remote-codex-session-bindings.v1' || !Array.isArray(document.bindings)) {
    return {
      ...base, ok: true, status: 'preserved_collision', quarantine_path: null,
      retired_binding_count: 0, preserved_binding_count: 0,
      blockers: [], warnings: ['retired_remote_bridge_binding_unmanaged_schema_preserved']
    };
  }
  const retired = document.bindings.filter((row) => isProvableRetiredRemoteBridgeBinding(row, root));
  const preserved = document.bindings.filter((row) => !isProvableRetiredRemoteBridgeBinding(row, root));
  if (retired.length === 0) {
    return {
      ...base, ok: true, status: 'no_match', quarantine_path: null,
      retired_binding_count: 0, preserved_binding_count: preserved.length,
      blockers: [], warnings: []
    };
  }

  const runId = `${Date.now()}-${process.pid}`;
  const quarantineDir = path.join(
    root,
    '.sneakoscope',
    'quarantine',
    'retired-remote-bridge',
    runId
  );
  const quarantinePath = path.join(quarantineDir, 'codex-session-bindings.original.json');
  try {
    await ensureConfinedDirectory(root, quarantineDir);
    await writeTextAtomic(quarantinePath, source, { mode: 0o600 });
    await writeTextAtomic(path.join(quarantineDir, 'receipt.json'), `${JSON.stringify({
      schema: 'sks.retired-remote-bridge-bindings-receipt.v1',
      generated_at: nowIso(),
      source_path: bindingPath,
      source_sha256: sha256(source),
      retired_binding_count: retired.length,
      preserved_binding_count: preserved.length
    }, null, 2)}\n`, { mode: 0o600 });
    if (preserved.length === 0) {
      await removeManagedPathVerified(root, bindingPath);
    } else {
      await writeTextAtomic(bindingPath, `${JSON.stringify({
        schema: 'sks.remote-codex-session-bindings.v1',
        bindings: preserved
      }, null, 2)}\n`, { mode: 0o600 });
    }
  } catch {
    return {
      ...base, ok: false, status: 'blocked', quarantine_path: quarantinePath,
      retired_binding_count: retired.length, preserved_binding_count: preserved.length,
      blockers: ['retired_remote_bridge_binding_quarantine_failed'], warnings: []
    };
  }
  return {
    ...base, ok: true, status: 'quarantined', quarantine_path: quarantinePath,
    retired_binding_count: retired.length, preserved_binding_count: preserved.length,
    blockers: [], warnings: []
  };
}

function isProvableRetiredRemoteBridgeBinding(value: unknown, root: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const machineId = String(row.machine_id || '');
  const projectId = String(row.project_id || '');
  const expectedSessionId = `telegram-${sha256(`${machineId}:${projectId}`).slice(0, 12)}`;
  return /^local-[0-9a-f]{12}$/.test(machineId)
    && /^project-[0-9a-f]{12}$/.test(projectId)
    && row.session_id === expectedSessionId
    && typeof row.project_root === 'string'
    && path.resolve(row.project_root) === root;
}

export function isManagedRetiredRemoteBridgeLaunchAgent(source: string): boolean {
  return /<key>Label<\/key>\s*<string>com\.sneakoscope\.telegram-hub<\/string>/.test(source)
    && /<key>ProgramArguments<\/key>\s*<array>/.test(source)
    && /<string>\/usr\/bin\/caffeinate<\/string>/.test(source)
    && /<string>telegram<\/string>\s*<string>hub<\/string>\s*<string>run<\/string>/.test(source);
}

function processFailure(error: unknown) {
  return {
    code: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    timedOut: false
  };
}

function launchdServiceAbsent(result: {
  code: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}): boolean {
  if (result.timedOut) return false;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /could not find service|no such (?:process|file)|not found|not loaded|does not exist/i.test(output)
    || (result.code === 113 && /\bbad request\b/i.test(output));
}
