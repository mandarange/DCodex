#!/usr/bin/env node
// @ts-nocheck
// Gate: safety:side-effect-zero
// Proves the requested-scope contract is deny-by-default: only project files are
// mutable, every global/destructive mutation requires explicit confirmation, and
// every applied mutation must be recorded in the mutation ledger with a backup or
// no-op reason. Operates entirely on temp dirs; never touches the real ~/.codex.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root, assertGate, emitGate, importDist } from './gate-lib.js';

const scope = await importDist('core/safety/requested-scope-contract.js');
const ledger = await importDist('core/safety/mutation-ledger.js');
const guardMod = await importDist('core/safety/mutation-guard.js');

const {
  createRequestedScopeContract,
  isMutationAllowed,
  isPathAllowed,
  REQUESTED_SCOPE_CONTRACT_SCHEMA,
  CONFIRMATION_REQUIRED
} = scope;
const { evaluateMutation, recordMutation, mutationLedgerPath, MUTATION_KINDS, MUTATION_LEDGER_SCHEMA } = ledger;
const { guardedWriteFile, guardedRename, guardContextForRoute, MutationGuardViolationError } = guardMod;

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; never fail the gate on teardown
  }
}

const tmpDirs = [];
const summary = { checks: {}, generated_at: new Date().toISOString() };

try {
  // ---------------------------------------------------------------------------
  // Schema + deny-by-default contract surface.
  // ---------------------------------------------------------------------------
  assertGate(
    REQUESTED_SCOPE_CONTRACT_SCHEMA === 'sks.requested-scope-contract.v1',
    'schema: REQUESTED_SCOPE_CONTRACT_SCHEMA mismatch',
    { schema: REQUESTED_SCOPE_CONTRACT_SCHEMA }
  );
  assertGate(
    Array.isArray(CONFIRMATION_REQUIRED) && CONFIRMATION_REQUIRED.length > 0,
    'schema: CONFIRMATION_REQUIRED is not a non-empty array',
    { confirmation_required: CONFIRMATION_REQUIRED }
  );

  const contract = createRequestedScopeContract({
    route: 'MAD',
    userRequest: 'repair project config',
    projectRoot: '/tmp/proj'
  });
  assertGate(
    contract.schema === REQUESTED_SCOPE_CONTRACT_SCHEMA,
    'contract: default contract carries the wrong schema',
    { contract }
  );

  // ---------------------------------------------------------------------------
  // project_files allowed; global/destructive kinds denied by default.
  // ---------------------------------------------------------------------------
  const projectAllowed = isMutationAllowed(contract, 'project_files');
  assertGate(projectAllowed.allowed === true, 'scope: project_files must be allowed', { decision: projectAllowed });

  const globalDenied = isMutationAllowed(contract, 'global_codex_config');
  assertGate(
    globalDenied.allowed === false && globalDenied.reason === 'mutation_not_in_scope:global_codex_config',
    'scope: global_codex_config must be denied (not in scope) by default',
    { decision: globalDenied }
  );

  const pkgDenied = isMutationAllowed(contract, 'package_install');
  assertGate(
    pkgDenied.allowed === false,
    'scope: package_install must be denied by default',
    { decision: pkgDenied }
  );
  const lbAuthDenied = isMutationAllowed(contract, 'codex_lb_auth');
  assertGate(
    lbAuthDenied.allowed === false,
    'scope: codex_lb_auth must be denied by default',
    { decision: lbAuthDenied }
  );
  // process_kill maps to the codex_app_process scope, denied by default.
  const appProcessDenied = isMutationAllowed(contract, 'codex_app_process');
  assertGate(
    appProcessDenied.allowed === false,
    'scope: codex_app_process (process_kill) must be denied by default',
    { decision: appProcessDenied }
  );
  summary.checks.deny_by_default = {
    project_files: projectAllowed.allowed,
    global_codex_config: globalDenied.allowed,
    package_install: pkgDenied.allowed,
    codex_lb_auth: lbAuthDenied.allowed,
    codex_app_process: appProcessDenied.allowed
  };

  // ---------------------------------------------------------------------------
  // Even with an override allowing the kind, confirmation is still required.
  // ---------------------------------------------------------------------------
  const overridden = createRequestedScopeContract({
    route: 'MAD',
    userRequest: 'repair project config',
    projectRoot: '/tmp/proj',
    overrides: { global_codex_config: true }
  });
  const overriddenNoConfirm = isMutationAllowed(overridden, 'global_codex_config');
  assertGate(
    overriddenNoConfirm.allowed === false && overriddenNoConfirm.reason.startsWith('requires_explicit_confirmation'),
    'confirmation: overridden global_codex_config must still require explicit confirmation',
    { decision: overriddenNoConfirm }
  );
  const overriddenConfirmed = isMutationAllowed(overridden, 'global_codex_config', { confirmed: true });
  assertGate(
    overriddenConfirmed.allowed === true,
    'confirmation: confirmed global_codex_config must be allowed',
    { decision: overriddenConfirmed }
  );
  summary.checks.explicit_confirmation = {
    denied_without_confirm: overriddenNoConfirm.allowed,
    allowed_with_confirm: overriddenConfirmed.allowed
  };

  // ---------------------------------------------------------------------------
  // Path scoping: project paths allowed; the global Codex config is forbidden.
  // ---------------------------------------------------------------------------
  const projectPath = isPathAllowed(contract, '/tmp/proj/src/x.ts');
  assertGate(projectPath.allowed === true, 'path: project source path must be allowed', { decision: projectPath });
  const codexConfigPath = isPathAllowed(contract, '~/.codex/config.toml');
  assertGate(
    codexConfigPath.allowed === false && codexConfigPath.reason.startsWith('forbidden_path'),
    'path: ~/.codex/config.toml must be a forbidden path',
    { decision: codexConfigPath }
  );
  summary.checks.path_scope = {
    project_path: projectPath.allowed,
    forbidden_codex_config: codexConfigPath.allowed
  };

  // Guard wrappers must enforce path scope before applying mutations.
  const guardRoot = mkTmp('sks-mutation-guard-path-');
  tmpDirs.push(guardRoot);
  const guardContract = createRequestedScopeContract({
    route: 'guard-fixture',
    userRequest: 'mutate project fixture',
    projectRoot: guardRoot
  });
  guardContract.forbidden_paths.push(path.join(guardRoot, 'forbidden/**'));
  const guardCtx = guardContextForRoute(guardRoot, guardContract, 'side-effect-zero-fixture');
  const insideTarget = path.join(guardRoot, 'ok.txt');
  await guardedWriteFile(guardCtx, insideTarget, 'ok');
  assertGate(fs.existsSync(insideTarget), 'guard path fixture: project file mutation should apply', { insideTarget });
  const outsideTarget = path.join(os.tmpdir(), `sks-outside-${Date.now()}.txt`);
  let outsideBlocked = false;
  try {
    await guardedWriteFile(guardCtx, outsideTarget, 'no');
  } catch (err) {
    outsideBlocked = err instanceof MutationGuardViolationError || String(err?.message || err).includes('path_not_in_scope');
  }
  assertGate(outsideBlocked && !fs.existsSync(outsideTarget), 'guard path fixture: outside project write must fail before apply', { outsideTarget });
  const forbiddenTarget = path.join(guardRoot, 'forbidden', 'no.txt');
  let forbiddenBlocked = false;
  try {
    await guardedWriteFile(guardCtx, forbiddenTarget, 'no');
  } catch (err) {
    forbiddenBlocked = err instanceof MutationGuardViolationError || String(err?.message || err).includes('forbidden_path');
  }
  assertGate(forbiddenBlocked && !fs.existsSync(forbiddenTarget), 'guard path fixture: forbidden path write must fail before apply', { forbiddenTarget });
  const renameSource = path.join(guardRoot, 'rename-source.txt');
  fs.writeFileSync(renameSource, 'keep');
  let renameBlocked = false;
  try {
    await guardedRename(guardCtx, renameSource, path.join(guardRoot, 'forbidden', 'renamed.txt'));
  } catch (err) {
    renameBlocked = err instanceof MutationGuardViolationError || String(err?.message || err).includes('forbidden_path');
  }
  assertGate(renameBlocked && fs.existsSync(renameSource), 'guard path fixture: forbidden rename target must fail before apply', { renameSource });
  summary.checks.mutation_guard_path_scope = {
    project_write_applied: true,
    outside_project_blocked: outsideBlocked,
    forbidden_path_blocked: forbiddenBlocked,
    rename_target_forbidden_blocked: renameBlocked
  };

  // ---------------------------------------------------------------------------
  // Mutation ledger violations.
  // ---------------------------------------------------------------------------
  assertGate(
    MUTATION_LEDGER_SCHEMA === 'sks.mutation-ledger.v1',
    'ledger: MUTATION_LEDGER_SCHEMA mismatch',
    { schema: MUTATION_LEDGER_SCHEMA }
  );

  // Applied global_config_write with no scope permission -> violation.
  const appliedOutOfScope = evaluateMutation(contract, 'global_config_write', {
    target: '~/.codex/config.toml',
    applied: true
  });
  assertGate(
    appliedOutOfScope.violation === true,
    'ledger: global config write applied out of scope must be a violation',
    { entry: appliedOutOfScope }
  );

  // Allowed (overridden + confirmed) global config write applied WITHOUT a
  // backup/no-op reason -> still a violation (config mutations need a backup).
  const configContract = createRequestedScopeContract({
    route: 'MAD',
    userRequest: 'repair project config',
    projectRoot: '/tmp/proj',
    overrides: { global_codex_config: true }
  });
  const configNoBackup = evaluateMutation(configContract, 'global_config_write', {
    target: 'x',
    confirmed: true,
    applied: true,
    backupPath: null,
    noOpReason: null
  });
  assertGate(
    configNoBackup.violation === true,
    'ledger: in-scope config write applied without backup/no-op reason must be a violation',
    { entry: configNoBackup }
  );

  // Allowed project_files file_write applied -> no violation.
  const projectWrite = evaluateMutation(contract, 'file_write', {
    target: '/tmp/proj/src/x.ts',
    applied: true,
    backupPath: null,
    noOpReason: null
  });
  assertGate(
    projectWrite.violation === false && projectWrite.requested_scope_allowed === true,
    'ledger: allowed project file_write must not be a violation',
    { entry: projectWrite }
  );
  summary.checks.ledger_violations = {
    applied_out_of_scope: appliedOutOfScope.violation,
    config_without_backup: configNoBackup.violation,
    project_write_ok: projectWrite.violation === false
  };

  // ---------------------------------------------------------------------------
  // No-mutation-without-ledger: required kinds are recordable, and recordMutation
  // produces the ledger file on disk.
  // ---------------------------------------------------------------------------
  const requiredKinds = [
    'file_write',
    'global_config_write',
    'package_install',
    'process_kill',
    'codex_app_flag_change',
    'codex_lb_auth_change',
    'skill_snapshot_promotion'
  ];
  for (const kind of requiredKinds) {
    assertGate(
      MUTATION_KINDS.includes(kind),
      `ledger: MUTATION_KINDS is missing required kind '${kind}'`,
      { mutation_kinds: MUTATION_KINDS }
    );
  }

  const ledgerRoot = mkTmp('sks-side-effect-ledger-');
  tmpDirs.push(ledgerRoot);
  const recordedPath = await recordMutation(ledgerRoot, projectWrite);
  assertGate(
    recordedPath === mutationLedgerPath(ledgerRoot) && fs.existsSync(recordedPath),
    'ledger: recordMutation did not write the ledger file at mutationLedgerPath',
    { recorded_path: recordedPath, expected: mutationLedgerPath(ledgerRoot) }
  );
  summary.checks.no_mutation_without_ledger = {
    required_kinds_present: true,
    ledger_file_written: true
  };

  // ---------------------------------------------------------------------------
  // Write the report and emit the gate.
  // ---------------------------------------------------------------------------
  const reportDir = path.join(root, '.sneakoscope', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'side-effect-zero.json');
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ schema: 'sks.side-effect-zero.v1', ok: true, ...summary }, null, 2)}\n`,
    'utf8'
  );

  emitGate('safety:side-effect-zero', {
    report_path: reportPath,
    checks_performed: [
      'deny_by_default',
      'explicit_confirmation',
      'path_scope',
      'mutation_guard_path_scope',
      'ledger_violations',
      'no_mutation_without_ledger'
    ]
  });
} finally {
  for (const dir of tmpDirs) rmTmp(dir);
}
