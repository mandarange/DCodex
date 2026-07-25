import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ensureDir, exists, globalSksRoot, packageRoot, PACKAGE_VERSION, readText, runProcess, tmpdir, which, writeTextAtomic } from '../core/fsx.js';
import { createRequestedScopeContract } from '../core/safety/requested-scope-contract.js';
import { guardedPackageInstall, guardContextForRoute } from '../core/safety/mutation-guard.js';
import { EMPTY_CODEX_INFO, getCodexInfo } from '../core/codex-adapter.js';
import { formatHarnessConflictReport, llmHarnessCleanupPrompt, scanHarnessConflicts } from '../core/harness-conflicts.js';
import { initProject, installGlobalSkills } from '../core/init.js';
import { context7ConfigToml, DOLLAR_SKILL_NAMES, GETDESIGN_REFERENCE, hasContext7ConfigText, RECOMMENDED_SKILLS } from '../core/routes.js';
import { checkZellijCapability } from '../core/zellij/zellij-capability.js';
import { reconcileCodexAppUpgradeProcesses } from '../core/codex-app.js';
import { restartCodexApp } from '../core/codex-app/codex-app-restart.js';
import { cleanupMacLaunchSecretEnvironment } from '../core/codex-app/sks-menubar.js';
import { recordCodexLbHealthEvent } from '../core/codex-lb-circuit.js';
import { loadCodexLbEnv, writeCodexLbKeychain, codexLbMetadataPath } from '../core/codex-lb/codex-lb-env.js';
import {
  codexLbToolCatalogPath,
  ensureCodexLbToolCatalog
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
import { extractTomlTable, writeCodexConfigGuarded } from '../core/codex/codex-config-guard.js';
import {
  ensureGlobalCodexFastModeDuringInstall,
  ensureTrailingNewline,
  normalizeCodexFastModeUiConfig,
  removeTopLevelTomlKeyIfValue,
  safeWriteCodexConfigToml,
  upsertTopLevelTomlString,
  upsertTomlTable
} from '../core/codex-runtime/codex-desktop-config-policy.js';
import { runPostinstallGlobalDoctorAndMarkPending } from '../core/update/update-migration-state.js';
import { repairCodexImagegen } from '../core/doctor/imagegen-repair.js';
import {
  canAskYesNo,
  compareVersions,
  hasCodexUnstableFeatureWarningSuppression,
  hasDeprecatedCodexHooksFeatureFlag,
  hasTopLevelCodexModeLock,
  isProjectSetupCandidate
} from './install-tool-helpers.js';
import { checkCodexLbResponseChain } from './install-helpers-codex-lb-chain.js';
import {
  CODEX_LB_CANONICAL_FAST_SERVICE_TIER,
  CODEX_LB_PROVIDER_ENV_KEY,
  CODEX_LB_PROVIDER_NAME,
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
  appliedCodexLbPersistenceModes,
  captureCodexLbSetupWriteState,
  codexLbSharedOpenAiRoutingState,
  detectCodexLbSetupDrift,
  ensureGlobalCodexAppGlmProfile,
  ensureStoredOpenRouterProviderDuringInstall,
  parseCodexLbEnvBaseUrl,
  parseCodexSharedLoginApiKey,
  removeCodexLbSharedOpenAiRouting,
  sha256Text,
  shellSingleQuote,
  upsertCodexAppGlmConfig,
  upsertCodexLbConfig,
  upsertCodexLbSharedOpenAiRouting
} from './install-helpers-codex-lb-config.js';
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
  const conflictScan = await scanHarnessConflicts(installRoot);
  if (conflictScan.hard_block) {
    await postinstallHarnessConflictNotice(conflictScan);
    return;
  }
  const codexLbConfigSnapshot = await capturePostinstallCodexLbConfigSnapshot();
  // A failed setup side-effect must never fail `npm i`. Wrap the whole flow; always
  // restore the codex-lb snapshot in finally (even on the early bootstrap return / on throw).
  try {
  console.log('\nSKS installed.');
  // The published tarball deliberately excludes dist/.sks-build-stamp.json
  // (package.json files: "!dist/.sks-build-stamp.json"), but `sks update`
  // self-verification requires a version-matching stamp inside the installed
  // package. Regenerate it here so npm installs are verifiable; never
  // overwrite an existing stamp (in a dev checkout the build writes the real
  // one, and re-stamping against the current source tree would mask a stale
  // dist).
  try {
    const stampLib: any = await import('../scripts/lib/ensure-dist-fresh.js');
    await fsp.access(stampLib.distStampPath).catch(async () => {
      await fsp.writeFile(stampLib.distStampPath, `${JSON.stringify(stampLib.buildStampPayload(), null, 2)}\n`);
      console.log('SKS build stamp: restored for update self-verification (npm packages ship without it).');
    });
  } catch (err: any) {
    console.log(`SKS build stamp: could not restore (${err?.message || err}); \`sks update\` self-verification may report dist_stamp missing.`);
  }
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
  const fastModeRepair = await ensureGlobalCodexFastModeDuringInstall();
  if (fastModeRepair.status === 'updated') console.log(`Codex App Fast mode: updated ${fastModeRepair.config_path}${fastModeRepair.backup_path ? ` (backup ${fastModeRepair.backup_path})` : ''}.`);
  else if (fastModeRepair.status === 'present') console.log('Codex App Fast mode: config already compatible.');
  else if (fastModeRepair.status === 'unparseable_config_preserved') console.log(`Codex App Fast mode: existing ${fastModeRepair.config_path} is not valid TOML — left untouched, backed up to ${fastModeRepair.backup_path}. Run \`sks doctor --fix\` to recover it.`);
  else if (fastModeRepair.status === 'skipped_unsafe_rewrite') console.log(`Codex App Fast mode: skipped (managed rewrite would not parse; ${fastModeRepair.config_path} left untouched).`);
  else if (fastModeRepair.status === 'skipped') console.log(`Codex App Fast mode: skipped (${fastModeRepair.reason}).`);
  else if (fastModeRepair.status === 'failed') console.log(`Codex App Fast mode: auto repair failed. Run \`sks setup\`. ${fastModeRepair.error || ''}`.trim());
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
  const postinstallDoctor = await runPostinstallGlobalDoctorAndMarkPending().catch((err: any) => ({
    ok: false,
    doctor: null,
    pending: null,
    blockers: [err?.message || String(err)],
    warnings: []
  }));
  if (postinstallDoctor.ok) console.log('SKS update migration: global Doctor ran; project receipt will be finalized on first normal command.');
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
  if (getdesignSkill.status === 'installed') console.log('getdesign Codex skill: installed.');
  else if (getdesignSkill.status === 'present') console.log('getdesign Codex skill: already available.');
  else if (getdesignSkill.status === 'skills_cli_missing') console.log(`getdesign Codex skill: skills CLI missing; generated getdesign-reference skill is installed. Later run \`${getdesignSkill.install}\` if the skills CLI is available.`);
  else if (getdesignSkill.status === 'skipped') console.log(`getdesign Codex skill: skipped (${getdesignSkill.reason}).`);
  else if (getdesignSkill.status === 'failed') console.log(`getdesign Codex skill: auto setup failed; generated getdesign-reference skill remains available. ${getdesignSkill.error || ''}`.trim());
  const bootstrapDecision = await postinstallBootstrapDecision(installRoot);
  if (bootstrapDecision.run) {
    console.log(`SKS bootstrap: ${bootstrapDecision.reason}.`);
    await runPostinstallBootstrap(installRoot, bootstrap);
    return;
  }
  console.log('\nNext:');
  console.log('  sks bootstrap');
  console.log(`\nSKS bootstrap was not run automatically: ${bootstrapDecision.reason}.`);
  console.log('This initializes the current project, installs SKS Codex App skills, verifies Codex App/Context7 readiness, and checks Zellij runtime dependencies.');
  console.log('Dependency repair: sks bootstrap --yes, sks deps check --yes, or sks --mad --yes. Postinstall reports missing CLI tools but does not mutate Homebrew/npm globals unless SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS=1 is set.');
  console.log('Open runtime after readiness is green: sks\n');
  } catch (err: any) {
    console.log(`\nSKS postinstall: a setup step did not complete; installation continues. Run \`sks doctor --fix\` afterward. (${err?.message || err})`);
  } finally {
    await restorePostinstallCodexLbConfigSnapshot(codexLbConfigSnapshot).catch(() => {});
    await reportPostinstallCodexLbAuth(codexLbConfigSnapshot).catch(() => {});
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
  const preserveActiveCodexLb = snapshot?.selected === true && snapshot?.codex_lb_key_in_shared_auth === true;
  const codexLbAuth = await ensureCodexLbAuthDuringInstall({
    forceCodexLbApiKeyAuth: preserveActiveCodexLb,
    ...(snapshot?.secret_api_key ? { apiKey: snapshot.secret_api_key } : {}),
    ...(snapshot?.base_url ? { baseUrl: snapshot.base_url } : {})
  });
  if (codexLbAuth.legacy_auth_migrated) console.log(`codex-lb auth: restored from existing Codex login cache into ${codexLbAuth.env_path}.`);
  else if (codexLbAuth.status === 'synced' || codexLbAuth.status === 'present' || codexLbAuth.status === 'repaired') console.log(`codex-lb auth: preserved from ${codexLbAuth.env_path}.`);
  else if (codexLbAuth.status === 'present_unselected') console.log('codex-lb auth: preserved but not selected; ChatGPT OAuth remains active.');
  else if (codexLbAuth.status === 'skipped') console.log(`codex-lb auth: skipped (${codexLbAuth.reason}).`);
  else if (codexLbAuth.status === 'missing_env_key') console.log('codex-lb auth: stored key missing. Run `sks codex-lb setup --host <domain> --api-key-stdin` to repair.');
  else if (codexLbAuth.status === 'missing_base_url') console.log('codex-lb auth: stored key has no recoverable base URL. Run `sks codex-lb reconfigure --host <domain> --api-key-stdin` once.');
  else if (codexLbAuth.status === 'not_configured') console.log('codex-lb (optional multi-account load balancer): not configured — opt in anytime with `sks codex-lb setup` (your choice; never applied automatically, never edits your Codex config without it). Swap key later: `sks codex-lb set-key`; switch auth: `sks codex-lb use-oauth` / `use-codex-lb`.');
  else if (codexLbAuth.status && codexLbAuth.status !== 'not_configured') console.log(`codex-lb auth: repair skipped (${codexLbAuth.status}${codexLbAuth.error ? `: ${codexLbAuth.error}` : ''}).`);
  const reconcile = codexLbAuth.auth_reconcile;
  if (reconcile?.status === 'oauth_preserved') {
    console.log(`codex-lb auth: ChatGPT OAuth preserved as backup; run \`sks codex-lb use-codex-lb\` to switch the App to codex-lb API-key auth (backup at ${reconcile.backup_path ?? 'unknown'}).`);
  } else if (reconcile?.status === 'oauth_restored') {
    console.log(`codex-lb auth: restored ChatGPT OAuth from ${reconcile.backup_path ?? 'unknown'} and cleared codex-lb provider selection.`);
  } else if (reconcile?.status === 'apikey_forced') {
    console.log(`codex-lb auth: forced API-key auth.json for CLI-only use (OAuth backup at ${reconcile.backup_path ?? 'unknown'}).`);
  } else if (reconcile?.status === 'backup_only') {
    console.log(`codex-lb auth: detected ChatGPT OAuth tokens in auth.json. OAuth backup written to ${reconcile.backup_path ?? 'unknown'}; auth.json left untouched because SKS_CODEX_LB_NO_AUTH_RECONCILE=1.`);
  } else if (reconcile?.status === 'failed') {
    console.log(`codex-lb auth: ChatGPT OAuth reconciliation could not complete (${reconcile.reason || 'unknown'}${reconcile.error ? `: ${reconcile.error}` : ''}). Run \`sks codex-lb repair\` to retry.`);
  }
  if (codexLbAuth.base_url && codexLbAuth.codex_lb?.env_key_configured && canAskYesNo() && process.env.SKS_SKIP_CODEX_LB_KEY_PROMPT !== '1') {
    const changeKey = (await askPostinstallQuestion('codex-lb key changed? Update now? [y/N] ')).trim();
    if (/^(y|yes|예|네|응)$/i.test(changeKey)) {
      const newKey = (await askPostinstallQuestion('New codex-lb API key (sk-clb-...): ')).trim();
      if (newKey) {
        const result = await configureCodexLb({ host: codexLbAuth.base_url, apiKey: newKey });
        if (result.ok) console.log(`codex-lb key updated: ${result.base_url}`);
        else console.log(`codex-lb key update failed: ${result.status}${result.error ? `: ${result.error}` : ''}`);
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
  if (process.env.SKS_POSTINSTALL_BOOTSTRAP === '0') return { run: false, reason: 'SKS_POSTINSTALL_BOOTSTRAP=0' };
  const installRoot = path.resolve(root || process.cwd());
  const candidate = await isProjectSetupCandidate(installRoot);
  const target = candidate ? installRoot : globalSksRoot();
  if (process.env.SKS_POSTINSTALL_BOOTSTRAP === '1') return { run: true, target, reason: 'forced by SKS_POSTINSTALL_BOOTSTRAP=1' };
  // A global `npm i -g sneakoscope` must NOT initialize whatever project the user's shell
  // happened to be in (that would scribble AGENTS.md/.codex/.agents into an unrelated repo).
  // Only bootstrap the global runtime root; the user runs `sks setup` inside a project explicitly.
  if (process.env.npm_config_global === 'true' && candidate) {
    return { run: true, target: globalSksRoot(), reason: 'global install: bootstrapping global SKS runtime only (run `sks setup` inside a project to initialize it)' };
  }
  if (candidate) return { run: true, target, reason: 'auto-running sks setup --bootstrap --install-scope global --force' };
  return { run: true, target, reason: 'no project marker found; auto-running global SKS runtime bootstrap' };
}

async function runPostinstallBootstrap(root: any, bootstrap: any) {
  const previousCwd = process.cwd();
  const decision = await postinstallBootstrapDecision(root);
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
  plan?: Record<string, unknown>;
  applied_actions?: Array<Record<string, unknown>>;
  drift?: string[];
  persistence?: CodexLbPersistenceSummary;
  config_path?: string;
  env_path?: string;
  metadata_path?: string;
  backup_path?: string | null;
  base_url?: string;
  env_key?: string;
  keychain?: Record<string, unknown>;
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
} & Partial<CodexLbStatusSnapshot>;

export type CodexLbLaunchPromptResult = ConfigureCodexLbResult;

async function capturePostinstallCodexLbConfigSnapshot(home: any = process.env.HOME || os.homedir()) {
  const configPath = codexLbConfigPath(home);
  const envPath = codexLbEnvPath(home);
  const authPath = codexAuthPath(home);
  const config = await readText(configPath, '');
  const envText = await readText(envPath, '');
  const authExisted = await exists(authPath);
  const authText = authExisted ? await readText(authPath, '') : '';
  const envLoad = await loadCodexLbEnv({ home, envPath });
  const envKey = envLoad.secret_api_key || '';
  const providerConfigured = /\[model_providers\.codex-lb\]/.test(config);
  const baseUrl = envLoad.base_url || codexLbProviderBaseUrl(config) || parseCodexLbEnvBaseUrl(envText);
  // Snapshot any codex-lb-related state so the upgrade-time bootstrap can't silently undo it.
  if (!envKey && !providerConfigured && !authExisted) return null;
  return {
    config_path: configPath,
    env_path: envPath,
    auth_path: authPath,
    base_url: baseUrl ? normalizeCodexLbBaseUrl(baseUrl) : null,
    selected: hasTopLevelCodexLbSelected(config),
    auth_mode: codexAuthModeSummary(authText).mode,
    codex_lb_key_in_shared_auth: Boolean(envKey && parseCodexAuthApiKey(authText) === envKey),
    credential_source: envLoad.source,
    credential_fingerprint: envLoad.api_key.fingerprint,
    credential_binding: envLoad.credential_binding,
    secret_api_key: envKey || null,
    auth_existed: authExisted,
    auth_text: authText
  };
}

async function restorePostinstallCodexLbConfigSnapshot(snapshot: any) {
  if (!snapshot) return { status: 'skipped', reason: 'no_snapshot' };
  let configRestored = false;
  if (snapshot.base_url) {
    const current = await readText(snapshot.config_path, '');
    const next = normalizeCodexFastModeUiConfig(upsertCodexLbConfig(current, snapshot.base_url, snapshot.selected === true));
    const alreadyOk = next === ensureTrailingNewline(current) && codexLbProviderBaseUrl(current);
    if (!alreadyOk) {
      const safeWrite = await safeWriteCodexConfigToml(snapshot.config_path, current, next, 'codex-lb-restore');
      configRestored = safeWrite.ok && safeWrite.changed === true;
    }
  }
  // Restore auth.json if bootstrap wiped it, or if an active codex-lb session was
  // silently switched back to OAuth during the synchronous update transaction.
  let authRestored = false;
  if (snapshot.auth_existed && snapshot.auth_text && snapshot.auth_text.trim()) {
    const currentAuthExists = await exists(snapshot.auth_path);
    const currentAuthText = currentAuthExists ? await readText(snapshot.auth_path, '') : '';
    const activeCodexLbAuthChanged = snapshot.selected === true
      && snapshot.codex_lb_key_in_shared_auth === true
      && snapshot.secret_api_key
      && parseCodexAuthApiKey(currentAuthText) !== snapshot.secret_api_key;
    if (!currentAuthExists || !currentAuthText.trim() || activeCodexLbAuthChanged) {
      await ensureDir(path.dirname(snapshot.auth_path));
      await writeTextAtomic(snapshot.auth_path, snapshot.auth_text, { mode: 0o600 });
      await fsp.chmod(snapshot.auth_path, 0o600).catch(() => {});
      authRestored = true;
    }
  }
  return {
    status: configRestored || authRestored ? 'restored' : 'present',
    config_path: snapshot.config_path,
    auth_path: snapshot.auth_path,
    config_restored: configRestored,
    auth_restored: authRestored
  };
}


async function ensureCodexLbToolCatalogSelection(input: {
  home: string;
  configPath: string;
  baseUrl: string;
  apiKey: string;
}, opts: any = {}) {
  const codexHome = opts.codexHome || path.join(input.home, '.codex');
  const catalogPath = codexLbToolCatalogPath(codexHome);
  const current = await readText(input.configPath, '');
  const selected = hasTopLevelCodexLbSelected(current);
  // Setup writes the catalog pointer before selecting the provider so Desktop can
  // load GPT-5.6/tool metadata the moment model_provider becomes codex-lb.
  const canBindCatalog = selected || opts.allowUnselectedCatalogWrite === true;
  const existingCatalogPath = topLevelTomlString(current, 'model_catalog_json');
  const { isSksManagedCatalogPath, resolveCatalogPath } = await import('../core/codex-app/multi-provider-router-support.js');
  const existingCatalogResolved = existingCatalogPath
    ? resolveCatalogPath(existingCatalogPath, { home: input.home, configPath: input.configPath })
    : null;
  // A foreign SKS-managed binding (e.g. the OpenRouter activation catalog) is
  // only replaceable when this run actually selects codex-lb; otherwise a
  // credentials-only setup/repair would strand the third-party activation
  // without its per-model feature catalog.
  const existingCatalogReplaceable = !existingCatalogResolved
    || (isSksManagedCatalogPath(existingCatalogResolved, { home: input.home })
      && (selected || opts.willSelectProvider === true));
  if (canBindCatalog && existingCatalogResolved && existingCatalogResolved !== path.resolve(catalogPath) && !existingCatalogReplaceable) {
    return {
      schema: 'sks.codex-lb-tool-catalog-selection.v1',
      ok: false,
      required: true,
      status: 'user_catalog_conflict',
      path: catalogPath,
      configured_path: existingCatalogPath,
      config_changed: false,
      selected,
      blockers: ['codex_lb_user_model_catalog_conflict']
    };
  }
  let hostname = '';
  try { hostname = new URL(input.baseUrl).hostname.toLowerCase(); } catch {}
  const reservedFixtureHost = /(?:^|\.)(?:test|invalid|example)$/.test(hostname);
  if (reservedFixtureHost && typeof opts.toolCatalogFetch !== 'function') {
    return {
      schema: 'sks.codex-lb-tool-catalog-selection.v1',
      ok: true,
      required: false,
      status: 'skipped_reserved_host',
      path: catalogPath,
      config_changed: false,
      selected,
      blockers: []
    };
  }
  const catalog = await ensureCodexLbToolCatalog({
    codexHome,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    ...(typeof opts.toolCatalogFetch === 'function' ? { fetchImpl: opts.toolCatalogFetch } : {}),
    timeoutMs: Number(opts.toolCatalogTimeoutMs || 5000),
    force: opts.forceToolCatalog === true
  });
  if (!catalog.ok || !canBindCatalog) {
    return {
      ...catalog,
      schema: 'sks.codex-lb-tool-catalog-selection.v1',
      config_changed: false,
      selected
    };
  }
  const next = ensureTrailingNewline(upsertTopLevelTomlString(current, 'model_catalog_json', catalog.path));
  if (next === ensureTrailingNewline(current)) {
    return { ...catalog, schema: 'sks.codex-lb-tool-catalog-selection.v1', config_changed: false, selected };
  }
  const safeWrite = await safeWriteCodexConfigToml(input.configPath, current, next, 'codex-lb-tool-catalog');
  return {
    ...catalog,
    schema: 'sks.codex-lb-tool-catalog-selection.v1',
    ok: catalog.ok && safeWrite.ok,
    status: safeWrite.ok ? catalog.status : safeWrite.status,
    config_changed: safeWrite.ok && safeWrite.changed === true,
    backup_path: safeWrite.backup_path,
    selected,
    blockers: safeWrite.ok ? catalog.blockers : [...new Set([...(catalog.blockers || []), 'codex_lb_tool_catalog_config_write_failed'])]
  };
}

export async function configureCodexLb(opts: any = {}): Promise<ConfigureCodexLbResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const configPath = opts.configPath || codexLbConfigPath(home);
  const envPath = opts.envPath || codexLbEnvPath(home);
  const rawHost = String(opts.host || opts.baseUrl || '');
  const baseUrl = normalizeCodexLbBaseUrl(rawHost);
  const apiKey = String(opts.apiKey || '').trim();
  const useDefaultProvider = opts.useDefaultProvider !== false;
  const writeEnvFile = opts.writeEnvFile !== false;
  const storeKeychain = opts.storeKeychain === true || opts.keychain === true;
  const syncLaunchctl = opts.syncLaunchctl === true || opts.syncLaunchEnv === true;
  const shellProfile = opts.shellProfile || 'skip';
  const setupAnswers = {
    host_or_base_url: rawHost,
    api_key_source: opts.apiKeySource || 'stdin',
    use_as_default_provider: useDefaultProvider,
    write_env_file: writeEnvFile,
    store_keychain: storeKeychain,
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
  const beforeState = await captureCodexLbSetupWriteState({ home, configPath, envPath, shellProfile });
  const appliedActions: Array<Record<string, unknown>> = [];
  await ensureDir(path.dirname(configPath));
  // Write the provider table first without selecting it. Desktop model/tool UI
  // exposure depends on a validated catalog; selecting before that leaves the App
  // on codex-lb with no GPT-5.6 picker surface.
  const current = await readText(configPath, '');
  const providerOnly = normalizeCodexFastModeUiConfig(upsertCodexLbConfig(current, baseUrl, false), {
    forceFastMode: opts.forceFastMode !== false
  });
  const safeWrite = await safeWriteCodexConfigToml(configPath, current, providerOnly, 'codex-lb');
  if (!safeWrite.ok) return { ok: false, status: safeWrite.status, config_path: configPath, env_path: envPath, backup_path: safeWrite.backup_path };
  appliedActions.push({ type: 'write_config_provider', target: configPath, ok: true, backup_path: safeWrite.backup_path });
  if (writeEnvFile) {
    await writeTextAtomic(envPath, `export CODEX_LB_BASE_URL=${shellSingleQuote(baseUrl)}\nexport CODEX_LB_API_KEY=${shellSingleQuote(apiKey)}\n`, { mode: 0o600 });
    await fsp.chmod(envPath, 0o600).catch(() => {});
    appliedActions.push({ type: 'write_env_file', target: envPath, ok: true });
  }
  process.env.CODEX_LB_BASE_URL = baseUrl;
  process.env.CODEX_LB_API_KEY = apiKey;
  let toolCatalog = await ensureCodexLbToolCatalogSelection({ home, configPath, baseUrl, apiKey }, { ...opts, allowUnselectedCatalogWrite: true, willSelectProvider: useDefaultProvider === true });
  if (toolCatalog.config_changed || toolCatalog.status === 'repaired' || toolCatalog.status === 'cached_compatible') {
    appliedActions.push({ type: 'write_model_tool_catalog', target: toolCatalog.path, ok: toolCatalog.ok === true, status: toolCatalog.status });
  }
  const catalogReadyForSelection = toolCatalog.ok === true
    && (toolCatalog.required === false || ['repaired', 'cached_compatible', 'cached_compatible_after_refresh_failed', 'cached_compatible_after_refresh_rejected', 'skipped_reserved_host', 'present'].includes(String(toolCatalog.status || '')));
  let providerSelected = false;
  if (useDefaultProvider && catalogReadyForSelection) {
    const beforeSelect = await readText(configPath, '');
    const selectedConfig = normalizeCodexFastModeUiConfig(upsertCodexLbConfig(beforeSelect, baseUrl, true), {
      forceFastMode: opts.forceFastMode !== false
    });
    const selectWrite = await safeWriteCodexConfigToml(configPath, beforeSelect, selectedConfig, 'codex-lb-select');
    if (!selectWrite.ok) {
      return {
        ok: false,
        status: selectWrite.status || 'provider_selection_failed',
        config_path: configPath,
        env_path: envPath,
        backup_path: selectWrite.backup_path,
        tool_catalog: toolCatalog,
        tool_output_recovery: toolOutputRecovery,
        error: 'codex_lb_provider_selection_write_failed'
      };
    }
    providerSelected = true;
    appliedActions.push({ type: 'select_default_provider', target: configPath, ok: true, backup_path: selectWrite.backup_path });
    // Re-bind after selection so model_catalog_json stays attached to the active provider.
    toolCatalog = await ensureCodexLbToolCatalogSelection({ home, configPath, baseUrl, apiKey }, opts);
    if (toolCatalog.config_changed) {
      appliedActions.push({ type: 'write_model_tool_catalog', target: toolCatalog.path, ok: toolCatalog.ok === true, status: toolCatalog.status });
    }
  } else if (useDefaultProvider) {
    appliedActions.push({
      type: 'select_default_provider',
      target: configPath,
      ok: false,
      status: 'deferred_until_tool_catalog_ready',
      blockers: toolCatalog.blockers || ['codex_lb_gpt56_tool_catalog_not_ready']
    });
  }
  const keyFingerprint = await sha256Text(apiKey);
  const metadataPath = opts.metadataPath || codexLbMetadataPath(home);
  await writeTextAtomic(metadataPath, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: baseUrl,
    updated_at: new Date().toISOString(),
    source: opts.source || 'setup',
    api_key: { redacted: true, sha256: keyFingerprint }
  }, null, 2)}\n`);
  await fsp.chmod(metadataPath, 0o600).catch(() => {});
  appliedActions.push({ type: 'write_metadata', target: metadataPath, ok: true });
  const keychain = storeKeychain ? await writeCodexLbKeychain(apiKey, opts).catch((err: any) => ({ ok: false, status: 'keychain_store_failed', error: err.message })) : { ok: false, status: 'skipped' };
  if (storeKeychain) appliedActions.push({ type: 'store_keychain', target: 'macOS Keychain service sks-codex-lb', ok: keychain.ok === true, status: keychain.status });
  const codexEnvironment = await syncCodexLbProviderEnvironment({ env_path: envPath, base_url: baseUrl }, { ...opts, home, apiKey, baseUrl, syncLaunchEnv: syncLaunchctl });
  if (syncLaunchctl) appliedActions.push({ type: 'sync_launchctl', target: 'macOS launchctl user environment (base URL only; API-key env removed)', ok: codexEnvironment.ok === true, status: codexEnvironment.status });
  const shellProfileResult = await installCodexLbShellProfileSnippet({ home, envPath, shellProfile }).catch((err: any) => ({ ok: false, status: 'failed', files: [], error: err.message }));
  if (shellProfile !== 'skip') appliedActions.push({ type: 'install_shell_profile_snippet', target: shellProfileResult.files?.join(', ') || shellProfile, ok: shellProfileResult.ok === true, status: shellProfileResult.status });
  const codexLb = await codexLbStatus({ ...opts, home, configPath, envPath });
  // Never activate shared sk-clb auth while the Desktop picker is still missing a
  // ready catalog/selection — that leaves App threads calling api.openai.com.
  const wantForceCodexLbApiKeyAuth = opts.forceCodexLbApiKeyAuth === true || opts.authMode === 'codex-lb';
  const forceCodexLbApiKeyAuth = wantForceCodexLbApiKeyAuth && providerSelected;
  const authReconcile = providerSelected
    ? await reconcileCodexLbAuthConflict({ ...opts, home, status: codexLb, forceCodexLbApiKeyAuth }).catch((err: any) => ({ status: 'failed', reason: 'exception', error: err.message }))
    : { status: 'deferred_until_provider_selected', reason: 'tool_catalog_or_selection_incomplete' };
  const codexLogin = !providerSelected
    ? { ok: true, status: 'deferred_until_provider_selected', reason: 'tool_catalog_or_selection_incomplete', error: null }
    : forceCodexLbApiKeyAuth
      ? { ok: ['apikey_forced', 'apikey_auth_active'].includes(authReconcile.status), status: authReconcile.status, ...(authReconcile.reason ? { reason: authReconcile.reason } : {}), error: authReconcile.error || null }
      : await maybeSyncCodexLbSharedLogin(apiKey, { ...opts, home, force: true });
  const finalCodexLb = await codexLbStatus({ ...opts, home, configPath, envPath });
  const ok = Boolean(codexEnvironment.ok && codexLogin.ok);
  const afterState = await captureCodexLbSetupWriteState({ home, configPath, envPath, shellProfile });
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
    ...(toolCatalog.required !== false && toolCatalog.ok !== true ? ['codex_lb_gpt56_tool_catalog_not_ready'] : [])
  ];
  const failureStatus = codexEnvironment.ok !== true
    ? (codexEnvironment.status || 'environment_failed')
    : codexLogin.ok !== true
      ? (codexLogin.status || 'login_failed')
      : null;
  return {
    ok: ok && drift.length === 0,
    status: ok && drift.length === 0 ? 'configured' : failureStatus || (drift.length ? 'setup_choice_drift' : 'configuration_failed'),
    plan: plan as any,
    applied_actions: appliedActions,
    drift,
    persistence,
    config_path: configPath,
    env_path: envPath,
    metadata_path: metadataPath,
    base_url: baseUrl,
    env_key: 'CODEX_LB_API_KEY',
    keychain,
    warnings,
    auth_reconcile: authReconcile,
    codex_lb: finalCodexLb,
    codex_environment: codexEnvironment,
    codex_login: codexLogin,
    tool_catalog: toolCatalog,
    tool_output_recovery: toolOutputRecovery,
    error: authReconcile.error || codexEnvironment.error || codexLogin.error || null
  };
}

export async function codexLbStatus(opts: any = {}) {
  const home = opts.home || process.env.HOME || os.homedir();
  const configPath = opts.configPath || codexLbConfigPath(home);
  const envPath = opts.envPath || codexLbEnvPath(home);
  const config = await readText(configPath, '');
  const envExists = await exists(envPath);
  const envText = envExists ? await readText(envPath, '') : '';
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
  const sharedOpenAiRouting = codexLbSharedOpenAiRoutingState(config, baseUrl);
  const codexLbKeyInSharedAuth = Boolean(authApiKey && envLoad.secret_api_key && authApiKey === envLoad.secret_api_key);
  const sharedOpenAiRoutingSafe = !codexLbKeyInSharedAuth || sharedOpenAiRouting.status === 'matched';
  const authRoutingCoherent = selected === codexLbKeyInSharedAuth && sharedOpenAiRoutingSafe;
  const providerContractOk = providerConfigured
    && providerBaseUrlMatchesCredential
    && providerName === CODEX_LB_PROVIDER_NAME
    && providerWireApi === 'responses'
    && providerEnvKey === CODEX_LB_PROVIDER_ENV_KEY
    && providerSupportsWebsockets === true
    && providerRequiresOpenAiAuth === true;
  const providerUsesCodexLbEnvAuth = providerConfigured && providerEnvKey === CODEX_LB_PROVIDER_ENV_KEY && providerOpenAiAuthDisabled;
  const codexAppUsableWithCodexLb = providerContractOk && envLoad.configured && Boolean(baseUrl) && authMode.codex_app_usable;
  const fastMode = codexLbFastModeConfigStatus(config);
  const launchEnvironment = await inspectCodexLbMacLaunchEnvironment(baseUrl, opts).catch((err: any) => ({
    checked: true,
    available: false,
    status: 'inspect_failed',
    error: err.message
  }));
  const providerReady = providerContractOk && envLoad.configured && Boolean(baseUrl) && authMode.codex_app_usable && authRoutingCoherent;
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
  return {
    ok: providerReady && (!selected || !probeToolOutputRecovery || toolOutputRecovery.ok),
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
    provider_uses_codex_lb_env_auth: providerUsesCodexLbEnvAuth,
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
      credential_binding: envLoad.credential_binding,
      keychain: envLoad.keychain,
      env_paths: envLoad.env_paths
    },
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
    auth_usable_for_codex_app: authMode.codex_app_usable && authRoutingCoherent,
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
  const lines = [
    'SKS codex-lb',
    '',
    `Configured: ${status.ok ? 'yes' : 'no'}`,
    `Selected:   ${status.selected ? 'yes' : 'no'}`,
    `Provider:   ${status.provider_contract_ok ? 'codex-lb App contract ok' : status.provider_configured ? 'drifted' : 'missing'}`,
    `Provider OpenAI Auth: ${status.provider_requires_openai_auth ? 'required' : 'not required/drifted'} (${status.provider_name || 'missing'})`,
    `Codex App auth: ${status.auth_usable_for_codex_app ? 'ok' : 'needs sign-in/repair'} (${status.auth_mode || 'unknown'})`,
    `Shared OpenAI routing: ${status.shared_openai_routing?.safe === false ? 'unsafe' : status.shared_openai_routing?.status || 'unknown'}${status.shared_openai_routing?.managed ? ' (sks-managed)' : ''}`,
    `Auth/routing coherent: ${status.auth_routing_coherent ? 'yes' : 'no'}`
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
  if (status.shared_openai_routing?.safe === false) lines.push('', 'Run: sks codex-lb use-codex-lb to pin built-in OpenAI routing to the codex-lb base URL before the shared key can hit api.openai.com.');
  else if (status.provider_configured && !status.provider_contract_ok) lines.push('', 'Run: sks codex-lb repair to rewrite the provider block to the current codex-lb App contract.');
  else if (status.ok && !status.auth_usable_for_codex_app && backupPresent) lines.push('', 'Run: sks codex-lb use-oauth to restore ChatGPT OAuth, or sks codex-lb use-codex-lb to force codex-lb API-key auth.');
  else if (status.ok && !status.auth_usable_for_codex_app) lines.push('', 'Run: sks codex-lb use-codex-lb, or sign in to Codex App/CLI again for ChatGPT OAuth.');
  else if (status.ok && !status.selected) lines.push('', 'Run: sks codex-lb repair to activate codex-lb for Codex App.');
  else if (status.ok) lines.push('', 'Status: codex-lb active; no repair needed.');
  else if (!status.ok && status.base_url && status.env_key_configured) lines.push('', 'Run: sks codex-lb repair / use-codex-lb to restore a coherent provider + shared-auth routing state.');
  else if (!status.ok) lines.push('', 'Run: sks codex-lb setup --host <domain> --api-key-stdin');
  if (backupPresent) lines.push('Switch fully away from codex-lb: sks codex-lb release');
  return `${lines.join('\n')}\n`;
}

export function formatCodexLbRepairResultText(result: any = {}) {
  const lines = [
    'codex-lb provider auth repaired for Codex CLI/App environment.',
    `Config: ${result.config_path}`,
    `Key env: ${result.env_path}`
  ];
  if (result.auth_reconcile?.status === 'oauth_restored') lines.push(`Codex App auth: ChatGPT OAuth restored from ${result.auth_reconcile.backup_path}.`);
  else if (result.auth_reconcile?.status === 'oauth_preserved') lines.push('Codex App auth: ChatGPT OAuth preserved as backup; run `sks codex-lb use-codex-lb` to force codex-lb API-key auth.');
  else if (['apikey_auth_active', 'apikey_forced'].includes(result.auth_reconcile?.status)) lines.push('Codex App auth: codex-lb API-key auth.json is active.');
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
  return block.match(/(^|\n)\s*env_key\s*=\s*"([^"]+)"/)?.[2] || '';
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
  let status = await codexLbStatus({
    ...opts,
    probeToolOutputRecovery: true,
    allowUnverifiedToolOutputRecovery: opts.allowUnverifiedToolOutputRecovery === true
  });
  let configRepaired = false;
  let legacyAuthMigrated = false;
  let legacyAuthPath = null;
  const toolOutputRecovery = status.base_url
    ? await probeCodexLbToolOutputRecovery({
        baseUrl: status.base_url,
        ...(typeof opts.toolOutputRecoveryFetch === 'function' ? { fetchImpl: opts.toolOutputRecoveryFetch } : {}),
        timeoutMs: Number(opts.toolOutputRecoveryTimeoutMs || 4_000),
        allowUnverified: opts.allowUnverifiedToolOutputRecovery === true
          || codexLbToolOutputRecoveryOverrideAcknowledged({ env: opts.env || process.env })
      })
    : status.tool_output_recovery;
  if (status.base_url && toolOutputRecovery?.ok !== true) {
    return {
      ok: false,
      status: 'tool_output_recovery_blocked',
      codex_lb: status,
      tool_output_recovery: toolOutputRecovery,
      error: toolOutputRecovery?.blockers?.join(', ') || 'codex-lb interrupted tool-output recovery is unverified'
    };
  }
  const currentConfig = await readText(status.config_path, '');
  if (!status.env_key_configured && status.base_url && (status.provider_configured || status.selected || status.env_base_url_configured)) {
    const legacyAuth = await restoreCodexLbEnvFromSharedLogin(status, opts);
    if (legacyAuth.ok) {
      legacyAuthMigrated = true;
      legacyAuthPath = legacyAuth.auth_path;
      status = await codexLbStatus({ ...opts, probeToolOutputRecovery: true });
    }
  }
  // An explicit third-party selection (openrouter, sks-router) is user-chosen
  // state. Background repair may fix the codex-lb provider table but must not
  // reselect codex-lb unless the user explicitly asked (use-codex-lb / forced).
  const repairCurrentProvider = topLevelTomlString(currentConfig, 'model_provider');
  const repairPreserveThirdParty = Boolean(repairCurrentProvider)
    && repairCurrentProvider !== 'codex-lb'
    && opts.forceCodexLbApiKeyAuth !== true
    && opts.authMode !== 'codex-lb';
  if (status.env_key_configured && status.base_url && (!status.provider_contract_ok || (!status.selected && !repairPreserveThirdParty) || legacyAuthMigrated || hasTopLevelCodexModeLock(currentConfig) || (opts.forceCodexLbApiKeyAuth === true && !status.ok))) {
    await ensureDir(path.dirname(status.config_path));
    let next = upsertCodexLbConfig(currentConfig, status.base_url, !repairPreserveThirdParty);
    next = normalizeCodexFastModeUiConfig(next, {
      forceFastMode: opts.forceFastMode === true || opts.forceCodexLbApiKeyAuth === true
    });
    const safeWrite = await safeWriteCodexConfigToml(status.config_path, currentConfig, next, 'codex-lb-repair');
    configRepaired = safeWrite.ok && safeWrite.changed === true;
    status = await codexLbStatus({ ...opts, probeToolOutputRecovery: true });
  }
  const canRepairAuthMode = (opts.forceCodexLbApiKeyAuth === true || status.codex_lb_key_in_shared_auth === true)
    && status.provider_contract_ok
    && status.env_key_configured
    && Boolean(status.base_url);
  if (!status.ok && !canRepairAuthMode) {
    return {
      ok: false,
      status: !status.env_key_configured ? 'missing_env_key' : !status.base_url ? 'missing_base_url' : 'not_configured',
      config_path: status.config_path,
      env_path: status.env_path,
      codex_lb: status
    };
  }
  await migrateCodexAuthKeyFormat({ home: opts.home });
  const codexEnvironment = await syncCodexLbProviderEnvironment(status, opts);
  const loadedEnv = await loadCodexLbEnv({
    ...opts,
    home: opts.home || process.env.HOME || os.homedir(),
    envPath: status.env_path
  });
  const apiKey = String(opts.apiKey || loadedEnv.secret_api_key || '').trim();
  const toolCatalog = await ensureCodexLbToolCatalogSelection({
    home: opts.home || process.env.HOME || os.homedir(),
    configPath: status.config_path,
    baseUrl: String(status.base_url || ''),
    apiKey
  }, opts);
  const forceCodexLbApiKeyAuth = opts.forceCodexLbApiKeyAuth === true || opts.authMode === 'codex-lb';
  const authReconcile = await reconcileCodexLbAuthConflict({ ...opts, status, forceCodexLbApiKeyAuth }).catch((err: any) => ({ status: 'failed', reason: 'exception', error: err.message }));
  const codexLogin = forceCodexLbApiKeyAuth
    ? { ok: ['apikey_forced', 'apikey_auth_active'].includes(authReconcile.status), status: authReconcile.status, ...(authReconcile.reason ? { reason: authReconcile.reason } : {}), error: authReconcile.error || null }
    : await maybeSyncCodexLbSharedLogin(apiKey, { ...opts, home: opts.home || process.env.HOME || os.homedir(), force: true });
  const finalStatus = await codexLbStatus({ ...opts, probeToolOutputRecovery: true });
  const finalReady = finalStatus.selected === true
    && finalStatus.provider_ready === true
    && finalStatus.auth_routing_coherent === true
    && finalStatus.shared_openai_routing?.safe === true;
  const baseOk = Boolean(codexEnvironment.ok
    && codexLogin.ok
    && (toolCatalog.required === false || toolCatalog.ok === true));
  const ok = baseOk && finalReady;
  return {
    ok,
    status: ok ? 'repaired' : baseOk ? 'final_readiness_failed' : (codexEnvironment.status || codexLogin.status),
    config_path: status.config_path,
    env_path: status.env_path,
    base_url: status.base_url,
    config_repaired: configRepaired,
    legacy_auth_migrated: legacyAuthMigrated,
    legacy_auth_path: legacyAuthPath,
    auth_reconcile: authReconcile,
    codex_lb: finalStatus,
    codex_environment: codexEnvironment,
    codex_login: codexLogin,
    tool_catalog: toolCatalog
  };
}

export async function ensureCodexLbAuthDuringInstall(opts: any = {}): Promise<CodexLbAuthInstallResult> {
  if (process.env.SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH === '1' && !opts.force) return { status: 'skipped', reason: 'SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH=1' };
  const status = await codexLbStatus(opts);
  if (!status.selected && !status.provider_configured && !status.env_key_configured) return { status: 'not_configured', codex_lb: status };
  if (status.ok && !status.selected && status.auth_mode === 'chatgpt_oauth') {
    return {
      ok: true,
      status: 'present_unselected',
      reason: 'chatgpt_oauth_active_codex_lb_unselected',
      config_path: status.config_path,
      env_path: status.env_path,
      base_url: status.base_url,
      codex_lb: status
    };
  }
  await migrateCodexAuthKeyFormat({ home: opts.home });
  if (status.ok && (!status.selected || !status.provider_contract_ok)) return repairCodexLbAuth(opts);
  if (!status.ok) {
    if (status.base_url && (status.env_key_configured || status.provider_configured || status.selected || status.env_base_url_configured)) return repairCodexLbAuth(opts);
    return { status: status.env_key_configured ? 'missing_base_url' : 'missing_env_key', codex_lb: status, config_path: status.config_path, env_path: status.env_path };
  }
  const codexEnvironment = await syncCodexLbProviderEnvironment(status, opts);
  const loadedEnv = await loadCodexLbEnv({
    ...opts,
    home: opts.home || process.env.HOME || os.homedir(),
    envPath: status.env_path
  });
  const apiKey = String(opts.apiKey || loadedEnv.secret_api_key || '').trim();
  const toolCatalog = await ensureCodexLbToolCatalogSelection({
    home: opts.home || process.env.HOME || os.homedir(),
    configPath: status.config_path,
    baseUrl: String(status.base_url || ''),
    apiKey
  }, opts);
  const codexLogin = await maybeSyncCodexLbSharedLogin(apiKey, { ...opts, home: opts.home || process.env.HOME || os.homedir(), force: true });
  const authReconcile = await reconcileCodexLbAuthConflict({ ...opts, status }).catch((err: any) => ({ status: 'failed', reason: 'exception', error: err.message }));
  const finalStatus = await codexLbStatus(opts);
  const finalReady = finalStatus.selected === true
    && finalStatus.provider_ready === true
    && finalStatus.auth_routing_coherent === true
    && finalStatus.shared_openai_routing?.safe === true;
  const baseOk = Boolean(codexEnvironment.ok
    && codexLogin.ok
    && (toolCatalog.required === false || toolCatalog.ok === true));
  const ok = baseOk && finalReady;
  return {
    ok,
    status: ok ? 'present' : baseOk ? 'final_readiness_failed' : (codexEnvironment.status || codexLogin.status),
    config_path: status.config_path,
    env_path: status.env_path,
    base_url: status.base_url,
    codex_lb: finalStatus,
    codex_environment: codexEnvironment,
    codex_login: codexLogin,
    tool_catalog: toolCatalog,
    auth_reconcile: authReconcile,
    error: codexEnvironment.error || codexLogin.error || null
  };
}

async function restoreCodexLbEnvFromSharedLogin(status: any = {}, opts: any = {}) {
  const home = opts.home || process.env.HOME || os.homedir();
  const authPath = opts.authPath || codexAuthPath(home);
  const envPath = opts.envPath || status.env_path || codexLbEnvPath(home);
  const authText = await readText(authPath, '');
  const apiKey = parseCodexSharedLoginApiKey(authText);
  if (!apiKey) return { ok: false, status: 'missing_legacy_login_key', auth_path: authPath, env_path: envPath };
  const baseUrl = status.base_url || parseCodexLbEnvBaseUrl(await readText(envPath, ''));
  if (!baseUrl) return { ok: false, status: 'missing_base_url', auth_path: authPath, env_path: envPath };
  await ensureDir(path.dirname(envPath));
  await writeTextAtomic(envPath, `export CODEX_LB_BASE_URL=${shellSingleQuote(normalizeCodexLbBaseUrl(baseUrl))}\nexport CODEX_LB_API_KEY=${shellSingleQuote(apiKey)}\n`, { mode: 0o600 });
  await fsp.chmod(envPath, 0o600).catch(() => {});
  const metadataPath = opts.metadataPath || codexLbMetadataPath(home);
  await writeTextAtomic(metadataPath, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: normalizeCodexLbBaseUrl(baseUrl),
    updated_at: new Date().toISOString(),
    source: 'legacy-login-migration',
    api_key: { redacted: true, sha256: await sha256Text(apiKey) }
  }, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(metadataPath, 0o600).catch(() => {});
  return { ok: true, status: 'migrated_login_cache', auth_path: authPath, env_path: envPath, base_url: normalizeCodexLbBaseUrl(baseUrl) };
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

// Migrate auth.json from legacy {"auth_mode":"apikey","key":"..."} to the codex 0.130.0+
// format {"auth_mode":"apikey","OPENAI_API_KEY":"..."}. Safe: preserves key value, only renames field.
async function migrateCodexAuthKeyFormat(opts: any = {}) {
  const home = opts.home || process.env.HOME || os.homedir();
  const authPath = opts.authPath || codexAuthPath(home);
  const text = await readText(authPath, '');
  if (!text.trim()) return { status: 'skipped', reason: 'empty' };
  try {
    const parsed = JSON.parse(text);
    if (parsed?.auth_mode !== 'apikey') return { status: 'skipped', reason: 'not_apikey' };
    if (parsed.OPENAI_API_KEY) return { status: 'skipped', reason: 'already_migrated' };
    const legacyKey = parsed.key || parsed.api_key || parsed.apiKey || parsed.openai_api_key;
    if (!legacyKey) return { status: 'skipped', reason: 'no_key_found' };
    const replacement = `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: legacyKey })}\n`;
    await writeTextAtomic(authPath, replacement, { mode: 0o600 });
    await fsp.chmod(authPath, 0o600).catch(() => {});
    return { status: 'migrated', auth_path: authPath };
  } catch {
    return { status: 'skipped', reason: 'parse_error' };
  }
}

// Codex App uses the shared OpenAI auth store for providers with
// requires_openai_auth=true. Before putting the codex-lb key in that store, SKS
// must also guard the built-in `openai` provider with the same LB base URL. This
// covers stale App threads and explicit CLI overrides that retain `openai`; the
// config guard is written and verified before auth.json changes.
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
          authPath,
          allowActiveSharedAuthTransition: true
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
  const sharedCodexLbAuthActive = Boolean(authApiKey && envLoad.secret_api_key && authApiKey === envLoad.secret_api_key);
  if (sharedCodexLbAuthActive && opts.allowActiveSharedAuthTransition !== true) {
    return {
      ok: false,
      status: 'failed',
      reason: 'shared_codex_lb_auth_active',
      provider_error: 'refusing to unselect codex-lb while its key is active in shared OpenAI auth',
      config_path: configPath
    };
  }
  const managedCatalogPath = codexLbToolCatalogPath(opts.codexHome || path.join(home, '.codex'));
  const managedCatalogSelected = topLevelTomlString(current, 'model_catalog_json') === managedCatalogPath;
  const providerBaseUrl = codexLbProviderBaseUrl(current) || envLoad.base_url || '';
  const sharedOpenAiRouting = codexLbSharedOpenAiRoutingState(current, providerBaseUrl);
  const managedSharedOpenAiRouting = sharedOpenAiRouting.status === 'matched' && sharedOpenAiRouting.managed;
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
        authPath,
        allowActiveSharedAuthTransition: true
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
        authPath,
        allowActiveSharedAuthTransition: true
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
    // Auth was just restored to ChatGPT OAuth. Allow deselection even if a stale
    // shared-key read would otherwise refuse, so release cannot leave OAuth + LB pin.
    const unselected = await unselectCodexLbProvider({
      ...opts,
      home,
      configPath,
      authPath,
      allowActiveSharedAuthTransition: true
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

export async function maybePromptCodexLbSetupForLaunch(args: any = [], opts: any = {}) {
  if (args.includes('--json') || args.includes('--skip-codex-lb') || process.env.SKS_SKIP_CODEX_LB_PROMPT === '1') return { status: 'skipped' };
  const allowUnverifiedToolOutputRecovery = opts.allowUnverifiedToolOutputRecovery === true
    || codexLbToolOutputRecoveryOverrideAcknowledged({ args, env: opts.env || process.env });
  let status = await codexLbStatus({
    ...opts,
    probeToolOutputRecovery: true,
    allowUnverifiedToolOutputRecovery
  });
  if (status.selected && status.tool_output_recovery?.ok !== true) {
    return {
      status: 'tool_output_recovery_blocked',
      ok: false,
      codex_lb: status,
      tool_output_recovery: status.tool_output_recovery,
      blockers: status.tool_output_recovery.blockers,
      operator_actions: status.tool_output_recovery.operator_actions,
      bypass_codex_lb: false
    };
  }
  if (status.env_key_configured && status.base_url && !status.selected && status.auth_mode === 'chatgpt_oauth') {
    return { status: 'continued_to_codex', ok: false, chain_health: null, codex_lb: status, reason: 'chatgpt_oauth_active_codex_lb_unselected' };
  }
  if (status.env_key_configured && status.base_url && (!status.provider_configured || !status.selected || !status.provider_contract_ok)) {
    let promptedRestore = false;
    if (!status.provider_configured && canAskYesNo()) {
      promptedRestore = true;
      const restore = (await askPostinstallQuestion('\ncodex-lb provider section is missing, but stored auth exists. Restore and route Codex through codex-lb? [Y/n] ')).trim();
      if (/^(n|no|아니|아니요|ㄴ)$/i.test(restore)) return { status: 'continued_to_codex', codex_lb: status };
    }
    const repaired = await repairCodexLbAuth({ ...opts, allowUnverifiedToolOutputRecovery });
    status = await codexLbStatus({ ...opts, probeToolOutputRecovery: true, allowUnverifiedToolOutputRecovery });
    if (status.selected && status.tool_output_recovery?.ok !== true) {
      return {
        status: 'tool_output_recovery_blocked',
        ok: false,
        repair: repaired,
        codex_lb: status,
        tool_output_recovery: status.tool_output_recovery,
        blockers: status.tool_output_recovery.blockers,
        operator_actions: status.tool_output_recovery.operator_actions,
        bypass_codex_lb: false
      };
    }
    if (!status.ok) return { status: 'repair_failed', ok: false, repair: repaired, codex_lb: status };
    if (!repaired.ok && repaired.error && promptedRestore) console.log(`codex-lb provider restored, but launch environment sync reported: ${repaired.error}`);
    else if (!repaired.ok && promptedRestore) console.log(`codex-lb provider restored, but provider auth sync reported: ${repaired.status}`);
    else if (repaired.config_repaired && promptedRestore) console.log(`codex-lb provider restored: ${status.base_url}`);
  }
  if (status.ok) {
    const codexEnvironment = await syncCodexLbProviderEnvironment(status, opts);
    if (codexEnvironment.status === 'synced') console.log('codex-lb provider auth synced for this user session.');
    const apiKey = parseCodexLbEnvKey(await readText(status.env_path, ''));
    const toolCatalog = await ensureCodexLbToolCatalogSelection({
      home: opts.home || process.env.HOME || os.homedir(),
      configPath: status.config_path,
      baseUrl: String(status.base_url || ''),
      apiKey
    }, opts);
    if (toolCatalog.required !== false && toolCatalog.ok !== true) {
      return { status: 'repair_failed', ok: false, codex_lb: status, codex_environment: codexEnvironment, tool_catalog: toolCatalog };
    }
    const codexLogin = await maybeSyncCodexLbSharedLogin(apiKey, { ...opts, home: opts.home || process.env.HOME || os.homedir() });
    if (codexLogin.status === 'synced') console.log('codex-lb auth synced with Codex CLI login cache.');
    const chainHealth = await checkCodexLbResponseChain(status, opts);
    if (!chainHealth.ok && chainHealth.chain_unhealthy) {
      // `previous_response_not_found` is normal for stateless LB deployments that don't persist
      // Responses across requests. The codex-lb provider still works fine — only the chained
      // health probe fails. Keep codex-lb active and just warn.
      if (chainHealth.status === 'previous_response_not_found') {
        console.log('codex-lb response chain check: previous_response_id not persisted by the load balancer (this is normal for stateless deployments). Keeping codex-lb active.');
        return { status: 'present', ...status, codex_environment: codexEnvironment, codex_login: codexLogin, tool_catalog: toolCatalog, chain_health: chainHealth };
      }
      // Hard chain failure (auth rejected, timeout, missing base URL, etc.). Don't silently
      // demote a configured codex-lb to ChatGPT OAuth — surface the failure and let the user
      // decide. Default keeps codex-lb (just press Enter).
      console.log(`codex-lb response chain check failed (${chainHealth.status}${chainHealth.error ? `: ${chainHealth.error}` : ''}).`);
      if (process.env.SKS_CODEX_LB_AUTOBYPASS === '1') {
        console.log('SKS_CODEX_LB_AUTOBYPASS=1 set; bypassing codex-lb to ChatGPT OAuth for this launch.');
        return { status: 'chain_unhealthy', ...status, ok: false, codex_environment: codexEnvironment, codex_login: codexLogin, tool_catalog: toolCatalog, chain_health: chainHealth, bypass_codex_lb: true };
      }
      if (canAskYesNo()) {
        const answer = (await askPostinstallQuestion('Use codex-lb anyway, or fall back to ChatGPT OAuth? [LB/oauth] ')).trim().toLowerCase();
        if (/^(oauth|o|chatgpt|fall ?back|n|no|아니|아니요|ㄴ)$/.test(answer)) {
          console.log('Falling back to ChatGPT OAuth for this launch. Re-enable codex-lb anytime with `sks codex-lb repair`.');
          return { status: 'chain_unhealthy', ...status, ok: false, codex_environment: codexEnvironment, codex_login: codexLogin, tool_catalog: toolCatalog, chain_health: chainHealth, bypass_codex_lb: true };
        }
        console.log('Keeping codex-lb active. To switch back to ChatGPT OAuth: `sks codex-lb release`.');
        return { status: 'present', ...status, codex_environment: codexEnvironment, codex_login: codexLogin, tool_catalog: toolCatalog, chain_health: chainHealth };
      }
      // Non-interactive context with no opt-out env var. The user explicitly configured codex-lb,
      // so default to keeping it active rather than silently swapping providers.
      console.log('Non-interactive launch + chain check failure. Keeping codex-lb active. Set SKS_CODEX_LB_AUTOBYPASS=1 to auto-bypass to ChatGPT OAuth.');
      return { status: 'present', ...status, codex_environment: codexEnvironment, codex_login: codexLogin, tool_catalog: toolCatalog, chain_health: chainHealth };
    }
    return { status: 'present', ...status, codex_environment: codexEnvironment, codex_login: codexLogin, tool_catalog: toolCatalog, chain_health: chainHealth };
  }
  if (!canAskYesNo()) return { status: 'non_interactive', codex_lb: status };
  const useCodexLb = (await askPostinstallQuestion('\ncodex-lb is not configured for this Codex App profile. Configure and route Codex through codex-lb now? [y/N] ')).trim();
  if (!/^(y|yes|예|네|응)$/i.test(useCodexLb)) return { status: 'continued_to_codex' };
  const host = (await askPostinstallQuestion('codex-lb host domain [http://127.0.0.1:2455]: ')).trim() || 'http://127.0.0.1:2455';
  const apiKey = (await askPostinstallQuestion('codex-lb API key: ')).trim();
  const configured = await configureCodexLb({ ...opts, host, apiKey, allowUnverifiedToolOutputRecovery });
  if (configured.ok) console.log(`codex-lb configured: ${configured.base_url}`);
  else console.log('codex-lb setup skipped: API key was empty.');
  return configured;
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
  const launchctl = opts.launchctlBin || await which('launchctl').catch(() => null) || await exists('/bin/launchctl').then((ok: any) => ok ? '/bin/launchctl' : null).catch(() => null);
  if (!launchctl) return { ok: false, status: 'launchctl_missing', error: 'launchctl not found on PATH' };
  const secretCleanup = await cleanupMacLaunchSecretEnvironment({ force: opts.forceLaunchEnv === true }).catch((err: any) => ({
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
    const result = await runProcess(launchctl, ['setenv', key, String(value)], { timeoutMs: 5000, maxOutputBytes: 8192 });
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
  const launchctl = opts.launchctlBin || await which('launchctl').catch(() => null) || await exists('/bin/launchctl').then((ok: any) => ok ? '/bin/launchctl' : null).catch(() => null);
  if (!launchctl) return { checked: true, available: false, status: 'launchctl_missing' };
  const readVar = async (key: string) => {
    const result = await runProcess(launchctl, ['getenv', key], { timeoutMs: 3000, maxOutputBytes: 8192 });
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

async function maybeSyncCodexLbSharedLogin(apiKey: any, opts: any = {}): Promise<CodexLbLoginSyncResult> {
  if (!apiKey) return { ok: false, status: 'missing_env_key' };
  if (!shouldSyncCodexLbSharedLogin(opts)) {
    return { ok: true, status: 'skipped', reason: 'codex-lb repair preserved the current Codex App auth; run `sks codex-lb use-codex-lb` to switch the app to codex-lb API-key auth.' };
  }
  return syncCodexApiKeyLogin(apiKey, opts);
}

function shouldSyncCodexLbSharedLogin(opts: any = {}) {
  return opts.syncCodexLogin === true || process.env.SKS_CODEX_LB_SYNC_CODEX_LOGIN === '1';
}

async function syncCodexApiKeyLogin(apiKey: any, opts: any = {}) {
  const home = opts.home || process.env.HOME || os.homedir();
  const codexHome = opts.codexHome || path.join(home, '.codex');
  const codexBin = opts.codexBin || (await getCodexInfo().catch(() => EMPTY_CODEX_INFO)).bin || await which('codex').catch(() => null);
  if (!codexBin) return { ok: false, status: 'codex_missing' };
  await ensureDir(codexHome);
  const env = { HOME: home, CODEX_HOME: codexHome, CODEX_LB_API_KEY: apiKey };
  if (!opts.force) {
    const current = await runProcess(codexBin, ['login', 'status'], { env, timeoutMs: 10000, maxOutputBytes: 8192 });
    if (current.code === 0 && !/not logged in/i.test(`${current.stdout}\n${current.stderr}`)) return { ok: true, status: 'present' };
  }
  const login = await runProcess(codexBin, ['login', '--with-api-key'], { input: `${apiKey}\n`, env, timeoutMs: 15000, maxOutputBytes: 8192 });
  if (login.code === 0) return { ok: true, status: 'synced' };
  return { ok: false, status: 'login_failed', error: redactSecretText(login.stderr || login.stdout || 'codex login failed', [apiKey]).trim() };
}


export {
  checkContext7,
  ensureCodexCliTool,
  ensureMadLaunchDependencies,
  ensureRelatedCliTools,
  ensureZellijCliTool,
  formatMadLaunchDependencyAction,
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
export { selftestCodexLb } from './install-helpers-codex-lb-selftest.js';
