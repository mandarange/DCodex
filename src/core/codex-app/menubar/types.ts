import type { sksMenuBarPaths } from './paths.js';

export interface SksMenuBarBuildStamp {
  schema: 'sks.sks-menubar-build-stamp.v2';
  package_version: string;
  source_sha256: string;
  source_files_sha256: Record<string, string>;
  resources_sha256: string;
  resource_files_sha256: Record<string, string>;
  action_script_sha256: string;
  info_plist_sha256: string;
  launch_agent_sha256: string;
  swiftc_version: string;
  codesign_identifier: string;
  legacy_v1?: {
    original_schema: 'sks.sks-menubar-build-stamp.v1';
    original_stamp_sha256: string;
    source_file: 'SKSMenuBar.swift';
    source_file_sha256: string;
    executable_sha256: string;
  };
}

export interface SksMenuBarLegacyBuildStampV1 {
  schema: 'sks.sks-menubar-build-stamp.v1';
  package_version: string;
  source_sha256: string;
  action_script_sha256: string;
  info_plist_sha256: string;
  launch_agent_sha256: string;
  swiftc_version: string;
  codesign_identifier: string;
}

export interface SksMenuBarTargetCheck {
  requested: string | null;
  resolved: string | null;
  packaged: string;
  exists: boolean;
  project_local: boolean;
  used_previous_script: boolean;
}

export interface SecretLaunchEnvCleanupResult {
  ok: boolean;
  status: 'cleaned' | 'skipped' | 'not_macos' | 'launchctl_missing' | 'partial';
  variables: string[];
  cleaned: string[];
  failed: Array<{ key: string; error: string }>;
  next_actions: string[];
}

export interface SksMenuBarConfig {
  schema: 'sks.sks-menubar-config.v1';
  codex_bundle_id: string | null;
  quit_with_codex: boolean;
}

export interface SksMenuBarInstallOptions {
  apply?: boolean;
  launch?: boolean;
  root?: string;
  home?: string;
  sksEntry?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
}

export interface SksMenuBarArtifactVerification {
  checked: boolean;
  ok: boolean;
  app_exists: boolean;
  executable_exists: boolean;
  executable_hash_ok: boolean;
  build_stamp_exists: boolean;
  action_script_exists: boolean;
  action_script_executable: boolean;
  action_script_hash_ok: boolean;
  info_plist_hash_ok: boolean;
  launch_agent_hash_ok: boolean;
  signature: SksMenuBarStatusResult['signature'];
  resources: SksMenuBarStatusResult['resources'];
  package_version: string | null;
  legacy_v1_normalized: boolean;
  blockers: string[];
}

export interface SksMenuBarRollbackOptions {
  home?: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
  launch?: boolean;
}

export type SksMenuBarGenerationPurpose = 'install' | 'rollback';
export type SksMenuBarGenerationArtifact = 'app' | 'build_stamp' | 'action_script' | 'launch_agent';

export interface SksMenuBarGenerationPairOutcome {
  kind: SksMenuBarGenerationArtifact;
  step: string;
  active: string;
  backup: string;
  staged: string | null;
  temporary: string;
  displaced: string | null;
  active_exists: boolean;
  backup_exists: boolean;
  staged_exists: boolean;
  temporary_exists: boolean;
  displaced_exists: boolean;
}

export interface SksMenuBarGenerationTransactionOutcome {
  schema: 'sks.menubar-generation-transaction-outcome.v1';
  ok: boolean;
  purpose: SksMenuBarGenerationPurpose;
  status: 'none' | 'applied' | 'committed' | 'rolled_back' | 'completed_commit' | 'terminal_uncertain';
  journal_path: string;
  failure_point: string | null;
  failure_pair: SksMenuBarGenerationArtifact | null;
  recovery_failure_point: string | null;
  recovery_failure_pair: SksMenuBarGenerationArtifact | null;
  error: string | null;
  pairs: SksMenuBarGenerationPairOutcome[];
}

export interface SksMenuBarRollbackResult {
  schema: 'sks.menubar-rollback.v1';
  ok: boolean;
  platform: NodeJS.Platform;
  status: 'rolled_back' | 'rolled_back_launch_skipped' | 'failed' | 'terminal_uncertain' | 'unsupported_platform';
  paths: ReturnType<typeof sksMenuBarPaths>;
  previous_version: string | null;
  replaced_version: string | null;
  verification_before: SksMenuBarArtifactVerification | null;
  verification_after: SksMenuBarArtifactVerification | null;
  launch: SksMenuBarInstallResult['launch'];
  actions: string[];
  warnings: string[];
  blockers: string[];
  transaction?: SksMenuBarGenerationTransactionOutcome | null;
}

export interface SksMenuBarInstallResult {
  schema: 'sks.codex-app-sks-menubar.v1';
  ok: boolean;
  apply: boolean;
  status: 'planned' | 'installed' | 'installed_launch_skipped' | 'installed_open_fallback' | 'unsupported_platform' | 'blocked' | 'terminal_uncertain';
  platform: NodeJS.Platform;
  app_path: string | null;
  executable_path: string | null;
  launch_agent_path: string | null;
  action_script_path: string | null;
  build_stamp_path: string | null;
  installed_version?: string | null;
  running_process?: SksMenuBarRuntimeProcess;
  menubar_version_probe?: SksMenuBarVersionProbe;
  duplicate_install_candidates?: string[];
  config_path?: string | null;
  report_path: string | null;
  codex_bundle_id?: string | null;
  menu_items: string[];
  actions: string[];
  launch?: {
    requested: boolean;
    method: 'launchctl' | 'open-fallback' | 'skipped' | 'none';
    ok: boolean;
    bootstrap_code?: number | null;
    bootstrap_timed_out?: boolean;
    kickstart_code?: number | null;
    kickstart_timed_out?: boolean;
    print_code?: number | null;
    verified_running_after_timeout?: boolean;
    terminal_uncertain?: boolean;
    open_code?: number | null;
    open_verified_running?: boolean;
    version_probe?: SksMenuBarVersionProbe;
    error?: string | null;
  };
  target_check?: SksMenuBarTargetCheck;
  build_stamp?: SksMenuBarBuildStamp | null;
  tcc_automation_status?: 'unknown' | 'granted' | 'denied';
  secret_env_cleanup?: SecretLaunchEnvCleanupResult;
  next_actions: string[];
  blockers: string[];
  warnings: string[];
  report_write_failed?: boolean;
  rollback?: SksMenuBarRollbackResult | null;
  transaction?: SksMenuBarGenerationTransactionOutcome | null;
}

export interface SksMenuBarStatusResult {
  schema: 'sks.menubar-status.v1';
  ok: boolean;
  platform: NodeJS.Platform;
  installed: boolean;
  running: boolean;
  installed_version: string | null;
  running_process: SksMenuBarRuntimeProcess;
  menubar_version_probe: SksMenuBarVersionProbe;
  duplicate_install_candidates: string[];
  paths: ReturnType<typeof sksMenuBarPaths>;
  launchd: { checked: boolean; ok: boolean; service: string | null; state: string | null; pid: number | null; error: string | null };
  action_target: {
    node_bin: string | null;
    node_exists: boolean;
    sks_entry: string | null;
    sks_entry_exists: boolean;
    smoke_code: number | null;
    smoke_output: string | null;
    version_detected: boolean;
    detected_version: string | null;
    expected_version: string;
    version_matches_expected: boolean;
    script_sha256: string | null;
    expected_script_sha256: string | null;
    script_hash_matches_stamp: boolean;
    executable: boolean;
    ok: boolean;
  };
  codex_sync: { ok: boolean; bundle_id: string | null; codex_running: boolean | null; icon_visible_expected: boolean; warning: string | null };
  build_stamp: SksMenuBarBuildStamp | null;
  package_version: string;
  signature: { checked: boolean; identifier: string | null; ok: boolean; error: string | null };
  resources: { checked: boolean; ok: boolean; missing: string[]; mismatched: string[] };
  blockers: string[];
  warnings: string[];
  next_actions: string[];
}

export interface SksMenuBarRuntimeProcess {
  checked: boolean;
  ok: boolean;
  pid: number | null;
  package_version: string | null;
  build_version: string | null;
  executable_path: string | null;
  started_at: string | null;
  source: 'runtime-state' | 'none';
  error: string | null;
}

export interface SksMenuBarVersionProbe {
  schema: 'sks.menubar-version-probe.v1';
  checked: boolean;
  ok: boolean;
  expected_version: string;
  running_version: string | null;
  pid: number | null;
  generated_at: string;
  persisted_path: string;
  error: string | null;
}

export interface SksMenuBarStopResult {
  ok: boolean;
  service: string;
  executable_paths: string[];
  bootout_codes: Array<number | null>;
  terminated_pids: number[];
  remaining_pids: number[];
  timed_out: boolean;
  error: string | null;
}

export interface SksMenuBarUninstallResult {
  schema: 'sks.menubar-uninstall.v1';
  ok: boolean;
  platform: NodeJS.Platform;
  paths: ReturnType<typeof sksMenuBarPaths>;
  actions: string[];
  warnings: string[];
  blockers: string[];
}

export interface NativeSourceInput {
  actionScriptPath: string;
  projectRootPath?: string;
  buildStampPath: string;
  configPath: string;
  lastActionLogPath: string;
  operationDirPath: string;
  codexBundleId: string | null;
  packageVersion: string;
}
