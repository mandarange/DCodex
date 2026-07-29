import path from 'node:path';
import { appendJsonlBounded, nowIso, writeJsonAtomic } from '../fsx.js';

// CLI (non-interactive) launches cannot answer repair prompts. Never hard-block
// them on manual zellij repair: the self-heal falls back headless and, when
// zellij stays unavailable, the launch finishes live_panes=false instead of
// failing. --attach opts back into the interactive contract and
// SKS_MAD_CLI_HEADLESS=0 restores the legacy blocking behavior.
export function resolveMadCliDegraded(input: {
  args: any[];
  env?: Record<string, string | undefined> | undefined;
  stdoutIsTTY?: boolean | undefined;
  stdinIsTTY?: boolean | undefined;
  explicitHeadless?: boolean | undefined;
}): boolean {
  const env = input.env || process.env;
  const list = (input.args || []).map((arg: any) => String(arg));
  if (input.explicitHeadless === true) return false;
  if (env.SKS_MAD_CLI_HEADLESS === '0') return false;
  if (list.includes('--attach')) return false;
  return input.stdoutIsTTY !== true
    || input.stdinIsTTY !== true
    || list.includes('--json')
    || env.SKS_NO_QUESTION === '1';
}

// Optional-mode zellij failures carry no blockers, only warnings; only those
// are safe to convert into a headless CLI fallback. Anything with blockers
// (including SKS_REQUIRE_ZELLIJ=1 contract violations) must stay a failure.
export function isOptionalZellijUnavailableLaunch(launch: any): boolean {
  if (!launch || launch.ok === true) return false;
  if ((launch.blockers || []).length > 0) return false;
  return (launch.warnings || []).some((warning: any) => String(warning) === 'zellij_launch_skipped_optional_missing');
}

export async function writeMadHeadlessZellijFallback(madLaunch: any, workspace: string, extraWarnings: string[] = []) {
  const report = {
    schema: 'sks.zellij-session.v1',
    generated_at: nowIso(),
    ok: true,
    kind: 'mad',
    status: 'headless-fallback',
    live_panes: false,
    mission_id: madLaunch.mission_id,
    session_name: null,
    workspace,
    root: madLaunch.root,
    cwd: path.resolve(process.cwd()),
    attach_command_with_env: null,
    blockers: [],
    warnings: ['zellij_headless_fallback_live_panes_false', ...extraWarnings.filter((warning) => warning && warning !== 'zellij_headless_fallback_live_panes_false')]
  };
  await writeJsonAtomic(path.join(madLaunch.dir, 'zellij-session.json'), report);
  await appendJsonlBounded(path.join(madLaunch.dir, 'events.jsonl'), { ts: nowIso(), type: 'mad_sks.zellij_headless_fallback', live_panes: false });
  return report;
}
