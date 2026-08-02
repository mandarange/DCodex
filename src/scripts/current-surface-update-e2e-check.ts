#!/usr/bin/env node
// Current-surface update and migration receipt end-to-end gate.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDoctorCommandAliasCleanup } from '../core/doctor/command-alias-cleanup.js';
import { PACKAGE_VERSION, packageRoot, readJson, writeReceiptRotated } from '../core/fsx.js';
import { runSksUpdateNow } from '../core/update-check.js';
import { ensureCurrentMigrationBeforeCommand, projectUpdateMigrationReceiptPath, runPackageLocalDoctor } from '../core/update/update-migration-state.js';

const REQUIRED_MIGRATION_STAGES = [
  'other-harness-cleanup',
  'current-public-surface-reconcile',
  'session-state-split',
  'skills-reconcile',
  'menubar-retarget',
  'config-fastmode-normalize',
  'hook-trust-refresh',
  'receipt-rotation'
];

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-current-surface-update-e2e-'));
const savedHome = process.env.HOME;
const savedGlobalRoot = process.env.SKS_GLOBAL_ROOT;
const savedCwd = process.cwd();

try {
  const home = path.join(tempRoot, 'home');
  const project = path.join(tempRoot, 'project');
  await seedUpgradeFixture(home, project);
  process.env.HOME = home;
  process.env.SKS_GLOBAL_ROOT = path.join(home, '.sneakoscope-global');
  process.chdir(project);

  const output = await captureConsole(async () => runSksUpdateNow({
    version: PACKAGE_VERSION,
    projectRoot: project,
    currentVersion: '4.8.4',
    json: false,
    quiet: false,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      HOME: home,
      SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'),
      SKS_INSTALLED_SKS_VERSION: '4.8.4',
      SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: PACKAGE_VERSION,
      SKS_UPDATE_TEMP_INSTALL_FIXTURE_ENTRYPOINT: path.join(packageRoot(), 'dist', 'bin', 'sks.js'),
      SKS_UPDATE_FAKE_INSTALL: '1',
      SKS_TEST_DOCTOR_OK: '1',
      SKS_TEST_DOCTOR_EMIT_MIGRATION_RECEIPT: '1',
      SKS_TEST_OLD_DOCTOR_FAIL: '1',
      SKS_UPDATE_SKIP_SKS_MENUBAR: '1',
      SKS_REQUIRE_ZELLIJ: '0',
      SKS_POSTINSTALL_GLOBAL_DOCTOR: '0',
      SKS_MIGRATION_DOCTOR_TIMEOUT_MS: '30000',
      // The updated-package doctor and receipt writer repeat the expensive
      // migration passes. Keep their dedicated budget above parallel CI load
      // without weakening the 30-second migration-timeout retry fixture below.
      SKS_UPDATE_NEW_DOCTOR_TIMEOUT_MS: '90000'
    }
  }));

  const result = output.value;
  assertGate(result.status === 'updated', 'simulated update must finish updated', { status: result.status, error: result.error, stages: result.stages });
  assertGate(result.temporary_install_smoke?.status === 'verified', 'simulated update must verify the package-local temporary install fixture', { temporary_install_smoke: result.temporary_install_smoke });
  const fakeInstallVerificationIds = result.verification.map((row) => row.id).sort();
  assertGate(
    JSON.stringify(fakeInstallVerificationIds) === JSON.stringify(['hooks_trusted', 'skills_manifest', 'version_match'])
      && result.verification.every((row) => row.ok),
    'all fake-install final self-verification checks must pass',
    { verification: result.verification }
  );
  assertGate(result.stages.some((stage) => stage.id === 'preflight' && stage.status === 'failed_continuing'), 'old-version doctor failure must continue', { stages: result.stages });
  assertGate(result.stages.some((stage) => stage.id === 'global_install' && stage.status === 'fake_installed'), 'fake install stage missing', { stages: result.stages });
  assertGate(/[▸>].*global_install|global_install/.test(output.text) && /final_self_verification/.test(output.text), 'progress output must include stage start/end lines', { output: output.text.slice(-2000) });

  const receipt = await readJson<any>(projectUpdateMigrationReceiptPath(project), null);
  const migrationStages = Array.isArray(receipt?.migration_stages) ? receipt.migration_stages : [];
  const stageIds = new Set(migrationStages.map((stage: any) => stage.id));
  for (const id of REQUIRED_MIGRATION_STAGES) assertGate(stageIds.has(id), `migration stage missing from receipt: ${id}`, { receipt });
  const badStages = migrationStages.filter((stage: any) => stage.ok !== true);
  assertGate(badStages.length === 0, 'migration stages must all be ok', { badStages, receipt });
  assertGate(!Object.hasOwn(receipt || {}, 'legacy_migration_stages'), 'receipt must expose only the current migration summary contract', { receipt });
  assertGate(!/\$(?:Agent|Team|MAD-DB|Swarm|ShadowClone|Kagebunshin|Ralph)\b|\bsks\s+(?:team|mad-db|tmux|xai|swarm|agent|ralph|ui)\b/i.test(JSON.stringify(receipt)), 'customer migration receipt must not publish retired surface names', { receipt });
  assertGate(!fs.existsSync(path.join(project, '.sneakoscope', 'current.json')), 'simulated update must remove legacy current.json from the active state surface', {});
  const migratedCurrent = await readJson<any>(path.join(project, '.sneakoscope', 'state', 'current.json'), null);
  assertGate(migratedCurrent?.mission_id === 'M-legacy', 'simulated update must preserve legacy state in state/current.json', { migratedCurrent });
  const migratedSessions = await fsp.readdir(path.join(project, '.sneakoscope', 'state', 'sessions'));
  assertGate(migratedSessions.length === 0, 'legacy state without _session_key must not create an unreadable mission-id session alias', { migratedSessions });
  const legacyStateBackups = (await fsp.readdir(path.join(project, '.sneakoscope', 'quarantine', 'update-legacy-state')))
    .filter((name) => name.startsWith('current-') && name.endsWith('.json'));
  assertGate(legacyStateBackups.length === 1, 'simulated update must keep exactly one recoverable legacy current.json backup', { legacyStateBackups });
  const legacyStateBackup = await readJson<any>(
    path.join(project, '.sneakoscope', 'quarantine', 'update-legacy-state', legacyStateBackups[0]!),
    null
  );
  assertGate(legacyStateBackup?.mission_id === 'M-legacy', 'legacy current.json backup must preserve the original state', { legacyStateBackup });

  const retiredResidue = [
    path.join(project, '.sneakoscope', 'team'),
    path.join(project, '.sneakoscope', 'team-dashboard-state.json'),
    path.join(project, '.sneakoscope', 'work-order-ledger.json'),
    path.join(project, '.sneakoscope', 'update', 'legacy-team-artifacts.json'),
    path.join(project, '.sneakoscope', 'missions', 'M-retired-surface'),
    path.join(project, '.sneakoscope', 'missions', 'M-shadow-surface'),
    path.join(project, '.sneakoscope', 'missions', 'M-kage-surface'),
    path.join(project, '.sneakoscope', 'missions', 'M-ralph-surface'),
    path.join(home, '.agents', 'skills', 'team'),
    path.join(home, '.agents', 'skills', 'agent'),
    path.join(home, '.agents', 'skills', 'ralph'),
    path.join(home, '.agents', 'skills', 'sks-research-discovery'),
    path.join(home, '.codex', 'skills', 'mad-db'),
    path.join(home, '.codex', 'sks-team.config.toml'),
    path.join(home, '.sneakoscope-global', '.codex', 'sks-team.config.toml'),
    path.join(project, '.agents', 'skills', 'tmux'),
    path.join(project, '.agents', 'skills', 'swarm'),
    path.join(project, '.codex', 'skills', 'xai'),
    path.join(project, '.codex', 'skills', 'shadow-clone'),
    path.join(project, '.codex', 'skills', 'kage-bunshin')
  ];
  for (const target of retiredResidue) {
    assertGate(!fs.existsSync(target), 'simulated update must remove managed retired residue', { target });
  }
  assertGate(fs.existsSync(path.join(project, '.agents', 'skills', 'customer-skill', 'SKILL.md')), 'simulated update must preserve user-authored skills', {});
  assertGate(fs.existsSync(path.join(project, '.sneakoscope', 'customer-state.json')), 'simulated update must preserve unrelated customer state', {});
  for (const target of [
    path.join(home, '.agents', 'skills', 'naruto'),
    path.join(home, '.codex', 'skills', 'research-discovery'),
    path.join(home, '.sneakoscope-global', '.agents', 'skills', 'answer'),
    path.join(project, '.agents', 'skills', 'imagegen'),
    path.join(project, '.codex', 'skills', 'qa-loop'),
    path.join(project, 'packages', 'app', '.agents', 'skills', 'dfix')
  ]) {
    assertGate(!fs.existsSync(target), 'simulated update must remove every managed legacy unprefixed SKS skill', { target });
  }
  for (const name of ['sks-naruto', 'sks-research', 'sks-answer', 'sks-imagegen', 'sks-qa-loop', 'sks-dfix']) {
    assertGate(fs.existsSync(path.join(home, '.agents', 'skills', name, 'SKILL.md')), 'simulated update must install the namespaced global picker skill', { name });
  }
  assertGate(!fs.existsSync(path.join(home, '.agents', 'skills', 'sks-research-discovery')), 'simulated update must remove the duplicate namespaced research-discovery picker skill', {});
  assertGate(!fs.existsSync(path.join(project, '.agents', 'skills', 'research')), 'simulated update must remove a user-authored legacy-name collision from the active picker surface', {});
  const quarantinedLegacySkills = await findFiles(path.join(project, '.sneakoscope', 'quarantine', 'skills'), 'SKILL.md');
  assertGate(quarantinedLegacySkills.length >= 1, 'simulated update must quarantine user-authored legacy-name collisions', { quarantinedLegacySkills });
  assertGate((await Promise.all(quarantinedLegacySkills.map((file) => fsp.readFile(file, 'utf8')))).some((text) => text.includes('keep user research collision')), 'simulated update quarantine must preserve the user-authored legacy skill content', { quarantinedLegacySkills });
  const currentGoalRoot = path.join(project, '.sneakoscope', 'missions', 'M-current-goal');
  const currentGoalWorkflow = await readJson<any>(path.join(currentGoalRoot, 'goal-workflow.json'), null);
  const currentGoalBridge = await fsp.readFile(path.join(currentGoalRoot, 'goal-bridge.md'), 'utf8');
  assertGate(fs.existsSync(path.join(currentGoalRoot, 'mission.json')), 'simulated update must preserve the current Goal mission', {});
  assertGate(!Object.hasOwn(currentGoalWorkflow?.pipeline_contract || {}, 'ralph_removed'), 'simulated update must remove retired Goal workflow metadata', {});
  assertGate(!/ralph/i.test(currentGoalBridge), 'simulated update must remove retired Goal bridge prose', {});
  const secondSurfacePass = await runDoctorCommandAliasCleanup({
    root: project,
    home,
    globalRuntimeRoot: path.join(home, '.sneakoscope-global'),
    fix: true
  });
  assertGate(secondSurfacePass.ok === true, 'second current-surface pass must remain clean', { blockers: secondSurfacePass.blockers });
  assertGate(secondSurfacePass.cleanup.detected_count === 0, 'second current-surface pass must detect no removed skills', { cleanup: secondSurfacePass.cleanup });
  assertGate(secondSurfacePass.cleanup.managed_runtime.detected_managed_artifact_count === 0, 'second current-surface pass must detect no managed runtime residue', { cleanup: secondSurfacePass.cleanup });
  assertGate(secondSurfacePass.cleanup.project_guidance.reconciled_count === 0, 'second current-surface pass must rewrite no guidance', { cleanup: secondSurfacePass.cleanup });
  const fromChatImgSkill = await fsp.readFile(path.join(home, '.agents', 'skills', 'sks-from-chat-img', 'SKILL.md'), 'utf8');
  assertGate(!fs.existsSync(path.join(home, '.agents', 'skills', 'from-chat-img')), 'simulated update must remove the legacy unprefixed visual skill directory', {});
  assertGate(!fromChatImgSkill.includes('$From-Chat-IMG'), 'simulated update must remove the unregistered visual route spelling from generated skills', {});
  assertGate(!fromChatImgSkill.includes('$from-chat-img'), 'simulated update must not advertise the visual add-on skill as another execution alias', {});
  assertGate(fromChatImgSkill.includes('$sks-from-chat-img'), 'simulated update must retain the namespaced Naruto visual add-on skill name', {});
  const reconciledAgents = await fsp.readFile(path.join(project, 'AGENTS.md'), 'utf8');
  const reconciledQuickReference = await fsp.readFile(path.join(project, '.codex', 'SNEAKOSCOPE.md'), 'utf8');
  const removedSurface = /\$(?:Agent|Team|MAD-DB|Swarm|ShadowClone|Kagebunshin|Ralph)\b|\bsks\s+(?:team|mad-db|tmux|xai|swarm|agent|ralph|ui)\b/i;
  assertGate(!removedSurface.test(reconciledAgents), 'simulated update must rewrite the managed AGENTS block to the current surface', {});
  assertGate(!removedSurface.test(reconciledQuickReference), 'simulated update must rewrite the managed Codex quick reference to the current surface', {});
  assertGate(reconciledAgents.includes('customer-authored-prefix'), 'managed AGENTS reconciliation must preserve user-authored content outside the SKS block', {});
  for (const [scope, root] of [
    ['home', home],
    ['global-runtime', path.join(home, '.sneakoscope-global')]
  ] as const) {
    const agents = await fsp.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    const quickReference = await fsp.readFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), 'utf8');
    const config = await fsp.readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
    assertGate(!removedSurface.test(agents), `simulated update must rewrite ${scope} AGENTS guidance`, {});
    assertGate(!removedSurface.test(quickReference), `simulated update must rewrite ${scope} Codex quick reference`, {});
    assertGate(!/profiles\.sks-team|profile\s*=\s*"sks-team"|\$MAD-DB|sks mad-db/i.test(config), `simulated update must remove ${scope} retired config policy/profile residue`, {});
  }

  const retryProject = path.join(tempRoot, 'retry-project');
  await fsp.mkdir(path.join(retryProject, '.sneakoscope'), { recursive: true });
  await writeIsolatedFixture(path.join(retryProject, '.sneakoscope', 'manifest.json'), '{}\n');
  const retry = await ensureCurrentMigrationBeforeCommand({
    command: 'update-e2e',
    cwd: retryProject,
    env: {
      ...process.env,
      HOME: home,
      SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'),
      SKS_TEST_DOCTOR_TIMEOUT_ONCE: '1',
      SKS_MIGRATION_DOCTOR_TIMEOUT_MS: '1'
    }
  });
  assertGate(retry.ok === true && retry.status === 'repaired', 'timeout doctor must retry once and repair', retry);
  assertGate(retry.warnings.some((warning) => warning.startsWith('doctor_migration_timeout_retry')), 'timeout retry warning missing', retry);

  const failProject = path.join(tempRoot, 'fail-project');
  await fsp.mkdir(path.join(failProject, '.sneakoscope'), { recursive: true });
  await writeIsolatedFixture(path.join(failProject, '.sneakoscope', 'manifest.json'), '{}\n');
  const failed = await ensureCurrentMigrationBeforeCommand({
    command: 'update-e2e',
    cwd: failProject,
    env: {
      ...process.env,
      HOME: home,
      SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'),
      SKS_TEST_DOCTOR_FAIL: '1',
      SKS_MIGRATION_DOCTOR_TIMEOUT_MS: '1'
    }
  });
  assertGate(failed.ok === false && failed.blockers.includes('doctor_migration_failed'), 'non-timeout doctor failure must not be reported as timeout', failed);
  assertGate(!failed.warnings.some((warning) => warning.startsWith('doctor_migration_timeout_retry')), 'non-timeout failure must not retry', failed);

  const currentDryRunProject = path.join(tempRoot, 'current-dry-run-project');
  await fsp.mkdir(path.join(currentDryRunProject, '.sneakoscope'), { recursive: true });
  const currentDryRun = await captureConsole(async () => runSksUpdateNow({
    projectRoot: currentDryRunProject,
    currentVersion: PACKAGE_VERSION,
    dryRun: true,
    json: false,
    quiet: false,
    timeoutMs: 5000,
    env: {
      ...process.env,
      HOME: home,
      SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'),
      SKS_INSTALLED_SKS_VERSION: PACKAGE_VERSION,
      SKS_NPM_VIEW_SNEAKOSCOPE_VERSION: PACKAGE_VERSION,
      SKS_UPDATE_SKIP_SKS_MENUBAR: '1'
    }
  }));
  assertGate(currentDryRun.value.status === 'dry_run', 'already-current update dry-run must stay dry_run', { result: currentDryRun.value });
  assertGate(!currentDryRun.value.stages.some((stage) => ['project_receipt', 'sks_menubar', 'global_skills_reconcile'].includes(stage.id)), 'already-current dry-run must not run mutating current-version repair stages', { stages: currentDryRun.value.stages });
  assertGate(!fs.existsSync(projectUpdateMigrationReceiptPath(currentDryRunProject)), 'already-current dry-run must not write a project receipt', { receipt: projectUpdateMigrationReceiptPath(currentDryRunProject) });

  const timeoutEntrypoint = path.join(tempRoot, 'timeout-doctor.js');
  await writeIsolatedFixture(timeoutEntrypoint, 'setInterval(() => {}, 1000)\n');
  const actualTimeout = await runPackageLocalDoctor({
    root: project,
    entrypoint: timeoutEntrypoint,
    args: [],
    env: {
      ...process.env,
      HOME: home,
      SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global')
    },
    timeoutMs: 25,
    maxOutputBytes: 1024
  });
  assertGate(actualTimeout.ok === false && actualTimeout.timedOut === true && actualTimeout.timed_out === true, 'package-local doctor timeout must come from real child process timeout path', actualTimeout);

  const rotationProject = path.join(tempRoot, 'rotation-project');
  const rotationReceipt = projectUpdateMigrationReceiptPath(rotationProject);
  await fsp.mkdir(path.dirname(rotationReceipt), { recursive: true });
  const base = path.basename(rotationReceipt);
  const dir = path.dirname(rotationReceipt);
  for (let index = 0; index < 5; index += 1) {
    const rotated = path.join(dir, `${base}.2026-07-03T00-00-0${index}-000Z.json`);
    await writeIsolatedFixture(rotated, JSON.stringify({ index }) + '\n');
    await fsp.utimes(rotated, new Date(2026, 6, 3, 0, 0, index), new Date(2026, 6, 3, 0, 0, index));
  }
  await writeIsolatedFixture(rotationReceipt, JSON.stringify({ current: true }) + '\n');
  await writeReceiptRotated(rotationReceipt, { next: true }, { keep: 5 });
  const rotatedAfterWrite = (await fsp.readdir(dir)).filter((name) => name.startsWith(`${base}.`) && name.endsWith('.json'));
  assertGate(rotatedAfterWrite.length <= 5, 'receipt rotation must include the just-rotated current receipt in keep=5 pruning', { rotatedAfterWrite });

  console.log(JSON.stringify({
    schema: 'sks.current-surface-update-e2e-check.v1',
    ok: true,
    package_version: PACKAGE_VERSION,
    update_status: result.status,
    verification: result.verification.map((row) => ({ id: row.id, ok: row.ok })),
    migration_stage_count: REQUIRED_MIGRATION_STAGES.length,
    progress_lines: output.text.split(/\r?\n/).filter(Boolean).length,
    retry_status: retry.status,
    failure_blockers: failed.blockers,
    retired_residue_removed_count: retiredResidue.length,
    second_pass_detected_residue_count: secondSurfacePass.cleanup.managed_runtime.detected_managed_artifact_count,
    current_dry_run_status: currentDryRun.value.status,
    actual_timeout_timed_out: actualTimeout.timedOut,
    rotated_receipt_count: rotatedAfterWrite.length
  }, null, 2));
} finally {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
  else process.env.SKS_GLOBAL_ROOT = savedGlobalRoot;
  await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function writeIsolatedFixture(file: string, content: string): Promise<void> {
  const target = path.resolve(file);
  const relative = path.relative(tempRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`isolated_fixture_path_refused:${target}`);
  }
  await fsp.writeFile(target, content);
}

async function seedUpgradeFixture(home: string, project: string): Promise<void> {
  const globalRuntimeRoot = path.join(home, '.sneakoscope-global');
  await fsp.mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
  await fsp.mkdir(path.join(home, '.codex', 'skills'), { recursive: true });
  await fsp.mkdir(path.join(home, '.codex', 'sks-menubar'), { recursive: true });
  await fsp.mkdir(path.join(globalRuntimeRoot, '.agents', 'skills'), { recursive: true });
  await fsp.mkdir(path.join(globalRuntimeRoot, '.codex'), { recursive: true });
  await fsp.mkdir(path.join(project, '.sneakoscope'), { recursive: true });
  await fsp.mkdir(path.join(project, '.codex'), { recursive: true });
  await fsp.mkdir(path.join(project, 'packages', 'app', '.sneakoscope'), { recursive: true });
  await fsp.writeFile(path.join(project, 'AGENTS.md'), [
    'customer-authored-prefix',
    '<!-- BEGIN Sneakoscope Codex GX MANAGED BLOCK -->',
    '# Retired SKS guidance',
    '- Old agent work uses `$Agent`.',
    '- General work defaults to `$Team`.',
    '- Database work uses `$MAD-DB`.',
    '- Clone work uses `$ShadowClone` or `$Kagebunshin`.',
    '- Persisted work uses `$Ralph`.',
    '- Do not use `sks --naruto`, `sks --clones`, `sks --glm`, or `sks zellij dashboard`.',
    '<!-- END Sneakoscope Codex GX MANAGED BLOCK -->',
    ''
  ].join('\n'));
  await fsp.writeFile(path.join(project, '.codex', 'SNEAKOSCOPE.md'), [
    '# ㅅㅋㅅ',
    'Install scope: `global`',
    'Command: `sks <command>`',
    'Files: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md, .agents/skills, .codex/agents, .sneakoscope/missions.',
    `Retired shortcuts: \`$Agent\`, \`$Team\`, \`$MAD-DB\`, \`$Swarm\`, \`$ShadowClone\`, \`$Kagebunshin\`, \`$Ralph\`, \`sks team\`, \`sks mad-db\`, \`sks ${['tm', 'ux'].join('')}\`, \`sks xai\`, \`sks swarm\`, \`sks agent\`, \`sks ralph\`.`,
    ''
  ].join('\n'));
  for (const root of [home, globalRuntimeRoot]) {
    await fsp.writeFile(path.join(root, 'AGENTS.md'), [
      '<!-- BEGIN Sneakoscope Codex GX MANAGED BLOCK -->',
      '# Retired SKS guidance',
      '- General work defaults to `$Team`.',
      '- Database work uses `sks mad-db`.',
      '- Persisted work uses `sks ralph`.',
      '<!-- END Sneakoscope Codex GX MANAGED BLOCK -->',
      ''
    ].join('\n'));
    await fsp.writeFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), [
      '# ㅅㅋㅅ',
      'Install scope: `global`',
      'Command: `sks <command>`',
      'Files: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md, .agents/skills, .codex/agents, .sneakoscope/missions.',
      'Retired shortcuts: `$Team`, `$MAD-DB`, `$Ralph`, `sks team`, `sks mad-db`, `sks ralph`.',
      ''
    ].join('\n'));
    await fsp.writeFile(path.join(root, '.codex', 'sks-team.config.toml'), [
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_reasoning_effort = "medium"',
      ''
    ].join('\n'));
  }
  await fsp.writeFile(path.join(home, '.agents', 'skills', '.sks-generated.json'), JSON.stringify({
    schema_version: 1,
    generated_by: 'sneakoscope',
    version: '4.8.4',
    skills: [],
    files: []
  }, null, 2) + '\n');
  await fsp.writeFile(path.join(home, '.codex', 'config.toml'), [
    'default_profile = "legacy"',
    'profile = "sks-team"',
    '',
    '[profiles.sks-team]',
    'service_tier = "fast"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    'model_reasoning_effort = "medium"',
    '',
    '[auto_review]',
    'policy = "In MAD-SKS launches, allow only scoped non-MadDB high-risk work approved for the active invocation and keep catastrophic DB wipe/all-row safeguards active. In first-class MAD-DB cycles, the explicit $MAD-DB or sks mad-db run|exec|apply-migration invocation is the SQL-plane approval boundary: execute requested execute_sql/apply_migration mutations with mission-local write transport, read-back proof, and final read-only restoration. Supabase project/account/billing/credential control-plane actions remain denied."',
    '',
    '[hooks.state."legacy"]',
    'trusted_hash = "old-hash"',
    ''
  ].join('\n'));
  await fsp.writeFile(path.join(globalRuntimeRoot, '.codex', 'config.toml'), [
    'model = "future-model"',
    '',
    '[profiles.sks-team]',
    'service_tier = "fast"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    'model_reasoning_effort = "medium"',
    '',
    '[auto_review]',
    'policy = "In MAD-SKS launches, allow only scoped non-MadDB high-risk work approved for the active invocation and keep catastrophic DB wipe/all-row safeguards active. In first-class MAD-DB cycles, the explicit $MAD-DB or sks mad-db run|exec|apply-migration invocation is the SQL-plane approval boundary: execute requested execute_sql/apply_migration mutations with mission-local write transport, read-back proof, and final read-only restoration. Supabase project/account/billing/credential control-plane actions remain denied."',
    ''
  ].join('\n'));
  await fsp.writeFile(path.join(home, '.codex', 'sks-menubar', 'sks-menubar-action.sh'), [
    '#!/usr/bin/env sh',
    'SKS_ENTRY="/old/sneakoscope/dist/bin/sks.js"',
    'exec "$SKS_ENTRY" "$@"',
    ''
  ].join('\n'));
  await fsp.writeFile(path.join(project, '.sneakoscope', 'current.json'), JSON.stringify({
    mission_id: 'M-legacy',
    phase: 'LEGACY'
  }, null, 2) + '\n');
  await fsp.writeFile(path.join(project, '.sneakoscope', 'customer-state.json'), '{"keep":true}\n');
  await fsp.mkdir(path.join(project, '.sneakoscope', 'team'), { recursive: true });
  await fsp.writeFile(path.join(project, '.sneakoscope', 'team', 'runtime.json'), '{"legacy":true}\n');
  await fsp.writeFile(path.join(project, '.sneakoscope', 'team-dashboard-state.json'), '{"schema":"sks.team-dashboard-state.v1"}\n');
  await fsp.writeFile(path.join(project, '.sneakoscope', 'work-order-ledger.json'), '{"schema_version":1,"route":"team","items":[]}\n');
  await fsp.mkdir(path.join(project, '.sneakoscope', 'update'), { recursive: true });
  await fsp.writeFile(path.join(project, '.sneakoscope', 'update', 'legacy-team-artifacts.json'), '{"schema":"sks.legacy-team-artifacts-migration.v1"}\n');
  for (const [id, mode] of [
    ['M-retired-surface', 'mad-db'], ['M-shadow-surface', '$ShadowClone'],
    ['M-kage-surface', '$Kagebunshin'], ['M-ralph-surface', '$Ralph']
  ] as const) {
    const mission = path.join(project, '.sneakoscope', 'missions', id);
    await fsp.mkdir(mission, { recursive: true });
    await fsp.writeFile(path.join(mission, 'mission.json'), JSON.stringify({
      id,
      mode,
      prompt: 'generated migration fixture',
      created_at: '2026-01-01T00:00:00.000Z',
      phase: 'PREPARE',
      questions_allowed: true,
      implementation_allowed: false
    }, null, 2) + '\n');
    await fsp.writeFile(path.join(mission, 'events.jsonl'), `${JSON.stringify({ type: 'mission.created', mission: id, mode })}\n`);
  }
  const currentGoalRoot = path.join(project, '.sneakoscope', 'missions', 'M-current-goal');
  await fsp.mkdir(currentGoalRoot, { recursive: true });
  await fsp.writeFile(path.join(currentGoalRoot, 'mission.json'), JSON.stringify({
    id: 'M-current-goal',
    mode: 'Goal',
    prompt: 'keep current goal mission',
    created_at: '2026-01-01T00:00:00.000Z',
    phase: 'intake',
    questions_allowed: true,
    implementation_allowed: false
  }, null, 2) + '\n');
  await fsp.writeFile(path.join(currentGoalRoot, 'goal-workflow.json'), JSON.stringify({
    schema_version: 1,
    mission_id: 'M-current-goal',
    route: 'Goal',
    native_goal: { workflow_kind: 'native /goal persistence bridge' },
    pipeline_contract: { overlay_only: true, ralph_removed: true }
  }, null, 2) + '\n');
  await fsp.writeFile(path.join(currentGoalRoot, 'goal-bridge.md'), [
    '# SKS Goal Persistence Bridge',
    '',
    '## Native Codex Goal Control',
    '',
    '## SKS Bridge Contract',
    '',
    '- Ralph route is removed from the user-facing SKS surface.',
    '- This file is a fast SKS overlay.',
    ''
  ].join('\n'));
  await writeManagedSkill(path.join(home, '.agents', 'skills', 'team'), 'team');
  await writeManagedSkill(path.join(home, '.agents', 'skills', 'agent'), 'agent');
  await writeManagedSkill(path.join(home, '.agents', 'skills', 'ralph'), 'ralph');
  await writeManagedSkill(path.join(home, '.agents', 'skills', 'naruto'), 'naruto');
  await writeManagedSkill(path.join(home, '.agents', 'skills', 'sks-research-discovery'), 'sks-research-discovery');
  await writeManagedSkill(path.join(home, '.codex', 'skills', 'mad-db'), 'mad-db');
  await writeManagedSkill(path.join(home, '.codex', 'skills', 'research-discovery'), 'research-discovery');
  await writeManagedSkill(path.join(globalRuntimeRoot, '.agents', 'skills', 'answer'), 'answer');
  await writeManagedSkill(path.join(project, '.agents', 'skills', 'tmux'), 'tmux');
  await writeManagedSkill(path.join(project, '.agents', 'skills', 'swarm'), 'swarm');
  await writeManagedSkill(path.join(project, '.agents', 'skills', 'imagegen'), 'imagegen');
  await writeManagedSkill(path.join(project, '.codex', 'skills', 'xai'), 'xai');
  await writeManagedSkill(path.join(project, '.codex', 'skills', 'shadow-clone'), 'shadow-clone');
  await writeManagedSkill(path.join(project, '.codex', 'skills', 'kage-bunshin'), 'kage-bunshin');
  await writeManagedSkill(path.join(project, '.codex', 'skills', 'qa-loop'), 'qa-loop');
  await writeManagedSkill(path.join(project, 'packages', 'app', '.agents', 'skills', 'dfix'), 'dfix');
  await writeUserSkill(path.join(project, '.agents', 'skills', 'research'), 'research', 'keep user research collision');
  await fsp.mkdir(path.join(project, '.agents', 'skills', 'customer-skill'), { recursive: true });
  await fsp.writeFile(path.join(project, '.agents', 'skills', 'customer-skill', 'SKILL.md'), '---\nname: customer-skill\n---\n\nkeep customer skill\n');
  await fsp.writeFile(path.join(project, '.codex', 'config.toml'), [
    '[user.fast_mode]',
    'visible = true',
    'default_profile = "sks-fast-high"',
    ''
  ].join('\n'));
  const stamp = path.join(packageRoot(), 'dist', '.sks-build-stamp.json');
  assertGate(fs.existsSync(stamp), 'dist build stamp missing; run npm run build:incremental first', { stamp });
}

async function writeManagedSkill(dir: string, name: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Sneakoscope generated retired skill\n---\n\n<!-- BEGIN SKS MANAGED SKILL v6.2.0 name=${name} -->\n`);
}

async function writeUserSkill(dir: string, name: string, body: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: User-authored skill\n---\n\n${body}\n`);
}

async function findFiles(root: string, fileName: string): Promise<string[]> {
  const rows = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const row of rows) {
    const target = path.join(root, row.name);
    if (row.isDirectory()) files.push(...await findFiles(target, fileName));
    else if (row.name === fileName) files.push(target);
  }
  return files;
}

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
  };
  try {
    const value = await fn();
    return { value, text: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

function assertGate(condition: unknown, message: string, detail: unknown = {}): asserts condition {
  if (condition) return;
  console.error(JSON.stringify({ schema: 'sks.current-surface-update-e2e-check.v1', ok: false, message, detail }, null, 2));
  process.exit(1);
}
