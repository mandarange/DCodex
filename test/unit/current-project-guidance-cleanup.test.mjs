import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  containsRetiredPublicSurface,
  reconcileCurrentProjectGuidance
} from '../../dist/core/doctor/current-project-guidance.js';

const RETIRED_POLICY = 'In MAD-SKS launches, allow only scoped non-MadDB high-risk work approved for the active invocation and keep catastrophic DB wipe/all-row safeguards active. In first-class MAD-DB cycles, the explicit $MAD-DB or sks mad-db run|exec|apply-migration invocation is the SQL-plane approval boundary: execute requested execute_sql/apply_migration mutations with mission-local write transport, read-back proof, and final read-only restoration. Supabase project/account/billing/credential control-plane actions remain denied.';
const OBSERVED_RETIRED_POLICY = 'In MAD-SKS launches, allow only the scoped non-MadDB high-risk surfaces approved for the active invocation and keep catastrophic DB wipe/all-row safeguards active. In first-class MAD-DB cycles, the explicit $MAD-DB or sks mad-db run|exec|apply-migration invocation is the SQL-plane approval boundary: execute requested execute_sql/apply_migration mutations with mission-local write transport, read-back proof, and final read-only restoration. Supabase project/account/billing/credential control-plane actions remain denied.';

test('retired guidance detection uses exact argv, option, and dollar-command boundaries', () => {
  const retiredTerminal = ['zel', 'lij'].join('');
  for (const value of [
    'run sks team --json',
    'run `sks mad-db apply-migration`',
    'sks tmux',
    'sks xai status',
    'sks swarm --json',
    'sks agent run task',
    'sks ralph status',
    'sks db check',
    'sks glm --json',
    'sks --agent reviewer',
    'sks --agent=reviewer',
    'sks --naruto',
    'sks --clones 4',
    `sks --${retiredTerminal}-dashboard`,
    'sks --glm',
    `sks ${retiredTerminal} dashboard`,
    '$Agent',
    '$Team now',
    '$MAD-DB',
    '$Swarm',
    '$ShadowClone',
    '$Kagebunshin',
    '$Ralph'
  ]) assert.equal(containsRetiredPublicSurface(value), true, value);

  for (const value of [
    'sks agent-bridge setup --json',
    'sks --agent-model gpt-5.6',
    'AGENT_BRIDGE_READY',
    'sks teamcity status',
    'sks mad-db2 run',
    'sks ralph2 status',
    'sks db2 check',
    'sks naruto run task --agents 5',
    'sks mad-sks status',
    'sks codex-app glm-profile install',
    '$TeamCity',
    '$MAD-DB2',
    '$Agent_Bridge',
    '$Ralph2'
  ]) assert.equal(containsRetiredPublicSurface(value), false, value);
});

test('doctor replaces the observed managed retired policy in HOME and global runtime without rewriting customer policy', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-guidance-retired-policy-'));
  const project = path.join(fixture, 'project');
  const home = path.join(fixture, 'home');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  const customerConfig = Buffer.from([
    '[auto_review]',
    'policy = "Customer policy may mention $MAD-DB or sks mad-db and must stay byte-for-byte."',
    ''
  ].join('\n'));
  try {
    for (const root of [project, home, globalRuntimeRoot]) {
      await fs.mkdir(path.join(root, '.codex'), { recursive: true });
    }
    await fs.writeFile(path.join(project, '.codex', 'config.toml'), customerConfig);
    for (const root of [home, globalRuntimeRoot]) {
      await fs.writeFile(path.join(root, '.codex', 'config.toml'), [
        '[auto_review]',
        `policy = "${OBSERVED_RETIRED_POLICY}"`,
        ''
      ].join('\n'));
    }

    const first = await reconcileCurrentProjectGuidance({ root: project, home, globalRuntimeRoot, fix: true });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.detected_count, 2, JSON.stringify(first));
    assert.equal(first.reconciled_count, 2, JSON.stringify(first));
    assert.deepEqual(await fs.readFile(path.join(project, '.codex', 'config.toml')), customerConfig);
    for (const root of [home, globalRuntimeRoot]) {
      const config = await fs.readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
      assert.match(config, /\$MAD-SKS/);
      assert.doesNotMatch(config, /\$MAD-DB|sks mad-db/i);
    }

    const second = await reconcileCurrentProjectGuidance({ root: project, home, globalRuntimeRoot, fix: true });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.detected_count, 0, JSON.stringify(second));
    assert.equal(second.reconciled_count, 0, JSON.stringify(second));
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('guidance reconciliation refuses a symlinked .codex ancestor without external writes', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-guidance-symlink-'));
  const root = path.join(fixture, 'project');
  const home = path.join(fixture, 'home');
  const outside = path.join(fixture, 'outside-codex');
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const quickReference = Buffer.from('# ㅅㅋㅅ\nInstall scope: `project`\nFiles: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md\nUse `$Team`.\n');
    const config = Buffer.from('[profiles.sks-team]\nmodel_reasoning_effort = "medium"\n');
    const profile = Buffer.from('customer profile bytes\n');
    await fs.writeFile(path.join(outside, 'SNEAKOSCOPE.md'), quickReference);
    await fs.writeFile(path.join(outside, 'config.toml'), config);
    await fs.writeFile(path.join(outside, 'sks-team.config.toml'), profile);
    await fs.symlink(outside, path.join(root, '.codex'));

    const report = await reconcileCurrentProjectGuidance({ root, home, fix: true });
    assert.equal(report.ok, false);
    assert.ok(report.error_count > 0);
    assert.ok(report.remaining_count > 0);
    assert.equal((await fs.lstat(path.join(root, '.codex'))).isSymbolicLink(), true);
    assert.deepEqual(await fs.readFile(path.join(outside, 'SNEAKOSCOPE.md')), quickReference);
    assert.deepEqual(await fs.readFile(path.join(outside, 'config.toml')), config);
    assert.deepEqual(await fs.readFile(path.join(outside, 'sks-team.config.toml')), profile);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('doctor reconciles nested project AGENTS.md without entering excluded or symlinked roots', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-guidance-nested-project-'));
  const project = path.join(fixture, 'project');
  const home = path.join(project, 'customer-home');
  const globalRuntimeRoot = path.join(project, 'customer-global-runtime');
  const outsideDirectory = path.join(fixture, 'outside-directory');
  const outsideFile = path.join(fixture, 'outside-file-AGENTS.md');
  try {
    for (const root of [project, home, globalRuntimeRoot, outsideDirectory]) await fs.mkdir(root, { recursive: true });
    const nestedManaged = path.join(project, 'packages', 'app', 'AGENTS.md');
    const nestedQuickReference = path.join(project, 'packages', 'app', '.codex', 'SNEAKOSCOPE.md');
    const nestedConfig = path.join(project, 'packages', 'app', '.codex', 'config.toml');
    const nestedProfile = path.join(project, 'packages', 'app', '.codex', 'sks-team.config.toml');
    const nestedUser = path.join(project, 'services', 'api', 'AGENTS.md');
    const nestedUserBytes = Buffer.from('# Customer API guidance\nRun `sks agent run` for this service.\n');
    await writeText(nestedManaged, legacyManagedAgents());
    await writeText(nestedQuickReference, legacyManagedQuickReference());
    await writeText(nestedConfig, '[profiles.sks-team]\nservice_tier = "fast"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "medium"\n');
    await writeText(nestedProfile, 'service_tier = "fast"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "medium"\n');
    await writeBytes(nestedUser, nestedUserBytes);

    const excludedFiles = [
      path.join(project, 'node_modules', 'dependency', 'AGENTS.md'),
      path.join(project, 'build', 'generated', 'AGENTS.md'),
      path.join(project, 'dist', 'bundle', 'AGENTS.md'),
      path.join(project, '.sneakoscope', 'quarantine', 'old', 'AGENTS.md'),
      path.join(project, '.venv', 'site-packages', 'AGENTS.md'),
      path.join(project, 'venv', 'site-packages', 'AGENTS.md'),
      path.join(project, 'target', 'debug', 'AGENTS.md'),
      path.join(project, '.cache', 'generated', 'AGENTS.md'),
      path.join(project, '.tox', 'py', 'AGENTS.md'),
      path.join(project, '__pycache__', 'generated', 'AGENTS.md'),
      path.join(project, 'Pods', 'Dependency', 'AGENTS.md'),
      path.join(project, 'DerivedData', 'Build', 'AGENTS.md')
    ];
    const excludedBytes = Buffer.from(legacyManagedAgents());
    for (const file of excludedFiles) await writeBytes(file, excludedBytes);

    const homeNested = path.join(home, 'projects', 'customer', 'AGENTS.md');
    const globalNested = path.join(globalRuntimeRoot, 'projects', 'customer', 'AGENTS.md');
    await writeBytes(homeNested, excludedBytes);
    await writeBytes(globalNested, excludedBytes);

    const outsideDirectoryAgents = path.join(outsideDirectory, 'AGENTS.md');
    const outsideDirectoryBytes = Buffer.from('# Outside directory\nUse `$Team`.\n');
    const outsideFileBytes = Buffer.from('# Outside file\nUse `sks mad-db run`.\n');
    await fs.writeFile(outsideDirectoryAgents, outsideDirectoryBytes);
    await fs.writeFile(outsideFile, outsideFileBytes);
    await fs.symlink(outsideDirectory, path.join(project, 'linked-directory'));
    await fs.mkdir(path.join(project, 'linked-file'), { recursive: true });
    await fs.symlink(outsideFile, path.join(project, 'linked-file', 'AGENTS.md'));

    const first = await reconcileCurrentProjectGuidance({ root: project, home, globalRuntimeRoot, fix: true });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.reconciled_count >= 2, JSON.stringify(first));

    const managedAfter = await fs.readFile(nestedManaged, 'utf8');
    const quickReferenceAfter = await fs.readFile(nestedQuickReference, 'utf8');
    const userAfter = await fs.readFile(nestedUser, 'utf8');
    assert.match(managedAfter, /BEGIN Sneakoscope Codex GX MANAGED BLOCK/);
    assert.match(userAfter, /BEGIN Sneakoscope Codex GX MANAGED BLOCK/);
    assert.match(quickReferenceAfter, /\$sks-naruto|Codex official subagent workflow/);
    for (const text of [managedAfter, quickReferenceAfter, userAfter]) assert.doesNotMatch(text, /\$Team|\$Agent|\$Ralph|sks team|sks agent|sks mad-db|sks ralph|sks db/i);
    assert.doesNotMatch(await fs.readFile(nestedConfig, 'utf8'), /profiles\.sks-team/);
    await assert.rejects(fs.access(nestedProfile));
    const quarantinedAgents = await findFiles(path.join(project, '.sneakoscope', 'quarantine'), 'AGENTS.md');
    const quarantinedUserAgents = [];
    for (const file of quarantinedAgents) {
      if ((await fs.readFile(file)).equals(nestedUserBytes)) quarantinedUserAgents.push(file);
    }
    assert.equal(quarantinedUserAgents.length, 1);

    for (const file of excludedFiles) assert.deepEqual(await fs.readFile(file), excludedBytes);
    assert.deepEqual(await fs.readFile(homeNested), excludedBytes);
    assert.deepEqual(await fs.readFile(globalNested), excludedBytes);
    assert.deepEqual(await fs.readFile(outsideDirectoryAgents), outsideDirectoryBytes);
    assert.deepEqual(await fs.readFile(outsideFile), outsideFileBytes);
    assert.equal((await fs.lstat(path.join(project, 'linked-directory'))).isSymbolicLink(), true);
    assert.equal((await fs.lstat(path.join(project, 'linked-file', 'AGENTS.md'))).isSymbolicLink(), true);

    const second = await reconcileCurrentProjectGuidance({ root: project, home, globalRuntimeRoot, fix: true });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.detected_count, 0);
    assert.equal(second.reconciled_count, 0);
    assert.equal((await findFiles(path.join(project, '.sneakoscope', 'quarantine'), 'AGENTS.md')).length, 2);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('5000+ directory guidance scan reports non-blocking truncation with cutoff evidence', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-guidance-truncation-warning-'));
  const project = path.join(fixture, 'project');
  const home = path.join(fixture, 'home');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  try {
    await Promise.all([project, home, globalRuntimeRoot].map((directory) => fs.mkdir(directory, { recursive: true })));
    const directories = Array.from({ length: 5_001 }, (_, index) =>
      path.join(project, `workspace-${String(index).padStart(5, '0')}`));
    for (let offset = 0; offset < directories.length; offset += 128) {
      await Promise.all(directories.slice(offset, offset + 128).map((directory) => fs.mkdir(directory)));
    }

    const report = await reconcileCurrentProjectGuidance({
      root: project,
      home,
      globalRuntimeRoot,
      fix: false
    });

    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.remaining_count, 0, JSON.stringify(report));
    assert.equal(report.error_count, 0, JSON.stringify(report));
    assert.equal(report.warnings.length, 1, JSON.stringify(report));
    const warning = report.warnings[0];
    assert.equal(warning.code, 'guidance_scan_truncated');
    assert.equal(warning.cutoff_reason, 'directory_limit');
    assert.equal(warning.directory_limit, 4_096);
    assert.equal(warning.depth_limit, 12);
    assert.equal(warning.visited_directory_count, 4_096);
    assert.ok(warning.exceeded_directory_count > 0, JSON.stringify(warning));
    assert.ok(warning.cutoff_path.startsWith(project + path.sep), JSON.stringify(warning));
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('doctor keeps nested guidance top-level-only when the project root is HOME or SKS_GLOBAL_ROOT', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-guidance-equal-roots-'));
  const home = path.join(fixture, 'home');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  try {
    const homeNested = path.join(home, 'customer', 'AGENTS.md');
    const globalNested = path.join(globalRuntimeRoot, 'customer', 'AGENTS.md');
    const legacyBytes = Buffer.from(legacyManagedAgents());
    await writeBytes(homeNested, legacyBytes);
    await writeBytes(globalNested, legacyBytes);

    const homeReport = await reconcileCurrentProjectGuidance({
      root: home,
      home,
      globalRuntimeRoot,
      fix: true
    });
    const globalReport = await reconcileCurrentProjectGuidance({
      root: globalRuntimeRoot,
      home,
      globalRuntimeRoot,
      fix: true
    });

    assert.equal(homeReport.ok, true, JSON.stringify(homeReport));
    assert.equal(globalReport.ok, true, JSON.stringify(globalReport));
    assert.deepEqual(await fs.readFile(homeNested), legacyBytes);
    assert.deepEqual(await fs.readFile(globalNested), legacyBytes);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('doctor guidance cleanup reconciles project, HOME, and SKS_GLOBAL_ROOT and quarantines user conflicts byte-for-byte', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-guidance-global-roots-'));
  const project = path.join(fixture, 'project');
  const home = path.join(fixture, 'home');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  try {
    for (const root of [project, home, globalRuntimeRoot]) await fs.mkdir(path.join(root, '.codex'), { recursive: true });

    const falsePositiveAgents = Buffer.from([
      '# Customer instructions',
      'Use `sks agent-bridge setup --json`.',
      'Keep `sks --agent-model gpt-5.6`, `AGENT_BRIDGE_READY`, `sks teamcity status`, and `sks mad-db2 run`.',
      ''
    ].join('\n'));
    const falsePositiveQuickReference = Buffer.from('Customer quick reference: sks agent-bridge status; sks --agent-model gpt-5.6.\n');
    await fs.writeFile(path.join(project, 'AGENTS.md'), falsePositiveAgents);
    await fs.writeFile(path.join(project, '.codex', 'SNEAKOSCOPE.md'), falsePositiveQuickReference);

    for (const root of [home, globalRuntimeRoot]) {
      await fs.writeFile(path.join(root, 'AGENTS.md'), legacyManagedAgents());
      await fs.writeFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), legacyManagedQuickReference());
    }

    await fs.writeFile(path.join(home, '.codex', 'config.toml'), [
      'profile = "sks-team"',
      'model = "future-model"',
      '',
      '[profiles.sks-team]',
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_reasoning_effort = "medium"',
      '',
      '[auto_review]',
      `policy = "${RETIRED_POLICY}"`,
      ''
    ].join('\n'));
    await fs.writeFile(path.join(home, '.codex', 'sks-team.config.toml'), [
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_reasoning_effort = "medium"',
      ''
    ].join('\n'));

    const customConfig = Buffer.from([
      'model = "customer-model"',
      '',
      '[profiles.sks-team]',
      'customer_setting = "preserve-in-quarantine"',
      '',
      '[features]',
      'hooks = true',
      ''
    ].join('\n'));
    const customProfile = Buffer.from('customer-owned retired-name profile\n');
    await fs.writeFile(path.join(globalRuntimeRoot, '.codex', 'config.toml'), customConfig);
    await fs.writeFile(path.join(globalRuntimeRoot, '.codex', 'sks-team.config.toml'), customProfile);

    const first = await reconcileCurrentProjectGuidance({ root: project, home, globalRuntimeRoot, fix: true });
    assert.equal(first.ok, true);
    assert.ok(first.reconciled_count >= 8, JSON.stringify(first));
    assert.ok(first.preserved_user_file_count >= 4, JSON.stringify(first));

    assert.deepEqual(await fs.readFile(path.join(project, 'AGENTS.md')), falsePositiveAgents);
    assert.deepEqual(await fs.readFile(path.join(project, '.codex', 'SNEAKOSCOPE.md')), falsePositiveQuickReference);
    for (const root of [home, globalRuntimeRoot]) {
      const agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
      const quickReference = await fs.readFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), 'utf8');
      assert.match(agents, /\$sks-naruto/);
      assert.match(quickReference, /\$sks-naruto|Codex official subagent workflow/);
      assert.doesNotMatch(`${agents}\n${quickReference}`, /\$Team|sks team|\$MAD-DB|sks mad-db|\$Ralph|sks ralph/i);
    }

    const homeConfig = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(homeConfig, /^model = "future-model"$/m);
    assert.match(homeConfig, /\$MAD-SKS/);
    assert.doesNotMatch(homeConfig, /profiles\.sks-team|profile\s*=\s*"sks-team"|\$MAD-DB|sks mad-db/i);
    await assert.rejects(fs.access(path.join(home, '.codex', 'sks-team.config.toml')));

    const globalConfig = await fs.readFile(path.join(globalRuntimeRoot, '.codex', 'config.toml'), 'utf8');
    assert.match(globalConfig, /^model = "customer-model"$/m);
    assert.match(globalConfig, /^\[features\]$/m);
    assert.doesNotMatch(globalConfig, /profiles\.sks-team|customer_setting/);
    await assert.rejects(fs.access(path.join(globalRuntimeRoot, '.codex', 'sks-team.config.toml')));

    const quarantinedConfigs = await findFiles(path.join(globalRuntimeRoot, '.sneakoscope', 'quarantine'), 'config.toml');
    const quarantinedProfiles = await findFiles(path.join(globalRuntimeRoot, '.sneakoscope', 'quarantine'), 'sks-team.config.toml');
    assert.equal(quarantinedConfigs.length, 1);
    assert.equal(quarantinedProfiles.length, 1);
    assert.deepEqual(await fs.readFile(quarantinedConfigs[0]), customConfig);
    assert.deepEqual(await fs.readFile(quarantinedProfiles[0]), customProfile);

    const second = await reconcileCurrentProjectGuidance({ root: project, home, globalRuntimeRoot, fix: true });
    assert.equal(second.ok, true);
    assert.equal(second.detected_count, 0);
    assert.equal(second.reconciled_count, 0);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

function legacyManagedAgents() {
  return [
    '<!-- BEGIN Sneakoscope Codex GX MANAGED BLOCK -->',
    '# Retired SKS guidance',
    '- Use `$Team`, `sks mad-db`, and `$Ralph`.',
    '<!-- END Sneakoscope Codex GX MANAGED BLOCK -->',
    ''
  ].join('\n');
}

function legacyManagedQuickReference() {
  return [
    '# ㅅㅋㅅ',
    'Install scope: `global`',
    'Command: `sks <command>`',
    'Files: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md, .agents/skills, .codex/agents, .sneakoscope/missions.',
    'Use `$Team`, `sks mad-db`, and `sks ralph`.',
    ''
  ].join('\n');
}

async function findFiles(root, fileName) {
  const rows = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const row of rows) {
    const target = path.join(root, row.name);
    if (row.isDirectory()) files.push(...await findFiles(target, fileName));
    else if (row.name === fileName) files.push(target);
  }
  return files;
}

async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

async function writeBytes(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}
