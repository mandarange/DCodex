import type { ReleasePackReceipt } from '../core/release/release-pack-receipt.js'

export const RELEASE_UPGRADE_SMOKE_SCHEMA = 'sks.release-upgrade-smoke.v2' as const

// The baseline lives in src/core/release so validators there can share it; re-exported
// here so existing script importers keep one import site.
export {
  RELEASE_UPGRADE_BASELINE_LABEL,
  RELEASE_UPGRADE_BASELINE_SHA256,
  RELEASE_UPGRADE_BASELINE_VERSION
} from '../core/release/release-upgrade-baseline.js'

export const POSTINSTALL_SAFETY_ENV = {
  CI: 'true',
  SKS_CODEX_LB_CHAIN_CHECK: '0',
  SKS_CODEX_LB_NO_AUTH_RECONCILE: '1',
  SKS_DISABLE_NETWORK: '1',
  SKS_IMAGEGEN_AUTO_INSTALL_CODEX: '0',
  SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS: '0',
  SKS_POSTINSTALL_BOOTSTRAP: '0',
  SKS_POSTINSTALL_GLOBAL_DOCTOR: '0',
  SKS_POSTINSTALL_NO_BOOTSTRAP: '1',
  SKS_POSTINSTALL_NO_PROMPT: '1',
  SKS_POSTINSTALL_RECONCILE_APP_PROCESSES: '0',
  SKS_POSTINSTALL_RETENTION_CLEANUP: '0',
  SKS_POSTINSTALL_SKIP_IMAGEGEN_REPAIR: '1',
  SKS_SKIP_CODEX_APP_UPGRADE_REPAIR: '1',
  SKS_SKIP_CODEX_GLM_PROFILE_REPAIR: '1',
  SKS_SKIP_CODEX_LB_CHAIN_CHECK: '1',
  SKS_SKIP_CODEX_LB_KEY_PROMPT: '1',
  SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1',
  SKS_SKIP_CODEX_LB_PROMPT: '1',
  SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH: '1',
  SKS_SKIP_POSTINSTALL_CONTEXT7: '1',
  SKS_SKIP_POSTINSTALL_GETDESIGN: '1',
  SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS: '1',
  SKS_SKIP_POSTINSTALL_SHIM: '1',
  SKS_SKIP_POSTINSTALL_SHIM_REPAIR: '1',
  SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
  SKS_UPDATE_RETENTION_CLEANUP: '0'
} as const

export interface ReleaseUpgradeSmokeOptions {
  targetTarball?: string
  targetReceipt?: string
  baselineTarball?: string
  baselineSha256?: string
  keepSandbox?: boolean
  argumentBlockers?: string[]
}

export interface ReleaseUpgradeCommandSpec {
  stage: string
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

export interface ReleaseUpgradeCommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

export type ReleaseUpgradeCommandRunner = (spec: ReleaseUpgradeCommandSpec) => Promise<ReleaseUpgradeCommandResult>

export interface ReleaseUpgradeIsolation {
  sandbox: string
  home: string
  codexHome: string
  npmCache: string
  npmPrefix: string
  npmUserConfig: string
  npmGlobalConfig: string
  workspace: string
  baselinePackDir: string
  commandReportsDir: string
  sealedInputsDir: string
  launchctlStub: string
  launchctlLog: string
  launchctlStubSha256: string
  env: NodeJS.ProcessEnv
}

export interface ReleaseUpgradeCommandReceipt {
  stage: string
  argv: string[]
  cwd: string
  isolated_home: string
  isolated_codex_home: string
  isolated_npm_cache: string
  isolated_npm_prefix: string
  exit_code: number | null
  timed_out: boolean
  duration_ms: number
  stdout_sha256: string
  stderr_sha256: string
  stdout_tail: string
  stderr_tail: string
  json_schema: string | null
  json_ok: boolean | null
  report_file: {
    validation_mode: 'strict_report_file' | 'pinned_baseline_stdout_only'
    path: string
    real_path: string | null
    inside_sandbox: boolean
    regular_file: boolean
    symlink_refused: boolean
    sha256: string | null
    json_sha256: string | null
    stdout_json_sha256: string | null
    matches_stdout: boolean
    schema: string | null
    ok: boolean | null
    root: string | null
    expected_package_version: string
  } | null
}

export interface ReleaseUpgradeState {
  status: 'pending' | 'passed' | 'failed' | 'skipped'
  expected_version: string | null
  observed_version: string | null
  command_stages: string[]
  blockers: string[]
}

export interface ReleaseUpgradeStates {
  baseline_package: ReleaseUpgradeState
  baseline_menubar: ReleaseUpgradeState
  target_package: ReleaseUpgradeState
  target_menubar: ReleaseUpgradeState
  menubar_rollback: ReleaseUpgradeState
  target_menubar_reinstall: ReleaseUpgradeState
  package_rollback: ReleaseUpgradeState
}

export interface ReleaseUpgradeLifecycleResult {
  commands: ReleaseUpgradeCommandReceipt[]
  states: ReleaseUpgradeStates
  blockers: string[]
}

export interface ReleaseUpgradeSmokeReport {
  schema: typeof RELEASE_UPGRADE_SMOKE_SCHEMA
  ok: boolean
  started_at: string
  generated_at: string
  platform: NodeJS.Platform
  baseline_version: string
  target_version: string
  root: string
  source_tree: {
    ok: boolean
    git_root: string | null
    head: string | null
    status_sha256: string | null
    dirty_entries: string[]
    blockers: string[]
  }
  target: {
    receipt_path: string | null
    receipt_sha256: string | null
    tarball_path: string | null
    tarball_sha256: string | null
    tarball_sha512_integrity: string | null
    sealed_tarball_path: string | null
    package_version: string | null
    source_commit: string | null
    receipt_source_commit: string | null
    npm_pack_proof: {
      proof_id: string | null
      info_sha256: string | null
      file_list_sha256: string | null
    }
    binding_ok: boolean
  }
  baseline: {
    source: 'registry' | 'provided'
    spec: string
    pinned_sha256: string
    tarball_path: string | null
    tarball_sha256: string | null
    sealed_tarball_path: string | null
    sha512_integrity: string | null
    registry_shasum: string | null
    inspection_warnings: string[]
  }
  isolation: {
    sandbox: string | null
    home: string | null
    codex_home: string | null
    npm_cache: string | null
    npm_prefix: string | null
    npm_userconfig: string | null
    workspace: string | null
    baseline_pack_dir: string | null
    command_reports_dir: string | null
    sealed_inputs_dir: string | null
    host_home_reused: boolean
    host_codex_home_reused: boolean
    host_npm_prefix_reused: boolean
    retained: boolean
    removed_after_success: boolean
    cleanup_status: 'not_created' | 'retained_on_failure' | 'retained_by_request' | 'removed' | 'remove_failed' | 'partial_creation_removed' | 'partial_creation_remove_failed'
    cleanup_error: string | null
  }
  menubar_launch_policy: {
    applicable: boolean
    launch_skipped: true
    proof_scope: 'bundle_install_status_rollback_only'
    separate_real_launch_proof_required: true
  }
  install_safety_policy: {
    host_process_mutation_allowed: false
    host_session_mutation_allowed: false
    postinstall_network_allowed: false
    postinstall_skip_env: string[]
    launchctl_stub_path: string | null
    launchctl_stub_sha256: string | null
    launchctl_log_path: string | null
    launchctl_calls: string[]
    launchctl_unexpected_calls: string[]
    real_launchctl_allowed: false
  }
  commands: ReleaseUpgradeCommandReceipt[]
  states: ReleaseUpgradeStates
  blockers: string[]
}

export interface PreparedTarget {
  receipt: ReleasePackReceipt
  receiptPath: string
  receiptSha256: string
  tarball: string
  sha256: string
}

export interface PreparedBaseline {
  source: 'registry' | 'provided'
  tarball: string
  sha256: string
  sha512Integrity: string
  registryShasum: string | null
  inspectionWarnings: string[]
}

export interface ReleaseUpgradeLifecycleInput {
  targetVersion: string
  targetTarball: string
  targetSha256: string
  baselineTarball: string
  baselineSha256: string
  isolation: ReleaseUpgradeIsolation
  platform: NodeJS.Platform
  npmCommand: string
}

export interface ReleaseUpgradeSmokeDependencies {
  runner?: ReleaseUpgradeCommandRunner
  platform?: NodeJS.Platform
  tmpRoot?: string
  npmCommand?: string
  now?: () => Date
  removeSandbox?: (sandbox: string) => Promise<void>
}

export interface ReleaseUpgradeIsolationCreationHooks {
  afterSandboxCreated?: (sandbox: string) => Promise<void>
  removeSandbox?: (sandbox: string) => Promise<void>
}
