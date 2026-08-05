import path from 'node:path';
import fsp from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ensureDir, exists, globalSksRoot, packageRoot } from '../core/fsx.js';
import {
  formatHarnessConflictReport,
  llmHarnessCleanupPrompt,
  scanHarnessConflicts
} from '../core/harness-conflicts.js';
import { reconcileCodexAppUpgradeProcesses } from '../core/codex-app.js';
import { runPostinstallGlobalDoctorAndMarkPending } from '../core/update/update-migration-state.js';
import { isProjectSetupCandidate } from './install-tool-helpers.js';
import {
  ensureCodexImagegenDuringInstall,
  ensureGlobalCodexSkillsDuringInstall,
  ensureGlobalContext7DuringInstall,
  ensureGlobalGetdesignSkillDuringInstall,
  ensureSksCommandDuringInstall
} from './install-helpers-install-support.js';

const doctorFixCommand = ['sks doctor', '--fix'].join(' ');

export async function postinstall({ bootstrap }: any) {
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

  try {
    const bootstrapDecision = await postinstallBootstrapDecision(installRoot);
    const conflictScan = await scanHarnessConflicts(installRoot);
    if (conflictScan.hard_block) {
      await postinstallHarnessConflictNotice(conflictScan);
      return;
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

    console.log('Codex App Fast mode: left unchanged during install; use the explicit Fast-mode command to change it.');
    console.log('Provider credentials and Codex provider selection were left byte-for-byte unchanged during install.');
    console.log('Configure providers explicitly with `sks bridge provider configure codex-lb ...` or `sks bridge provider configure openrouter ...`.');

    const imagegenRepair = await ensureCodexImagegenDuringInstall();
    if (imagegenRepair.status === 'ready') console.log('Codex App Image Gen: ready ($imagegen/gpt-image-2 detected).');
    else if (imagegenRepair.status === 'recovered') console.log('Codex App Image Gen: recovered and re-detected. Start a new Codex/Work task; restart the desktop app only if the new task still lacks $imagegen.');
    else if (imagegenRepair.status === 'blocked') console.log(`Codex App Image Gen: blocked; run \`${doctorFixCommand}\`. ${(imagegenRepair.blockers || []).join(', ')}`.trim());
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

    const appProcessRepair: any = process.env.SKS_POSTINSTALL_RECONCILE_APP_PROCESSES === '1'
      ? await reconcileCodexAppUpgradeProcesses()
      : { status: 'skipped', reason: 'opt_in_required', killed: [] };
    if (appProcessRepair.status === 'repaired') console.log(`Codex App reconnect repair: stopped ${appProcessRepair.killed.length} stale orphan app-server process(es). Restart Codex App to reconnect cleanly.`);
    else if (appProcessRepair.status === 'partial') console.log(`Codex App reconnect repair: stopped ${appProcessRepair.killed.length} stale orphan app-server process(es); ${(appProcessRepair.failed ?? []).length} could not be stopped. Restart Codex App if reconnecting continues.`);
    else if (appProcessRepair.status === 'skipped' && appProcessRepair.reason === 'opt_in_required') console.log(`Codex App reconnect repair: not run (set SKS_POSTINSTALL_RECONCILE_APP_PROCESSES=1 to allow postinstall to stop stale orphan app-server processes; otherwise run \`${doctorFixCommand}\`).`);
    else if (appProcessRepair.status === 'skipped' && appProcessRepair.reason !== 'platform') console.log(`Codex App reconnect repair: skipped (${appProcessRepair.reason}).`);
    else if (appProcessRepair.status === 'failed') console.log(`Codex App reconnect repair: skipped (${appProcessRepair.error || appProcessRepair.reason || 'process check failed'}).`);

    const globalSkills = await ensureGlobalCodexSkillsDuringInstall();
    if (globalSkills.status === 'installed') {
      const removed = globalSkills.removed_stale_generated_skills || [];
      const cleanup = removed.length ? ` Removed stale generated skill shadow(s): ${removed.join(', ')}.` : '';
      console.log(`Codex App global $ skills: installed in ${globalSkills.root} (${globalSkills.installed_count} skills).${cleanup}`);
    } else if (globalSkills.status === 'partial') {
      console.log(`Codex App global $ skills: partial in ${globalSkills.root}; missing ${(globalSkills.missing_skills ?? []).join(', ')}. Run \`${doctorFixCommand}\`.`);
    } else if (globalSkills.status === 'skipped') {
      console.log(`Codex App global $ skills: skipped (${globalSkills.reason}).`);
    } else if (globalSkills.status === 'failed') {
      console.log(`Codex App global $ skills: auto setup failed. Run \`${doctorFixCommand}\`. ${globalSkills.error || ''}`.trim());
    }

    const getdesignSkill = await ensureGlobalGetdesignSkillDuringInstall();
    console.log(`getdesign Codex skill: not installed automatically; generated getdesign-reference skill is available. To install the upstream skill manually, review commit ${getdesignSkill.reviewed_ref} and run \`${getdesignSkill.install}\`.`);
    console.log(`SKS bootstrap: ${bootstrapDecision.reason}.`);
    await runPostinstallBootstrap(installRoot, bootstrap, bootstrapDecision);
  } catch (err: any) {
    console.log(`\nSKS postinstall: a setup step did not complete; installation continues. Run \`${doctorFixCommand}\` afterward. (${err?.message || err})`);
  } finally {
    // Provider credentials and routing are intentionally outside install-time
    // mutation, so there is no provider snapshot to restore here.
  }
}

function postinstallExternalMutationsAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.SKS_POSTINSTALL_BOOTSTRAP === '1' && env.SKS_POSTINSTALL_NO_BOOTSTRAP !== '1';
}

async function restoreInstalledPackageBuildStamp() {
  try {
    const stampLib: any = await import('../scripts/lib/ensure-dist-fresh.js');
    const root = path.resolve(packageRoot());
    const rawStamp = String(stampLib.distStampPath || '').trim();
    if (!rawStamp) throw new Error('dist_stamp_path_missing');
    const stamp = path.resolve(rawStamp);
    const relative = path.relative(root, stamp);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('dist_stamp_outside_package_root');
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
  if (process.env.SKS_POSTINSTALL_RETENTION_CLEANUP === '0') return { status: 'skipped', reason: 'disabled_by_env', action_count: 0 };
  if (!(await exists(path.join(projectRoot, '.sneakoscope', 'missions')))) return { status: 'skipped', reason: 'missions_missing', action_count: 0 };
  try {
    const { enforceRetention } = await import('../core/retention.js');
    const result = await enforceRetention(projectRoot, {
      mode: 'postinstall_update',
      pruneReportLogs: true,
      policy: { max_tmp_age_hours: 0 }
    });
    return { status: 'completed', root: projectRoot, action_count: Array.isArray(result.actions) ? result.actions.length : 0 };
  } catch (err: any) {
    return { status: 'failed', root: projectRoot, action_count: 0, error: err?.message || String(err) };
  }
}

async function postinstallHarnessConflictNotice(conflictScan: any) {
  console.log('\nSneakoscope Codex package installed, but SKS setup is blocked.');
  console.log(formatHarnessConflictReport(conflictScan, { includePrompt: false }));
  console.log(`\nWhat this means: npm can finish installing the package. Conflicting OMX/DCodex markers must be removed explicitly with \`sks conflicts cleanup --yes\` before \`sks setup\`, \`${doctorFixCommand}\`, or \`sks update\` can proceed.`);
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
  console.log(`After approved cleanup, rerun: sks setup && ${doctorFixCommand} && sks selftest --mock\n`);
}

function shouldAskPostinstallQuestion() {
  if (process.env.SKS_POSTINSTALL_PROMPT === '1') return true;
  return Boolean(input.isTTY && output.isTTY && process.env.CI !== 'true' && process.env.SKS_POSTINSTALL_NO_PROMPT !== '1');
}

async function askPostinstallQuestion(prompt: string) {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export async function postinstallBootstrapDecision(root: any) {
  if (process.env.SKS_POSTINSTALL_NO_BOOTSTRAP === '1') return { run: false, reason: 'SKS_POSTINSTALL_NO_BOOTSTRAP=1' };
  if (process.env.SKS_POSTINSTALL_BOOTSTRAP !== '1') return { run: false, reason: 'explicit opt-in required (SKS_POSTINSTALL_BOOTSTRAP=1)' };
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
export { codexLbConfigPath, codexLbEnvPath } from './install-helpers-codex-lb-shared.js';
