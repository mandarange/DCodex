import { flag } from '../cli/args.js';
import { sksMenuBarRestartDeferred } from '../core/codex-app/menubar/index.js';

export type DoctorProfile = 'fast' | 'fix' | 'migration' | 'full' | 'capabilities';

export function doctorProfileFromArgs(args: any[] = [], doctorFix = false): DoctorProfile {
  const explicit = readOption(args, '--profile');
  if (isDoctorProfile(explicit)) return explicit;
  if (flag(args, '--full')) return 'full';
  if (flag(args, '--capabilities')) return 'capabilities';
  return doctorFix ? 'fix' : 'fast';
}

export function doctorArgWarnings(args: any[] = []): string[] {
  const warnings: string[] = [];
  const explicit = readOption(args, '--profile');
  if (explicit && !isDoctorProfile(explicit)) {
    warnings.push(`unknown_profile:${explicit}; supported profiles: migration, full, capabilities, fast, fix`);
  }
  for (const value of unknownDoctorFlags(args)) warnings.push(`unknown_flag:${value}`);
  return warnings;
}

export function doctorMenuBarInstallPolicy(
  args: any[] = [],
  doctorFix = false,
  env: NodeJS.ProcessEnv = process.env
): { profile: DoctorProfile; phase_enabled: boolean; apply: boolean; launch: boolean } {
  const profile = doctorProfileFromArgs(args, doctorFix);
  const phaseEnabled = doctorPhaseIdsForProfile(profile).includes('sks_menubar');
  const apply = doctorFix && phaseEnabled;
  return {
    profile,
    phase_enabled: phaseEnabled,
    apply,
    launch: apply && !sksMenuBarRestartDeferred(env)
  };
}

export function doctorPhaseIdsForProfile(profile: DoctorProfile): string[] {
  const required = [
    'codex_startup_repair',
    'startup_config_repair',
    'codex_config_syntax_repair',
    'context7_repair',
    'context7_mcp_repair',
    'hook_trust_repair',
    'command_alias_cleanup'
  ];
  if (profile === 'migration') return required;
  const optional = ['supabase_mcp_repair', 'native_capability_repair', 'sks_menubar', 'desktop_bridge_catalog_repair'];
  if (profile === 'full' || profile === 'capabilities') return ['setup', ...required, ...optional];
  return [...required, ...optional];
}

export function doctorProfileRequiresDesktopBridgeReadiness(profile: DoctorProfile): boolean {
  // The migration profile owns config/schema convergence only. Requiring a
  // configured and running Desktop Bridge here makes the first command after
  // an update fail even after it has written a current migration receipt.
  // Ordinary Doctor profiles still report and enforce live bridge readiness.
  return profile !== 'migration';
}

function unknownDoctorFlags(args: any[]): string[] {
  const knownBoolean = new Set([
    '--fix', '--yes', '-y', '--machine-only', '--actual-codex', '--require-actual-codex',
    '--full', '--capabilities', '--repair-codex-app-ui',
    '--repair-native-capabilities', '--repair-codex-native', '--local-only', '--global-only', '--project', '--global',
    '--dry-run', '--json'
  ]);
  const knownValue = new Set(['--profile', '--report-file', '--codex-bin', '--install-scope']);
  const unknown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (!arg.startsWith('-')) continue;
    if (knownValue.has(arg)) {
      index += 1;
      continue;
    }
    if (!knownBoolean.has(arg)) unknown.push(arg);
  }
  return unknown;
}

function isDoctorProfile(value: unknown): value is DoctorProfile {
  return ['migration', 'full', 'capabilities', 'fast', 'fix'].includes(String(value || ''));
}

function readOption(args: any[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : null;
}
