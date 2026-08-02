import type { SksMenuBarStatusResult } from '../codex-app/menubar/types.js';

type SksMenuBarDoctorStatus = Pick<SksMenuBarStatusResult, 'ok' | 'blockers' | 'warnings'>
  & {
    installed_version?: SksMenuBarStatusResult['installed_version'];
    running_process?: SksMenuBarStatusResult['running_process'];
    menubar_version_probe?: SksMenuBarStatusResult['menubar_version_probe'];
    launchd?: Pick<SksMenuBarStatusResult['launchd'], 'error' | 'state'>;
    action_target?: Pick<SksMenuBarStatusResult['action_target'], 'smoke_code'>;
  };

export function buildSksMenuBarDoctorPostcheck(status: SksMenuBarDoctorStatus): {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  installed_version: string | null;
  running_version: string | null;
  running_pid: number | null;
  menubar_version_probe: SksMenuBarStatusResult['menubar_version_probe'] | null;
} {
  const blockers = [...new Set((status.blockers || []).map((blocker) => {
    if (blocker === 'launchd_not_running') {
      return `launchd_not_running:${status.launchd?.error || status.launchd?.state || 'unknown'}`;
    }
    if (blocker === 'action_script_smoke_failed') {
      return `action_script_smoke_failed:${status.action_target?.smoke_code ?? 'no_code'}`;
    }
    return blocker;
  }))];
  if (status.ok !== true && blockers.length === 0) blockers.push('menubar_status_not_ok');
  return {
    ok: blockers.length === 0,
    installed_version: status.installed_version || null,
    running_version: status.running_process?.package_version || null,
    running_pid: status.running_process?.pid || null,
    menubar_version_probe: status.menubar_version_probe || null,
    blockers,
    warnings: [
      ...(status.warnings || []),
      blockers.length === 0 ? 'menubar_postcheck_passed' : 'menubar_postcheck_failed'
    ]
  };
}
