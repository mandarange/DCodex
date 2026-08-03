import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ensureDir, exists, globalSksRoot, packageRoot, PACKAGE_VERSION, readText, runProcess, tmpdir, which, writeTextAtomic } from '../core/fsx.js';
import { createRequestedScopeContract } from '../core/safety/requested-scope-contract.js';
import { guardedPackageInstall, guardContextForRoute } from '../core/safety/mutation-guard.js';
import { formatHarnessConflictReport, llmHarnessCleanupPrompt, scanHarnessConflicts } from '../core/harness-conflicts.js';
import { initProject, installGlobalSkills } from '../core/init.js';
import { context7ConfigToml, DOLLAR_SKILL_NAMES, GETDESIGN_REFERENCE, hasContext7ConfigText, RECOMMENDED_SKILLS } from '../core/routes.js';
import { reconcileCodexAppUpgradeProcesses } from '../core/codex-app.js';
import { restartCodexApp } from '../core/codex-app/codex-app-restart.js';
import { cleanupMacLaunchSecretEnvironment } from '../core/codex-app/menubar/index.js';
import { recordCodexLbHealthEvent } from '../core/codex-lb-circuit.js';
import {
  CODEX_LB_SECURE_KEYCHAIN_SERVICE,
  loadCodexLbEnv,
  codexLbMetadataPath
} from '../core/codex-lb/codex-lb-env.js';
import {
  codexLbToolCatalogPath
} from '../core/codex-lb/codex-lb-tool-catalog.js';
import {
  codexLbToolOutputRecoveryNotChecked,
  codexLbToolOutputRecoveryNotSelected,
  codexLbToolOutputRecoveryOverrideAcknowledged,
  probeCodexLbToolOutputRecovery,
  type CodexLbToolOutputRecoveryProbe
} from '../core/codex-lb/codex-lb-tool-output-recovery.js';
import {
  GLM_CODEX_CONFIG_PROFILE_ID,
  GLM_CODEX_CONFIG_PROVIDER_ID,
  GLM_CODEX_CONFIG_REASONING_PROFILES,
  GLM_52_OPENROUTER_MODEL
} from '../core/codex-app/openrouter-provider.js';
import {
  buildCodexLbSetupPlan,
  codexLbPersistenceSummary,
  installCodexLbShellProfileSnippet,
  selectedCodexLbPersistenceModes,
  type CodexLbPersistenceSummary,
  type CodexLbPersistenceMode
} from '../core/codex-lb/codex-lb-setup.js';
import {
  DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT,
  modeRequiresChatGptOAuth,
  parseCodexLbDesktopMode,
  parseCodexLbGatewayAuthTransport,
  type CodexLbDesktopMode,
  type CodexLbGatewayAuthTransport
} from '../core/codex-lb/desktop-mode.js';
import {
  assertDesktopAuthUnchangedBySks,
  captureCodexAuthSnapshot,
  type CodexAuthSnapshot
} from '../core/codex-lb/desktop-auth-invariant.js';
import { extractTomlTable, writeCodexConfigGuarded } from '../core/codex/codex-config-guard.js';
import {
  ensureGlobalCodexFastModeDuringInstall,
  ensureTrailingNewline,
  normalizeCodexFastModeUiConfig,
  removeTopLevelTomlKeyIfValue,
  safeWriteCodexConfigToml,
  upsertTomlTable
} from '../core/codex-runtime/codex-desktop-config-policy.js';
import { runPostinstallGlobalDoctorAndMarkPending } from '../core/update/update-migration-state.js';
import { repairCodexImagegen } from '../core/doctor/imagegen-repair.js';
import {
  canAskYesNo,
  compareVersions,
  hasCodexUnstableFeatureWarningSuppression,
  hasDeprecatedCodexHooksFeatureFlag,
  isProjectSetupCandidate
} from './install-tool-helpers.js';
import { printCodexLbSetupWarnings } from './codex-lb-setup-warning-output.js';
import { checkCodexLbResponseChain } from './install-helpers-codex-lb-chain.js';
import {
  CODEX_LB_CANONICAL_FAST_SERVICE_TIER,
  CODEX_LB_PROVIDER_ENV_KEY,
  askPostinstallQuestion,
  codexAuthChatgptBackupPath,
  codexAuthPath,
  codexLbConfigPath,
  codexLbEnvPath,
  hasTopLevelCodexLbSelected,
  normalizeCodexLbBaseUrl,
  parseCodexLbEnvKey,
  redactSecretText
} from './install-helpers-codex-lb-shared.js';
import {
  CODEX_LB_DESKTOP_BRIDGE_MARKER,
  CODEX_LB_DESKTOP_COMPAT_MARKER,
  CODEX_LB_PROVIDER_SELECTION_MARKER,
  appliedCodexLbPersistenceModes,
  captureCodexLbSetupWriteState,
  codexLbSharedOpenAiRoutingState,
  detectCodexLbSetupDrift,
  ensureGlobalCodexAppGlmProfile,
  ensureStoredOpenRouterProviderDuringInstall,
  hardenCodexLbSetupRecoveryPath,
  removeCodexLbSetupRecoveryPath,
  removeCodexLbOrphanManagedMarkers,
  removeCodexLbSharedOpenAiRouting,
  removeCodexLbManagedDesktopConfig,
  restoreCodexLbSetupWriteState,
  sha256Text,
  shellSingleQuote,
  upsertCodexAppGlmConfig,
  upsertCodexLbConfig,
  upsertCodexLbCliProviderConfig,
  upsertCodexLbCompatDesktopConfig,
  upsertCodexLbNativeDesktopConfig,
  upsertCodexLbSharedOpenAiRouting,
  writeCodexLbSetupFileIfUnchanged
} from './install-helpers-codex-lb-config.js';
import { detectLegacyCodexLbDesktopState } from '../core/codex-lb/legacy-migration.js';
import {
  ensureCodexImagegenDuringInstall,
  ensureGlobalCodexSkillsDuringInstall,
  ensureGlobalContext7DuringInstall,
  ensureGlobalGetdesignSkillDuringInstall,
  ensureSksCommandDuringInstall
} from './install-helpers-install-support.js';
import { escapeRegExp } from '../core/text/regex.js';

function packagedSksEntrypoint() {
  return path.join(packageRoot(), 'dist', 'bin', 'sks.js');
}

export async function postinstall({ bootstrap, args = [] }: any) {
  const installRoot = path.resolve(process.env.INIT_CWD || process.cwd());
  console.log('\nSKS installed.');
  await restoreInstalledPackageBuildStamp();
  if (!postinstallExternalMutationsAllowed(process.env)) {
    console.log('Automatic bootstrap was not run; npm install leaves project, HOME, Codex, and global SKS state unchanged by default.');
    console.log('Next: run `sks bootstrap` when you are ready to initialize SKS.');
    console.log('Dependency diagnostics remain explicit: sks deps check');
    console.log('Explicit lifecycle opt-in: SKS_POSTINSTALL_BOOTSTRAP=1 npm i -g sneakoscope');
    console.log('Optional Homebrew/npm-global tool repair remains off unless SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS=1 is also set.');
    const reason = process.env.SKS_POSTINSTALL_NO_BOOTSTRAP === '1'
      ? 'SKS_POSTINSTALL_NO_BOOTSTRAP=1'
      : 'explicit opt-in required (SKS_POSTINSTALL_BOOTSTRAP=1)';
    console.log(`Reason: ${reason}.`);
    return;
  }

  let codexLbConfigSnapshot: any = null;
  let reconcileCodexLb = false;
  // A failed setup side-effect must never fail `npm i`. Wrap the whole flow; always
  // restore the codex-lb snapshot in finally (even on the early bootstrap return / on throw).
  try {
    const bootstrapDecision = await postinstallBootstrapDecision(installRoot);
    const conflictScan = await scanHarnessConflicts(installRoot);
    if (conflictScan.hard_block) {
      await postinstallHarnessConflictNotice(conflictScan);
      return;
    }
    codexLbConfigSnapshot = await capturePostinstallCodexLbConfigSnapshot();
    reconcileCodexLb = true;
    const shim = await ensureSksCommandDuringInstall();
    if (shim.status === 'present') console.log(`SKS command: available (${shim.command ?? 'unknown'}).`);
    else if (shim.status === 'repaired') console.log(`SKS command: stale PATH shim repaired (${shim.command ?? 'unknown'}).`);
    else if (shim.status === 'created') console.log(`SKS command: shim created at ${shim.command ?? 'unknown'}.`);
    else if (shim.status === 'created_not_on_path') console.log(`SKS command: shim created at ${shim.command ?? 'unknown'}. Add ${path.dirname(shim.command ?? '')} to PATH, or run npx -y -p sneakoscope sks.`);
    else if (shim.status === 'skipped') console.log(`SKS command: skipped (${shim.reason}).`);
    else console.log(`SKS command: shim unavailable. Use npx -y -p sneakoscope sks. ${shim.error || ''}`.trim());
    const context7Install = await ensureGlobalContext7DuringInstall();
    if (context7Install.status === 'present') console.log('Context7 MCP: already configured for Codex.');
    else if (context7Install.status === 'installed') console.log('Context7 MCP: configured for Codex.');
    else if (context7Install.status === 'codex_missing') console.log('Context7 MCP: Codex CLI missing. Install @openai/codex or set SKS_CODEX_BIN, then run `sks context7 setup --scope global` or `sks setup` in a project.');
    else if (context7Install.status === 'skipped') console.log(`Context7 MCP: skipped (${context7Install.reason}).`);
    else if (context7Install.status === 'failed') console.log(`Context7 MCP: auto setup failed. Run \`sks context7 setup --scope global\` or \`sks setup\`. ${context7Install.error || ''}`.trim());
    console.log('Codex App Fast mode: left unchanged during install; use the explicit Fast-mode command to change it.');
    const openRouterProviderRepair = await ensureStoredOpenRouterProviderDuringInstall();
    if (openRouterProviderRepair.status === 'updated') console.log('OpenRouter provider: repaired for the stored key (credentials and active model were preserved).');
    else if (openRouterProviderRepair.status === 'present') console.log('OpenRouter provider: stored-key configuration already compatible.');
    else if (openRouterProviderRepair.status === 'skipped') console.log('OpenRouter provider: no stored key; no provider configuration was added.');
    else if (openRouterProviderRepair.status === 'failed') console.log('OpenRouter provider: stored key was preserved, but provider repair failed. Run `sks doctor --fix`.');
    const imagegenRepair = await ensureCodexImagegenDuringInstall();
    if (imagegenRepair.status === 'ready') console.log('Codex App Image Gen: ready ($imagegen/gpt-image-2 detected).');
    else if (imagegenRepair.status === 'recovered') console.log('Codex App Image Gen: recovered and re-detected. Start a new Codex/Work task; restart the desktop app only if the new task still lacks $imagegen.');
    else if (imagegenRepair.status === 'blocked') console.log(`Codex App Image Gen: blocked; run \`sks doctor --fix\`. ${(imagegenRepair.blockers || []).join(', ')}`.trim());
    else if (imagegenRepair.status === 'skipped') console.log(`Codex App Image Gen: skipped (${imagegenRepair.reason}).`);
    const postinstallDoctor = await runPostinstallGlobalDoctorAndMarkPending({
      env: {
        ...process.env,
        // Postinstall records the pending migration only. Broad Doctor repair is
        // explicit because it may change Codex UI/runtime configuration.
        SKS_POSTINSTALL_GLOBAL_DOCTOR: '0'
      }
    }).catch((err: any) => ({
      ok: false,
      doctor: null,
      pending: null,
      blockers: [err?.message || String(err)],
      warnings: []
    }));
    if (postinstallDoctor.ok) console.log('SKS update migration: pending receipt recorded; no global Doctor repair ran during install.');
    else console.log(`SKS update migration: global Doctor did not complete; first normal command will retry. ${(postinstallDoctor.blockers || []).join(', ')}`.trim());
    const postinstallRetention = await runPostinstallProjectRetentionCleanup(installRoot);
    if (postinstallRetention.status === 'completed' && postinstallRetention.action_count > 0) console.log(`SKS mission cleanup: removed ${postinstallRetention.action_count} disposable runtime artifact(s) from closed missions.`);
    else if (postinstallRetention.status === 'failed') console.log(`SKS mission cleanup: skipped (${postinstallRetention.error || 'cleanup failed'}).`);
    // Terminating a third-party app's processes during `npm i` is unsafe by default; opt-in only.
    const appProcessRepair: any = process.env.SKS_POSTINSTALL_RECONCILE_APP_PROCESSES === '1'
      ? await reconcileCodexAppUpgradeProcesses()
      : { status: 'skipped', reason: 'opt_in_required', killed: [] };
    if (appProcessRepair.status === 'repaired') console.log(`Codex App reconnect repair: stopped ${appProcessRepair.killed.length} stale orphan app-server process(es). Restart Codex App to reconnect cleanly.`);
    else if (appProcessRepair.status === 'partial') console.log(`Codex App reconnect repair: stopped ${appProcessRepair.killed.length} stale orphan app-server process(es); ${(appProcessRepair.failed ?? []).length} could not be stopped. Restart Codex App if reconnecting continues.`);
    else if (appProcessRepair.status === 'skipped' && appProcessRepair.reason === 'opt_in_required') console.log('Codex App reconnect repair: not run (set SKS_POSTINSTALL_RECONCILE_APP_PROCESSES=1 to allow postinstall to stop stale orphan app-server processes; otherwise run `sks doctor --fix`).');
    else if (appProcessRepair.status === 'skipped' && appProcessRepair.reason !== 'platform') console.log(`Codex App reconnect repair: skipped (${appProcessRepair.reason}).`);
    else if (appProcessRepair.status === 'failed') console.log(`Codex App reconnect repair: skipped (${appProcessRepair.error || appProcessRepair.reason || 'process check failed'}).`);
    const globalSkills = await ensureGlobalCodexSkillsDuringInstall();
    if (globalSkills.status === 'installed') {
      const removed = globalSkills.removed_stale_generated_skills || [];
      const cleanup = removed.length ? ` Removed stale generated skill shadow(s): ${removed.join(', ')}.` : '';
      console.log(`Codex App global $ skills: installed in ${globalSkills.root} (${globalSkills.installed_count} skills).${cleanup}`);
    }
    else if (globalSkills.status === 'partial') console.log(`Codex App global $ skills: partial in ${globalSkills.root}; missing ${(globalSkills.missing_skills ?? []).join(', ')}. Run \`sks doctor --fix\`.`);
    else if (globalSkills.status === 'skipped') console.log(`Codex App global $ skills: skipped (${globalSkills.reason}).`);
    else if (globalSkills.status === 'failed') console.log(`Codex App global $ skills: auto setup failed. Run \`sks doctor --fix\`. ${globalSkills.error || ''}`.trim());
    const getdesignSkill = await ensureGlobalGetdesignSkillDuringInstall();
    console.log(`getdesign Codex skill: not installed automatically; generated getdesign-reference skill is available. To install the upstream skill manually, review commit ${getdesignSkill.reviewed_ref} and run \`${getdesignSkill.install}\`.`);
    console.log(`SKS bootstrap: ${bootstrapDecision.reason}.`);
    await runPostinstallBootstrap(installRoot, bootstrap, bootstrapDecision);
    return;
  } catch (err: any) {
    console.log(`\nSKS postinstall: a setup step did not complete; installation continues. Run \`sks doctor --fix\` afterward. (${err?.message || err})`);
  } finally {
    if (reconcileCodexLb) {
      await restorePostinstallCodexLbConfigSnapshot(codexLbConfigSnapshot).catch(() => {});
      await reportPostinstallCodexLbAuth(codexLbConfigSnapshot).catch(() => {});
    }
  }
}

function postinstallExternalMutationsAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.SKS_POSTINSTALL_BOOTSTRAP === '1' && env.SKS_POSTINSTALL_NO_BOOTSTRAP !== '1';
}

async function restoreInstalledPackageBuildStamp() {
  // The published tarball deliberately excludes dist/.sks-build-stamp.json,
  // but `sks update` self-verification requires that package-local file.
  // This is the only default postinstall write and is confined to the installed
  // package root; every consumer/global mutation requires explicit opt-in.
  try {
    const stampLib: any = await import('../scripts/lib/ensure-dist-fresh.js');
    const root = path.resolve(packageRoot());
    const rawStamp = String(stampLib.distStampPath || '').trim();
    if (!rawStamp) throw new Error('dist_stamp_path_missing');
    const stamp = path.resolve(rawStamp);
    const relative = path.relative(root, stamp);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('dist_stamp_outside_package_root');
    }
    await fsp.access(stamp).catch(async () => {
      await fsp.writeFile(stamp, `${JSON.stringify(stampLib.buildStampPayload(), null, 2)}\n`);
      console.log('SKS build stamp: restored inside the installed package for update self-verification.');
    });
  } catch (err: any) {
    console.log(`SKS build stamp: could not restore (${err?.message || err}); \`sks update\` self-verification may report dist_stamp missing.`);
  }
}

async function runPostinstallProjectRetentionCleanup(root: string) {
  const projectRoot = path.resolve(root || process.cwd());
  if (process.env.SKS_POSTINSTALL_RETENTION_CLEANUP === '0') {
    return { status: 'skipped', reason: 'disabled_by_env', action_count: 0 };
  }
  if (!(await exists(path.join(projectRoot, '.sneakoscope', 'missions')))) {
    return { status: 'skipped', reason: 'missions_missing', action_count: 0 };
  }
  try {
    const { enforceRetention } = await import('../core/retention.js');
    const result = await enforceRetention(projectRoot, {
      mode: 'postinstall_update',
      pruneReportLogs: true,
      policy: { max_tmp_age_hours: 0 }
    });
    return {
      status: 'completed',
      root: projectRoot,
      action_count: Array.isArray(result.actions) ? result.actions.length : 0
    };
  } catch (err: any) {
    return {
      status: 'failed',
      root: projectRoot,
      action_count: 0,
      error: err?.message || String(err)
    };
  }
}

async function reportPostinstallCodexLbAuth(snapshot: any = null) {
  const codexLbAuth = await ensureCodexLbAuthDuringInstall({
    ...(snapshot?.secret_api_key ? { apiKey: snapshot.secret_api_key } : {}),
    ...(snapshot?.base_url ? { baseUrl: snapshot.base_url } : {})
  });
  if (codexLbAuth.legacy_auth_migrated) console.log(`codex-lb auth: restored from existing Codex login cache into ${codexLbAuth.env_path}.`);
  else if (codexLbAuth.status === 'synced' || codexLbAuth.status === 'present' || codexLbAuth.status === 'repaired') console.log(`codex-lb auth: preserved from ${codexLbAuth.env_path}.`);
  else if (codexLbAuth.status === 'present_unselected') console.log('codex-lb auth: preserved but not selected; ChatGPT OAuth remains active.');
  else if (codexLbAuth.status === 'skipped') console.log(`codex-lb auth: skipped (${codexLbAuth.reason}).`);
  else if (codexLbAuth.status === 'missing_env_key') console.log('codex-lb auth: stored key missing. Store it in ~/.codex/sks-codex-lb.env, run `sks codex-lb setup --host <domain> --api-key-stdin --yes`, or provide CODEX_LB_API_KEY in the environment.');
  else if (codexLbAuth.status === 'missing_base_url') console.log('codex-lb auth: stored key has no recoverable base URL. Run `sks codex-lb reconfigure --host <domain> --api-key-stdin` once.');
  else if (codexLbAuth.status === 'legacy_migration_required') console.log('codex-lb legacy Desktop auth routing was left unchanged. Migrate explicitly with `sks codex-lb migrate-legacy-desktop --restart-app`.');
  else if (codexLbAuth.status === 'not_configured') console.log('codex-lb (optional multi-account load balancer): not configured — use `sks codex-lb setup`, then choose `use-desktop-full`, `use-cli`, or `disable` explicitly.');
  else if (codexLbAuth.status && codexLbAuth.status !== 'not_configured') console.log(`codex-lb auth: repair skipped (${codexLbAuth.status}${codexLbAuth.error ? `: ${codexLbAuth.error}` : ''}).`);
  const reconcile = codexLbAuth.auth_reconcile;
  if (reconcile?.status === 'oauth_untouched') {
    console.log('codex-lb auth: ChatGPT OAuth/shared Codex auth was left byte-for-byte unchanged.');
  } else if (reconcile?.status === 'legacy_migration_required') {
    console.log('codex-lb auth: legacy shared-auth routing requires `sks codex-lb migrate-legacy-desktop --restart-app`; background install will not migrate it.');
  }
  if (codexLbAuth.base_url && codexLbAuth.codex_lb?.env_key_configured && canAskYesNo() && process.env.SKS_SKIP_CODEX_LB_KEY_PROMPT !== '1') {
    const changeKey = (await askPostinstallQuestion('codex-lb key changed? Update now? [y/N] ')).trim();
    if (/^(y|yes|예|네|응)$/i.test(changeKey)) {
      const newKey = (await askPostinstallQuestion('New codex-lb API key (sk-clb-...): ')).trim();
      if (newKey) {
        const result = await configureCodexLb({ host: codexLbAuth.base_url, apiKey: newKey });
        if (result.ok) console.log(`codex-lb key updated: ${result.base_url}`);
        else console.log(`codex-lb key update failed: ${result.status}${result.error ? `: ${result.error}` : ''}`);
        printCodexLbSetupWarnings(result);
      }
    }
  }
  return codexLbAuth;
}

async function postinstallHarnessConflictNotice(conflictScan: any) {
  console.log('\nSneakoscope Codex package installed, but SKS setup is blocked.');
  console.log(formatHarnessConflictReport(conflictScan, { includePrompt: false }));
  console.log('\nWhat this means: npm can finish installing the package. Conflicting OMX/DCodex markers must be removed explicitly with `sks conflicts cleanup --yes` before `sks setup`, `sks doctor --fix`, or `sks update` can proceed.');
  console.log('No files were removed by postinstall.');
  console.log('Cleanup requires a human-approved Codex App session. Keep the model selected in Codex and use high reasoning effort.');
  if (shouldAskPostinstallQuestion()) {
    const answer = await askPostinstallQuestion('Show the cleanup prompt now? [y/N] ');
    if (/^(y|yes|예|네|응)$/i.test(answer.trim())) {
      console.log('\nCleanup prompt:\n');
      console.log(llmHarnessCleanupPrompt(conflictScan));
    } else {
      console.log('Cleanup prompt skipped. You can print it later with: sks conflicts prompt');
    }
  } else {
    console.log('Print the cleanup prompt later with: sks conflicts prompt');
  }
  console.log('After approved cleanup, rerun: sks setup && sks doctor --fix && sks selftest --mock\n');
}

function shouldAskPostinstallQuestion() {
  if (process.env.SKS_POSTINSTALL_PROMPT === '1') return true;
  return Boolean(input.isTTY && output.isTTY && process.env.CI !== 'true' && process.env.SKS_POSTINSTALL_NO_PROMPT !== '1');
}

export async function postinstallBootstrapDecision(root: any) {
  if (process.env.SKS_POSTINSTALL_NO_BOOTSTRAP === '1') return { run: false, reason: 'SKS_POSTINSTALL_NO_BOOTSTRAP=1' };
  if (process.env.SKS_POSTINSTALL_BOOTSTRAP !== '1') {
    return { run: false, reason: 'explicit opt-in required (SKS_POSTINSTALL_BOOTSTRAP=1)' };
  }
  const installRoot = path.resolve(root || process.cwd());
  const candidate = await isProjectSetupCandidate(installRoot);
  const target = candidate ? installRoot : globalSksRoot();
  return { run: true, target, reason: 'forced by SKS_POSTINSTALL_BOOTSTRAP=1' };
}

async function runPostinstallBootstrap(root: any, bootstrap: any, selectedDecision?: any) {
  const previousCwd = process.cwd();
  const decision = selectedDecision || await postinstallBootstrapDecision(root);
  const target = path.resolve(decision.target || root || previousCwd);
  await ensureDir(target);
  process.chdir(target);
  try {
    await bootstrap(['--from-postinstall', '--install-scope', 'global', '--force']);
  } finally {
    process.chdir(previousCwd);
  }
}

type CodexLbStatusSnapshot = Awaited<ReturnType<typeof codexLbStatus>>;

export type CodexLbAuthReconcileResult = {
  status: string;
  reason?: string;
  auth_path?: string;
  backup_path?: string;
  routing_guard?: Record<string, unknown>;
  routing_rollback?: Record<string, unknown>;
  error?: string;
};

export type CodexLbEnvSyncResult = {
  ok: boolean;
  status: string;
  env_path?: string;
  base_url?: string | null;
  launch_environment?: Record<string, unknown>;
  error?: string | null;
  skipped?: boolean;
  reason?: string;
};

export type CodexLbLoginSyncResult = {
  ok: boolean;
  status: string;
  reason?: string;
  error?: string | null;
};

export type CodexLbAuthInstallResult = {
  status: string;
  ok?: boolean;
  reason?: string;
  legacy_auth_migrated?: boolean;
  legacy_auth_path?: string | null;
  config_path?: string;
  env_path?: string;
  base_url?: string | null;
  config_repaired?: boolean;
  codex_lb?: CodexLbStatusSnapshot;
  codex_environment?: CodexLbEnvSyncResult;
  codex_login?: CodexLbLoginSyncResult;
  auth_reconcile?: CodexLbAuthReconcileResult;
  tool_catalog?: Record<string, unknown>;
  tool_output_recovery?: CodexLbToolOutputRecoveryProbe;
  error?: string | null;
};

export type ConfigureCodexLbResult = {
  ok?: boolean;
  status: string;
  mode?: CodexLbDesktopMode;
  identity_plane?: 'unchanged';
  routing_plane?: 'cli_provider' | 'desktop_native_bridge' | 'desktop_compat_provider';
  gateway_auth_transport?: CodexLbGatewayAuthTransport;
  oauth_preserved?: boolean;
  auth_mutated?: false;
  plan?: Record<string, unknown>;
  applied_actions?: Array<Record<string, unknown>>;
  drift?: string[];
  persistence?: CodexLbPersistenceSummary;
  center_credentials?: Record<string, unknown>;
  config_path?: string;
  env_path?: string;
  metadata_path?: string;
  backup_path?: string | null;
  base_url?: string | null;
  env_key?: string;
  keychain?: Record<string, unknown>;
  legacy_keychain_cleanup?: Record<string, unknown>;
  rollback?: Record<string, any>;
  recovery_paths?: string[];
  secret_recovery_paths?: string[];
  warnings?: string[];
  auth_reconcile?: CodexLbAuthReconcileResult;
  codex_lb?: CodexLbStatusSnapshot;
  codex_environment?: CodexLbEnvSyncResult;
  codex_login?: CodexLbLoginSyncResult;
  tool_catalog?: Record<string, unknown>;
  tool_output_recovery?: CodexLbToolOutputRecoveryProbe;
  error?: string | null;
  chain_health?: { status?: string } & Record<string, unknown>;
  bypass_codex_lb?: boolean;
  repair?: CodexLbAuthInstallResult;
  reason?: string;
  blockers?: string[];
} & Partial<CodexLbStatusSnapshot>;

export type CodexLbLaunchPromptResult = ConfigureCodexLbResult;

export interface ConfigureCodexLbDesktopRoutingOptions {
  mode: CodexLbDesktopMode;
  home?: string;
  configPath?: string;
  authPath?: string;
  bridgeBaseUrl?: string;
  remoteBaseUrl?: string;
  gatewayAuthTransport?: CodexLbGatewayAuthTransport;
}

export interface ConfigureCodexLbDesktopRoutingResult {
  schema: 'sks.codex-lb-desktop-routing.v1';
  ok: boolean;
  status:
    | 'desktop_routing_configured'
    | 'desktop_routing_present'
    | 'desktop_routing_disabled'
    | 'desktop_oauth_required'
    | 'desktop_gateway_auth_transport_unsupported'
    | 'desktop_dual_auth_compat_unavailable'
    | 'invalid_desktop_routing_input'
    | 'failed';
  mode: CodexLbDesktopMode;
  identity_plane: 'chatgpt_oauth' | 'unavailable';
  routing_plane: 'desktop_native_bridge' | 'desktop_compat_provider' | 'disabled' | 'unchanged';
  gateway_auth_transport: CodexLbGatewayAuthTransport;
  oauth_preserved: boolean;
  auth_mutated: false;
  config_path: string;
  auth_path: string;
  auth_before: CodexAuthSnapshot;
  auth_after: CodexAuthSnapshot;
  backup_path?: string | null;
  rollback?: Record<string, unknown>;
  blockers: string[];
  error?: string;
}

export async function configureCodexLbDesktopRouting(
  opts: ConfigureCodexLbDesktopRoutingOptions
): Promise<ConfigureCodexLbDesktopRoutingResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const configPath = opts.configPath || codexLbConfigPath(home);
  const authPath = opts.authPath || codexAuthPath(home);
  const mode = parseCodexLbDesktopMode(opts.mode);
  const gatewayAuthTransport = parseCodexLbGatewayAuthTransport(
    opts.gatewayAuthTransport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT
  );
  const authBefore = await captureCodexAuthSnapshot({ home, authPath });
  const identityPlane: ConfigureCodexLbDesktopRoutingResult['identity_plane'] = authBefore.mode === 'chatgpt_oauth' || authBefore.mode === 'mixed'
    ? 'chatgpt_oauth'
    : 'unavailable';
  const base = {
    schema: 'sks.codex-lb-desktop-routing.v1' as const,
    mode,
    gateway_auth_transport: gatewayAuthTransport,
    identity_plane: identityPlane,
    auth_mutated: false as const,
    config_path: configPath,
    auth_path: authPath,
    auth_before: authBefore
  };
  if (desktopModeRequiresGlobalSecretEnvironment(mode)) {
    return {
      ...base,
      ok: false,
      status: 'desktop_dual_auth_compat_unavailable',
      routing_plane: 'unchanged',
      oauth_preserved: true,
      auth_after: authBefore,
      blockers: ['desktop_dual_auth_compat_requires_global_secret_environment']
    };
  }
  if (mode === 'cli-provider') {
    return {
      ...base,
      ok: false,
      status: 'invalid_desktop_routing_input',
      routing_plane: 'unchanged',
      oauth_preserved: true,
      auth_after: authBefore,
      blockers: ['cli_provider_is_not_a_desktop_routing_mode']
    };
  }
  if (modeRequiresChatGptOAuth(mode) && identityPlane !== 'chatgpt_oauth') {
    return {
      ...base,
      ok: false,
      status: 'desktop_oauth_required',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      auth_after: authBefore,
      blockers: ['chatgpt_oauth_required_for_desktop']
    };
  }
  if (mode === 'desktop-dual-auth-compat' && gatewayAuthTransport !== 'x-codex-lb-api-key') {
    return {
      ...base,
      ok: false,
      status: 'desktop_gateway_auth_transport_unsupported',
      routing_plane: 'unchanged',
      oauth_preserved: true,
      auth_after: authBefore,
      blockers: ['desktop_compat_cannot_use_authorization_bearer_without_replacing_oauth']
    };
  }
  if (mode === 'desktop-native-bridge' && (!opts.bridgeBaseUrl || !opts.remoteBaseUrl)) {
    return {
      ...base,
      ok: false,
      status: 'invalid_desktop_routing_input',
      routing_plane: 'unchanged',
      oauth_preserved: true,
      auth_after: authBefore,
      blockers: [
        ...(!opts.bridgeBaseUrl ? ['missing_bridge_base_url'] : []),
        ...(!opts.remoteBaseUrl ? ['missing_remote_base_url'] : [])
      ]
    };
  }
  if (mode === 'desktop-dual-auth-compat' && !opts.remoteBaseUrl) {
    return {
      ...base,
      ok: false,
      status: 'invalid_desktop_routing_input',
      routing_plane: 'unchanged',
      oauth_preserved: true,
      auth_after: authBefore,
      blockers: ['missing_remote_base_url']
    };
  }

  const current = await readText(configPath, '');
  let next: string;
  try {
    next = mode === 'desktop-native-bridge'
      ? upsertCodexLbNativeDesktopConfig(current, {
          bridgeBaseUrl: String(opts.bridgeBaseUrl),
          remoteBaseUrl: String(opts.remoteBaseUrl)
        })
      : mode === 'desktop-dual-auth-compat'
        ? upsertCodexLbCompatDesktopConfig(current, { remoteBaseUrl: String(opts.remoteBaseUrl) })
        : removeCodexLbManagedDesktopConfig(current);
  } catch (error: unknown) {
    return {
      ...base,
      ok: false,
      status: 'failed',
      routing_plane: 'unchanged',
      oauth_preserved: true,
      auth_after: authBefore,
      blockers: ['desktop_config_conflict'],
      error: error instanceof Error ? error.message : String(error)
    };
  }
  const write = await safeWriteCodexConfigToml(
    configPath,
    current,
    next,
    'codex-lb-desktop-routing',
    { verifyUnchangedBeforeWrite: true }
  );
  if (!write.ok) {
    return {
      ...base,
      ok: false,
      status: 'failed',
      routing_plane: 'unchanged',
      oauth_preserved: true,
      auth_after: authBefore,
      backup_path: write.backup_path,
      blockers: ['desktop_config_write_failed'],
      error: write.status
    };
  }
  const authAfter = await captureCodexAuthSnapshot({ home, authPath });
  try {
    await assertDesktopAuthUnchangedBySks(authBefore, authAfter);
  } catch (error: unknown) {
    const writtenText = await readText(configPath, '');
    const rollbackWrite = await safeWriteCodexConfigToml(
      configPath,
      writtenText,
      current,
      'codex-lb-desktop-routing-auth-invariant-rollback',
      { verifyUnchangedBeforeWrite: true }
    );
    return {
      ...base,
      ok: false,
      status: 'failed',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      auth_after: authAfter,
      backup_path: write.backup_path,
      rollback: {
        ok: rollbackWrite.ok,
        status: rollbackWrite.status,
        config_restored: rollbackWrite.ok
      },
      blockers: ['desktop_auth_byte_invariant_failed', ...(rollbackWrite.ok ? [] : ['desktop_config_rollback_failed'])],
      error: error instanceof Error ? error.message : String(error)
    };
  }
  const routingPlane = mode === 'desktop-native-bridge'
    ? 'desktop_native_bridge'
    : mode === 'desktop-dual-auth-compat'
      ? 'desktop_compat_provider'
      : 'disabled';
  return {
    ...base,
    ok: true,
    status: mode === 'disabled'
      ? 'desktop_routing_disabled'
      : write.changed === true
        ? 'desktop_routing_configured'
        : 'desktop_routing_present',
    routing_plane: routingPlane,
    oauth_preserved: true,
    auth_after: authAfter,
    backup_path: write.backup_path,
    blockers: []
  };
}

export async function configureCodexLbCliProvider(opts: {
  home?: string;
  configPath?: string;
  authPath?: string;
  remoteBaseUrl: string;
  selectGlobally?: boolean;
}): Promise<{
  schema: 'sks.codex-lb-cli-provider.v1';
  ok: boolean;
  status: string;
  mode: 'cli-provider';
  identity_plane: 'unchanged';
  routing_plane: 'cli_provider';
  oauth_preserved: boolean;
  auth_mutated: false;
  config_path: string;
  auth_path: string;
  auth_before: CodexAuthSnapshot;
  auth_after: CodexAuthSnapshot;
  blockers: string[];
  backup_path?: string | null;
}> {
  const home = opts.home || process.env.HOME || os.homedir();
  const configPath = opts.configPath || codexLbConfigPath(home);
  const authPath = opts.authPath || codexAuthPath(home);
  const authBefore = await captureCodexAuthSnapshot({ home, authPath });
  const current = await readText(configPath, '');
  const next = upsertCodexLbCliProviderConfig(current, {
    remoteBaseUrl: opts.remoteBaseUrl,
    ...(opts.selectGlobally === undefined ? {} : { selectGlobally: opts.selectGlobally })
  });
  const write = await safeWriteCodexConfigToml(
    configPath,
    current,
    next,
    'codex-lb-cli-provider',
    { verifyUnchangedBeforeWrite: true }
  );
  const authAfter = await captureCodexAuthSnapshot({ home, authPath });
  try {
    await assertDesktopAuthUnchangedBySks(authBefore, authAfter);
  } catch {
    return {
      schema: 'sks.codex-lb-cli-provider.v1',
      ok: false,
      status: 'auth_changed_during_cli_provider_write',
      mode: 'cli-provider',
      identity_plane: 'unchanged',
      routing_plane: 'cli_provider',
      oauth_preserved: false,
      auth_mutated: false,
      config_path: configPath,
      auth_path: authPath,
      auth_before: authBefore,
      auth_after: authAfter,
      blockers: ['shared_auth_byte_invariant_failed'],
      backup_path: write.backup_path
    };
  }
  return {
    schema: 'sks.codex-lb-cli-provider.v1',
    ok: write.ok,
    status: write.ok ? (write.changed ? 'configured' : 'present') : write.status,
    mode: 'cli-provider',
    identity_plane: 'unchanged',
    routing_plane: 'cli_provider',
    oauth_preserved: true,
    auth_mutated: false,
    config_path: configPath,
    auth_path: authPath,
    auth_before: authBefore,
    auth_after: authAfter,
    blockers: write.ok ? [] : ['cli_provider_config_write_failed'],
    backup_path: write.backup_path
  };
}

function hasTopLevelMarker(text: string, marker: string): boolean {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).some((line) => line.trim() === marker);
}

function managedCodexLbDesktopMode(text: string): 'desktop-native-bridge' | 'desktop-dual-auth-compat' | null {
  if (hasTopLevelMarker(text, CODEX_LB_DESKTOP_BRIDGE_MARKER)) return 'desktop-native-bridge';
  if (hasTopLevelMarker(text, CODEX_LB_DESKTOP_COMPAT_MARKER)) return 'desktop-dual-auth-compat';
  return null;
}

function codexLbRoutingPlane(mode: CodexLbDesktopMode): NonNullable<ConfigureCodexLbResult['routing_plane']> {
  if (mode === 'desktop-native-bridge') return 'desktop_native_bridge';
  if (mode === 'desktop-dual-auth-compat') return 'desktop_compat_provider';
  return 'cli_provider';
}

export async function capturePostinstallCodexLbConfigSnapshot(home: any = process.env.HOME || os.homedir()) {
  const configPath = codexLbConfigPath(home);
  const envPath = codexLbEnvPath(home);
  const authPath = codexAuthPath(home);
  const config = await readText(configPath, '');
  const auth = await captureCodexAuthSnapshot({ home, authPath });
  const envLoad = await loadCodexLbEnv({ home, envPath });
  const envKey = envLoad.secret_api_key || '';
  const providerConfigured = /\[model_providers\.codex-lb\]/.test(config);
  const baseUrl = envLoad.base_url || codexLbProviderBaseUrl(config);
  const desktopMode = managedCodexLbDesktopMode(config);
  const bridgeBaseUrl = desktopMode === 'desktop-native-bridge'
    ? topLevelTomlString(config, 'openai_base_url')
    : '';
  // Snapshot any codex-lb-related state so the upgrade-time bootstrap can't silently undo it.
  if (!envKey && !providerConfigured && !baseUrl && !desktopMode) return null;
  return {
    config_path: configPath,
    env_path: envPath,
    auth_path: authPath,
    base_url: baseUrl ? normalizeCodexLbBaseUrl(baseUrl) : null,
    bridge_base_url: bridgeBaseUrl || null,
    desktop_mode: desktopMode,
    selected: hasTopLevelCodexLbSelected(config),
    auth_mode: auth.mode,
    auth_sha256: auth.sha256,
    credential_source: envLoad.source,
    credential_fingerprint: envLoad.api_key.fingerprint,
    credential_binding: envLoad.credential_binding,
    secret_api_key: envKey || null
  };
}

export async function restorePostinstallCodexLbConfigSnapshot(snapshot: any) {
  if (!snapshot) return { status: 'skipped', reason: 'no_snapshot' };
  let configRestored = false;
  let configStatus = 'present';
  if (snapshot.base_url) {
    const current = await readText(snapshot.config_path, '');
    let next = current;
    try {
      if (snapshot.desktop_mode === 'desktop-native-bridge' && snapshot.bridge_base_url) {
        next = upsertCodexLbNativeDesktopConfig(current, {
          bridgeBaseUrl: snapshot.bridge_base_url,
          remoteBaseUrl: snapshot.base_url
        });
      } else if (snapshot.desktop_mode === 'desktop-dual-auth-compat') {
        next = upsertCodexLbCompatDesktopConfig(current, { remoteBaseUrl: snapshot.base_url });
      } else {
        next = upsertCodexLbCliProviderConfig(current, {
          remoteBaseUrl: snapshot.base_url,
          selectGlobally: snapshot.selected === true
        });
      }
    } catch (error: unknown) {
      return {
        status: 'failed',
        reason: 'managed_routing_restore_conflict',
        config_path: snapshot.config_path,
        auth_path: snapshot.auth_path,
        config_restored: false,
        auth_restored: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (ensureTrailingNewline(next) !== ensureTrailingNewline(current)) {
      const safeWrite = await safeWriteCodexConfigToml(
        snapshot.config_path,
        current,
        next,
        'codex-lb-safe-routing-restore',
        { verifyUnchangedBeforeWrite: true }
      );
      configRestored = safeWrite.ok && safeWrite.changed === true;
      configStatus = safeWrite.ok ? (configRestored ? 'restored' : 'present') : safeWrite.status;
    }
  }
  const authAfter = await captureCodexAuthSnapshot({
    home: path.dirname(path.dirname(snapshot.auth_path)),
    authPath: snapshot.auth_path
  });
  const authUnchanged = snapshot.auth_sha256 === authAfter.sha256;
  return {
    status: configStatus,
    config_path: snapshot.config_path,
    auth_path: snapshot.auth_path,
    config_restored: configRestored,
    auth_restored: false,
    auth_unchanged: authUnchanged
  };
}

export async function configureCodexLb(opts: any = {}): Promise<ConfigureCodexLbResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const configPath = opts.configPath || codexLbConfigPath(home);
  const envPath = opts.envPath || codexLbEnvPath(home);
  const metadataPath = opts.metadataPath || codexLbMetadataPath(home);
  const rawHost = String(opts.host || opts.baseUrl || '');
  const baseUrl = normalizeCodexLbBaseUrl(rawHost);
  const apiKey = String(opts.apiKey || '').trim();
  const requestedDesktopMode = parseCodexLbDesktopMode(opts.desktopMode || 'cli-provider');
  const writeEnvFile = opts.writeEnvFile !== false;
  const storeKeychain = opts.storeKeychain === true || opts.keychain === true;
  const keychainStoreImpl = typeof opts.keychainStoreImpl === 'function'
    ? opts.keychainStoreImpl
    : null;
  const syncLaunchctl = opts.syncLaunchctl === true || opts.syncLaunchEnv === true;
  const shellProfile = opts.shellProfile || 'skip';
  if (storeKeychain && !keychainStoreImpl) {
    return {
      ok: false,
      status: 'keychain_acl_helper_unavailable',
      config_path: configPath,
      env_path: envPath,
      metadata_path: metadataPath,
      keychain: {
        ok: false,
        status: 'keychain_acl_helper_unavailable',
        keychain_state_verified: true,
        keychain_state_status: 'unchanged'
      },
      error: 'Dedicated signed Keychain helper unavailable; use the owner-only env file.'
    };
  }
  const beforeState = await captureCodexLbSetupWriteState({
    home,
    configPath,
    envPath,
    metadataPath,
    shellProfile
  });
  await opts.testHooks?.afterBeforeStateCapture?.({ configPath });
  const configBeforeEntry = beforeState.files.find((entry: any) => entry?.path === configPath);
  if (!configBeforeEntry) {
    return {
      ok: false,
      status: 'setup_snapshot_failed',
      config_path: configPath,
      env_path: envPath,
      metadata_path: metadataPath
    };
  }
  const setupMutationPaths = new Set([
    configPath,
    metadataPath,
    ...(writeEnvFile ? [envPath] : []),
    ...(shellProfile === 'skip'
      ? []
      : beforeState.files
        .map((entry: any) => String(entry?.path || ''))
        .filter((file: string) => file && file !== configPath && file !== envPath && file !== metadataPath))
  ]);
  const unsafeSetupTargets = beforeState.files
    .filter((entry: any) => setupMutationPaths.has(String(entry?.path || ''))
      && entry?.existed === true
      && entry?.kind !== 'regular')
    .map((entry: any) => `unsafe_setup_write_target:${entry.path}:${entry.kind}`);
  if (unsafeSetupTargets.length > 0) {
    return {
      ok: false,
      status: 'unsafe_setup_write_target',
      config_path: configPath,
      env_path: envPath,
      metadata_path: metadataPath,
      drift: unsafeSetupTargets
    };
  }
  const initialConfig = configBeforeEntry.existed === true
    ? Buffer.from(String(configBeforeEntry.bytes_base64 || ''), 'base64').toString('utf8')
    : '';
  const preservedDesktopMode = managedCodexLbDesktopMode(initialConfig);
  const managedCliSelection = hasTopLevelMarker(initialConfig, CODEX_LB_PROVIDER_SELECTION_MARKER)
    && hasTopLevelCodexLbSelected(initialConfig);
  const preservedLegacySelection = hasTopLevelCodexLbSelected(initialConfig)
    && !preservedDesktopMode
    && !managedCliSelection;
  const desktopMode: CodexLbDesktopMode = preservedDesktopMode || 'cli-provider';
  if (desktopModeRequiresGlobalSecretEnvironment(desktopMode)) {
    return {
      ok: false,
      status: 'desktop_dual_auth_compat_unavailable',
      config_path: configPath,
      env_path: envPath,
      error: 'desktop_dual_auth_compat_requires_global_secret_environment'
    };
  }
  // A stored CLI provider is invoked explicitly by CLI configuration/flags. It
  // must never become the global Codex Desktop selection as a setup side effect.
  const useDefaultProvider = desktopMode === 'desktop-dual-auth-compat'
    || preservedLegacySelection
    || managedCliSelection
    || (desktopMode === 'cli-provider' && opts.useDefaultProvider === true);
  const setupAnswers = {
    host_or_base_url: rawHost,
    api_key_source: opts.apiKeySource || 'stdin',
    desktop_mode: 'cli-provider' as const,
    use_as_default_provider: useDefaultProvider,
    gateway_auth_transport: (opts.gatewayAuthTransport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT) as CodexLbGatewayAuthTransport,
    write_env_file: writeEnvFile,
    store_keychain: storeKeychain,
    keychain_helper_verified: Boolean(keychainStoreImpl),
    sync_launchctl: syncLaunchctl,
    install_shell_profile: shellProfile,
    run_health_check: opts.runHealth === true,
    allow_insecure_localhost: opts.allowInsecureHttp === true || opts.allowInsecureLocalhost === true
  };
  const selectedPersistenceModes = selectedCodexLbPersistenceModes(setupAnswers as any);
  const plan = buildCodexLbSetupPlan(setupAnswers as any, {
    home,
    configPath,
    envPath,
    metadataPath: opts.metadataPath || codexLbMetadataPath(home)
  });
  if (!baseUrl) return { ok: false, status: 'missing_host_or_base_url', config_path: configPath, env_path: envPath };
  if (plan.blockers.length) return { ok: false, status: 'plan_blocked', plan: plan as any, drift: plan.blockers, config_path: configPath, env_path: envPath };
  if (/[\u0000-\u001f\u007f\s]/.test(rawHost.trim())) return { ok: false, status: 'invalid_host_or_base_url', config_path: configPath, env_path: envPath, error: 'host_or_base_url_contains_whitespace_or_control_character' };
  if (!apiKey) return { ok: false, status: 'missing_api_key', config_path: configPath, env_path: envPath };
  const toolOutputRecovery = await probeCodexLbToolOutputRecovery({
    baseUrl,
    ...(typeof opts.toolOutputRecoveryFetch === 'function' ? { fetchImpl: opts.toolOutputRecoveryFetch } : {}),
    timeoutMs: Number(opts.toolOutputRecoveryTimeoutMs || 4_000),
    allowUnverified: opts.allowUnverifiedToolOutputRecovery === true
      || codexLbToolOutputRecoveryOverrideAcknowledged({ env: opts.env || process.env })
  });
  if (!toolOutputRecovery.ok) {
    return {
      ok: false,
      status: 'tool_output_recovery_blocked',
      plan: plan as any,
      config_path: configPath,
      env_path: envPath,
      base_url: baseUrl,
      tool_output_recovery: toolOutputRecovery,
      drift: toolOutputRecovery.blockers,
      warnings: toolOutputRecovery.warnings
    };
  }
  const insecureLocalWarning = /^http:\/\//i.test(baseUrl) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(baseUrl) && !opts.allowInsecureHttp
    ? ['codex-lb base URL uses http outside localhost; prefer https or pass an explicit allow flag in the calling surface.']
    : [];
  const processEnvBefore = {
    baseUrl: process.env.CODEX_LB_BASE_URL,
    apiKey: process.env.CODEX_LB_API_KEY
  };
  const authBefore = await captureCodexAuthSnapshot({ home, authPath: opts.authPath || codexAuthPath(home) });
  const appliedActions: Array<Record<string, unknown>> = [];
  await ensureDir(path.dirname(configPath));
  // Credential setup never activates a Desktop route. It may refresh the remote
  // URL inside an already explicit SKS-managed native/compat route, but an
  // unmarked legacy selection is preserved for explicit migration.
  const current = initialConfig;
  let providerOnly = current;
  try {
    if (desktopMode === 'desktop-native-bridge') {
      const bridgeBaseUrl = topLevelTomlString(current, 'openai_base_url');
      if (!bridgeBaseUrl) {
        return {
          ok: false,
          status: 'managed_desktop_bridge_missing_base_url',
          mode: desktopMode,
          config_path: configPath,
          env_path: envPath
        };
      }
      providerOnly = upsertCodexLbNativeDesktopConfig(current, {
        bridgeBaseUrl,
        remoteBaseUrl: baseUrl
      });
    } else if (desktopMode === 'desktop-dual-auth-compat') {
      providerOnly = upsertCodexLbCompatDesktopConfig(current, { remoteBaseUrl: baseUrl });
    } else if (!preservedLegacySelection) {
      providerOnly = upsertCodexLbCliProviderConfig(current, {
        remoteBaseUrl: baseUrl,
        selectGlobally: useDefaultProvider
      });
    }
  } catch (error: unknown) {
    return {
      ok: false,
      status: 'managed_desktop_routing_conflict',
      mode: desktopMode,
      config_path: configPath,
      env_path: envPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  await opts.testHooks?.beforeInitialConfigWrite?.({ configPath });
  const safeWrite = await safeWriteCodexConfigToml(
    configPath,
    current,
    providerOnly,
    'codex-lb',
    {
      verifyUnchangedBeforeWrite: true,
      expectedBeforeExists: configBeforeEntry.existed === true,
      ...(configBeforeEntry.existed === true
        ? { expectedBeforeMode: Number(configBeforeEntry.mode) }
        : {})
    }
  );
  if (!safeWrite.ok) return { ok: false, status: safeWrite.status, config_path: configPath, env_path: envPath, backup_path: safeWrite.backup_path };
  appliedActions.push({
    type: preservedLegacySelection
      ? 'preserve_legacy_desktop_routing'
      : desktopMode === 'desktop-native-bridge'
        ? 'preserve_desktop_native_bridge'
        : desktopMode === 'desktop-dual-auth-compat'
          ? 'preserve_desktop_compat_provider'
          : 'write_cli_provider',
    target: configPath,
    ok: true,
    backup_path: safeWrite.backup_path
  });
  const configExpectedAfter = (safeWrite as any).expected_after;
  if (!configExpectedAfter || typeof configExpectedAfter.exists !== 'boolean') {
    return {
      ok: false,
      status: 'partial_configuration_phase_snapshot_failed',
      mode: desktopMode,
      identity_plane: 'unchanged',
      routing_plane: codexLbRoutingPlane(desktopMode),
      oauth_preserved: true,
      auth_mutated: false,
      plan: plan as any,
      applied_actions: appliedActions,
      drift: ['setup_phase_snapshot_failed:after_config_write'],
      config_path: configPath,
      env_path: envPath,
      metadata_path: metadataPath,
      backup_path: safeWrite.backup_path,
      error: 'guarded config writer did not return an owned post-write snapshot'
    };
  }
  let setupExpectedState: any = {
    ...beforeState,
    files: beforeState.files.map((entry: any) => entry.path === configPath
      ? configExpectedAfter.exists
        ? {
            path: configPath,
            existed: true,
            kind: 'regular',
            bytes_base64: Buffer.from(String(configExpectedAfter.text || '')).toString('base64'),
            mode: Number(configExpectedAfter.mode)
          }
        : { path: configPath, existed: false, kind: 'missing', bytes_base64: '', mode: null }
      : entry)
  };
  const recordExpectedRegularFile = (file: string, text: string, mode: number) => {
    setupExpectedState = {
      ...setupExpectedState,
      files: setupExpectedState.files.map((entry: any) => entry.path === file
        ? {
            path: file,
            existed: true,
            kind: 'regular',
            bytes_base64: Buffer.from(text).toString('base64'),
            mode: mode & 0o777
          }
        : entry)
    };
  };
  const setupWriteRecoveryPaths: string[] = [];
  const writeSetupFile = async (input: {
    file: string;
    text: string;
    mode: number;
    beforeReplacement?: (input: { path: string }) => void | Promise<void>;
  }) => {
    const expected = beforeState.files.find(
      (entry: any) => path.resolve(String(entry?.path || '')) === path.resolve(input.file)
    );
    if (!expected) {
      throw new Error(`setup_snapshot_missing:${input.file}`);
    }
    const result = await writeCodexLbSetupFileIfUnchanged({
      file: input.file,
      expected,
      text: input.text,
      mode: input.mode,
      ...(input.beforeReplacement ? { beforeReplacement: input.beforeReplacement } : {})
    });
    if (result.recovery_path) setupWriteRecoveryPaths.push(result.recovery_path);
    if (result.ok || result.installed) {
      recordExpectedRegularFile(input.file, input.text, input.mode);
    }
    if (!result.ok) {
      throw new Error(`${result.status}:${input.file}${result.error ? `:${result.error}` : ''}`);
    }
    return result;
  };
  const rollbackSetupAfterFailure = async (input: {
    stage: string;
    error: unknown;
    keychain?: any;
    keychainRetained: boolean;
    restoreProcessEnvironment: boolean;
    externalStateMayBeMutated?: boolean;
    expectedCurrentState: any;
    centerCredentials?: Record<string, unknown>;
    codexEnvironment?: CodexLbEnvSyncResult;
  }): Promise<ConfigureCodexLbResult> => {
    const rollback = await restoreCodexLbSetupWriteState(beforeState, input.expectedCurrentState, {
      ...(typeof opts.testHooks?.beforeRollbackFileReplacement === 'function'
        ? { beforeReplacement: opts.testHooks.beforeRollbackFileReplacement }
        : {})
    });
    const rollbackBlockers = [...rollback.blockers];
    const processRollbackBlockers: string[] = [];
    if (input.restoreProcessEnvironment) {
      if (process.env.CODEX_LB_BASE_URL === processEnvBefore.baseUrl) {
        // Already restored by this process or another cooperating actor.
      } else if (process.env.CODEX_LB_BASE_URL === baseUrl) {
        if (processEnvBefore.baseUrl === undefined) delete process.env.CODEX_LB_BASE_URL;
        else process.env.CODEX_LB_BASE_URL = processEnvBefore.baseUrl;
      } else {
        processRollbackBlockers.push('setup_rollback_conflict:process.env.CODEX_LB_BASE_URL');
      }
      if (process.env.CODEX_LB_API_KEY === processEnvBefore.apiKey) {
        // Already restored by this process or another cooperating actor.
      } else if (process.env.CODEX_LB_API_KEY === apiKey) {
        if (processEnvBefore.apiKey === undefined) delete process.env.CODEX_LB_API_KEY;
        else process.env.CODEX_LB_API_KEY = processEnvBefore.apiKey;
      } else {
        processRollbackBlockers.push('setup_rollback_conflict:process.env.CODEX_LB_API_KEY');
      }
    }
    rollbackBlockers.push(...processRollbackBlockers);
    const afterRollback = await captureCodexLbSetupWriteState({
      home,
      configPath,
      envPath,
      metadataPath,
      shellProfile
    });
    if (beforeState.stateHash !== afterRollback.stateHash) {
      rollbackBlockers.push('setup_rollback_state_verification_failed');
    }
    const recoveryPaths = [
      ...(safeWrite.backup_path ? [safeWrite.backup_path] : []),
      ...setupWriteRecoveryPaths,
      ...rollback.recovery
    ];
    const secretRecoveryPaths = [...new Set(recoveryPaths)]
      .filter((recoveryPath) => isRecoveryPathForFile(recoveryPath, envPath));
    for (const recoveryPath of secretRecoveryPaths) {
      if (!await hardenCodexLbSetupRecoveryPath(recoveryPath)) {
        rollbackBlockers.push(`setup_secret_recovery_mode_unverified:${recoveryPath}`);
      }
    }
    if (secretRecoveryPaths.length > 0) {
      rollbackBlockers.push('setup_secret_recovery_retained');
    }
    const filesystemRollbackOk = rollbackBlockers.length === 0;
    const keychain = input.keychain || { ok: false, status: 'not_written' };
    return {
      ok: false,
      status: input.keychainRetained
        ? 'partial_configuration_keychain_retained'
        : input.externalStateMayBeMutated
          ? 'partial_configuration_external_state_unknown'
        : filesystemRollbackOk
          ? 'setup_failed_rolled_back'
          : 'setup_failed_rollback_incomplete',
      mode: desktopMode,
      identity_plane: 'unchanged',
      routing_plane: codexLbRoutingPlane(desktopMode),
      oauth_preserved: true,
      auth_mutated: false,
      plan: plan as any,
      applied_actions: appliedActions,
      drift: [
        `setup_stage_failed:${input.stage}`,
        ...(input.keychainRetained ? ['codex_lb_keychain_replacement_retained'] : []),
        ...(input.externalStateMayBeMutated ? ['codex_lb_external_environment_requires_inspection'] : []),
        ...rollbackBlockers
      ],
      rollback: {
        ...rollback,
        ok: filesystemRollbackOk,
        blockers: rollbackBlockers,
        byte_and_mode_verified: filesystemRollbackOk,
        keychain_retained: input.keychainRetained,
        secret_recovery_paths: secretRecoveryPaths,
        config_backup_path: safeWrite.backup_path || null,
        config_backup_status: safeWrite.backup_path ? 'retained_for_recovery' : 'not_created',
        recovery_paths: recoveryPaths
      },
      partial_configuration: {
        schema: 'sks.codex-lb-partial-configuration.v1',
        failure_stage: input.stage,
        filesystem_state: filesystemRollbackOk ? 'restored' : 'indeterminate',
        process_environment_state: input.restoreProcessEnvironment
          ? (processRollbackBlockers.length === 0 ? 'restored' : 'indeterminate')
          : 'unchanged',
        keychain_state: input.keychainRetained ? 'replacement_retained' : 'unchanged',
        external_environment_state: input.externalStateMayBeMutated ? 'inspect_with_status' : 'unchanged',
        durable_applied_state: [
          ...(input.keychainRetained
            ? [`macOS Keychain service ${CODEX_LB_SECURE_KEYCHAIN_SERVICE}`]
            : []),
          ...(input.externalStateMayBeMutated ? ['Center/launch environment may retain a partial update'] : [])
        ],
        recovery_actions: [
          'Run: sks codex-lb status --json',
          'Rerun setup with --api-key-stdin after resolving the failed stage.',
          `Inspect ${CODEX_LB_SECURE_KEYCHAIN_SERVICE} before removing any retained Keychain credential.`,
          ...(secretRecoveryPaths.length > 0
            ? ['Review and securely remove secret_recovery_paths after preserving any concurrent user edits.']
            : [])
        ],
        recovery_paths: recoveryPaths,
        secret_recovery_paths: secretRecoveryPaths
      } as any,
      config_path: configPath,
      env_path: envPath,
      metadata_path: metadataPath,
      keychain,
      ...(input.centerCredentials ? { center_credentials: input.centerCredentials } : {}),
      ...(input.codexEnvironment ? { codex_environment: input.codexEnvironment } : {}),
      error: redactSecretText(
        input.error instanceof Error ? input.error.message : String(input.error || input.stage),
        [apiKey]
      )
    } as ConfigureCodexLbResult;
  };
  const toolCatalog = {
    schema: 'sks.codex-lb-tool-catalog-selection.v1',
    ok: true,
    required: false,
    status: desktopMode === 'desktop-native-bridge'
      ? 'not_bound_for_desktop_native'
      : desktopMode === 'desktop-dual-auth-compat'
        ? 'not_bound_for_desktop_compat'
        : 'not_bound_for_cli_provider',
    path: codexLbToolCatalogPath(path.join(home, '.codex')),
    config_changed: false,
    selected: desktopMode === 'desktop-dual-auth-compat',
    blockers: [] as string[]
  };
  const keyFingerprint = await sha256Text(apiKey);
  const metadataText = `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: baseUrl,
    updated_at: new Date().toISOString(),
    source: opts.source || 'setup',
    desktop_mode: desktopMode,
    requested_desktop_mode: requestedDesktopMode,
    gateway_auth_transport: opts.gatewayAuthTransport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT,
    api_key: { redacted: true, sha256: keyFingerprint }
  }, null, 2)}\n`;
  try {
    await opts.testHooks?.beforeMetadataWrite?.({ metadataPath });
    const metadataWrite = await writeSetupFile({
      file: metadataPath,
      text: metadataText,
      mode: 0o600,
      ...(typeof opts.testHooks?.beforeSetupFileReplacement === 'function'
        ? { beforeReplacement: opts.testHooks.beforeSetupFileReplacement }
        : {})
    });
    appliedActions.push({
      type: 'write_metadata',
      target: metadataPath,
      ok: true,
      status: metadataWrite.status,
      recovery_path: metadataWrite.recovery_path || null
    });
  } catch (error: unknown) {
    return rollbackSetupAfterFailure({
      stage: 'write_metadata',
      error,
      keychainRetained: false,
      restoreProcessEnvironment: false,
      expectedCurrentState: setupExpectedState
    });
  }
  const keychainWriteState = setupExpectedState;
  const keychain: any = storeKeychain
    ? await keychainStoreImpl(apiKey, opts).catch((err: any) => ({
        ok: false,
        status: 'keychain_store_failed',
        error: err.message
      }))
    : { ok: false, status: 'skipped' };
  if (storeKeychain) appliedActions.push({ type: 'store_keychain', target: `macOS Keychain service ${CODEX_LB_SECURE_KEYCHAIN_SERVICE}`, ok: keychain.ok === true, status: keychain.status });
  if (storeKeychain && keychain.ok !== true) {
    await opts.testHooks?.beforeRollbackStart?.({ configPath });
    const rollback = await restoreCodexLbSetupWriteState(beforeState, keychainWriteState, {
      ...(typeof opts.testHooks?.beforeRollbackFileReplacement === 'function'
        ? { beforeReplacement: opts.testHooks.beforeRollbackFileReplacement }
        : {})
    });
    const rollbackBlockers = [...rollback.blockers];
    if (keychain.keychain_state_verified !== true) {
      rollbackBlockers.push('setup_rollback_keychain_state_indeterminate');
    }
    const backupStatus = safeWrite.backup_path ? 'retained_for_recovery' : 'not_created';
    const afterRollback = await captureCodexLbSetupWriteState({ home, configPath, envPath, metadataPath, shellProfile });
    if (beforeState.stateHash !== afterRollback.stateHash) {
      rollbackBlockers.push('setup_rollback_state_verification_failed');
    }
    const recoveryPaths = [
      ...(safeWrite.backup_path ? [safeWrite.backup_path] : []),
      ...setupWriteRecoveryPaths,
      ...rollback.recovery
    ];
    const secretRecoveryPaths = [...new Set(recoveryPaths)]
      .filter((recoveryPath) => isRecoveryPathForFile(recoveryPath, envPath));
    for (const recoveryPath of secretRecoveryPaths) {
      if (!await hardenCodexLbSetupRecoveryPath(recoveryPath)) {
        rollbackBlockers.push(`setup_secret_recovery_mode_unverified:${recoveryPath}`);
      }
    }
    if (secretRecoveryPaths.length > 0) {
      rollbackBlockers.push('setup_secret_recovery_retained');
    }
    const finalRollbackOk = rollbackBlockers.length === 0;
    return {
      ok: false,
      status: finalRollbackOk
        ? 'keychain_store_failed_rolled_back'
        : keychain.keychain_state_verified !== true
          ? 'keychain_state_indeterminate'
          : 'keychain_store_failed_rollback_incomplete',
      mode: desktopMode,
      identity_plane: 'unchanged',
      routing_plane: codexLbRoutingPlane(desktopMode),
      oauth_preserved: true,
      auth_mutated: false,
      plan: plan as any,
      applied_actions: appliedActions,
      drift: ['codex_lb_keychain_store_failed', ...rollbackBlockers],
      rollback: {
        ...rollback,
        ok: finalRollbackOk,
        blockers: rollbackBlockers,
        byte_and_mode_verified: finalRollbackOk,
        config_backup_path: safeWrite.backup_path || null,
        config_backup_status: backupStatus,
        recovery_paths: recoveryPaths,
        secret_recovery_paths: secretRecoveryPaths
      },
      config_path: configPath,
      env_path: envPath,
      metadata_path: metadataPath,
      keychain,
      error: keychain.error || keychain.status
    };
  }
  const writeSetupEnvFile = async () => {
    await opts.testHooks?.beforeEnvWrite?.({ envPath });
    const envText = `export CODEX_LB_BASE_URL=${shellSingleQuote(baseUrl)}\nexport CODEX_LB_API_KEY=${shellSingleQuote(apiKey)}\n`;
    const envWrite = await writeSetupFile({
      file: envPath,
      text: envText,
      mode: 0o600,
      ...(typeof opts.testHooks?.beforeSetupFileReplacement === 'function'
        ? { beforeReplacement: opts.testHooks.beforeSetupFileReplacement }
        : {})
    });
    appliedActions.push({
      type: 'write_env_file',
      target: envPath,
      ok: true,
      status: envWrite.status,
      recovery_path: envWrite.recovery_path || null
    });
    await opts.testHooks?.afterEnvWrite?.({ envPath });
  };
  if (writeEnvFile && !storeKeychain) {
    try {
      await writeSetupEnvFile();
    } catch (error: unknown) {
      return rollbackSetupAfterFailure({
        stage: 'write_env_file',
        error,
        keychain,
        keychainRetained: false,
        restoreProcessEnvironment: false,
        expectedCurrentState: setupExpectedState
      });
    }
  }
  let shellProfileResult: any = { ok: true, status: 'skipped', files: [] };
  try {
    await opts.testHooks?.beforeCenterSync?.();
  } catch (error: unknown) {
    return rollbackSetupAfterFailure({
      stage: 'sync_center_desktop_credentials',
      error,
      keychain,
      keychainRetained: storeKeychain && keychain.ok === true,
      restoreProcessEnvironment: false,
      expectedCurrentState: setupExpectedState
    });
  }
  const skipLaunchEnvironment = opts.syncLaunchEnv === false
    || process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV === '1';
  const {
    repairCodexLbLegacyKeychainMigration,
    syncDesktopCenterLaunchCredentials
  } = await import('../core/codex-lb/desktop-center-credentials.js');
  const centerCredentials: any = skipLaunchEnvironment
    ? {
        schema: 'sks.codex-lb-desktop-center-credentials.v1',
        ok: true,
        status: 'skipped',
        mode: desktopMode,
        api_key_fingerprint: keyFingerprint,
        base_url_present: true,
        launch_env: { api_key: 'skipped', base_url: 'skipped' },
        stale_twins_removed: [],
        stale_twins_quarantined: [],
        stale_keychain_cleared: [],
        blockers: []
      }
    : await syncDesktopCenterLaunchCredentials({
        mode: desktopMode,
        home,
        ...(opts.platform ? { platform: opts.platform } : {}),
        ...(opts.launchctlBin ? { launchctlBin: opts.launchctlBin } : {}),
        ...(opts.securityBin ? { securityBin: opts.securityBin } : {}),
        ...(opts.runProcessImpl ? { runProcessImpl: opts.runProcessImpl } : {}),
        deferLegacyKeychainCleanup: writeEnvFile && !storeKeychain,
        // Use the just-written values; avoid ambient process.env shadowing.
        loadedEnv: await loadCodexLbEnv({ ...opts, home, processEnv: {}, envPath, metadataPath })
      }).catch((error: unknown) => ({
        ok: false,
        status: 'center_desktop_credentials_failed',
        error: error instanceof Error ? error.message : String(error)
      }));
  appliedActions.push({
    type: 'sync_center_desktop_credentials',
    target: 'launchctl from official sks-codex-lb store',
    ok: centerCredentials.ok === true,
    status: centerCredentials.status
  });
  if (centerCredentials.ok !== true) {
    return rollbackSetupAfterFailure({
      stage: 'sync_center_desktop_credentials',
      error: centerCredentials.error || centerCredentials.status,
      keychain,
      keychainRetained: storeKeychain && keychain.ok === true,
      restoreProcessEnvironment: false,
      externalStateMayBeMutated: true,
      expectedCurrentState: setupExpectedState,
      centerCredentials
    });
  }
  const codexEnvironment = await syncCodexLbProviderEnvironment({ env_path: envPath, base_url: baseUrl }, {
    ...opts,
    home,
    apiKey,
    baseUrl,
    // Center sync owns dual-auth secret injection; avoid the old unset-only path racing it.
    syncLaunchEnv: syncLaunchctl && desktopMode !== 'desktop-dual-auth-compat'
  }).catch((error: unknown) => ({
    ok: false,
    status: 'environment_failed',
    error: error instanceof Error ? error.message : String(error)
  }));
  if (syncLaunchctl && desktopMode !== 'desktop-dual-auth-compat') {
    appliedActions.push({ type: 'sync_launchctl', target: 'macOS launchctl user environment (base URL only; API-key env removed)', ok: codexEnvironment.ok === true, status: codexEnvironment.status });
  }
  if (codexEnvironment.ok !== true) {
    return rollbackSetupAfterFailure({
      stage: 'sync_codex_environment',
      error: codexEnvironment.error || codexEnvironment.status,
      keychain,
      keychainRetained: storeKeychain && keychain.ok === true,
      restoreProcessEnvironment: true,
      externalStateMayBeMutated: true,
      expectedCurrentState: setupExpectedState,
      centerCredentials,
      codexEnvironment
    });
  }
  if (writeEnvFile && storeKeychain) {
    try {
      await writeSetupEnvFile();
    } catch (error: unknown) {
      return rollbackSetupAfterFailure({
        stage: 'write_env_file',
        error,
        keychain,
        keychainRetained: true,
        restoreProcessEnvironment: true,
        externalStateMayBeMutated: true,
        expectedCurrentState: setupExpectedState,
        centerCredentials,
        codexEnvironment
      });
    }
  }
  process.env.CODEX_LB_BASE_URL = baseUrl;
  process.env.CODEX_LB_API_KEY = apiKey;
  shellProfileResult = await installCodexLbShellProfileSnippet({
    home,
    envPath,
    shellProfile,
    expectedFiles: beforeState.files,
    writeFileIfUnchanged: async ({ file, text, mode }) => {
      try {
        await opts.testHooks?.beforeShellProfileWrite?.({ file });
        return await writeSetupFile({
          file,
          text,
          mode,
          ...(typeof opts.testHooks?.beforeSetupFileReplacement === 'function'
            ? { beforeReplacement: opts.testHooks.beforeSetupFileReplacement }
            : {})
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          status: message.split(':', 1)[0] || 'write_failed',
          error: message
        };
      }
    }
  })
    .catch((err: any) => ({ ok: false, status: 'failed', files: [], error: err.message }));
  if (shellProfile !== 'skip') {
    appliedActions.push({
      type: 'install_shell_profile_snippet',
      target: shellProfileResult.files?.join(', ') || shellProfile,
      ok: shellProfileResult.ok === true,
      status: shellProfileResult.status
    });
  }
  if (shellProfileResult.ok !== true) {
    return rollbackSetupAfterFailure({
      stage: 'install_shell_profile_snippet',
      error: shellProfileResult.error || shellProfileResult.status,
      keychain,
      keychainRetained: storeKeychain && keychain.ok === true,
      restoreProcessEnvironment: true,
      externalStateMayBeMutated: true,
      expectedCurrentState: setupExpectedState,
      centerCredentials,
      codexEnvironment
    });
  }
  const authAfter = await captureCodexAuthSnapshot({ home, authPath: opts.authPath || codexAuthPath(home) });
  let authInvariantError: string | null = null;
  try {
    await assertDesktopAuthUnchangedBySks(authBefore, authAfter);
  } catch (error: unknown) {
    authInvariantError = error instanceof Error ? error.message : String(error);
  }
  const authReconcile = {
    status: authInvariantError ? 'failed' : 'oauth_untouched',
    reason: authInvariantError || 'credential_setup_does_not_mutate_desktop_auth',
    auth_path: authBefore.path,
    ...(authInvariantError ? { error: authInvariantError } : {})
  };
  const codexLogin = {
    ok: !authInvariantError,
    status: authInvariantError ? 'desktop_auth_byte_invariant_failed' : 'not_required',
    reason: authInvariantError || 'cli_gateway_key_is_separate_from_chatgpt_oauth',
    error: authInvariantError
  };
  if (authInvariantError) {
    return rollbackSetupAfterFailure({
      stage: 'verify_desktop_auth_invariant',
      error: authInvariantError,
      keychain,
      keychainRetained: storeKeychain && keychain.ok === true,
      restoreProcessEnvironment: true,
      externalStateMayBeMutated: true,
      expectedCurrentState: setupExpectedState,
      centerCredentials,
      codexEnvironment
    });
  }
  const finalCodexLb = await codexLbStatus({ ...opts, home, configPath, envPath });
  const keychainOk = !storeKeychain || keychain.ok === true;
  const ok = Boolean(codexEnvironment.ok && codexLogin.ok && keychainOk);
  const afterState = await captureCodexLbSetupWriteState({ home, configPath, envPath, metadataPath, shellProfile });
  const drift = [
    ...detectCodexLbSetupDrift({
      useDefaultProvider,
      writeEnvFile,
      storeKeychain,
      syncLaunchctl,
      shellProfile,
      selected: finalCodexLb.selected,
      envFile: finalCodexLb.env_file,
      keychain,
      codexEnvironment,
      shellProfileResult,
      beforeState,
      afterState
    }),
    ...(authInvariantError ? ['desktop_auth_byte_invariant_failed'] : []),
    ...(!keychainOk ? ['codex_lb_keychain_store_failed'] : []),
    ...(toolCatalog.required !== false && toolCatalog.ok !== true ? ['codex_lb_gpt56_tool_catalog_not_ready'] : [])
  ];
  const appliedPersistenceModes = appliedCodexLbPersistenceModes({
    writeEnvFile,
    storeKeychain,
    syncLaunchctl,
    shellProfile,
    envFile: finalCodexLb.env_file,
    keychain,
    codexEnvironment,
    shellProfileResult,
    apiKeySource: finalCodexLb.env_loader?.api_key?.source || null
  });
  const persistence = codexLbPersistenceSummary({
    selectedModes: selectedPersistenceModes,
    appliedModes: appliedPersistenceModes,
    processOnly: appliedPersistenceModes.includes('process_only_ephemeral')
  });
  const warnings = [
    ...insecureLocalWarning,
    ...persistence.warnings,
    ...(preservedLegacySelection ? ['legacy_desktop_auth_routing_requires_explicit_migrate_legacy_desktop'] : []),
    ...(toolCatalog.required !== false && toolCatalog.ok !== true ? ['codex_lb_gpt56_tool_catalog_not_ready'] : [])
  ];
  if (!ok || drift.length > 0) {
    return rollbackSetupAfterFailure({
      stage: 'verify_final_setup_state',
      error: drift.join(',') || 'configuration_failed',
      keychain,
      keychainRetained: storeKeychain && keychain.ok === true,
      restoreProcessEnvironment: true,
      externalStateMayBeMutated: true,
      expectedCurrentState: setupExpectedState,
      centerCredentials,
      codexEnvironment
    });
  }
  const retainedSetupRecoveryPaths: string[] = [];
  for (const recoveryPath of [...new Set(setupWriteRecoveryPaths)]) {
    if (await removeCodexLbSetupRecoveryPath(recoveryPath)) {
      for (const action of appliedActions) {
        if (action.recovery_path === recoveryPath) {
          action.recovery_path = null;
          action.recovery_claim_cleanup = 'removed_after_final_verification';
        }
      }
      continue;
    }
    retainedSetupRecoveryPaths.push(recoveryPath);
    await hardenCodexLbSetupRecoveryPath(recoveryPath);
  }
  const retainedSecretRecoveryPaths = retainedSetupRecoveryPaths
    .filter((recoveryPath) => isRecoveryPathForFile(recoveryPath, envPath));
  let legacyKeychainCleanup: any = {
    ok: true,
    status: 'not_applicable',
    keychain_cleared: [],
    blockers: []
  };
  if ((opts.platform || process.platform) === 'darwin' && writeEnvFile && !storeKeychain) {
    await opts.testHooks?.beforeLegacyKeychainCleanup?.({ envPath, metadataPath });
    const migration = await repairCodexLbLegacyKeychainMigration({
      home,
      baseUrl,
      envPath,
      metadataPath,
      account: opts.account || process.env.USER || 'sks',
      platform: opts.platform || process.platform,
      ...(opts.securityBin ? { securityBin: opts.securityBin } : {}),
      ...(opts.runProcessImpl ? { runProcessImpl: opts.runProcessImpl } : {}),
      expectedApiKeySha256: keyFingerprint
    });
    const cleanupBlockers = [...new Set(migration.blockers)];
    const replacementStoreVerified = migration.env_key_valid
      && migration.status !== 'replacement_store_unverified'
      && migration.status !== 'env_file_unsafe';
    const cleanupOk = replacementStoreVerified
      && migration.ok
      && cleanupBlockers.length === 0;
    legacyKeychainCleanup = {
      ok: cleanupOk,
      status: !replacementStoreVerified
        ? 'legacy_keychain_cleanup_blocked_replacement_store_unverified'
        : cleanupOk
        ? migration.keychain_cleared.length > 0
          ? 'legacy_keychain_removed'
          : 'legacy_keychain_absent'
        : 'legacy_keychain_cleanup_failed_secure_store_retained',
      replacement_store_verified: replacementStoreVerified,
      keychain_cleared: migration.keychain_cleared,
      blockers: cleanupBlockers
    };
    appliedActions.push({
      type: 'migrate_legacy_keychain',
      target: 'macOS Keychain service sks-codex-lb',
      ok: legacyKeychainCleanup.ok,
      status: legacyKeychainCleanup.status
    });
  }
  const finalWarnings = [
    ...warnings,
    ...(retainedSetupRecoveryPaths.length > 0 ? ['setup_recovery_claim_cleanup_required'] : []),
    ...(retainedSecretRecoveryPaths.length > 0 ? ['setup_secret_recovery_retained'] : []),
    ...(!legacyKeychainCleanup.ok
      ? ['legacy_keychain_cleanup_indeterminate_rotate_provider_key']
      : legacyKeychainCleanup.keychain_cleared.length > 0
        ? ['legacy_keychain_removed_rotate_provider_key_if_not_already_rotated']
        : [])
  ];
  return {
    ok: legacyKeychainCleanup.ok,
    status: legacyKeychainCleanup.ok
      ? 'configured'
      : 'legacy_keychain_cleanup_failed_secure_store_retained',
    mode: desktopMode,
    identity_plane: 'unchanged',
    routing_plane: codexLbRoutingPlane(desktopMode),
    gateway_auth_transport: opts.gatewayAuthTransport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT,
    oauth_preserved: !authInvariantError,
    auth_mutated: false,
    plan: plan as any,
    applied_actions: appliedActions,
    drift: [...drift, ...legacyKeychainCleanup.blockers],
    persistence,
    center_credentials: centerCredentials,
    config_path: configPath,
    env_path: envPath,
    metadata_path: metadataPath,
    backup_path: safeWrite.backup_path || null,
    recovery_paths: [
      ...new Set([
        ...(safeWrite.backup_path ? [safeWrite.backup_path] : []),
        ...retainedSetupRecoveryPaths
      ])
    ],
    secret_recovery_paths: retainedSecretRecoveryPaths,
    base_url: baseUrl,
    env_key: 'CODEX_LB_API_KEY',
    keychain,
    legacy_keychain_cleanup: legacyKeychainCleanup,
    warnings: finalWarnings,
    auth_reconcile: authReconcile,
    codex_lb: finalCodexLb,
    codex_environment: codexEnvironment,
    codex_login: codexLogin,
    tool_catalog: toolCatalog,
    tool_output_recovery: toolOutputRecovery,
    error: authReconcile.error || codexEnvironment.error || codexLogin.error || null
  };
}

function isRecoveryPathForFile(recoveryPath: string, file: string): boolean {
  const target = path.resolve(file);
  const candidate = path.resolve(String(recoveryPath || ''));
  return candidate.startsWith(`${target}.sks-`);
}

function desktopModeRequiresGlobalSecretEnvironment(mode: CodexLbDesktopMode): boolean {
  return mode === 'desktop-dual-auth-compat';
}

export async function codexLbStatus(opts: any = {}) {
  const home = opts.home || process.env.HOME || os.homedir();
  const configPath = opts.configPath || codexLbConfigPath(home);
  const envPath = opts.envPath || codexLbEnvPath(home);
  const rawConfig = await readText(configPath, '');
  const orphanManagedMarkerCleanup = removeCodexLbOrphanManagedMarkers(rawConfig);
  const config = orphanManagedMarkerCleanup.text;
  const envExists = await exists(envPath);
  const envLoad = await loadCodexLbEnv({ ...opts, home, envPath });
  const authPath = opts.authPath || codexAuthPath(home);
  const authText = await readText(authPath, '');
  const authMode = codexAuthModeSummary(authText);
  const authApiKey = parseCodexAuthApiKey(authText);
  const envKeyConfigured = Boolean(envLoad.secret_api_key);
  const providerConfigured = /\[model_providers\.codex-lb\]/.test(config);
  const selected = hasTopLevelCodexLbSelected(config);
  const providerBaseUrl = normalizeCodexLbBaseUrl(codexLbProviderBaseUrl(config));
  const credentialBaseUrl = envLoad.base_url;
  const baseUrl = credentialBaseUrl || providerBaseUrl || null;
  const providerBaseUrlMatchesCredential = Boolean(providerBaseUrl && credentialBaseUrl && providerBaseUrl === credentialBaseUrl);
  const providerName = codexLbProviderName(config);
  const providerWireApi = codexLbProviderWireApi(config);
  const providerSupportsWebsockets = codexLbProviderSupportsWebsockets(config);
  const providerRequiresOpenAiAuth = codexLbProviderRequiresOpenAiAuth(config);
  const providerOpenAiAuthDisabled = codexLbProviderOpenAiAuthDisabled(config);
  const providerEnvKey = codexLbProviderEnvKey(config);
  const providerHasSeparateGatewayAuth = codexLbProviderHasSeparateGatewayAuth(config);
  const desktopMode = managedCodexLbDesktopMode(config);
  const bridgeBaseUrl = desktopMode === 'desktop-native-bridge'
    ? topLevelTomlString(config, 'openai_base_url')
    : '';
  const sharedOpenAiRouting = codexLbSharedOpenAiRoutingState(config, baseUrl);
  const codexLbKeyInSharedAuth = Boolean(authApiKey && envLoad.secret_api_key && authApiKey === envLoad.secret_api_key);
  const sharedOpenAiRoutingSafe = !codexLbKeyInSharedAuth || sharedOpenAiRouting.status === 'matched';
  const cliProviderContractOk = providerConfigured
    && providerBaseUrlMatchesCredential
    && providerName === 'codex-lb'
    && providerWireApi === 'responses'
    && providerEnvKey === CODEX_LB_PROVIDER_ENV_KEY
    && providerHasSeparateGatewayAuth
    && providerSupportsWebsockets === true
    && providerOpenAiAuthDisabled;
  const retiredCompatConfigured = desktopMode === 'desktop-dual-auth-compat';
  const definedButNotSelected = providerConfigured && !selected && desktopMode === null;
  const providerContractOk = !retiredCompatConfigured && cliProviderContractOk;
  const providerUsesCodexLbEnvAuth = providerConfigured
    && providerEnvKey === CODEX_LB_PROVIDER_ENV_KEY
    && providerHasSeparateGatewayAuth
    && providerOpenAiAuthDisabled;
  const oauthAvailable = authMode.mode === 'chatgpt_oauth' || authMode.mode === 'browser_marker';
  const authRoutingCoherent = desktopMode === 'desktop-native-bridge'
    ? !selected && oauthAvailable && !codexLbKeyInSharedAuth
    : desktopMode === 'desktop-dual-auth-compat'
      ? selected && oauthAvailable && !codexLbKeyInSharedAuth
      : !codexLbKeyInSharedAuth && (!selected || providerUsesCodexLbEnvAuth);
  const codexAppUsableWithCodexLb = desktopMode === 'desktop-native-bridge'
    ? Boolean(bridgeBaseUrl && oauthAvailable)
    : retiredCompatConfigured
      ? false
      : authMode.codex_app_usable;
  const fastMode = codexLbFastModeConfigStatus(config);
  const launchEnvironment = await inspectCodexLbMacLaunchEnvironment(baseUrl, opts).catch((err: any) => ({
    checked: true,
    available: false,
    status: 'inspect_failed',
    error: err.message
  }));
  const providerReady = providerContractOk
    && envLoad.configured
    && Boolean(baseUrl)
    && authRoutingCoherent
    && !retiredCompatConfigured
    && (desktopMode === 'desktop-native-bridge' ? Boolean(bridgeBaseUrl) : true);
  const blockers = [
    ...(retiredCompatConfigured ? ['desktop_dual_auth_compat_unavailable'] : []),
    ...(!retiredCompatConfigured && providerConfigured && !providerContractOk
      ? ['codex_lb_provider_contract_drift']
      : [])
  ];
  const probeToolOutputRecovery = opts.probeToolOutputRecovery === true;
  const toolOutputRecovery = !selected
    ? codexLbToolOutputRecoveryNotSelected()
    : !probeToolOutputRecovery || !providerContractOk || !envLoad.configured
      ? codexLbToolOutputRecoveryNotChecked(true)
      : await probeCodexLbToolOutputRecovery({
          baseUrl,
          ...(typeof opts.toolOutputRecoveryFetch === 'function' ? { fetchImpl: opts.toolOutputRecoveryFetch } : {}),
          timeoutMs: Number(opts.toolOutputRecoveryTimeoutMs || 4_000),
          allowUnverified: opts.allowUnverifiedToolOutputRecovery === true
            || codexLbToolOutputRecoveryOverrideAcknowledged({ env: opts.env || process.env })
        });
  const secretResolution = {
    source: envLoad.source,
    path: envLoad.source === 'env-file' ? envLoad.env_paths[0] || envPath : null,
    prompt_risk: 'none' as const
  };
  return {
    ok: providerReady && (!selected || !probeToolOutputRecovery || toolOutputRecovery.ok),
    blockers,
    warnings: definedButNotSelected ? ['codex_lb_defined_but_not_selected'] : [],
    orphan_managed_markers: orphanManagedMarkerCleanup.orphan_markers,
    managed_marker_cleanup_required: orphanManagedMarkerCleanup.changed,
    activation_guidance: definedButNotSelected
      ? [
          'Run `sks codex-lb use-cli` to select the CLI provider.',
          'Run `sks codex-lb use-desktop-full` to activate managed Desktop bridge mode.'
        ]
      : [],
    provider_ready: providerReady,
    config_path: configPath,
    env_path: envPath,
    provider_configured: providerConfigured,
    provider_base_url: providerBaseUrl || null,
    credential_base_url: credentialBaseUrl || null,
    provider_base_url_matches_credential: providerBaseUrlMatchesCredential,
    provider_name: providerName || null,
    provider_wire_api: providerWireApi || null,
    provider_supports_websockets: providerSupportsWebsockets,
    provider_contract_ok: providerContractOk,
    provider_requires_openai_auth: providerRequiresOpenAiAuth,
    provider_openai_auth_disabled: providerOpenAiAuthDisabled,
    provider_env_key: providerEnvKey || null,
    provider_has_separate_gateway_auth: providerHasSeparateGatewayAuth,
    provider_uses_codex_lb_env_auth: providerUsesCodexLbEnvAuth,
    desktop_mode: desktopMode || (selected ? 'legacy-or-manual-selected-provider' : 'cli-provider'),
    bridge_base_url: bridgeBaseUrl || null,
    legacy_migration_required: Boolean(
      !desktopMode
      && selected
      && authMode.mode === 'apikey'
      && sharedOpenAiRouting.managed
    ),
    selected,
    env_file: envExists,
    env_key_configured: envKeyConfigured,
    env_base_url_configured: Boolean(envLoad.base_url),
    env_loader: {
      configured: envLoad.configured,
      missing: envLoad.missing,
      source: envLoad.source,
      source_priority: envLoad.source_priority,
      api_key: envLoad.api_key,
      blockers: envLoad.blockers,
      guidance: envLoad.guidance,
      credential_binding: envLoad.credential_binding,
      keychain: envLoad.keychain,
      env_paths: envLoad.env_paths
    },
    secret_resolution: secretResolution,
    base_url: baseUrl,
    auth_path: authPath,
    auth_mode: authMode.mode,
    codex_lb_key_in_shared_auth: codexLbKeyInSharedAuth,
    auth_routing_coherent: authRoutingCoherent,
    shared_openai_routing: {
      status: sharedOpenAiRouting.status,
      safe: sharedOpenAiRoutingSafe,
      managed: sharedOpenAiRouting.managed,
      configured_base_url: sharedOpenAiRouting.configured_base_url
    },
    auth_usable_for_codex_app: codexAppUsableWithCodexLb && authRoutingCoherent,
    auth_summary: !sharedOpenAiRoutingSafe
      ? 'codex-lb key is active in shared auth without a verified built-in OpenAI routing guard'
      : !authRoutingCoherent
        ? 'Codex provider selection and shared auth mode do not form a coherent codex-lb/OAuth state'
      : codexAppUsableWithCodexLb ? `codex-lb provider uses ${authMode.mode} OpenAI-style auth through Codex App` : authMode.summary,
    fast_mode: fastMode,
    launch_environment: launchEnvironment,
    tool_output_recovery: toolOutputRecovery
  };
}

export function formatCodexLbStatusText(status: any = {}, opts: any = {}) {
  const backupPresent = Boolean(opts.backupPresent);
  const backupPath = opts.backupPath || '';
  const resolution = status.secret_resolution || {};
  const resolutionSource = String(resolution.source || status.env_loader?.source || 'missing');
  const resolutionPath = resolution.path
    || (resolutionSource === 'env-file' ? status.env_loader?.env_paths?.[0] || status.env_path : null);
  const displayResolutionPath = resolutionPath
    ? formatCodexLbStatusPath(String(resolutionPath), opts.home || os.homedir())
    : '';
  const resolutionLabel = displayResolutionPath
    ? `${resolutionSource} (${displayResolutionPath})`
    : resolutionSource;
  const keychainUsage = resolutionSource === 'keychain' ? 'used' : 'not used';
  const promptRisk = String(
    resolution.prompt_risk
      || (resolutionSource === 'keychain' ? 'possible' : 'none')
  );
  const lines = [
    'SKS codex-lb',
    '',
    `Configured: ${status.ok ? 'yes' : 'no'}`,
    `Selected:   ${status.selected ? 'yes' : 'no'}`,
    `Provider:   ${status.provider_contract_ok ? 'codex-lb App contract ok' : status.provider_configured ? 'drifted' : 'missing'}`,
    `Provider OpenAI Auth: ${status.provider_requires_openai_auth ? 'required' : 'not required/drifted'} (${status.provider_name || 'missing'})`,
    `Codex App auth: ${status.auth_usable_for_codex_app ? 'ok' : 'needs sign-in/repair'} (${status.auth_mode || 'unknown'})`,
    `Shared OpenAI routing: ${status.shared_openai_routing?.safe === false ? 'unsafe' : status.shared_openai_routing?.status || 'unknown'}${status.shared_openai_routing?.managed ? ' (sks-managed)' : ''}`,
    `Auth/routing coherent: ${status.auth_routing_coherent ? 'yes' : 'no'}`,
    `Key source: ${resolutionLabel} · keychain: ${keychainUsage} · prompt risk: ${promptRisk}`
  ];
  if (status.tool_output_recovery?.status && status.tool_output_recovery.status !== 'not_selected') {
    const recovery = status.tool_output_recovery;
    lines.push(`Interrupted tool-output recovery: ${recovery.ok ? 'ready' : 'blocked'} (${recovery.observed_version || recovery.status}; minimum ${recovery.minimum_version})`);
    if (!recovery.ok) {
      for (const action of recovery.operator_actions || []) lines.push(`  action: ${action}`);
    }
  }
  if (status.auth_summary) lines.push(`Auth detail: ${status.auth_summary}`);
  if (status.fast_mode) {
    const fast = status.fast_mode;
    lines.push(`Fast Mode: ${fast.configured ? `configured request=${fast.codex_request_service_tier} upstream=${fast.codex_lb_upstream_service_tier}` : 'not configured'}`);
    if (!fast.actual_service_tier_verified) lines.push(`Fast proof: unverified until ${fast.proof_required}. Run: ${fast.verification_command}`);
  }
  lines.push(`Env file:   ${status.env_file ? status.env_path : 'missing'}`);
  if (status.base_url) lines.push(`Base URL:   ${status.base_url}`);
  lines.push(`ChatGPT backup: ${backupPresent ? `yes (${backupPath})` : 'no'}`);
  if ((status.warnings || []).includes('codex_lb_defined_but_not_selected')) {
    lines.push('', 'Warning [codex_lb_defined_but_not_selected]: the codex-lb provider is defined but not selected.');
    for (const action of status.activation_guidance || []) lines.push(`  ${action}`);
  }
  if (status.legacy_migration_required || status.shared_openai_routing?.safe === false) lines.push('', 'Run: sks codex-lb migrate-legacy-desktop --restart-app. Ordinary repair will not rewrite shared Codex auth.');
  else if (status.provider_configured && !status.provider_contract_ok) lines.push('', 'Run: sks codex-lb repair to rewrite the provider block to the current codex-lb App contract.');
  else if (status.desktop_mode === 'desktop-native-bridge' && !status.auth_usable_for_codex_app) lines.push('', 'Sign in with ChatGPT OAuth, then run: sks codex-lb use-desktop-full.');
  else if (status.ok && status.desktop_mode === 'cli-provider' && !status.selected && !(status.warnings || []).includes('codex_lb_defined_but_not_selected')) lines.push('', 'CLI provider is stored but unselected. Run `sks codex-lb use-cli` for CLI use or `sks codex-lb use-desktop-full` for managed Desktop routing.');
  else if (status.desktop_mode === 'desktop-dual-auth-compat') lines.push('', 'The retired compatibility route is blocked. Run `sks codex-lb use-desktop-full` or `sks codex-lb disable`.');
  else if (status.ok) lines.push('', 'Status: configured; no ordinary repair needed.');
  else if (!status.ok && status.base_url && status.env_key_configured) lines.push('', 'Run: sks codex-lb repair. To change routing explicitly, use `use-desktop-full`, `use-cli`, or `disable`.');
  else if (!status.ok && !status.env_key_configured) lines.push('', 'Gateway key missing. Store CODEX_LB_API_KEY in ~/.codex/sks-codex-lb.env, run `sks codex-lb setup --host <domain> --api-key-stdin --yes`, or provide CODEX_LB_API_KEY in the environment.');
  else if (!status.ok) lines.push('', 'Run: sks codex-lb setup --host <domain> --api-key-stdin');
  if (backupPresent) lines.push('Legacy OAuth backup detected; use `sks codex-lb migrate-legacy-desktop --restart-app` instead of background auth switching.');
  return `${lines.join('\n')}\n`;
}

function formatCodexLbStatusPath(file: string, home: string): string {
  const resolvedFile = path.resolve(file);
  const resolvedHome = path.resolve(String(home || ''));
  const relative = path.relative(resolvedHome, resolvedFile);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? `~/${relative.split(path.sep).join('/')}`
    : file;
}

export function formatCodexLbRepairResultText(result: any = {}) {
  const lines = [
    'codex-lb credential/provider configuration repaired without changing Codex shared auth.',
    `Config: ${result.config_path}`,
    `Key env: ${result.env_path}`
  ];
  if (result.auth_reconcile?.status === 'oauth_untouched') lines.push('Codex App auth: unchanged.');
  else if (result.auth_reconcile?.status === 'legacy_migration_required') lines.push('Legacy Desktop auth routing: run `sks codex-lb migrate-legacy-desktop --restart-app` explicitly.');
  return `${lines.join('\n')}\n`;
}

function codexLbProviderBaseUrl(text: any = '') {
  const block = String(text || '').match(/(^|\n)\[model_providers\.codex-lb\]([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[2] || '';
  return block.match(/(^|\n)\s*base_url\s*=\s*"([^"]+)"/)?.[2] || '';
}

function codexLbProviderName(text: any = '') {
  const block = String(text || '').match(/(^|\n)\[model_providers\.codex-lb\]([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[2] || '';
  return (block.match(/(^|\n)\s*name\s*=\s*"([^"]+)"/)?.[2] || '').trim();
}

function codexLbProviderWireApi(text: any = '') {
  const block = String(text || '').match(/(^|\n)\[model_providers\.codex-lb\]([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[2] || '';
  return (block.match(/(^|\n)\s*wire_api\s*=\s*"([^"]+)"/)?.[2] || '').trim();
}

function codexLbProviderSupportsWebsockets(text: any = '') {
  const block = String(text || '').match(/(^|\n)\[model_providers\.codex-lb\]([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[2] || '';
  if (/(^|\n)\s*supports_websockets\s*=\s*true\s*(?:#.*)?(?=\n|$)/.test(block)) return true;
  if (/(^|\n)\s*supports_websockets\s*=\s*false\s*(?:#.*)?(?=\n|$)/.test(block)) return false;
  return null;
}

function codexLbProviderRequiresOpenAiAuth(text: any = '') {
  const block = String(text || '').match(/(^|\n)\[model_providers\.codex-lb\]([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[2] || '';
  return /(^|\n)\s*requires_openai_auth\s*=\s*true\s*(?:#.*)?(?=\n|$)/.test(block);
}

function codexLbProviderOpenAiAuthDisabled(text: any = '') {
  const block = String(text || '').match(/(^|\n)\[model_providers\.codex-lb\]([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[2] || '';
  return /(^|\n)\s*requires_openai_auth\s*=\s*false\s*(?:#.*)?(?=\n|$)/.test(block);
}

function codexLbProviderEnvKey(text: any = '') {
  const block = String(text || '').match(/(^|\n)\[model_providers\.codex-lb\]([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[2] || '';
  return block.match(/(^|\n)\s*env_key\s*=\s*"([^"]+)"/)?.[2]
    || block.match(/env_http_headers\s*=\s*\{[^}]*"X-Codex-LB-API-Key"\s*=\s*"([^"]+)"[^}]*\}/)?.[1]
    || '';
}

function codexLbProviderHasSeparateGatewayAuth(text: any = '') {
  const block = String(text || '').match(/(^|\n)\[model_providers\.codex-lb\]([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[2] || '';
  return /X-Codex-LB-API-Key/.test(block)
    && /CODEX_LB_API_KEY/.test(block)
    && !/(^|\n)\s*env_key\s*=/.test(block);
}

function codexLbFastModeConfigStatus(text: any = '') {
  const globalServiceTier = topLevelTomlString(text, 'service_tier');
  const profileBlock = String(text || '').match(/(^|\n)\[profiles\.sks-fast-high\]([\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/)?.[2] || '';
  const profileServiceTier = profileBlock.match(/(^|\n)\s*service_tier\s*=\s*"([^"]+)"/)?.[2] || '';
  const configured = globalServiceTier === 'fast' || globalServiceTier === CODEX_LB_CANONICAL_FAST_SERVICE_TIER;
  return {
    schema: 'sks.codex-lb-fast-mode-config.v1',
    configured,
    top_level_service_tier: globalServiceTier || null,
    legacy_profile_service_tier: profileServiceTier || null,
    codex_request_service_tier: configured ? 'fast' : null,
    codex_lb_upstream_service_tier: configured ? CODEX_LB_CANONICAL_FAST_SERVICE_TIER : null,
    actual_service_tier_verified: false,
    verification_command: 'sks codex-lb fast-check --json',
    proof_required: 'codex-lb request log must show requestedServiceTier=priority and actualServiceTier/serviceTier=priority'
  };
}

function topLevelTomlString(text: any = '', key: string) {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.match(new RegExp(`(^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`))?.[2] || '';
}

function tomlTableString(text: any = '', table: string, key: string) {
  const block = String(text || '').match(new RegExp(`(^|\\n)\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`))?.[2] || '';
  return block.match(new RegExp(`(^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`))?.[2] || '';
}

export async function repairCodexLbAuth(opts: any = {}): Promise<CodexLbAuthInstallResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  let status = await codexLbStatus({ ...opts, home });
  const authPath = opts.authPath || status.auth_path || codexAuthPath(home);
  const authBefore = await captureCodexAuthSnapshot({ home, authPath });
  const currentConfig = await readText(status.config_path, '');
  const legacyEnv = await loadCodexLbEnv({ ...opts, home });
  const legacyDetection = await detectLegacyCodexLbDesktopState({
    home,
    configPath: status.config_path,
    authPath,
    ...(status.base_url ? { remoteBaseUrl: status.base_url } : {}),
    ...(legacyEnv.secret_api_key
      ? { expectedGatewayApiKey: legacyEnv.secret_api_key }
      : {})
  });
  const legacySharedAuthSelected = status.selected === true
    && status.auth_mode === 'apikey'
    && status.shared_openai_routing?.managed === true;
  if (legacyDetection.legacy_destructive_mode || legacySharedAuthSelected) {
    return {
      ok: false,
      status: 'legacy_migration_required',
      reason: 'legacy_desktop_auth_routing_requires_explicit_migration',
      config_path: status.config_path,
      env_path: status.env_path,
      base_url: status.base_url,
      codex_lb: status,
      auth_reconcile: {
        status: 'legacy_migration_required',
        reason: 'run_sks_codex_lb_migrate_legacy_desktop',
        auth_path: authPath
      },
      codex_login: {
        ok: true,
        status: 'not_required',
        reason: 'ordinary_repair_never_changes_shared_codex_auth'
      },
      tool_catalog: {
        ok: true,
        required: false,
        status: 'not_bound_during_repair',
        config_changed: false
      }
    };
  }

  if (!status.env_key_configured && status.base_url && (status.provider_configured || status.selected || status.env_base_url_configured)) {
    if (status.auth_mode === 'apikey') {
      return {
        ok: false,
        status: 'legacy_migration_required',
        reason: 'shared_codex_api_key_cannot_be_assumed_to_be_the_codex_lb_gateway_key',
        config_path: status.config_path,
        env_path: status.env_path,
        base_url: status.base_url,
        codex_lb: status,
        auth_reconcile: {
          status: 'legacy_migration_required',
          reason: 'run_sks_codex_lb_setup_with_a_separate_gateway_key_or_migrate_legacy_desktop',
          auth_path: authPath
        },
        codex_login: {
          ok: true,
          status: 'not_required',
          reason: 'ordinary_repair_never_reads_gateway_credentials_from_shared_codex_auth'
        },
        tool_catalog: {
          ok: true,
          required: false,
          status: 'not_bound_during_repair',
          config_changed: false
        }
      };
    }
  }
  if (!status.env_key_configured || !status.base_url) {
    return {
      ok: false,
      status: !status.env_key_configured ? 'missing_env_key' : 'missing_base_url',
      config_path: status.config_path,
      env_path: status.env_path,
      codex_lb: status,
      auth_reconcile: {
        status: 'oauth_untouched',
        reason: 'ordinary_repair_never_changes_shared_codex_auth',
        auth_path: authPath
      }
    };
  }

  const configBeforeRepair = await readText(status.config_path, '');
  const desktopMode = managedCodexLbDesktopMode(configBeforeRepair);
  let nextConfig = configBeforeRepair;
  try {
    if (desktopMode === 'desktop-native-bridge') {
      const bridgeBaseUrl = topLevelTomlString(configBeforeRepair, 'openai_base_url');
      if (!bridgeBaseUrl) throw new Error('managed_desktop_bridge_missing_base_url');
      nextConfig = upsertCodexLbNativeDesktopConfig(configBeforeRepair, {
        bridgeBaseUrl,
        remoteBaseUrl: status.base_url
      });
    } else if (desktopMode === 'desktop-dual-auth-compat') {
      nextConfig = upsertCodexLbCompatDesktopConfig(configBeforeRepair, {
        remoteBaseUrl: status.base_url
      });
    } else {
      nextConfig = upsertCodexLbCliProviderConfig(configBeforeRepair, {
        remoteBaseUrl: status.base_url,
        // Preserve an already explicit manual selection, but never create one.
        selectGlobally: status.selected === true
      });
    }
  } catch (error: unknown) {
    return {
      ok: false,
      status: 'managed_desktop_routing_conflict',
      config_path: status.config_path,
      env_path: status.env_path,
      base_url: status.base_url,
      codex_lb: status,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  await ensureDir(path.dirname(status.config_path));
  const configWrite = await safeWriteCodexConfigToml(
    status.config_path,
    configBeforeRepair,
    nextConfig,
    'codex-lb-safe-repair',
    { verifyUnchangedBeforeWrite: true }
  );
  if (!configWrite.ok) {
    return {
      ok: false,
      status: configWrite.status,
      config_path: status.config_path,
      env_path: status.env_path,
      base_url: status.base_url,
      codex_lb: status,
      error: 'codex_lb_config_repair_failed'
    };
  }

  const codexEnvironment = await syncCodexLbProviderEnvironment(status, opts);
  const authAfter = await captureCodexAuthSnapshot({ home, authPath });
  let authInvariantError: string | null = null;
  try {
    await assertDesktopAuthUnchangedBySks(authBefore, authAfter);
  } catch (error: unknown) {
    authInvariantError = error instanceof Error ? error.message : String(error);
  }
  if (authInvariantError) {
    const writtenConfig = await readText(status.config_path, '');
    await safeWriteCodexConfigToml(
      status.config_path,
      writtenConfig,
      configBeforeRepair,
      'codex-lb-safe-repair-auth-invariant-rollback',
      { verifyUnchangedBeforeWrite: true }
    );
  }
  const finalStatus = await codexLbStatus({ ...opts, home });
  const toolOutputRecovery = opts.probeToolOutputRecovery === true && status.selected
    ? await probeCodexLbToolOutputRecovery({
        baseUrl: status.base_url,
        ...(typeof opts.toolOutputRecoveryFetch === 'function' ? { fetchImpl: opts.toolOutputRecoveryFetch } : {}),
        timeoutMs: Number(opts.toolOutputRecoveryTimeoutMs || 4_000),
        allowUnverified: opts.allowUnverifiedToolOutputRecovery === true
          || codexLbToolOutputRecoveryOverrideAcknowledged({ env: opts.env || process.env })
      })
    : codexLbToolOutputRecoveryNotChecked(status.selected === true);
  const authReconcile: CodexLbAuthReconcileResult = {
    status: authInvariantError ? 'failed' : 'oauth_untouched',
    reason: authInvariantError || 'ordinary_repair_never_changes_shared_codex_auth',
    auth_path: authPath,
    ...(authInvariantError ? { error: authInvariantError } : {})
  };
  const codexLogin: CodexLbLoginSyncResult = {
    ok: !authInvariantError,
    status: authInvariantError ? 'desktop_auth_byte_invariant_failed' : 'not_required',
    reason: authInvariantError || 'gateway_credentials_are_independent_from_codex_login',
    error: authInvariantError
  };
  const toolCatalog = {
    schema: 'sks.codex-lb-tool-catalog-selection.v1',
    ok: true,
    required: false,
    status: desktopMode === 'desktop-native-bridge'
      ? 'not_bound_for_desktop_native'
      : 'not_bound_during_repair',
    config_changed: false,
    selected: finalStatus.selected,
    blockers: [] as string[]
  };
  const ok = Boolean(configWrite.ok && codexEnvironment.ok && !authInvariantError);
  return {
    ok,
    status: ok
      ? configWrite.changed
        ? 'repaired'
        : finalStatus.selected
          ? 'present'
          : 'present_unselected'
      : authInvariantError
        ? 'desktop_auth_byte_invariant_failed'
        : codexEnvironment.status,
    config_path: status.config_path,
    env_path: status.env_path,
    base_url: status.base_url,
    config_repaired: configWrite.changed === true,
    legacy_auth_migrated: false,
    legacy_auth_path: null,
    auth_reconcile: authReconcile,
    codex_lb: finalStatus,
    codex_environment: codexEnvironment,
    codex_login: codexLogin,
    tool_catalog: toolCatalog,
    tool_output_recovery: toolOutputRecovery,
    error: authInvariantError || codexEnvironment.error || null
  };
}

export async function ensureCodexLbAuthDuringInstall(opts: any = {}): Promise<CodexLbAuthInstallResult> {
  if (process.env.SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH === '1' && !opts.force) return { status: 'skipped', reason: 'SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH=1' };
  const status = await codexLbStatus(opts);
  if (!status.selected && !status.provider_configured && !status.env_key_configured) return { status: 'not_configured', codex_lb: status };
  return repairCodexLbAuth({
    ...opts,
    probeToolOutputRecovery: false
  });
}

// Detects a real ChatGPT OAuth token blob in auth.json.
// A bare {"auth_mode":"browser"} marker is NOT considered an OAuth token blob — we preserve it.
function hasChatgptOAuthTokens(text: any = '') {
  try {
    const parsed = JSON.parse(String(text || ''));
    if (!parsed || typeof parsed !== 'object') return false;
    const authMode = String(parsed.auth_mode || parsed.authMode || parsed.mode || '').toLowerCase();
    const tokens = parsed.tokens || parsed.oauth || parsed.oauth_tokens;
    if (tokens && typeof tokens === 'object') {
      if (tokens.id_token || tokens.access_token || tokens.refresh_token) return true;
    }
    if (authMode && /chatgpt|oauth|browser/.test(authMode)) {
      // Only treat as an OAuth blob when real tokens or a refresh metadata trail are also present.
      if (parsed.last_refresh || parsed.expires_at || parsed.refresh_token || parsed.access_token || parsed.id_token) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function parseCodexAuthApiKey(text: any = '') {
  try {
    const parsed = JSON.parse(String(text || ''));
    const key = parsed?.key || parsed?.api_key || parsed?.apiKey || parsed?.openai_api_key || parsed?.OPENAI_API_KEY;
    return typeof key === 'string' ? key.trim() : '';
  } catch {
    return '';
  }
}

function codexAuthModeSummary(text: any = '') {
  const raw = String(text || '').trim();
  if (!raw) return { mode: 'missing', codex_app_usable: false, summary: 'missing auth.json' };
  if (hasChatgptOAuthTokens(raw)) return { mode: 'chatgpt_oauth', codex_app_usable: true, summary: 'ChatGPT OAuth token blob present' };
  const apiKey = parseCodexAuthApiKey(raw);
  if (apiKey) return { mode: 'apikey', codex_app_usable: true, summary: 'API-key auth.json available for requires_openai_auth providers' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.auth_mode === 'browser') return { mode: 'browser_marker', codex_app_usable: true, summary: 'browser auth marker present; token storage is not inspectable' };
  } catch {}
  return { mode: 'unknown', codex_app_usable: false, summary: 'unrecognized auth.json shape' };
}

// Legacy compatibility helper for pre-remediation installations that already
// coupled the codex-lb gateway key to shared Codex auth. No current setup,
// repair, Desktop routing, update, or launch path calls this writer. New flows
// keep ChatGPT OAuth and the gateway credential in separate trust planes.
export async function reconcileCodexLbAuthConflict(opts: any = {}): Promise<CodexLbAuthReconcileResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const status = opts.status || await codexLbStatus({ ...opts, home });
  const authPath = opts.authPath || codexAuthPath(home);
  const backupPath = opts.backupPath || codexAuthChatgptBackupPath(home);
  if (!status.env_key_configured || !status.base_url) {
    return { status: 'skipped', reason: 'codex_lb_not_ready', auth_path: authPath };
  }
  const authExists = await exists(authPath);
  const authText = authExists ? await readText(authPath, '') : '';
  const envLoad = await loadCodexLbEnv({ ...opts, home, envPath: status.env_path });
  const apiKey = String(opts.apiKey || envLoad.secret_api_key || '').trim();
  if (!apiKey) {
    return { status: 'skipped', reason: 'missing_env_key', auth_path: authPath };
  }
  const forceCodexLbApiKeyAuth = opts.forceCodexLbApiKeyAuth === true;
  const currentApiKey = parseCodexAuthApiKey(authText);
  let routingGuardAdded = false;

  const ensureSharedOpenAiRouting = async () => {
    const configPath = opts.configPath || status.config_path || codexLbConfigPath(home);
    const currentConfig = await readText(configPath, '');
    const planned = upsertCodexLbSharedOpenAiRouting(currentConfig, status.base_url);
    if (!planned.ok) {
      return {
        ok: false,
        status: planned.status,
        config_path: configPath,
        configured_base_url: planned.configured_base_url
      };
    }
    if (planned.status === 'present') {
      return { ok: true, status: 'present', changed: false, config_path: configPath, managed: planned.managed };
    }
    const written = await safeWriteCodexConfigToml(configPath, currentConfig, planned.text, 'codex-lb-shared-auth-routing');
    if (!written.ok) return { ok: false, status: written.status, config_path: configPath, error: 'shared_openai_routing_write_failed' };
    const after = await readText(configPath, '');
    const verified = codexLbSharedOpenAiRoutingState(after, status.base_url);
    if (verified.status !== 'matched' || !verified.managed) {
      return { ok: false, status: 'readback_failed', config_path: configPath, error: 'shared_openai_routing_readback_failed' };
    }
    routingGuardAdded = true;
    return { ok: true, status: 'added', changed: true, config_path: configPath, managed: true };
  };

  const rollbackSharedOpenAiRouting = async () => {
    if (!routingGuardAdded) return { ok: true, status: 'not_needed' };
    const configPath = opts.configPath || status.config_path || codexLbConfigPath(home);
    const currentConfig = await readText(configPath, '');
    const removal = removeCodexLbSharedOpenAiRouting(currentConfig, status.base_url);
    if (!removal.changed) return { ok: false, status: 'not_owned_or_changed' };
    const written = await safeWriteCodexConfigToml(configPath, currentConfig, ensureTrailingNewline(removal.text), 'codex-lb-shared-auth-routing-rollback');
    if (!written.ok) return { ok: false, status: written.status };
    const after = codexLbSharedOpenAiRoutingState(await readText(configPath, ''), status.base_url);
    return { ok: after.status === 'missing' && !after.managed, status: after.status === 'missing' && !after.managed ? 'rolled_back' : 'readback_failed' };
  };

  const rollbackAuth = async () => {
    try {
      if (authExists) await writeTextAtomic(authPath, authText, { mode: 0o600 });
      else await fsp.rm(authPath, { force: true });
      return { ok: true, status: 'rolled_back' };
    } catch (err: any) {
      return { ok: false, status: 'rollback_failed', error: err.message };
    }
  };

  const writeApiKeyAuth = async (reason: string, backupPathForResult: string | null = null) => {
    const routingGuard = await ensureSharedOpenAiRouting();
    if (!routingGuard.ok) {
      return {
        status: 'failed',
        reason: routingGuard.status === 'conflicting_user_openai_base_url' ? 'shared_openai_base_url_conflict' : 'shared_openai_routing_guard_failed',
        auth_path: authPath,
        backup_path: backupPathForResult || backupPath,
        routing_guard: routingGuard,
        error: routingGuard.error || routingGuard.status
      };
    }
    try {
      await writeTextAtomic(authPath, `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }, null, 2)}\n`, { mode: 0o600 });
      await fsp.chmod(authPath, 0o600).catch(() => {});
      const finalConfig = await readText(opts.configPath || status.config_path || codexLbConfigPath(home), '');
      const finalAuth = await readText(authPath, '');
      const finalRouting = codexLbSharedOpenAiRoutingState(finalConfig, status.base_url);
      if (finalRouting.status !== 'matched' || parseCodexAuthApiKey(finalAuth) !== apiKey) {
        const authRollback = await rollbackAuth();
        const routingRollback = await rollbackSharedOpenAiRouting();
        return {
          status: 'failed',
          reason: 'activation_readback_failed',
          auth_path: authPath,
          backup_path: backupPathForResult || backupPath,
          routing_guard: routingGuard,
          routing_rollback: routingRollback,
          error: authRollback.ok && routingRollback.ok ? 'activation_readback_failed_rolled_back' : 'activation_readback_failed_rollback_incomplete'
        };
      }
      return {
        status: 'apikey_forced',
        reason,
        auth_path: authPath,
        backup_path: backupPathForResult || backupPath,
        routing_guard: routingGuard
      };
    } catch (err: any) {
      const authRollback = await rollbackAuth();
      const routingRollback = await rollbackSharedOpenAiRouting();
      return {
        status: 'failed',
        reason: 'write_failed',
        auth_path: authPath,
        backup_path: backupPathForResult || backupPath,
        routing_guard: routingGuard,
        routing_rollback: routingRollback,
        error: authRollback.ok && routingRollback.ok ? err.message : `${err.message}; activation rollback incomplete`
      };
    }
  };
  if (!authExists) {
    if (forceCodexLbApiKeyAuth) return writeApiKeyAuth('codex_lb_auth_selected_missing_auth');
    return { status: 'skipped', reason: 'auth_missing', auth_path: authPath };
  }
  if (!authText.trim()) {
    if (forceCodexLbApiKeyAuth) return writeApiKeyAuth('codex_lb_auth_selected_empty_auth');
    return { status: 'skipped', reason: 'auth_empty', auth_path: authPath };
  }
  if (hasChatgptOAuthTokens(authText)) {
    try {
      await ensureDir(path.dirname(backupPath));
      await writeTextAtomic(backupPath, authText, { mode: 0o600 });
      await fsp.chmod(backupPath, 0o600).catch(() => {});
    } catch (err: any) {
      return { status: 'failed', reason: 'backup_failed', auth_path: authPath, backup_path: backupPath, error: err.message };
    }
    if (process.env.SKS_CODEX_LB_NO_AUTH_RECONCILE === '1' && !opts.force) {
      return {
        status: 'backup_only',
        reason: 'SKS_CODEX_LB_NO_AUTH_RECONCILE=1',
        auth_path: authPath,
        backup_path: backupPath
      };
    }
    if (forceCodexLbApiKeyAuth) return writeApiKeyAuth('codex_lb_auth_selected', backupPath);
    if (process.env.SKS_CODEX_LB_FORCE_APIKEY_AUTH !== '1') {
      return {
        status: 'oauth_preserved',
        reason: 'chatgpt_oauth_preserved_until_use_codex_lb_auth',
        auth_path: authPath,
        backup_path: backupPath
      };
    }
    return writeApiKeyAuth('SKS_CODEX_LB_FORCE_APIKEY_AUTH=1', backupPath);
  }

  if (forceCodexLbApiKeyAuth) {
    if (currentApiKey && currentApiKey === apiKey) {
      const routingGuard = await ensureSharedOpenAiRouting();
      if (!routingGuard.ok) {
        return {
          status: 'failed',
          reason: routingGuard.status === 'conflicting_user_openai_base_url' ? 'shared_openai_base_url_conflict' : 'shared_openai_routing_guard_failed',
          auth_path: authPath,
          backup_path: backupPath,
          routing_guard: routingGuard,
          error: routingGuard.error || routingGuard.status
        };
      }
      return {
        status: 'apikey_auth_active',
        reason: 'codex_lb_auth_selected',
        auth_path: authPath,
        backup_path: backupPath,
        routing_guard: routingGuard
      };
    }
    return writeApiKeyAuth('codex_lb_auth_selected_replace_existing');
  }
  if (currentApiKey && currentApiKey === apiKey) {
    const routingGuard = await ensureSharedOpenAiRouting();
    if (!routingGuard.ok) {
      return {
        status: 'failed',
        reason: routingGuard.status === 'conflicting_user_openai_base_url' ? 'shared_openai_base_url_conflict' : 'shared_openai_routing_guard_failed',
        auth_path: authPath,
        backup_path: backupPath,
        routing_guard: routingGuard,
        error: routingGuard.error || routingGuard.status
      };
    }
    const backupText = await readText(backupPath, '');
    if (hasChatgptOAuthTokens(backupText) && process.env.SKS_CODEX_LB_KEEP_APIKEY_AUTH !== '1') {
      try {
        const restored = backupText.endsWith('\n') ? backupText : `${backupText}\n`;
        await writeTextAtomic(authPath, restored, { mode: 0o600 });
        await fsp.chmod(authPath, 0o600).catch(() => {});
        const unselected = await unselectCodexLbProvider({
          ...opts,
          home,
          authPath
        });
        if (!unselected.ok) {
          await writeTextAtomic(authPath, authText, { mode: 0o600 });
          await fsp.chmod(authPath, 0o600).catch(() => {});
          return {
            status: 'failed',
            reason: 'oauth_restore_provider_unselect_failed',
            auth_path: authPath,
            backup_path: backupPath,
            routing_guard: routingGuard,
            error: unselected.provider_error || unselected.reason || unselected.status
          };
        }
        return {
          status: 'oauth_restored',
          reason: 'restored_chatgpt_oauth_for_codex_app',
          auth_path: authPath,
          backup_path: backupPath,
          routing_guard: routingGuard
        };
      } catch (err: any) {
        return { status: 'failed', reason: 'restore_failed', auth_path: authPath, backup_path: backupPath, error: err.message };
      }
    }
    return {
      status: 'apikey_auth_active',
      reason: hasChatgptOAuthTokens(backupText) ? 'SKS_CODEX_LB_KEEP_APIKEY_AUTH=1' : 'chatgpt_oauth_backup_missing',
      auth_path: authPath,
      backup_path: backupPath,
      routing_guard: routingGuard
    };
  }

  return { status: 'no_oauth_conflict', auth_path: authPath };
}

// Expose the ChatGPT OAuth backup path so the CLI can surface it in status / release output.
export function codexLbChatgptBackupPath(home: any = process.env.HOME || os.homedir()) {
  return codexAuthChatgptBackupPath(home);
}

// Remove a top-level TOML key (only above the first table header). Returns the original text
// unchanged when the key isn't present.
function removeTopLevelTomlString(text: any, key: any) {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x: any) => /^\s*\[.+\]\s*$/.test(x));
  const end = firstTable === -1 ? lines.length : firstTable;
  let removed = false;
  for (let i = end - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) {
      lines.splice(i, 1);
      removed = true;
    }
  }
  if (!removed) return text;
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

// Unselect codex-lb at the top-level model_provider setting. Leaves [model_providers.codex-lb]
// and the env file alone so the user can re-engage with `sks codex-lb repair`.
export async function unselectCodexLbProvider(opts: any = {}) {
  const home = opts.home || process.env.HOME || os.homedir();
  const configPath = opts.configPath || codexLbConfigPath(home);
  const current = await readText(configPath, '');
  if (!current.trim()) return { ok: true, status: 'not_selected', reason: 'no_config', config_path: configPath };
  const envPath = opts.envPath || codexLbEnvPath(home);
  const envLoad = await loadCodexLbEnv({ ...opts, home, envPath });
  const authPath = opts.authPath || codexAuthPath(home);
  const authApiKey = parseCodexAuthApiKey(await readText(authPath, ''));
  const managedCatalogPath = codexLbToolCatalogPath(opts.codexHome || path.join(home, '.codex'));
  const managedCatalogSelected = topLevelTomlString(current, 'model_catalog_json') === managedCatalogPath;
  const providerBaseUrl = codexLbProviderBaseUrl(current) || envLoad.base_url || '';
  const sharedOpenAiRouting = codexLbSharedOpenAiRoutingState(current, providerBaseUrl);
  const managedSharedOpenAiRouting = sharedOpenAiRouting.status === 'matched' && sharedOpenAiRouting.managed;
  const codexLbRoutingOwned = hasTopLevelCodexLbSelected(current)
    || /\[model_providers\.codex-lb\]/.test(current)
    || managedCatalogSelected
    || managedSharedOpenAiRouting;
  if (authApiKey && codexLbRoutingOwned) {
    return {
      ok: false,
      status: 'failed',
      reason: 'shared_codex_lb_auth_active',
      provider_error: 'refusing to unselect codex-lb while API-key auth could fall through to built-in OpenAI',
      config_path: configPath
    };
  }
  if (!hasTopLevelCodexLbSelected(current) && !managedCatalogSelected && !managedSharedOpenAiRouting) return { ok: true, status: 'not_selected', config_path: configPath };
  try {
    // Only remove a codex-lb selection. A third-party selection (openrouter,
    // sks-router) is user-chosen state that a codex-lb unselect/oauth-restore
    // must never clobber while cleaning up managed codex-lb pins.
    let next = removeTopLevelTomlKeyIfValue(current, 'model_provider', 'codex-lb');
    next = removeTopLevelTomlKeyIfValue(next, 'model_catalog_json', managedCatalogPath);
    const routingRemoval = removeCodexLbSharedOpenAiRouting(next, providerBaseUrl);
    next = routingRemoval.text;
    next = ensureTrailingNewline(next);
    const safeWrite = await safeWriteCodexConfigToml(configPath, current, next, 'codex-lb-unselect');
    const after = safeWrite.ok ? await readText(configPath, '') : current;
    const afterRouting = codexLbSharedOpenAiRoutingState(after, providerBaseUrl);
    const selectionRemoved = !hasTopLevelCodexLbSelected(after)
      && topLevelTomlString(after, 'model_catalog_json') !== managedCatalogPath
      && (!managedSharedOpenAiRouting || (afterRouting.status === 'missing' && !afterRouting.managed));
    if (safeWrite.ok && selectionRemoved) return { ok: true, status: 'unselected', config_path: configPath, backup_path: safeWrite.backup_path, routing_guard_removed: routingRemoval.changed };
    const providerError = safeWrite.ok ? 'provider_selection_remains_after_write' : safeWrite.status || 'provider_config_write_blocked';
    return {
      ok: false,
      status: 'failed',
      reason: 'provider_config_write_blocked',
      provider_error: providerError,
      write_status: safeWrite.status || 'failed',
      config_path: configPath,
      backup_path: safeWrite.backup_path,
      config_preserved: safeWrite.changed !== true
    };
  } catch (err: any) {
    return { ok: false, status: 'failed', reason: 'write_failed', provider_error: err.message || 'write_failed', config_path: configPath, error: err.message };
  }
}

function providerDeselectionOutcome(result: any) {
  const ok = result?.status === 'unselected' || result?.status === 'not_selected';
  return {
    ok,
    provider_unselected: ok,
    provider_status: result?.status || 'failed',
    provider_error: ok ? null : String(result?.provider_error || result?.error || result?.reason || result?.status || 'unselect_failed')
  };
}

// Reverse of reconcileCodexLbAuthConflict: restore the ChatGPT OAuth blob from the backup file
// so the user can return to the official ChatGPT account login. Also deselects codex-lb at the
// model_provider level by default so the restored OAuth blob actually wins; pass keepProvider
// to skip that.
//
// Options:
//   home          - HOME override (selftest)
//   keepProvider  - leave `model_provider = "codex-lb"` selected (default: deselect)
//   deleteBackup  - remove ~/.codex/auth.chatgpt-backup.json after a successful restore
//                   (default: false; keeping it makes the next reconcile cycle a no-op clobber risk)
//   force         - restore even if the current auth.json shape isn't recognized
export async function releaseCodexLbAuthHold(opts: any = {}) {
  const home = opts.home || process.env.HOME || os.homedir();
  const authPath = opts.authPath || codexAuthPath(home);
  const backupPath = opts.backupPath || codexAuthChatgptBackupPath(home);
  const configPath = opts.configPath || codexLbConfigPath(home);
  const authExisted = await exists(authPath);
  const currentAuthText = await readText(authPath, '');
  const trimmedCurrent = currentAuthText.trim();
  if (opts.keepProvider) {
    const currentConfig = await readText(configPath, '');
    const providerBaseUrl = codexLbProviderBaseUrl(currentConfig);
    const routing = codexLbSharedOpenAiRoutingState(currentConfig, providerBaseUrl);
    if (hasTopLevelCodexLbSelected(currentConfig) || (routing.status === 'matched' && routing.managed)) {
      return {
        ok: false,
        status: 'failed',
        reason: 'keep_provider_unsafe_with_shared_auth',
        auth_path: authPath,
        backup_path: backupPath,
        provider_unselected: false
      };
    }
  }

  // Repeated "Use ChatGPT OAuth" is idempotent. If OAuth/browser auth is
  // already active, a historical backup is unnecessary; only ensure that the
  // codex-lb provider is no longer selected.
  const currentAuthMode = codexAuthModeSummary(currentAuthText);
  if (!opts.force && (currentAuthMode.mode === 'chatgpt_oauth' || currentAuthMode.mode === 'browser_marker')) {
    let provider = { ok: true, provider_unselected: false, provider_status: 'kept', provider_error: null as string | null };
    if (!opts.keepProvider) {
      const unselected = await unselectCodexLbProvider({
        ...opts,
        home,
        configPath,
        authPath
      });
      provider = providerDeselectionOutcome(unselected);
    }
    return {
      ok: provider.ok,
      status: provider.ok ? 'already_chatgpt' : 'failed',
      ...(provider.ok ? {} : { reason: 'provider_unselect_failed' }),
      auth_path: authPath,
      backup_path: backupPath,
      provider_unselected: provider.provider_unselected,
      provider_status: provider.provider_status,
      provider_error: provider.provider_error
    };
  }

  const backupExists = await exists(backupPath);
  const backupText = backupExists ? await readText(backupPath, '') : '';
  if (!backupExists || !backupText.trim()) {
    return {
      status: 'no_backup',
      auth_path: authPath,
      backup_path: backupPath,
      provider_unselected: false
    };
  }
  if (!hasChatgptOAuthTokens(backupText)) {
    return {
      status: 'no_backup',
      reason: 'backup_not_oauth',
      auth_path: authPath,
      backup_path: backupPath,
      provider_unselected: false
    };
  }

  // If auth.json already looks like ChatGPT OAuth (user re-logged in some other way), don't
  // clobber it — but still honor the deselect request so the OAuth blob takes effect.
  if (trimmedCurrent && hasChatgptOAuthTokens(currentAuthText) && !opts.force) {
    let provider = { ok: true, provider_unselected: false, provider_status: 'kept', provider_error: null as string | null };
    if (!opts.keepProvider) {
      const unselected = await unselectCodexLbProvider({
        ...opts,
        home,
        configPath,
        authPath
      });
      provider = providerDeselectionOutcome(unselected);
    }
    return {
      ok: provider.ok,
      status: provider.ok ? 'already_chatgpt' : 'failed',
      ...(provider.ok ? {} : { reason: 'provider_unselect_failed' }),
      auth_path: authPath,
      backup_path: backupPath,
      provider_unselected: provider.provider_unselected,
      provider_status: provider.provider_status,
      provider_error: provider.provider_error
    };
  }

  // Refuse to clobber unfamiliar auth.json shapes unless forced. We expect either an empty file,
  // the apikey shape we wrote during reconcile, or a stray `{"auth_mode":"browser"}` marker.
  if (!opts.force && trimmedCurrent) {
    const looksApikey = /"auth_mode"\s*:\s*"apikey"/.test(currentAuthText) && Boolean(parseCodexAuthApiKey(currentAuthText));
    const looksBrowserMarker = /^\{\s*"auth_mode"\s*:\s*"browser"\s*\}\s*$/.test(currentAuthText);
    if (!looksApikey && !looksBrowserMarker) {
      return {
        status: 'auth_in_use',
        reason: 'unfamiliar_auth_json',
        auth_path: authPath,
        backup_path: backupPath,
        provider_unselected: false
      };
    }
  }

  try {
    await ensureDir(path.dirname(authPath));
    const restored = backupText.endsWith('\n') ? backupText : `${backupText}\n`;
    await writeTextAtomic(authPath, restored, { mode: 0o600 });
    await fsp.chmod(authPath, 0o600).catch(() => {});
  } catch (err: any) {
    return {
      status: 'failed',
      reason: 'restore_failed',
      auth_path: authPath,
      backup_path: backupPath,
      error: err.message,
      provider_unselected: false
    };
  }

  let provider = { ok: true, provider_unselected: false, provider_status: 'kept', provider_error: null as string | null };
  if (!opts.keepProvider) {
    // Auth was just restored to ChatGPT OAuth, so provider deselection is safe.
    const unselected = await unselectCodexLbProvider({
      ...opts,
      home,
      configPath,
      authPath
    });
    provider = providerDeselectionOutcome(unselected);
  }
  if (!provider.ok) {
    const rollback = await rollbackCodexAuthRestore({ authPath, authExisted, currentAuthText });
    return {
      ok: false,
      status: 'failed',
      reason: 'provider_unselect_failed',
      auth_path: authPath,
      backup_path: backupPath,
      backup_removed: false,
      auth_restored: rollback.ok !== true,
      auth_rollback: rollback,
      rollback_safe: rollback.ok === true,
      provider_unselected: false,
      provider_status: provider.provider_status,
      provider_error: provider.provider_error
    };
  }

  let backupRemoved = false;
  if (opts.deleteBackup) {
    try {
      await fsp.rm(backupPath, { force: true });
      backupRemoved = true;
    } catch {
      // Non-fatal: the restore and provider deselection already landed.
    }
  }

  return {
    ok: true,
    status: 'released',
    auth_path: authPath,
    backup_path: backupPath,
    backup_removed: backupRemoved,
    auth_restored: true,
    provider_unselected: provider.provider_unselected,
    provider_status: provider.provider_status,
    provider_error: provider.provider_error
  };
}

async function rollbackCodexAuthRestore(input: { authPath: string; authExisted: boolean; currentAuthText: string }) {
  try {
    if (input.authExisted) {
      await writeTextAtomic(input.authPath, input.currentAuthText, { mode: 0o600 });
      await fsp.chmod(input.authPath, 0o600).catch(() => {});
    } else {
      await fsp.rm(input.authPath, { force: true });
    }
    return { ok: true, status: 'restored_previous_auth' };
  } catch (err: any) {
    return { ok: false, status: 'rollback_failed', error: err.message };
  }
}

export async function maybePromptCodexLbSetupForLaunch(args: any = [], opts: any = {}): Promise<ConfigureCodexLbResult> {
  if (args.includes('--json') || args.includes('--skip-codex-lb') || process.env.SKS_SKIP_CODEX_LB_PROMPT === '1') return { status: 'skipped' };
  const allowUnverifiedToolOutputRecovery = opts.allowUnverifiedToolOutputRecovery === true
    || codexLbToolOutputRecoveryOverrideAcknowledged({ args, env: opts.env || process.env });
  let status = await codexLbStatus({ ...opts, probeToolOutputRecovery: false });
  if (status.legacy_migration_required) {
    return {
      status: 'legacy_migration_required',
      ok: false,
      codex_lb: status,
      blockers: ['run_sks_codex_lb_migrate_legacy_desktop']
    };
  }
  if (status.env_key_configured && status.base_url) {
    const repaired = await repairCodexLbAuth({
      ...opts,
      allowUnverifiedToolOutputRecovery,
      probeToolOutputRecovery: false
    });
    status = await codexLbStatus({ ...opts, probeToolOutputRecovery: false });
    if (!repaired.ok) return { status: repaired.status, ok: false, repair: repaired, codex_lb: status };
    const codexEnvironment = repaired.codex_environment || await syncCodexLbProviderEnvironment(status, opts);
    return {
      status: status.desktop_mode === 'cli-provider' && !status.selected ? 'continued_to_codex' : 'present',
      ...status,
      codex_environment: codexEnvironment,
      ...(repaired.codex_login ? { codex_login: repaired.codex_login } : {}),
      ...(repaired.tool_catalog ? { tool_catalog: repaired.tool_catalog } : {}),
      reason: status.desktop_mode === 'cli-provider' && !status.selected
        ? 'unselected_cli_provider_available_for_explicit_use'
        : 'explicit_managed_desktop_routing_preserved'
    };
  }
  if (!canAskYesNo()) return { status: 'non_interactive', codex_lb: status };
  const useCodexLb = (await askPostinstallQuestion('\ncodex-lb is not configured. Store credentials and an unselected CLI provider now? [y/N] ')).trim();
  if (!/^(y|yes|예|네|응)$/i.test(useCodexLb)) return { status: 'continued_to_codex' };
  const host = (await askPostinstallQuestion('codex-lb host domain [http://127.0.0.1:2455]: ')).trim() || 'http://127.0.0.1:2455';
  const apiKey = (await askPostinstallQuestion('codex-lb API key: ')).trim();
  const configured = await configureCodexLb({ ...opts, host, apiKey, allowUnverifiedToolOutputRecovery });
  if (configured.ok) console.log(`codex-lb credentials stored: ${configured.base_url}. Use \`sks codex-lb use-cli\`, \`use-desktop-full\`, or \`disable\` explicitly.`);
  else console.log('codex-lb setup skipped: API key was empty.');
  printCodexLbSetupWarnings(configured);
  return configured;
}

function scrubCodexLbToolEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.CODEX_LB_API_KEY;
  delete sanitized.OPENROUTER_API_KEY;
  return sanitized;
}

async function syncCodexLbProviderEnvironment(status: any = {}, opts: any = {}): Promise<CodexLbEnvSyncResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const envPath = opts.envPath || status.env_path || codexLbEnvPath(home);
  const envLoad = await loadCodexLbEnv({ ...opts, home, envPath });
  const apiKey = String(opts.apiKey || envLoad.secret_api_key || '').trim();
  if (!apiKey) return { ok: false, status: 'missing_env_key' };
  const baseUrl = envLoad.base_url || opts.baseUrl || status.base_url;
  process.env.CODEX_LB_API_KEY = apiKey;
  if (baseUrl) process.env.CODEX_LB_BASE_URL = baseUrl;
  const launchEnv = await syncCodexLbMacLaunchEnvironment(baseUrl ? { CODEX_LB_BASE_URL: baseUrl } : {}, opts);
  const ok = launchEnv.ok || launchEnv.skipped || launchEnv.status === 'not_macos';
  return {
    ok,
    status: launchEnv.status === 'synced' ? 'launch_base_url_synced_secret_env_removed' : ok ? 'process_env' : launchEnv.status,
    env_path: envPath,
    base_url: baseUrl || null,
    launch_environment: launchEnv,
    error: launchEnv.error || null
  };
}

async function syncCodexLbMacLaunchEnvironment(values: any = {}, opts: any = {}) {
  if (opts.syncLaunchEnv === false || process.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV === '1') return { ok: true, status: 'skipped', skipped: true, reason: 'SKS_SKIP_CODEX_LB_LAUNCH_ENV=1' };
  if (process.platform !== 'darwin' && !opts.forceLaunchEnv) return { ok: true, status: 'not_macos', skipped: true };
  const launchctl = opts.launchctlBin
    || await exists('/bin/launchctl').then((ok: any) => ok ? '/bin/launchctl' : null).catch(() => null);
  if (!launchctl) return { ok: false, status: 'launchctl_missing', error: '/bin/launchctl not found' };
  const childEnv = scrubCodexLbToolEnvironment();
  const secretCleanup = await cleanupMacLaunchSecretEnvironment({
    force: opts.forceLaunchEnv === true,
    launchctlBin: launchctl,
    env: childEnv
  }).catch((err: any) => ({
    ok: false,
    status: 'partial',
    variables: ['CODEX_LB_API_KEY', 'OPENROUTER_API_KEY'],
    cleaned: [],
    failed: [{ key: 'CODEX_LB_API_KEY', error: err?.message || String(err) }, { key: 'OPENROUTER_API_KEY', error: err?.message || String(err) }],
    next_actions: ['Run launchctl unsetenv for CODEX_LB_API_KEY and OPENROUTER_API_KEY']
  }));
  const variables = Object.entries(values).filter(([key, value]: any) => value && !['CODEX_LB_API_KEY', 'OPENROUTER_API_KEY'].includes(String(key)));
  const results: any[] = [];
  for (const [key, value] of variables) {
    const result = await runProcess(launchctl, ['setenv', key, String(value)], {
      timeoutMs: 5000,
      maxOutputBytes: 8192,
      env: childEnv,
      envMode: 'replace'
    });
    results.push({
      key,
      ok: result.code === 0,
      error: result.code === 0 ? null : redactSecretText(result.stderr || result.stdout || 'launchctl setenv failed', [value]).trim()
    });
  }
  const failed = results.filter((result: any) => !result.ok);
  if (failed.length) return { ok: false, status: 'launch_env_failed', variables: results.map((result: any) => result.key), failed, secret_env_cleanup: secretCleanup, error: failed.map((result: any) => `${result.key}: ${result.error}`).join('; ') };
  return {
    ok: secretCleanup.ok !== false,
    status: variables.length ? 'synced' : 'secret_env_removed',
    variables: results.map((result: any) => result.key),
    skipped_secret_variables: ['CODEX_LB_API_KEY', 'OPENROUTER_API_KEY'],
    secret_env_cleanup: secretCleanup
  };
}

async function inspectCodexLbMacLaunchEnvironment(baseUrl: any = '', opts: any = {}) {
  if (process.platform !== 'darwin' && !opts.forceLaunchEnv) return { checked: false, status: 'not_macos', skipped: true };
  const launchctl = opts.launchctlBin
    || await exists('/bin/launchctl').then((ok: any) => ok ? '/bin/launchctl' : null).catch(() => null);
  if (!launchctl) return { checked: true, available: false, status: 'launchctl_missing' };
  const childEnv = scrubCodexLbToolEnvironment();
  const readVar = async (key: string) => {
    const result = await runProcess(launchctl, ['getenv', key], {
      timeoutMs: 3000,
      maxOutputBytes: 8192,
      env: childEnv,
      envMode: 'replace'
    });
    return result.code === 0 ? String(result.stdout || '').trim() : '';
  };
  // launchctl can stall behind the same launchd/TCC boundary for every key.
  // These reads are independent, so keep the worst case to one timeout window
  // instead of three serial windows on `sks --mad` preflight.
  const [currentBaseUrl, currentApiKey, currentOpenRouterKey] = await Promise.all([
    readVar('CODEX_LB_BASE_URL'),
    readVar('CODEX_LB_API_KEY'),
    readVar('OPENROUTER_API_KEY')
  ]);
  const baseMatches = !baseUrl || currentBaseUrl === String(baseUrl || '').trim();
  const basePresent = Boolean(currentBaseUrl);
  const keyPresent = Boolean(currentApiKey);
  const openRouterKeyPresent = Boolean(currentOpenRouterKey);
  return {
    checked: true,
    available: true,
    status: keyPresent || openRouterKeyPresent
      ? 'secret_env_present'
      : basePresent && baseMatches
        ? 'base_url_only'
        : basePresent
          ? 'partial'
          : 'missing',
    variables: [
      ...(keyPresent ? ['CODEX_LB_API_KEY'] : []),
      ...(openRouterKeyPresent ? ['OPENROUTER_API_KEY'] : []),
      ...(basePresent ? ['CODEX_LB_BASE_URL'] : [])
    ],
    base_url_present: basePresent,
    base_url_matches: baseMatches,
    api_key_present: keyPresent,
    openrouter_api_key_present: openRouterKeyPresent,
    next_actions: keyPresent || openRouterKeyPresent
      ? ['Run: sks doctor --fix', 'Rotate CODEX_LB_API_KEY and OPENROUTER_API_KEY if they were exposed in launchd.']
      : []
  };
}

export {
  checkContext7,
  ensureCodexCliTool,
  ensureRelatedCliTools,
  maybePromptCodexUpdateForLaunch,
  maybePromptSksUpdateForLaunch,
  shouldAutoApproveInstall
} from './install-tool-helpers.js';

export {
  codexFastModeDesktopStatus,
  ensureGlobalCodexFastModeDuringInstall,
  normalizeCodexFastModeUiConfig,
  safeWriteCodexConfigToml
} from '../core/codex-runtime/codex-desktop-config-policy.js';

export type { SksPostinstallShimResult } from './install-helpers-install-support.js';
export {
  checkRequiredSkills,
  context7GlobalMcpStatus,
  ensureCodexImagegenDuringInstall,
  ensureGlobalCodexSkillsDuringInstall,
  ensureProjectContext7Config,
  ensureSksCommandDuringInstall,
  globalCodexSkillsRoot,
  selftestSksShimRepair
} from './install-helpers-install-support.js';
export {
  askPostinstallQuestion,
  codexLbConfigPath,
  codexLbEnvPath,
  normalizeCodexLbBaseUrl
} from './install-helpers-codex-lb-shared.js';
export {
  ensureGlobalCodexAppGlmProfile,
  ensureStoredOpenRouterProviderDuringInstall,
  upsertCodexAppGlmConfig,
  upsertCodexLbConfig
} from './install-helpers-codex-lb-config.js';
export { checkCodexLbResponseChain } from './install-helpers-codex-lb-chain.js';
