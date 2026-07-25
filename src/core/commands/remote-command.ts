import path from 'node:path';
import { isHelpRequest } from '../../cli/help.js';
import { globalSksRoot, projectRoot, readJson, sha256 } from '../fsx.js';
import {
  findRemoteMachine,
  loadRemoteMachineRegistry,
  remoteMachineRegistryPath,
  remoteReadiness,
  RemoteWorker,
  resolveAllowedProjectRoot,
  runRemoteWorkerJsonl,
  selectWorkerMachine,
  validateRemoteMachineRegistry
} from '../remote/index.js';

export async function remoteCommand(args: string[] = []): Promise<unknown> {
  if (isHelpRequest(args)) {
    printRemoteUsage();
    return { schema: 'sks.remote-command.v1', ok: true, action: 'help' };
  }
  const action = args[0] ?? 'readiness';
  const rest = args.slice(1);
  const json = args.includes('--json');
  try {
    if (action === 'readiness') return await readiness(rest, json);
    if (action === 'machines' || action === 'machine') return await machines(rest, json);
    if (action === 'worker') return await worker(rest, json);
    return fail('unknown_action', ['readiness', 'machines list', 'machines validate', 'worker --stdio'], json);
  } catch (err: unknown) {
    process.exitCode = 1;
    return print({
      schema: 'sks.remote-command-error.v1',
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }, json);
  }
}

async function readiness(args: readonly string[], json: boolean): Promise<unknown> {
  const root = path.resolve(readOption(args, '--root') ?? readOption(args, '--project-root') ?? await projectRoot());
  const machineId = readOption(args, '--machine');
  const configPath = configFile(args);
  const machine = machineId ? findRemoteMachine(await loadRemoteMachineRegistry(configPath), machineId) : null;
  return print(await remoteReadiness({ root, machine }), json);
}

async function machines(args: readonly string[], json: boolean): Promise<unknown> {
  const subcommand = args[0] ?? 'list';
  const configPath = configFile(args);
  const raw = await readJson<unknown>(configPath, null);
  const validation = validateRemoteMachineRegistry(raw);
  if (subcommand === 'validate') {
    if (!validation.ok) process.exitCode = 1;
    return print({
      schema: 'sks.remote-machine-validation.v1',
      ok: validation.ok,
      config_path: configPath,
      issues: validation.issues,
      machine_count: validation.registry?.machines.length ?? 0
    }, json);
  }
  if (subcommand === 'list') {
    if (!validation.ok || !validation.registry) throw new Error(`remote_machine_registry_invalid:${validation.issues.join(',')}`);
    return print({
      schema: 'sks.remote-machine-list.v1',
      ok: true,
      machines: validation.registry.machines.map((machine) => ({
        id: machine.id,
        display_name: machine.display_name,
        transport: machine.transport,
        ssh_alias: machine.ssh_alias,
        allowed_roots: machine.allowed_roots,
        enabled: machine.enabled
      }))
    }, json);
  }
  return fail('unknown_machine_action', ['list', 'validate'], json);
}

async function worker(args: readonly string[], json: boolean): Promise<unknown> {
  if (!args.includes('--stdio')) return fail('worker_stdio_required', ['worker --stdio'], json);
  const configPath = configFile(args);
  const registry = await loadRemoteMachineRegistry(configPath);
  const machine = selectWorkerMachine(registry, readOption(args, '--machine'));
  const root = path.resolve(readOption(args, '--project-root') ?? await projectRoot());
  const resolvedRoot = await resolveAllowedProjectRoot(machine, root);
  const projectId = readOption(args, '--project-id') ?? `project-${sha256(resolvedRoot).slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(projectId)) throw new Error('remote_project_id_invalid');
  const runtime = new RemoteWorker({ root: resolvedRoot, machine, projectId });
  await runRemoteWorkerJsonl({
    input: process.stdin,
    output: process.stdout,
    handle: (request) => runtime.handle(request)
  });
  return { schema: 'sks.remote-worker-exit.v1', ok: true };
}

function configFile(args: readonly string[]): string {
  return path.resolve(readOption(args, '--config') ?? remoteMachineRegistryPath(globalSksRoot()));
}

function readOption(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : null;
}

function printRemoteUsage(): void {
  console.log(`SKS Remote — local machine registry and worker transport

Usage:
  sks remote readiness [--json]
  sks remote machines list [--json]
  sks remote machines validate [--json]
  sks remote worker --stdio

The machine registry and session targets are written by \`sks telegram setup\`;
see docs/telegram-and-center.md for the end-to-end pairing flow.
`);
}

function fail(error: string, supported: readonly string[], json: boolean): unknown {
  process.exitCode = 2;
  return print({ schema: 'sks.remote-command.v1', ok: false, error, supported }, json);
}

function print(value: unknown, _json: boolean): unknown {
  console.log(JSON.stringify(value, null, 2));
  return value;
}
