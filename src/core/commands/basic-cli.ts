import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMANDS } from '../../cli/command-registry.js';
import { COMMAND_MANIFEST_LITE, type CommandManifestLiteEntry } from '../../cli/command-manifest-lite.js';
import { flag } from '../../cli/args.js';
import { printJson, sksTextLogo } from '../../cli/output.js';
import { ui as cliUi } from '../../cli/cli-theme.js';
import { PACKAGE_VERSION, ensureDir, exists, nowIso, projectRoot, readJson, rmrf, sksRoot, tmpdir, writeJsonAtomic } from '../fsx.js';
import { DOLLAR_COMMANDS, USAGE_TOPICS, routePrompt, routeReasoning, reasoningInstruction, sksPrefixedDollarCommand } from '../routes.js';
import { DOLLAR_COMMAND_ALIASES_LITE, DOLLAR_COMMANDS_LITE } from '../routes/dollar-manifest-lite.js';
import { initProject, normalizeInstallScope, sksCommandPrefix } from '../init.js';
import { buildFeatureRegistry, validateFeatureRegistry } from '../feature-registry.js';
import { runFeatureFixture } from '../feature-fixture-executor.js';
import { hooksExplainReport } from '../../cli/feature-commands.js';
import { writeSelftestRouteProof } from '../proof/selftest-proof-fixtures.js';
import { createMission } from '../mission.js';
import {
  formatSksUpdateStatusText,
  runSksUpdateNow,
  runSksUpdateReview,
  runSksUpdateRollback,
  runSksUpdateStatus
} from '../update-check.js';
import { persistSksUpdateNoticeFromVersions } from '../update/update-notice.js';
import { updateStageFailureDiagnostics } from '../update/update-stage-diagnostics.js';
import { withSecretPreservationGuard } from '../config/config-migration-journal.js';

interface CommandRow {
  name: string;
  usage: string;
  description: string;
  maturity: CommandManifestLiteEntry['maturity'];
}

const REMOVED_USAGE_TOPICS = new Set(['db', 'ui']);

export async function helpCommand(args: string[] = []): Promise<void | unknown> {
  const topic = args[0];
  if (topic) return usageCommand([topic]);
  console.log(`${sksTextLogo()}\n\nUsage\n`);
  console.log('  sks');
  console.log('  sks help [topic]');
  console.log('  sks commands [--json]');
  console.log('  sks dollar-commands [--json]');
  console.log('  sks proof show --json');
  console.log('');
  for (const row of commandRows().filter((entry) => entry.maturity !== 'labs')) {
    console.log(`  ${row.usage.padEnd(58)} ${row.description}`);
  }
  console.log('\nThree core promises: Completion Proof for serious routes, Image Voxel TriWiki for visual routes, and release-gated Codex App/Desktop Bridge/hooks/Rust evidence.');
}

export function commandsCommand(args: string[] = []): unknown {
  const commands = commandRows();
  if (flag(args, '--json')) {
    return printJson({
      schema: 'sks.command-registry.v1',
      aliases: ['sks', 'sneakoscope'],
      commands
    });
  }
  console.log(`${sksTextLogo()}\n\nCommands\n`);
  const width = Math.max(...commands.map((entry) => entry.usage.length));
  for (const entry of commands) console.log(`${entry.usage.padEnd(width)}  ${entry.description}`);
}

export function dollarCommandsCommand(args: any = []) {
  const out = { dollar_commands: DOLLAR_COMMANDS_LITE, app_skill_aliases: DOLLAR_COMMAND_ALIASES_LITE };
  if (flag(args, '--json')) return printJson(out);
  console.log(`${sksTextLogo()}\n\n$ Commands\n`);
  const width = Math.max(...DOLLAR_COMMANDS_LITE.map((entry: any) => entry.command.length));
  for (const entry of DOLLAR_COMMANDS_LITE) console.log(`${entry.command.padEnd(width)}  ${entry.route}: ${entry.description}`);
  console.log(`\nCanonical Codex App picker skills: ${DOLLAR_COMMAND_ALIASES_LITE.map((entry: any) => entry.app_skill).join(', ')}`);
}

export function aliasesCommand() {
  console.log('Aliases');
  console.log('- sks, sneakoscope');
  console.log('- $ aliases:');
  for (const entry of DOLLAR_COMMAND_ALIASES_LITE) console.log(`  ${entry.app_skill} -> ${entry.canonical}`);
}

export function dfixCommand() {
  console.log(`SKS Direct Fix Mode

Prompt command:
  $sks-dfix <tiny direct fix request>

Rules:
  Apply only the requested tiny copy/config/docs/labels/spacing/translation/simple mechanical edit.
  Keep verification cheap and explicit.
  Finish with a DFix completion summary and one Honest check line.`);
}

export function usageCommand(args: any = []) {
  const topic = args[0] || 'overview';
  if (topic === 'overview') {
    console.log(`Usage topics: ${USAGE_TOPICS}`);
    console.log('Try: sks usage goal, sks usage naruto, sks usage image-ux-review');
    return;
  }
  if (topic === 'seo-geo-optimizer') {
    console.log('seo-geo-optimizer\n');
    console.log('Usage: sks seo-geo-optimizer [seo|geo] doctor|audit|plan|apply|verify|status|rollback|fixture [mission|latest] [--mode seo|geo] [--root <path>] [--url <origin>] [--target auto|website|docs|package] [--framework auto|next-app|next-pages|static] [--offline] [--strict] [--json]');
    console.log('       sks seo-geo-optimizer apply <mission|latest> --mode seo|geo --apply [--include-llms-txt] [--scope <rule-or-path,...>] [--yes] [--json]');
    console.log('       sks seo-geo-optimizer rollback <mission|latest> --mode seo|geo --apply [--yes] [--json]');
    console.log('Unified SEO/GEO optimizer audit/plan/apply/verify lifecycle on the search-visibility kernel.');
    return;
  }
  const row = commandRows().find((entry: any) => entry.name === topic);
  if (row) {
    console.log(`${row.name}\n`);
    console.log(`Usage: ${row.usage}`);
    console.log(row.description);
    return;
  }
  const route = REMOVED_USAGE_TOPICS.has(String(topic).toLowerCase())
    ? null
    : DOLLAR_COMMANDS.find((entry: any) => entry.command.toLowerCase() === sksPrefixedDollarCommand(topic).toLowerCase());
  if (route) {
    console.log(`${sksPrefixedDollarCommand(route.command)}\n`);
    console.log(`${route.route}: ${route.description}`);
    return;
  }
  console.log(`Unknown usage topic: ${topic}`);
  console.log(`Known topics: ${USAGE_TOPICS}`);
}

export function quickstartCommand() {
  console.log(`Sneakoscope Codex Quickstart

  sks setup --local-only
  sks doctor
  sks commands
  sks dollar-commands
  sks all-features selftest --mock --execute-fixtures --strict-artifacts --json

For implementation work, use Codex App prompt routes such as $sks-naruto, $sks-goal, $sks-qa-loop, $sks-image-ux-review, and $sks-computer-use.`);
}

export async function updateStatusCommand(args: any = []) {
  const root = await resolveUpdateProjectRoot(args);
  const registry = resolveUpdateRegistry(args);
  const result = await runSksUpdateStatus({
    refresh: flag(args, '--refresh'),
    projectRoot: root,
    ...(registry ? { registry } : {})
  });
  applyUpdateCommandExitCode(result);
  if (flag(args, '--json')) return printJson(result);
  cliUi.banner('update status');
  result.update_count > 0 ? cliUi.warn(`${result.update_count} update action(s) available`) : cliUi.ok('all tracked components are current');
  console.log(`${sksTextLogo()}\n\n${formatSksUpdateStatusText(result)}`);
  return result;
}

export async function updateCheckCommand(args: any = []) {
  return updateStatusCommand(flag(args, '--refresh') ? args : [...args, '--refresh']);
}

export async function updateCommand(sub: any = 'now', args: any = []) {
  let action = String(sub || 'now').toLowerCase();
  let effectiveArgs = args;
  if (action.startsWith('-')) {
    effectiveArgs = [String(sub), ...args];
    action = 'now';
  }
  if (action === 'status') return updateStatusCommand(effectiveArgs);
  if (action === 'check') return updateCheckCommand(effectiveArgs);
  if (!['review', 'now', 'rollback'].includes(action)) {
    console.error('Usage: sks update [status|check|review|now|rollback] [--refresh] [--version <version>] [--project-root <path>] [--registry <url>] [--json] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const root = await resolveUpdateProjectRoot(effectiveArgs);
  const registry = resolveUpdateRegistry(effectiveArgs);
  const version = valueAfter(effectiveArgs, '--version') || valueAfter(effectiveArgs, '-v');
  if (action === 'review') {
    const result = await runSksUpdateReview({
      version,
      projectRoot: root,
      ...(registry ? { registry } : {}),
      json: flag(effectiveArgs, '--json'),
      quiet: flag(effectiveArgs, '--quiet'),
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 128 * 1024
    });
    applyUpdateCommandExitCode(result);
    if (flag(effectiveArgs, '--json')) return printJson(result);
    cliUi.banner('update review');
    result.ok ? cliUi.ok('update plan ready') : cliUi.fail('update plan unavailable');
    console.log(`Current: ${result.current}`);
    console.log(`Target: ${result.target || 'unavailable'}`);
    console.log(`Project root: ${result.project_root}`);
    console.log(`Global root: ${result.global_root || 'unavailable'}`);
    console.log(`Stages: ${result.stages.join(' -> ')}`);
    console.log(`Rollback: ${result.rollback_command}`);
    if (result.error) console.log(`Error: ${result.error}`);
    return result;
  }
  if (action === 'rollback') {
    const result = await withSecretPreservationGuard(root, 'update-rollback', async () => runSksUpdateRollback({
      version: version || '',
      dryRun: flag(effectiveArgs, '--dry-run'),
      projectRoot: root,
      ...(registry ? { registry } : {}),
      json: flag(effectiveArgs, '--json'),
      quiet: flag(effectiveArgs, '--quiet'),
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 128 * 1024
    }));
    if (result.update && !flag(effectiveArgs, '--dry-run')) {
      await persistSksUpdateNoticeFromVersions({
        packageName: result.update.package,
        currentVersion: result.update.new_version || result.update.from,
        latestVersion: result.update.latest,
        error: result.ok ? null : result.error
      }).catch(() => undefined);
    }
    applyUpdateCommandExitCode(result);
    if (flag(effectiveArgs, '--json')) return printJson(result);
    cliUi.banner('update rollback');
    result.ok ? cliUi.ok(result.status) : cliUi.fail(result.status || 'failed');
    console.log(`SKS rollback ${result.status}`);
    console.log(`Requested version: ${result.requested_version || 'invalid'}`);
    if (result.receipt_path) console.log(`Operation receipt: ${result.receipt_path}`);
    if (result.update?.rollback?.command) console.log(`Rollback: ${result.update.rollback.command}`);
    if (result.error) console.log(`Error: ${result.error}`);
    return result;
  }
  const result = await withSecretPreservationGuard(root, 'update-now', async () => runSksUpdateNow({
    version,
    dryRun: flag(effectiveArgs, '--dry-run'),
    projectRoot: root,
    ...(registry ? { registry } : {}),
    json: flag(effectiveArgs, '--json'),
    quiet: flag(effectiveArgs, '--quiet'),
    timeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 128 * 1024
  }));
  if (!flag(effectiveArgs, '--dry-run')) {
    await persistSksUpdateNoticeFromVersions({
      packageName: result.package,
      currentVersion: result.new_version || result.from,
      latestVersion: result.latest,
      error: result.ok ? null : result.error
    }).catch(() => undefined);
  }
  applyUpdateCommandExitCode(result);
  if (flag(effectiveArgs, '--json')) return printJson(result);
  cliUi.banner('update');
  result.ok ? cliUi.ok(result.status) : result.status === 'updated_with_issues' ? cliUi.warn(result.status) : cliUi.fail(result.status || 'failed');
  console.log(`${sksTextLogo()}\n`);
  console.log(`SKS update ${result.status}`);
  if (result.command) console.log(`Command: ${result.command}`);
  if (result.global_root) console.log(`Global root: ${result.global_root}`);
  console.log(`Project root: ${result.project_root}`);
  if (result.new_binary) console.log(`New binary: ${result.new_binary}`);
  if (result.new_version) console.log(`New version: ${result.new_version}`);
  if (result.project_receipt) console.log(`Migration receipt: ${result.project_receipt.root} (${result.migration_current ? 'current' : 'not current'})`);
  if (result.sks_menubar) console.log(`SKS menu bar: ${result.sks_menubar.status}${result.sks_menubar.app_path ? ` (${result.sks_menubar.app_path})` : ''}`);
  if (result.operation_receipt_path) console.log(`Operation receipt: ${result.operation_receipt_path}`);
  if (result.rollback?.command) console.log(`Rollback: ${result.rollback.command}`);
  for (const stage of result.stages || []) console.log(formatSksUpdateStageText(stage, result.project_root));
  if (result.verification?.length) {
    console.log('Self verification:');
    cliUi.table([
      ['check', 'status', 'detail'],
      ...result.verification.map((item) => [item.id, item.ok ? 'ok' : 'failed', item.detail || ''])
    ]);
    const remediation = [...new Set(result.verification.filter((item) => !item.ok).map((item) => item.remediation).filter((value): value is string => Boolean(value)))];
    for (const action of remediation) console.log(`Remediation: ${action}`);
  }
  if (result.error) console.log(`Error: ${result.error}`);
}

export function formatSksUpdateStageText(
  stage: { id: string; ok: boolean; status: string; detail?: Record<string, unknown> },
  projectRoot: string
): string {
  const line = `Stage ${stage.id}: ${stage.ok ? 'ok' : 'failed'} ${stage.status}`;
  const diagnostics = updateStageFailureDiagnostics(stage, projectRoot);
  return diagnostics.length ? `${line} — ${diagnostics.join('; ')}` : line;
}

export function updateCommandResultRequiresFailureExit(result: any): boolean {
  return result?.source === 'error'
    || result?.ok === false
    || result?.status === 'failed'
    || result?.status === 'terminal_uncertain';
}

function applyUpdateCommandExitCode(result: any): void {
  if (updateCommandResultRequiresFailureExit(result)) process.exitCode = 1;
}

export async function setupCommand(args: any = []) {
  if (flag(args, '--help') || flag(args, '-h')) return usageCommand(['setup']);
  const root = await projectRoot();
  const { formatHarnessConflictReport, scanHarnessConflicts } = await import('../harness-conflicts.js');
  const conflictScan = await scanHarnessConflicts(root);
  if (conflictScan.hard_block) {
    const blocked = {
      schema: 'sks.setup.v1',
      ok: false,
      status: 'blocked_harness_conflict',
      root,
      blockers: conflictScan.hard.map((item: any) => `${item.name || 'harness'}:${item.path}`),
      conflicts: conflictScan.conflicts,
      cleanup_prompt_command: 'sks conflicts cleanup --yes'
    };
    process.exitCode = 1;
    if (flag(args, '--json')) {
      printJson(blocked);
      return blocked;
    }
    console.error(formatHarnessConflictReport(conflictScan, { includePrompt: false }));
    console.error('Run `sks conflicts cleanup --yes` to quarantine OMX/DCodex markers before setup.');
    return blocked;
  }
  const installScope = installScopeFromArgs(args);
  let res: any = null;
  let cliTools: any = null;
  await withSecretPreservationGuard(root, 'setup-command', async () => {
    res = await initProject(root, {
      force: flag(args, '--force'),
      installScope,
      localOnly: flag(args, '--local-only'),
      globalCommand: 'sks'
    });
    const { ensureRelatedCliTools } = await import('../../cli/install-helpers.js');
    cliTools = await ensureRelatedCliTools(args);
  });
  const readiness = initProjectInstallReadiness(res);
  const result = {
    schema: 'sks.setup.v1',
    ok: readiness.ok,
    status: readiness.status,
    root,
    install_scope: installScope,
    command_prefix: sksCommandPrefix(installScope, { globalCommand: 'sks' }),
    created: res.created || [],
    local_only: flag(args, '--local-only'),
    cli_tools: cliTools,
    skill_install: res.skill_install,
    blockers: readiness.blockers,
    warnings: readiness.warnings
  };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) {
    printJson(result);
    return result;
  }
  console.log(`${result.ok ? 'Setup complete' : 'Setup blocked'}: ${root}`);
  console.log(`Install scope: ${installScope}`);
  console.log(`Codex CLI: ${cliTools.codex.status}${cliTools.codex.version ? ` ${cliTools.codex.version}` : ''}`);
  for (const file of result.created) console.log(`- ${file}`);
  for (const warning of readiness.warnings) console.log(`Warning: ${warning}`);
  for (const blocker of readiness.blockers) console.error(`Blocker: ${blocker}`);
  return result;
}

export async function bootstrapCommand(args: any = []) {
  if (flag(args, '--help') || flag(args, '-h')) return usageCommand(['bootstrap']);
  return setupCommand(['--local-only', ...args]);
}

export async function initCommand(args: any = []) {
  if (flag(args, '--help') || flag(args, '-h')) return usageCommand(['init']);
  return setupCommand(args);
}

export async function fixPathCommand(args: any = []) {
  const root = await projectRoot();
  const installScope = installScopeFromArgs(args);
  let res: any = null;
  await withSecretPreservationGuard(root, 'fix-path-command', async () => {
    res = await initProject(root, { installScope, localOnly: flag(args, '--local-only'), globalCommand: 'sks', force: true });
  });
  const readiness = initProjectInstallReadiness(res);
  const result = {
    schema: 'sks.fix-path.v1',
    ok: readiness.ok,
    status: readiness.status,
    root,
    install_scope: installScope,
    hook_command_prefix: sksCommandPrefix(installScope, { globalCommand: 'sks' }),
    hooks: path.join(root, '.codex', 'hooks.json'),
    skill_install: res?.skill_install,
    blockers: readiness.blockers,
    warnings: readiness.warnings
  };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) {
    printJson(result);
    return result;
  }
  console.log(`${result.ok ? 'SKS hook path refreshed' : 'SKS hook path refresh blocked'}: ${path.relative(root, result.hooks)}`);
  for (const warning of readiness.warnings) console.log(`Warning: ${warning}`);
  for (const blocker of readiness.blockers) console.error(`Blocker: ${blocker}`);
  return result;
}

function initProjectInstallReadiness(res: any) {
  const manualBlockers = [
    ...(res?.codex_config_install?.manual_blockers || []),
    ...(res?.agent_install?.manual_blockers || [])
  ].map(String);
  const skillWarnings = Array.isArray(res?.skill_install?.warnings)
    ? res.skill_install.warnings.map(String)
    : [];
  const skillBlockers = res?.skill_install?.ok === false
    ? ['authoritative_sks_skill_install_failed', ...skillWarnings.map((warning: string) => `skill_install:${warning}`)]
    : [];
  const installBlockers = [
    ...(res?.codex_config_install?.ok === false && !res?.codex_config_install?.manual_blockers?.length
      ? ['codex_config_install_failed']
      : []),
    ...(res?.agent_install?.ok === false && !res?.agent_install?.manual_blockers?.length
      ? ['official_subagent_agent_install_failed']
      : [])
  ];
  const blockers = [...new Set([...manualBlockers, ...skillBlockers, ...installBlockers])];
  const warnings = [...new Set([
    ...(res?.codex_config_install?.warnings || []).map(String),
    ...(res?.agent_install?.warnings || []).map(String),
    ...skillWarnings
  ])];
  const ok = blockers.length === 0
    && res?.skill_install?.ok !== false
    && res?.codex_config_install?.ok !== false
    && res?.agent_install?.ok !== false;
  const status = manualBlockers.length
    ? 'manual_blocked'
    : skillBlockers.length
      ? 'skill_blocked'
      : installBlockers.length
        ? 'install_blocked'
        : 'completed';
  return { ok, status, blockers, warnings };
}

export async function depsCommand(sub: any = 'check', args: any = []) {
  const action = sub || 'check';
  if (action !== 'check' && action !== 'status') {
    console.error('Usage: sks deps check [--json] [--yes]');
    process.exitCode = 1;
    return;
  }
  const npm = whichSync('npm');
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  const root = await sksRoot();
  const { ensureRelatedCliTools } = await import('../../cli/install-helpers.js');
  const repairRequested = flag(args, '--yes') || flag(args, '-y');
  const cliTools = await ensureRelatedCliTools(repairRequested ? args : [...args, '--dry-run']);
  const codexReady = cliTools.codex.status === 'present' || cliTools.codex.status === 'installed';
  const result = {
    schema: 'sks.deps-status.v1',
    root,
    ready: Boolean(nodeOk && npm && codexReady),
    node: { ok: nodeOk, version: process.version },
    npm: { ok: Boolean(npm), bin: npm },
    cli_tools: cliTools,
    next_actions: [
      ...(!nodeOk ? ['Install Node.js 20.11+.'] : []),
      ...(!npm ? ['Install npm or a Node.js distribution that includes npm.'] : []),
      ...(!codexReady ? [`Run sks deps check --yes or npm i -g @openai/codex@latest.`] : [])
    ]
  };
  if (flag(args, '--json')) return printJson(result);
  console.log('SKS Dependencies');
  console.log(`Node: ${result.node.ok ? 'ok' : 'missing'} ${result.node.version}`);
  console.log(`npm:  ${result.npm.ok ? 'ok' : 'missing'} ${result.npm.bin || ''}`.trim());
  console.log(`Codex CLI: ${cliTools.codex.status}${cliTools.codex.version ? ` ${cliTools.codex.version}` : ''}`);
  for (const action of result.next_actions) console.log(`Next: ${action}`);
  if (!result.ready) process.exitCode = 1;
}

export async function postinstallCommand(args: any = []) {
  const { postinstall } = await import('../../cli/install-helpers.js');
  return postinstall({ bootstrap: bootstrapCommand, args });
}

export async function selftestCommand(args: any = []) {
  if (flag(args, '--real')) return selftestRealCommand(args);
  process.env.CI = 'true';
  const root = await projectRoot();
  const tmp = tmpdir('sks-selftest-');
  await ensureDir(tmp);
  try {
    const registry = await buildFeatureRegistry({ root });
    const coverage = validateFeatureRegistry(registry);
    if (!coverage.ok) throw new Error(`selftest: feature registry blocked: ${coverage.blockers.join(', ')}`);
    const mission = await createMission(tmp, { mode: 'naruto', prompt: 'selftest route proof fixture' });
    await writeSelftestRouteProof(tmp, { missionId: mission.id, kind: 'route_gate' });
    const proof = await readJson(path.join(tmp, '.sneakoscope', 'missions', mission.id, 'completion-proof.json'), null);
    if (!proof?.mission_id) throw new Error('selftest: completion proof fixture missing');
    const hookExplain = hooksExplainReport();
    if (!hookExplain.events.includes('Stop')) throw new Error('selftest: hook explain missing Stop');
    const result = {
      schema: 'sks.selftest.v1',
      ok: true,
      version: PACKAGE_VERSION,
      generated_at: nowIso(),
      checks: ['feature_registry', 'route_completion_proof_fixture', 'hooks_policy_surface'],
      tmp_root: tmp,
      tmp_cleaned: true
    };
    if (flag(args, '--json')) return printJson(result);
    console.log('SKS selftest passed');
  } finally {
    await rmrf(tmp);
  }
}

/**
 * `sks selftest --real`: actually spawns every feature fixture whose kind is
 * 'execute' or 'execute_and_validate_artifacts', derives real pass/fail status
 * from the process exit code (and, for execute_and_validate_artifacts, from
 * whether the declared expected_artifacts actually exist and match their
 * declared schema), and writes a JSON report that explicitly lists fixtures
 * skipped because they are mock/wiring_only kind rather than silently omitting
 * them. This is additive: plain `sks selftest --mock` behavior is unchanged.
 */
export async function selftestRealCommand(args: any = []) {
  process.env.CI = 'true';
  const root = await projectRoot();
  const registry = await buildFeatureRegistry({ root });
  const executableKinds = new Set(['execute', 'execute_and_validate_artifacts']);
  const results: any[] = [];
  const skippedWiringOnly: any[] = [];
  for (const feature of registry.features || []) {
    const fx = feature.fixture || {};
    if (executableKinds.has(fx.kind)) {
      const run = await runFeatureFixture(feature, { root });
      results.push(run);
    } else if (fx.kind === 'mock' || fx.kind === 'wiring_only' || fx.quality === 'wiring_only') {
      skippedWiringOnly.push({ id: feature.id, kind: fx.kind, reason: fx.reason || 'mock_or_wiring_only_kind_not_executed' });
    }
  }
  const failures = results.filter((row: any) => !row.ok);
  const ok = failures.length === 0;
  const report = {
    schema: 'sks.selftest-real.v1',
    ok,
    version: PACKAGE_VERSION,
    generated_at: nowIso(),
    root,
    checked: results.length,
    passed: results.filter((row: any) => row.ok).length,
    failed: failures.length,
    results,
    skipped_wiring_only: skippedWiringOnly,
    skipped_wiring_only_count: skippedWiringOnly.length,
    blockers: failures.flatMap((row: any) => row.blockers || [])
  };
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'selftest-real-report.json');
  await writeJsonAtomic(reportPath, report);
  const output = { ...report, report_file: path.relative(root, reportPath) };
  if (flag(args, '--json')) return printJson(output);
  console.log(`SKS selftest --real: ${ok ? 'passed' : 'blocked'} (checked=${results.length}, skipped_wiring_only=${skippedWiringOnly.length})`);
  console.log(`Report: ${path.relative(root, reportPath)}`);
  if (!ok) {
    for (const blocker of report.blockers) console.log(`- ${blocker}`);
    process.exitCode = 1;
  }
  return output;
}

export async function reasoningCommand(args: any = []) {
  const prompt = args.filter((arg: any) => !String(arg).startsWith('--')).join(' ').trim();
  const route = routePrompt(prompt || '$SKS');
  const info = routeReasoning(route, prompt);
  const result = {
    route: route?.command || '$SKS',
    effort: info.effort,
    profile: info.profile,
    reason: info.reason,
    temporary: true,
    instruction: reasoningInstruction(info)
  };
  if (flag(args, '--json')) return printJson(result);
  console.log('SKS Reasoning Route');
  console.log(`Route:   ${result.route}`);
  console.log(`Effort:  ${result.effort}`);
  console.log(`Profile: ${result.profile}`);
}

export async function autoReviewCommand(sub: any = 'status', args: any = []) {
  const { autoReviewStatus, enableAutoReview, disableAutoReview } = await import('../auto-review.js');
  const { writeRouteCollaborationArtifacts } = await import('../agents/route-collaboration-ledger.js');
  const action = sub || 'status';
  const result = action === 'fixture'
    ? await reviewNativeAgentFixture()
    : action === 'enable' || action === 'start'
    ? await enableAutoReview({ high: flag(args, '--high') })
    : action === 'disable'
      ? await disableAutoReview()
      : await autoReviewStatus();
  if (flag(args, '--json')) return printJson(result);
  console.log(JSON.stringify(result, null, 2));

  async function reviewNativeAgentFixture() {
    const root = await projectRoot();
    const { id } = await createMission(root, { mode: 'review', prompt: 'Review native agent collaboration fixture' });
    const native = await writeRouteCollaborationArtifacts(root, {
      missionId: id,
      route: '$Review',
      routeKey: 'Review',
      prompt: 'Review route approval safety, verification, and integration through the native agent runtime.',
      mode: 'REVIEW'
    });
    return {
      schema: 'sks.review-native-agent-fixture.v1',
      ok: native.ok,
      mission_id: id,
      native_agent_collaboration: native
    };
  }
}

function commandRows(): CommandRow[] {
  return COMMAND_MANIFEST_LITE.map((entry) => ({
    name: entry.name,
    usage: `sks ${entry.name}`,
    description: entry.summary,
    maturity: entry.maturity
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function installScopeFromArgs(args: any = [], fallback: any = 'global') {
  if (flag(args, '--project')) return 'project';
  if (flag(args, '--global')) return 'global';
  const index = args.indexOf('--install-scope');
  return normalizeInstallScope(index >= 0 && args[index + 1] ? args[index + 1] : fallback);
}

function whichSync(command: any) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    encoding: 'utf8',
    shell: process.platform !== 'win32'
  });
  return result.status === 0 ? String(result.stdout || '').trim().split(/\r?\n/)[0] : null;
}

function valueAfter(args: any[] = [], name: string): string | null {
  const index = args.findIndex((arg: any) => String(arg) === name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value === undefined ? null : String(value);
}

async function resolveUpdateProjectRoot(args: any[] = []): Promise<string> {
  const option = explicitOptionValue(args, '--project-root');
  if (!option.specified) return projectRoot();
  if (!option.value) throw new Error('update_project_root_value_required');
  const root = path.resolve(option.value);
  if (root === path.parse(root).root) throw new Error('update_project_root_filesystem_root_refused');
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`update_project_root_not_directory:${root}`);
  const canonicalRoot = await fsp.realpath(root);
  if (canonicalRoot === path.parse(canonicalRoot).root) {
    throw new Error('update_project_root_filesystem_root_refused');
  }
  return canonicalRoot;
}

function explicitOptionValue(args: any[], name: string): { specified: boolean; value: string | null } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === name) {
      const next = args[index + 1];
      const value = next === undefined || String(next).startsWith('-') ? null : String(next).trim();
      return { specified: true, value: value || null };
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1).trim();
      return { specified: true, value: value || null };
    }
  }
  return { specified: false, value: null };
}

function resolveUpdateRegistry(args: any[]): string | null {
  const option = explicitOptionValue(args, '--registry');
  if (!option.specified) return null;
  if (!option.value) throw new Error('update_registry_value_required');
  return option.value;
}
