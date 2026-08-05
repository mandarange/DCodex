import { writeJsonAtomic } from '../../../fsx.js';
import { MENU_ITEMS } from '../constants.js';
import { sksMenuBarPaths } from '../paths.js';
import { defaultNextActions } from '../status.js';
import type { SksMenuBarInstallResult } from '../types.js';

export function baseResult(
  paths: ReturnType<typeof sksMenuBarPaths>,
  apply: boolean,
  status: SksMenuBarInstallResult['status'],
  ok: boolean,
  actions: string[],
  warnings: string[]
): SksMenuBarInstallResult {
  return {
    schema: 'sks.codex-app-sks-menubar.v1', ok, apply, status, platform: process.platform,
    app_path: paths.app_path, executable_path: paths.executable_path,
    launch_agent_path: paths.launch_agent_path, action_script_path: paths.action_script_path,
    build_stamp_path: paths.build_stamp_path, config_path: paths.config_path,
    report_path: paths.report_path, menu_items: [...MENU_ITEMS], actions,
    tcc_automation_status: 'unknown', next_actions: defaultNextActions(), blockers: [], warnings
  };
}

export async function writeReport(reportPath: string, result: SksMenuBarInstallResult): Promise<void> {
  try { await writeJsonAtomic(reportPath, result); }
  catch { result.report_write_failed = true; result.warnings.push('menubar_report_write_failed'); }
}
