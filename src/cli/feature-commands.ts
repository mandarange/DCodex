import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { exists, projectRoot, readJson, writeJsonAtomic } from '../core/fsx.js';
import { CODEX_ACCESS_TOKENS_DOCS_URL } from '../core/codex-app.js';
import { redactSecrets } from '../core/secret-redaction.js';
import { evaluateHookPayload } from '../core/hooks-runtime.js';
import { buildAllFeaturesSelftest, buildFeatureRegistry, validateFeatureRegistry, writeAllFeatureCompletionReport, writeFeatureInventoryDocs } from '../core/feature-registry.js';
import { recordHookPolicyMismatchWrongness } from '../core/triwiki-wrongness/wrongness-ledger.js';
import { codexSchemaSnapshotReport } from '../core/codex-compat/codex-schema-snapshot.js';
import { validateCodexFixtureOutputs } from '../core/codex-compat/codex-hook-schema.js';
import { codexHookWarningCheck } from '../core/codex-compat/codex-hook-warning-detector.js';
import { codexHookTrustDoctor } from '../core/codex-hooks/codex-hook-trust-doctor.js';
import { writeTrustedHashStateForHooksFile } from '../core/codex-hooks/codex-hook-state-writer.js';
import { installManagedCodexHooks } from '../core/codex-hooks/codex-hook-managed-install.js';
import { writeCodexHookOfficialParityReport } from '../core/codex-hooks/codex-hook-official-parity.js';

const flag = (args: any, name: any) => args.includes(name);

export async function featuresCommand(sub: any = 'list', args: any = []) {
  const action = sub || 'list';
  const root = await projectRoot();
  if (action === 'list' || action === 'status' || action === 'registry') {
    const registry = await buildFeatureRegistry({ root });
    if (flag(args, '--json')) return console.log(JSON.stringify(registry, null, 2));
    printFeatureRegistrySummary(registry);
    if (!registry.coverage.ok) process.exitCode = 1;
    return;
  }
  if (action === 'check') {
    const registry = await buildFeatureRegistry({ root });
    const coverage = validateFeatureRegistry(registry);
    const result = { schema: 'sks.feature-registry-check.v1', generated_at: registry.generated_at, ok: coverage.ok, coverage };
    if (flag(args, '--json')) console.log(JSON.stringify(result, null, 2));
    else printFeatureCoverage(coverage);
    if (!coverage.ok) process.exitCode = 1;
    return;
  }
  if (action === 'inventory') {
    const writeDocs = flag(args, '--write-docs');
    const result = writeDocs
      ? await writeFeatureInventoryDocs({ root })
      : { ok: true, registry: await buildFeatureRegistry({ root }), path: path.join(root, 'docs', 'feature-inventory.md') };
    if (flag(args, '--json')) return console.log(JSON.stringify({ ok: result.ok, path: result.path, coverage: result.registry.coverage }, null, 2));
    if (writeDocs) console.log(`Feature inventory written: ${path.relative(root, result.path)}`);
    printFeatureRegistrySummary(result.registry);
    if (!result.registry.coverage.ok) process.exitCode = 1;
    return;
  }
  if (action === 'complete') {
    const report = await writeAllFeatureCompletionReport({ root });
    if (!report.ok) process.exitCode = report.status === 'contract_covered_unverified' ? 2 : 1;
    if (flag(args, '--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`All feature completion: ${report.status}`);
      console.log(`Report: ${path.relative(root, report.files.json)}`);
    }
    return;
  }
  console.error('Usage: sks features list|check|inventory|complete [--json] [--write-docs]');
  process.exitCode = 1;
}

export async function allFeaturesCommand(sub: any = 'selftest', args: any = []) {
  const action = sub || 'selftest';
  if (action === 'complete' || action === 'completion') {
    const root = await projectRoot();
    const report = await writeAllFeatureCompletionReport({ root });
    if (!report.ok) process.exitCode = report.status === 'contract_covered_unverified' ? 2 : 1;
    if (flag(args, '--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`All feature completion: ${report.status}`);
      console.log(`Report: ${path.relative(root, report.files.json)}`);
    }
    return;
  }
  if (action !== 'selftest') {
    console.error('Usage: sks all-features selftest|complete --mock [--execute-fixtures] [--json]');
    process.exitCode = 1;
    return;
  }
  const root = await projectRoot();
  const registry = await buildFeatureRegistry({ root });
  const result = buildAllFeaturesSelftest(registry, { executeFixtures: flag(args, '--execute-fixtures'), strictArtifacts: flag(args, '--strict-artifacts'), root });
  if (flag(args, '--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('SKS all-features selftest');
    console.log(`Status: ${result.status}`);
    for (const check of result.checks) console.log(`- ${check.ok ? 'ok' : 'blocked'} ${check.id}${check.blockers.length ? `: ${check.blockers.join(', ')}` : ''}`);
    if (result.note) console.log(`\n${result.note}`);
  }
  if (!result.ok) process.exitCode = 1;
}

export async function hooksCommand(sub: any = 'explain', args: any = []) {
  const action = sub || 'explain';
  const root = await projectRoot();
  if (action === 'status') {
    const report = await hooksStatusReport(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Hooks: ${report.ok ? 'ok' : 'missing'}`);
    for (const file of report.hooks_files) console.log(`- ${file.path}: ${file.exists ? 'present' : 'missing'}`);
    return;
  }
  if (action === 'trust-report') {
    const report = await hooksTrustReport(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Hooks trust report: ${report.ok ? 'ok' : 'blocked'}`);
    for (const event of report.events) console.log(`- ${event.event}: ${event.command}`);
    return;
  }
  if (action === 'doctor' || action === 'trust-doctor') {
    const report = await codexHookTrustDoctor(root, { fix: flag(args, '--fix'), managed: flag(args, '--managed'), actual: flag(args, '--actual') });
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Hooks trust doctor: ${report.ok ? 'ok' : 'blocked'}`);
    for (const warning of report.warnings) console.log(`- ${warning}`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === 'trust-state') {
    const report = await codexHookTrustDoctor(root, { managed: flag(args, '--managed'), actual: flag(args, '--actual') });
    const anyReport = report as any;
    if (flag(args, '--json')) return console.log(JSON.stringify({ schema: flag(args, '--actual') ? 'sks.codex-hook-trust-state-command.v2' : 'sks.codex-hook-trust-state-command.v1', ok: report.ok, actual: flag(args, '--actual'), entries: report.entries, trust: report.trust, sources: anyReport.sources || [], managed_dirs: anyReport.managed_dirs || [], blockers: anyReport.blockers || [] }, null, 2));
    console.log(`Hook trust entries: ${report.entries.length}`);
    return;
  }
  if (action === 'trust-fix') {
    const report = await codexHookTrustDoctor(root, { fix: true, managed: flag(args, '--managed') });
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Hooks trust fix: ${report.ok ? 'ok' : 'blocked'}`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === 'repair') {
    if (flag(args, '--trusted')) {
      const parity = await writeCodexHookOfficialParityReport(root);
      if (!parity.official_hash_available) {
        const blocked = {
          schema: 'sks.codex-hooks-repair.v1',
          ok: false,
          mode: 'trusted',
          status: 'blocked',
          blocker: 'official_hash_oracle_unavailable',
          next_command: 'sks hooks repair --managed --json',
          parity
        };
        if (flag(args, '--json')) return console.log(JSON.stringify(blocked, null, 2));
        console.log('Hooks trusted repair blocked: official hash oracle unavailable. Run `sks hooks repair --managed --json`.');
        process.exitCode = 1;
        return;
      }
    }
    const projectReport = await installManagedCodexHooks(root);
    const userReport = await installManagedCodexHooks(root, {
      requirementsPath: path.join(os.homedir(), '.codex', 'requirements.toml'),
      managedDir: path.join(os.homedir(), '.codex', 'managed-hooks')
    });
    const actual = await codexHookTrustDoctor(root, { actual: true });
    const result = {
      schema: 'sks.codex-hooks-repair.v1',
      ok: Boolean(projectReport.ok && userReport.ok && actual.ok),
      mode: 'managed',
      root,
      project_install: projectReport,
      user_install: userReport,
      actual_trust: actual.trust,
      managed_dirs: (actual as any).managed_dirs || [],
      blockers: (actual as any).blockers || [],
      next_command: 'sks hooks trust-doctor --actual --json',
      actions: ['project_requirements_toml_managed_install', 'user_requirements_toml_managed_install']
    };
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Hooks managed repair: ${result.ok ? 'ok' : 'blocked'}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'install') {
    const report = flag(args, '--managed')
      ? await installManagedCodexHooks(root)
      : await writeTrustedHashStateForHooksFile(root, undefined, undefined, { allowSksHashFallback: flag(args, '--trusted'), reason: 'Use --managed unless you intentionally accept SKS-only trusted_hash fallback with --trusted.' });
    if (flag(args, '--json')) return console.log(JSON.stringify({ ...report, schema: flag(args, '--managed') ? 'sks.codex-hooks-managed-install.v1' : 'sks.codex-hook-install-command.v2', mode: flag(args, '--managed') ? 'managed' : flag(args, '--project') ? 'project' : 'trust-state-only', trusted: flag(args, '--trusted') }, null, 2));
    console.log(flag(args, '--managed') ? `Hooks managed install: ${report.ok ? 'ok' : 'blocked'}` : `Hooks install trust state: ${report.ok ? 'ok' : 'blocked'}`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === 'actual-parity' || action === 'official-parity' || (action === 'parity' && flag(args, '--official'))) {
    const report = await writeCodexHookOfficialParityReport(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Hooks official parity: ${report.ok ? 'ok' : 'blocked'} (${report.path})`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === 'replay') {
    const fixture = args.find((arg: any) => !String(arg).startsWith('--'));
    const report = await hooksReplayReport(root, fixture);
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Hook replay: ${report.ok ? 'ok' : 'blocked'} ${report.event || 'unknown'}`);
    if (report.decision) console.log(`Decision: ${report.decision}`);
    return;
  }
  if (action === 'codex-schema') {
    const report = await codexSchemaSnapshotReport();
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Codex hook schema snapshot: ${report.ok ? 'ok' : 'blocked'} (${report.baseline})`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === 'codex-validate') {
    const report = await validateCodexFixtureOutputs(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Codex hook output validation: ${report.ok ? 'ok' : 'blocked'} (${report.checked} fixture outputs)`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === 'warning-check') {
    const report = await codexHookWarningCheck(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Codex hook warning check: ${report.ok ? 'ok' : 'blocked'} (${report.warnings_count} warnings)`);
    for (const warning of report.warnings) console.log(`- ${warning}`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action === 'replay-codex-fixtures') {
    const report = await codexHookWarningCheck(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Codex hook fixture replay: ${report.ok ? 'ok' : 'blocked'} (${report.warnings_count} warnings)`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (action !== 'explain') {
    console.error('Usage: sks hooks explain|status|doctor|trust-report|trust-state|trust-doctor|trust-fix|install|repair|actual-parity|official-parity|parity --official|replay <fixture.json>|codex-schema|codex-validate|warning-check|replay-codex-fixtures [--json]');
    process.exitCode = 1;
    return;
  }
  const report = hooksExplainReport();
  if (flag(args, '--json')) return console.log(JSON.stringify(report, null, 2));
  console.log('SKS hooks explain\n');
  console.log(`Status: ${report.status}`);
  console.log(`Feature key: ${report.feature_key}`);
  console.log(`Config paths: ${report.config_paths.join(', ')}`);
  console.log(`Events: ${report.events.join(', ')}`);
  console.log(`Handlers: ${report.handlers.supported.join(', ')} supported; ${report.handlers.parsed_but_skipped.join(', ')} parsed but skipped`);
  console.log('\nPolicies:');
  for (const policy of report.sks_policies) console.log(`- ${policy}`);
  console.log('\nSources:');
  for (const source of report.sources) console.log(`- ${source.title}: ${source.url}`);
}

async function hooksStatusReport(root: any) {
  const files = [
    path.join(os.homedir(), '.codex', 'hooks.json'),
    path.join(root, '.codex', 'hooks.json')
  ];
  const hooksFiles: any[] = [];
  for (const file of files) {
    hooksFiles.push({ path: file, exists: await exists(file) });
  }
  return {
    schema: 'sks.hooks-status.v1',
    hooks_files: hooksFiles,
    ok: hooksFiles.some((file: any) => file.exists)
  };
}

async function hooksTrustReport(root: any) {
  const status = await hooksStatusReport(root);
  const trust = await codexHookTrustDoctor(root).catch(() => null);
  return redactSecrets({
    schema: 'sks.hooks-trust-report.v1',
    hooks_files: status.hooks_files.map((file: any) => file.path),
    events: [
      { event: 'SessionStart', command: 'sks hook session-start', writes: ['.sneakoscope/state'], network: false, secret_policy: 'redacted', risk: 'low' },
      { event: 'PreToolUse', command: 'sks hook pre-tool', writes: ['.sneakoscope/bus/tool-events.jsonl'], network: false, secret_policy: 'redacted', risk: 'medium' },
      { event: 'PermissionRequest', command: 'sks hook permission-request', writes: ['.sneakoscope/state'], network: false, secret_policy: 'redacted', risk: 'medium' },
      { event: 'PostToolUse', command: 'sks hook post-tool', writes: ['.sneakoscope/missions'], network: false, secret_policy: 'redacted', risk: 'medium' },
      { event: 'PreCompact', command: 'sks hook pre-compact', writes: ['.sneakoscope/state'], network: false, secret_policy: 'redacted', risk: 'low' },
      { event: 'PostCompact', command: 'sks hook post-compact', writes: ['.sneakoscope/state'], network: false, secret_policy: 'redacted', risk: 'low' },
      { event: 'UserPromptSubmit', command: 'sks hook user-prompt-submit', writes: ['.sneakoscope/missions'], network: false, secret_policy: 'redacted', risk: 'medium' },
      { event: 'SubagentStart', command: 'sks hook subagent-start', writes: ['.sneakoscope/missions'], network: false, secret_policy: 'redacted', risk: 'low' },
      { event: 'SubagentStop', command: 'sks hook subagent-stop', writes: ['.sneakoscope/missions'], network: false, secret_policy: 'redacted', risk: 'low' },
      { event: 'Stop', command: 'sks hook stop', writes: ['.sneakoscope/missions', '.sneakoscope/proof'], network: false, secret_policy: 'redacted', risk: 'high' }
    ],
    trust,
    ok: status.ok && (trust?.ok ?? true),
    warnings: [...(status.ok ? [] : ['no hooks.json file found in project or user config']), ...(trust?.warnings || [])]
  });
}

async function hooksReplayReport(root: any, fixturePath: any) {
  if (!fixturePath) return { schema: 'sks.hooks-replay.v1', ok: false, reason: 'fixture_required' };
  const absolute = path.resolve(fixturePath);
  const fixture = await readJson(absolute, {});
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-hooks-replay-'));
  const payload = { ...(fixture.payload || fixture), cwd: tempRoot };
  const state = fixture.state || {};
  if (state.mission_id && fixture.proof) {
    await writeJsonAtomic(path.join(tempRoot, '.sneakoscope', 'missions', state.mission_id, 'completion-proof.json'), fixture.proof);
  }
  const event = fixture.event || fixture.hook_event_name || fixture.name || 'unknown';
  const hookName = normalizeReplayHookName(event);
  const runtime = await evaluateHookPayload(hookName, payload, { root: tempRoot, state });
  const decision = runtime.decision || runtime.permissionDecision || (runtime.continue === true ? 'continue' : 'continue');
  const expected = await readExpectedReplay(absolute);
  const comparable = {
    decision,
    permissionDecision: runtime.permissionDecision || null,
    reason: runtime.reason || 'fixture_safe',
    gate: runtime.gate || runtime.hookSpecificOutput?.gate || null,
    missing: runtime.missing || runtime.hookSpecificOutput?.missing || [],
    issues: runtime.issues || runtime.hookSpecificOutput?.issues || runtime.missing || [],
    continue: runtime.continue,
    secret_policy: 'redacted'
  };
  const match = expected ? matchHookExpected(comparable, expected) : { ok: decision !== 'block' && decision !== 'deny', failures: [] };
  const matchesExpected = expected ? match.ok : null;
  const ok = match.ok;
  const wrongness = expected && !match.ok
    ? await recordHookPolicyMismatchWrongness(root, {
        artifact: path.relative(root, absolute).startsWith('..') ? absolute : path.relative(root, absolute),
        expected: JSON.stringify(expected),
        actual: JSON.stringify(comparable),
        detail: match.failures.join(', '),
        route: '$Hooks'
      })
    : null;
  return redactSecrets({
    schema: 'sks.hooks-replay.v1',
    ok,
    event,
    hook: hookName,
    command: payload.command || payload.tool_input?.command || payload.toolInput?.command || payload.input?.command || '',
    decision,
    permissionDecision: comparable.permissionDecision,
    reason: comparable.reason,
    gate: comparable.gate,
    missing: comparable.missing,
    issues: comparable.issues,
    continue: comparable.continue,
    matches_expected: matchesExpected,
    expected_failures: match.failures,
    secret_policy: 'redacted',
    wrongness
  });
}

function matchHookExpected(actual: any = {}, expected: any = {}) {
  const failures: any[] = [];
  if (expected.decision !== undefined && expected.decision !== actual.decision) failures.push(`decision:${actual.decision}`);
  if (expected.permissionDecision !== undefined && expected.permissionDecision !== actual.permissionDecision) failures.push(`permissionDecision:${actual.permissionDecision}`);
  if (expected.reason !== undefined && expected.reason !== actual.reason) failures.push('reason');
  if (expected.reason_contains !== undefined && !String(actual.reason || '').includes(expected.reason_contains)) failures.push('reason_contains');
  if (expected.gate !== undefined && expected.gate !== actual.gate) failures.push(`gate:${actual.gate}`);
  if (expected.continue !== undefined && expected.continue !== actual.continue) failures.push(`continue:${actual.continue}`);
  for (const item of expected.missing_contains || []) {
    if (!containsValue(actual.missing, item)) failures.push(`missing_contains:${item}`);
  }
  for (const item of expected.issues_contains || []) {
    if (!containsValue(actual.issues, item) && !containsValue(actual.missing, item) && !String(actual.reason || '').includes(item)) failures.push(`issues_contains:${item}`);
  }
  if (expected.secret_policy !== undefined && expected.secret_policy !== actual.secret_policy) failures.push(`secret_policy:${actual.secret_policy}`);
  return { ok: failures.length === 0, failures };
}

function containsValue(values: any, item: any) {
  const list = Array.isArray(values) ? values : [values].filter(Boolean);
  return list.some((value: any) => String(value || '').includes(item));
}

function normalizeReplayHookName(event: any = '') {
  const normalized = String(event || '').replace(/[_\s]+/g, '-').toLowerCase();
  if (normalized.includes('pretool') || normalized.includes('pre-tool')) return 'pre-tool';
  if (normalized.includes('permission')) return 'permission-request';
  if (normalized.includes('userprompt') || normalized.includes('user-prompt')) return 'user-prompt-submit';
  if (normalized.includes('posttool') || normalized.includes('post-tool')) return 'post-tool';
  if (normalized.includes('sessionstart') || normalized.includes('session-start')) return 'session-start';
  if (normalized.includes('subagentstart') || normalized.includes('subagent-start')) return 'subagent-start';
  if (normalized.includes('subagentstop') || normalized.includes('subagent-stop')) return 'subagent-stop';
  if (normalized.includes('precompact') || normalized.includes('pre-compact')) return 'pre-compact';
  if (normalized.includes('postcompact') || normalized.includes('post-compact')) return 'post-compact';
  if (normalized.includes('stop')) return 'stop';
  return normalized || 'pre-tool';
}

async function readExpectedReplay(fixturePath: any) {
  const expectedPath = path.join(path.dirname(fixturePath), 'expected', `${path.basename(fixturePath, '.json')}.expected.json`);
  if (!await exists(expectedPath)) return null;
  return readJson(expectedPath, null);
}

export function hooksExplainReport() {
  return {
    schema: 'sks.hooks-explain.v1',
    status: 'supported_by_official_docs_and_local_config',
    feature_key: 'features.hooks',
    deprecated_feature_alias: 'features.codex_hooks',
    config_paths: ['~/.codex/hooks.json', '~/.codex/config.toml', '<repo>/.codex/hooks.json', '<repo>/.codex/config.toml'],
    events: ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop'],
    handlers: {
      supported: ['command'],
      parsed_but_skipped: ['prompt', 'agent'],
      async_command_hooks: 'parsed_but_not_supported'
    },
    runtime_notes: [
      'Matching hooks from multiple files all run.',
      'Multiple matching command hooks for the same event are launched concurrently.',
      'Project-local hooks require a trusted project .codex layer.',
      'Repo-local hook commands should resolve from git root instead of assuming the session cwd.'
    ],
    sks_policies: [
      'secret_scan_policy',
      'directory_rule_policy',
      'db_safety_policy',
      'visual_claim_source_policy',
      'proof_required_policy',
      'codex_lb_health_policy'
    ],
    sources: [
      { title: 'OpenAI Codex Hooks', url: 'https://developers.openai.com/codex/hooks' },
      { title: 'OpenAI Codex Configuration Reference', url: 'https://developers.openai.com/codex/config-reference' },
      { title: 'OpenAI Codex Access Tokens', url: CODEX_ACCESS_TOKENS_DOCS_URL }
    ]
  };
}

function printFeatureRegistrySummary(registry: any) {
  console.log('SKS feature registry\n');
  console.log(`Schema:   ${registry.schema}`);
  console.log(`Features: ${registry.features.length}`);
  printFeatureCoverage(registry.coverage);
}

function printFeatureCoverage(coverage: any = {}) {
  console.log(`Coverage: ${coverage.ok ? 'ok' : 'blocked'} (${coverage.status || 'unknown'})`);
  for (const [kind, values] of Object.entries(coverage.unmapped || {}) as Array<[string, any[]]>) {
    console.log(`- ${kind}: ${values.length ? values.join(', ') : 'none'}`);
  }
  if (coverage.blockers?.length) console.log(`Blockers: ${coverage.blockers.join(', ')}`);
}
