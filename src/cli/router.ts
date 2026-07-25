import {
  COMMAND_ALIASES_LITE,
  COMMAND_MANIFEST_BY_NAME,
  COMMAND_NAME_SET,
  type CommandNameLite,
} from './command-manifest-lite.js';
import { helpResult, isHelpRequest, renderManifestHelp } from './help.js';
import { findRetiredGlobalExecutionArgumentErrors } from './global-mode-router.js';

export interface NormalizedCommand {
  command: CommandNameLite | null;
  rawCommand: string | null;
  aliasTarget: CommandNameLite | null;
  args: string[];
}

export interface UnknownCommandResult {
  ok: false;
  status: 'blocked';
  command: string;
  reason: 'unknown_command';
}

export function isCommandName(value: string): value is CommandNameLite {
  return COMMAND_NAME_SET.has(value);
}

export function normalizeCommand(args: readonly string[] = []): NormalizedCommand {
  const cmd = args[0];
  if (!cmd) return { command: null, rawCommand: null, aliasTarget: null, args: [...args] };
  const mapped: string =
    cmd in COMMAND_ALIASES_LITE ? COMMAND_ALIASES_LITE[cmd as keyof typeof COMMAND_ALIASES_LITE] : cmd;
  const rest = args.slice(1);
  const command = isCommandName(mapped) ? mapped : null;
  return {
    command,
    rawCommand: cmd,
    aliasTarget: command && mapped !== cmd ? command : null,
    args: rest,
  };
}

export async function dispatch(args?: readonly string[]): Promise<unknown> {
  const argv = args ?? process.argv.slice(2);
  try {
    return await dispatchInner(argv);
  } catch (err: unknown) {
    // Final choke point: any uncaught bug anywhere in the dispatch chain (gate
    // checks, lazy command import, command run()) must never leak a raw stack
    // dump to the user as their "answer" — convert it to a structured, honest
    // failure instead. Every existing explicit error path above already sets
    // process.exitCode and returns normally (never throws), so this only ever
    // catches genuinely unexpected exceptions; it changes nothing about those
    // paths' exit codes or messages.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    else process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    const result = { ok: false, error: message, command: normalizeCommand(argv).rawCommand };
    // A --json caller depends on stdout always being exactly one JSON result
    // (this is the same non-interactive contract SKS_AGENT_MODE promises) — an
    // uncaught crash must not leave stdout empty, or a JSON.parse on the
    // consuming end breaks with no diagnosable output at all.
    if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    return result;
  }
}

async function dispatchInner(argv: readonly string[]): Promise<unknown> {
  const retiredGlm = findRetiredGlobalExecutionArgumentErrors(argv).filter((item) => item.includes('--glm'));
  if (retiredGlm.length && argv.some((arg) => arg === '--glm' || String(arg).startsWith('--glm='))) {
    const hint = 'GLM MAD CLI was removed. Use SKS Center Providers or: sks codex-app use-openrouter --model <id>';
    console.error(hint);
    process.exitCode = 1;
    const result = {
      ok: false,
      status: 'blocked',
      mode: 'glm',
      reason: 'glm_mad_removed',
      hint,
      blockers: retiredGlm
    };
    if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const { command, rawCommand, args: rest } = normalizeCommand(argv);
  if (!command) {
    if (!argv.length) {
      const mod = await import('../commands/doctor.js');
      return mod.run('doctor', []);
    }
    const raw = argv[0] ?? '';
    console.error(`Unknown command: ${raw}`);
    process.exitCode = 1;
    const result: UnknownCommandResult = {
      ok: false,
      status: 'blocked',
      command: raw,
      reason: 'unknown_command',
    };
    if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const entry = COMMAND_MANIFEST_BY_NAME[command];
  const helpRequest = isHelpRequest(rest);
  if (!helpRequest) {
    const commandGate = await ensureActiveRouteCommandGate(command, rest);
    if (!commandGate.ok) {
      if ('command_result' in commandGate && commandGate.command_result) {
        process.exitCode = 1;
        if (argv.includes('--json')) console.log(JSON.stringify(commandGate.command_result, null, 2));
        else printHandledCommandBlock(commandGate.command_result);
        return commandGate.command_result;
      }
      if (argv.includes('--json')) console.log(JSON.stringify(commandGate, null, 2));
      console.error(commandGate.message);
      process.exitCode = 1;
      return commandGate;
    }
    // 20차 P2-2: --help/-h/help must never wait on (or be blocked by) the
    // migration gate's lock — a stuck/contended migration lock previously
    // made `sks <cmd> --help` take the full MIGRATION_LOCK_WAIT_MS (20s) and
    // then fail, for a request that only wants usage text.
    const { ensureCurrentMigrationBeforeCommand } = await import('../core/update/update-migration-state.js');
    const migrationGate = await ensureCurrentMigrationBeforeCommand({
      command,
      args: rest,
      skipMigrationGate: entry.skipMigrationGate === true
        || entry.readonly === true
        || safeReadOnlySubcommand(command, rest)
        || safeActiveRouteVisualQuery(command, rest)
    });
    if (!migrationGate.ok) {
      console.error('SKS project migration blocked.');
      console.error(`Scope: ${migrationGate.scope || 'project'}`);
      console.error(`Stage: ${migrationGate.failed_stage_id || migrationGate.status}`);
      if (migrationGate.failed_stage_id) console.error(`Failed stage: ${migrationGate.failed_stage_id}`);
      for (const blocker of migrationGate.blockers) console.error(`Required blocker: ${blocker}`);
      for (const warning of migrationGate.warnings) console.error(`Optional warning: ${warning}`);
      console.error(`Receipt: ${migrationGate.receipt_path}`);
      console.error('Remedies: run `sks doctor --fix --yes`, then retry; diagnostics that must bypass this gate are marked skipMigrationGate in the command registry.');
      if (argv.includes('--json')) console.log(JSON.stringify(migrationGate, null, 2));
      process.exitCode = 1;
      return migrationGate;
    }
  }
  const { COMMANDS } = await import('./command-registry.js');
  const commandEntry = COMMANDS[command as keyof typeof COMMANDS];
  const mod = await commandEntry.lazy();
  // Usage is answered here, before dispatch. Leaving it to each command module
  // meant a module that never learned to recognise `--help` ran its real work
  // instead — `sks commit-and-push --help` performed an actual commit and push.
  // A command opts into richer text by exporting `usage()`; everything else
  // gets the manifest-derived floor.
  if (helpRequest) {
    console.log(typeof mod.usage === 'function'
      ? mod.usage(rawCommand || command)
      : renderManifestHelp(command, entry));
    return helpResult(command);
  }
  if (typeof mod.run !== 'function') throw new Error(`Command ${command} must export run(command, args)`);
  return mod.run(rawCommand || command, rest);
}

async function ensureActiveRouteCommandGate(command: CommandNameLite, args: readonly string[]) {
  const entry = COMMAND_MANIFEST_BY_NAME[command];
  if (command === 'route' || entry.readonly === true || entry.allowedDuringActiveRoute === true && entry.mutatesRouteState !== true) {
    return { ok: true, status: 'allowed' };
  }
  if (entry.mutatesRouteState !== true) return { ok: true, status: 'allowed' };
  if (safeReadOnlySubcommand(command, args)) return { ok: true, status: 'allowed_status_subcommand' };
  if (safeActiveRouteVisualQuery(command, args)) return { ok: true, status: 'allowed_visual_query' };
  const [{ projectRoot, readJson }, { stateFile }] = await Promise.all([
    import('../core/fsx.js'),
    import('../core/mission.js')
  ]);
  const root = await projectRoot(process.cwd()).catch(() => process.cwd());
  const state = await readJson(stateFile(root), {}).catch(() => ({}));
  if (safeActiveRouteContinuation(command, args, state)) return { ok: true, status: 'allowed_active_route_continuation' };
  if (!activeRouteStateBlocksCommand(state)) return { ok: true, status: 'allowed' };
  const visualPreflight = await blockedVisualSourcePreflight(command, args);
  if (visualPreflight) {
    return {
      ok: false,
      status: 'handled_non_mutating_visual_preflight',
      command_result: visualPreflight
    };
  }
  return {
    schema: 'sks.command-gate-active-route.v1',
    ok: false,
    status: 'blocked',
    command,
    active_mission_id: state.mission_id || null,
    active_route: state.route || state.route_command || state.mode || null,
    active_phase: state.phase || null,
    message: `SKS command gate blocked '${command}' because active route mission ${state.mission_id} is not closed. Run: sks route close --mission ${state.mission_id}`
  };
}

function safeActiveRouteVisualQuery(command: CommandNameLite, args: readonly string[]) {
  if (command !== 'computer-use') return false;
  const sub = String(args.find((arg) => !String(arg).startsWith('-')) || '').toLowerCase();
  if (sub !== 'require') return false;
  return !args.some((arg) => ['--fix', '--yes', '-y', '--write', '--apply', '--execute', '--force', '--real'].includes(String(arg)));
}

async function blockedVisualSourcePreflight(command: CommandNameLite, args: readonly string[]) {
  if (command !== 'image-ux-review' || String(args[0] || '').toLowerCase() !== 'run') return null;
  if (!args.includes('--from-chrome-extension') && !args.includes('--from-computer-use')) return null;
  const { imageUxReviewSourcePreflight } = await import('../core/commands/image-ux-review-command.js');
  const preflight = await imageUxReviewSourcePreflight([...args.slice(1)]);
  return preflight.result;
}

function printHandledCommandBlock(result: any) {
  console.error(`SKS command blocked: ${result?.blocker || result?.status || 'preflight_failed'}`);
  for (const line of Array.isArray(result?.guidance) ? result.guidance : []) console.error(`- ${line}`);
}

export function safeReadOnlySubcommand(command: CommandNameLite, args: readonly string[]) {
  const sub = String(args[0] || '').toLowerCase();
  const nested = String(args[1] || '').toLowerCase();
  if (command === 'naruto' && ['status', 'subagents', 'proof'].includes(sub)) {
    return !args.some((arg) => ['--fix', '--yes', '-y', '--write', '--apply', '--execute', '--force', '--real'].includes(String(arg)));
  }
  // SKS Center probes use nested read paths (`mcp config list|test|backups`,
  // `remote readiness`). Treat those as migration-safe so a blocked project
  // receipt cannot blank Overview / MCP / Remote pages.
  if (command === 'mcp' && sub === 'config' && ['list', 'test', 'backups', 'show'].includes(nested)) {
    return !args.some((arg) => ['--fix', '--yes', '-y', '--write', '--apply', '--execute', '--force', '--real'].includes(String(arg)));
  }
  if (command === 'remote' && ['readiness', 'status', 'show'].includes(sub)) {
    return !args.some((arg) => ['--fix', '--yes', '-y', '--write', '--apply', '--execute', '--force', '--real'].includes(String(arg)));
  }
  // `remote machines list|validate` only reads and validates the machine registry.
  if (command === 'remote' && ['machines', 'machine'].includes(sub) && ['list', 'validate'].includes(nested)) {
    return !args.some((arg) => ['--fix', '--yes', '-y', '--write', '--apply', '--execute', '--force', '--real'].includes(String(arg)));
  }
  // Telegram diagnostics must stay reachable while a project migration is blocked:
  // these are exactly the commands an operator runs to find out why pairing is
  // broken, and `validate-config` / `hub status` only read config and launchctl
  // state. Blocking them turns a blocked migration into an undiagnosable one.
  // `hub` with no explicit action defaults to `run`, which starts the hub, so only
  // the literal `hub status` qualifies here.
  if (command === 'telegram' && (sub === 'validate-config' || (sub === 'hub' && nested === 'status'))) {
    return !args.some((arg) => ['--fix', '--yes', '-y', '--write', '--apply', '--execute', '--force', '--real'].includes(String(arg)));
  }
  if (!['status', 'show', 'list', 'observe', 'watch', 'doctor', 'help'].includes(sub)) return false;
  return !args.some((arg) => ['--fix', '--yes', '-y', '--write', '--apply', '--execute', '--force', '--real'].includes(String(arg)));
}

export function safeActiveRouteContinuation(command: CommandNameLite, args: readonly string[], state: any = {}) {
  const subcommand = String(args[0] || '').toLowerCase();
  const activeRoute = String(state.route || state.route_command || state.mode || '').replace(/^\$/, '').replace(/[-_]/g, '').toUpperCase();
  if (command === 'naruto') {
    if (activeRoute !== 'NARUTO' || subcommand !== 'run') return false;
    const requestedMission = optionValue(args, ['--mission', '--mission-id']);
    return Boolean(state.mission_id)
      && (requestedMission === String(state.mission_id) || requestedMission === 'latest');
  }
  const expectedRoutes = new Map<CommandNameLite, readonly string[]>([
    ['research', ['RESEARCH']],
    ['autoresearch', ['AUTORESEARCH', 'RESEARCH']],
    ['qa-loop', ['QALOOP']]
  ]).get(command);
  if (!expectedRoutes) return false;
  if (!expectedRoutes.includes(activeRoute)) return false;
  if (subcommand === 'prepare') {
    const parentMissionId = String(process.env.SKS_RUN_PARENT_MISSION_ID || '').trim();
    return command !== 'autoresearch'
      && String(state.mode || '').toUpperCase() === 'RUN'
      && String(state.phase || '').toUpperCase() === 'RUN_ROUTE_SELECTED'
      && Boolean(parentMissionId)
      && parentMissionId === String(state.mission_id || '');
  }
  if (subcommand !== 'run') return false;
  const requestedMission = String(args[1] || '').trim();
  return Boolean(state.mission_id) && (requestedMission === String(state.mission_id) || requestedMission === 'latest');
}

function optionValue(args: readonly string[], names: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    for (const name of names) {
      if (arg === name) {
        const next = String(args[index + 1] || '').trim();
        return next && !next.startsWith('-') ? next : '';
      }
      if (arg.startsWith(name + '=')) return arg.slice(name.length + 1).trim();
    }
  }
  return '';
}

function activeRouteStateBlocksCommand(state: any = {}) {
  if (!state?.mission_id || state.route_closed === true) return false;
  const mode = String(state.mode || '').toUpperCase();
  if (!mode || ['WIKI', 'STATUS', 'HELP'].includes(mode)) return false;
  if (/(?:DONE|COMPLETE|CLOSED|BLOCKED|FAILED)$/i.test(String(state.phase || ''))) return false;
  return Boolean(state.route || state.route_command || ['NARUTO', 'QALOOP', 'RESEARCH', 'LOOP', 'MADSKS', 'GOAL'].includes(mode));
}
