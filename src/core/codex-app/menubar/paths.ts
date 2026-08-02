import os from 'node:os';
import path from 'node:path';
import { SKS_MENUBAR_LABEL } from './constants.js';

export function sksMenuBarPaths(homeInput?: string, rootInput?: string) {
  const home = path.resolve(homeInput || process.env.HOME || os.homedir());
  const root = path.resolve(rootInput || process.cwd());
  const installDir = path.join(home, '.codex', 'sks-menubar');
  const appPath = path.join(installDir, 'SKSMenuBar.app');
  const contentsPath = path.join(appPath, 'Contents');
  const macosPath = path.join(contentsPath, 'MacOS');
  return {
    home,
    root,
    install_dir: installDir,
    app_path: appPath,
    staging_app_path: `${appPath}.staging`,
    backup_app_path: `${appPath}.previous`,
    contents_path: contentsPath,
    macos_path: macosPath,
    resources_path: path.join(contentsPath, 'Resources'),
    executable_path: path.join(macosPath, 'SKSMenuBar'),
    sources_path: path.join(installDir, 'Sources'),
    info_plist_path: path.join(contentsPath, 'Info.plist'),
    action_script_path: path.join(installDir, 'sks-menubar-action.sh'),
    staging_action_script_path: path.join(installDir, 'sks-menubar-action.sh.staging'),
    previous_action_script_path: path.join(installDir, 'sks-menubar-action.sh.previous'),
    build_stamp_path: path.join(installDir, 'build-stamp.json'),
    runtime_state_path: path.join(installDir, 'runtime-state.json'),
    version_probe_path: path.join(installDir, 'menubar-version-probe.json'),
    duplicate_receipts_dir: path.join(installDir, 'receipts', 'project-duplicates'),
    staging_build_stamp_path: path.join(installDir, 'build-stamp.json.staging'),
    previous_build_stamp_path: path.join(installDir, 'build-stamp.json.previous'),
    config_path: path.join(installDir, 'config.json'),
    launch_agent_path: path.join(home, 'Library', 'LaunchAgents', `${SKS_MENUBAR_LABEL}.plist`),
    staging_launch_agent_path: path.join(installDir, `${SKS_MENUBAR_LABEL}.plist.staging`),
    previous_launch_agent_path: path.join(installDir, `${SKS_MENUBAR_LABEL}.plist.previous`),
    install_transaction_path: path.join(installDir, 'generation-install-transaction.json'),
    rollback_transaction_path: path.join(installDir, 'generation-rollback-transaction.json'),
    report_path: path.join(root, '.sneakoscope', 'reports', 'sks-menubar.json'),
    stdout_log_path: path.join(installDir, 'menubar.out.log'),
    stderr_log_path: path.join(installDir, 'menubar.err.log'),
    logs_dir: path.join(installDir, 'logs'),
    last_action_log_path: path.join(installDir, 'logs', 'last-action.log'),
    operations_dir: path.join(home, '.sneakoscope-global', 'operations')
  };
}
