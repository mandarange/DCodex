import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../core/codex-compat/codex-runtime-contract.js';
import {
  DOCTOR_CONSOLE_NOT_MEASURED,
  doctorDedupeStatus, doctorSkillStatus,
  formatCodexDoctorConsoleStatus,
  nativeCapabilityStatus,
  sksMenuBarRunningVersionConsoleLines,
  uniqueNativeManualActions
} from './doctor-helpers.js';

export { DOCTOR_CONSOLE_NOT_MEASURED };

export interface DoctorConsoleExtras {
  oauthCallbackOperatorActions: string[];
  nativeCapabilityReadiness: any;
  agentBridgeManifestExists: boolean;
  /** Wrapper around the current-app capability artifacts; carries `skipped` (the report inside does not). */
  codexCurrentAppCapability: any;
  /** Wrapper around the plugin inventory artifacts; carries `skipped` (the report inside does not). */
  pluginInventory: any;
  rootIsHome?: boolean;
}

/**
 * Renders the human doctor report from the composed result object.
 *
 * Truthfulness rule: a source that says `skipped: true` (or a probe that was
 * never run) was NOT measured, and every console row derived from it must say
 * so — `not measured (run: sks doctor --full)` — never `degraded`, `missing`,
 * `optional_missing`, `unavailable`, and never a fake `ok` either. The default
 * `--fix` profile deliberately skips the deep Codex App/harness measurements;
 * rendering those skips as failures showed users a wall of red for work that
 * was intentionally never attempted. JSON output is unaffected: machine
 * consumers already read the stubs' own `skipped: true`.
 */
export function renderDoctorConsoleReport(result: any, extras: DoctorConsoleExtras): string[] {
  const lines: string[] = [];
  const line = (text: string) => lines.push(text);
  const skippedOr = (skipped: boolean, measured: string) => (skipped ? DOCTOR_CONSOLE_NOT_MEASURED : measured);

  const ready = result.ready || {};
  const codex = result.codex || {};
  const codexConfig = result.codex_config || {};
  const oauthDiagnostic = result.oauth_callback_port_diagnostic || { conflict: false, listeners: [], warnings: [] };
  const context7Repair = result.context7_repair || {};
  const codexStartupRepair = result.codex_startup_repair || {};
  const codexConfigSyntaxRepair = result.codex_config_syntax_repair;
  const rust = result.rust || {};
  const codexApp = result.codex_app || {};
  const runtimeReadiness = result.runtime_readiness || { notes: [], repair_actions: [] };
  const codexNativeFeatureMatrix = result.codex_native_feature_matrix || {};
  const repair = result.repair || {};
  const doctorNativeCapabilityRepair = repair.doctor_native_capability;
  const commandAliasCleanup = result.command_aliases || {};
  const codexAppHarnessMatrix = result.codex_app_harness_matrix || {};
  const codexAppUi = result.codex_app_ui || {};
  const sksMenuBar = result.sks_menubar || {};
  const providerContext = result.provider_context || {};
  const imagegen = result.imagegen || {};
  const imagegenRepair = result.imagegen_repair || {};
  const computerUseRepair = repair.computer_use || {};
  const browserUseRepair = repair.browser_use || {};
  const mcpTransportCollisionRepair = repair.mcp_transport_collision;
  const codexCurrentAppSection = result.codex_current_app || {};
  const codexCurrentAppDoctor = codexCurrentAppSection.doctor || {};
  const pluginPolicy = codexCurrentAppSection.plugin_app_template_policy;
  const desktopBridge = result.desktop_bridge || {};
  const permissionProfiles = result.codex_permission_profiles || {};
  const configRepair = repair.codex_config;
  const migrationJournal = repair.migration_journal;
  const sksUpdate = repair.sks_update;
  const globalSksInstallCleanup = repair.global_sks_installs;

  line('SKS Doctor');
  for (const warning of result.arg_warnings || []) line(`Argument warning: ${warning}`);
  for (const warning of result.official_subagent_config?.warnings || []) line(`Official subagent warning: ${warning}`);
  line(`Root:      ${result.root}`);
  if (extras.rootIsHome) {
    line('Note: this is your home directory, not a project — project rows below describe the home folder. Run from your project: cd <your-project> && sks doctor');
  }
  line(`Node:      ${result.node?.ok ? 'ok' : 'fail'} ${result.node?.version || ''}`);
  line(`Codex:     ${codex.bin ? 'ok' : 'missing'} ${codex.version || ''}`);
  if (oauthDiagnostic.conflict) {
    const listeners = (oauthDiagnostic.listeners || [])
      .map((listener: any) => `${listener.command} pid ${listener.pid} ${listener.address}`)
      .join(', ');
    line(`OAuth callback port 1455: warning (${listeners})`);
    for (const action of extras.oauthCallbackOperatorActions) line(`  action: ${action}`);
  }
  const actual = (codexConfig.checks || []).find((check: any) => check.name === 'actual_codex_cli_config_load');
  line('Project config:');
  line(`  node read:       ${ready.codex_config_readable_by_node ? 'ok' : 'failed'}`);
  line(`  codex cli read:  ${ready.codex_config_readable_by_codex_cli ? 'ok' : (actual?.status || 'failed')}`);
  line('Context7 MCP:');
  line(`  transport: ${context7Repair.preferred_transport || 'remote'}`);
  line(`  repair: ${context7Repair.ok ? 'ok' : 'blocked'}`);
  for (const action of context7Repair.actions || []) line(`  - ${action}`);
  for (const warning of context7Repair.warnings || []) line(`  warning: ${warning}`);
  line('Codex startup config:');
  line(`  repair: ${codexStartupRepair.ok ? 'ok' : 'blocked'}`);
  for (const action of codexStartupRepair.actions || []) line(`  - ${action}`);
  for (const action of codexStartupRepair.manual_actions || []) line(`  manual: ${action}`);
  for (const warning of codexStartupRepair.warnings || []) line(`  warning: ${warning}`);
  if (codexConfigSyntaxRepair) {
    line('Codex config syntax:');
    line(`  repair: ${codexConfigSyntaxRepair.ok ? 'ok' : 'blocked'}`);
    for (const action of codexConfigSyntaxRepair.actions || []) line(`  - ${action}`);
    for (const action of codexConfigSyntaxRepair.manual_actions || []) line(`  manual: ${action}`);
    for (const warning of codexConfigSyntaxRepair.warnings || []) line(`  warning: ${warning}`);
  }
  // A null bridge report means the probe was never run for this profile;
  // formatCodexDoctorConsoleStatus renders that as not-measured, and reserves
  // `unavailable` for a probe that ran and found the bridge unusable.
  line(`  codex doctor:    ${formatCodexDoctorConsoleStatus(result.codex_doctor)}`);
  line(`Rust acc.: ${rust.mode || (rust.available ? 'rust_accelerated' : 'js_fallback')} ${rust.version || rust.status || ''}`);
  line(`Codex App: ${codexApp.skipped === true ? DOCTOR_CONSOLE_NOT_MEASURED : ready.codex_app_ready ? 'ok' : 'optional_missing'}`);
  // The fallback feature matrix marks itself `skipped` when deep diagnostics
  // were deferred; its stub defaults are not measurements, so neither the
  // readiness rows nor the notes/repair actions derived from them may print
  // as if they were.
  const featureMatrixSkipped = codexNativeFeatureMatrix.skipped === true;
  line('SKS Runtime Readiness:');
  line(`  Codex Native: ${skippedOr(featureMatrixSkipped, String(runtimeReadiness.codex_native))}`);
  line(`  Loop Mesh: ${skippedOr(featureMatrixSkipped, String(runtimeReadiness.loop_mesh))}`);
  line(`  QA Visual: ${skippedOr(featureMatrixSkipped, String(runtimeReadiness.qa_visual))}`);
  line(`  Research Sources: ${skippedOr(featureMatrixSkipped, String(runtimeReadiness.research_sources))}`);
  line(`  Image Follow-up: ${skippedOr(featureMatrixSkipped, String(runtimeReadiness.image_followup))}`);
  if (!featureMatrixSkipped) {
    for (const note of runtimeReadiness.notes || []) line(`  ${note}`);
    if ((runtimeReadiness.repair_actions || []).length) {
      line('Repair actions:');
      for (const action of runtimeReadiness.repair_actions) line(`  - ${action}`);
    }
  }
  const nativeCapabilitySource = doctorNativeCapabilityRepair?.native_capabilities;
  const nativeCapabilitiesSkipped = nativeCapabilitySource?.skipped === true;
  const nativeCapabilityRows = Array.isArray(nativeCapabilitySource?.capabilities)
    ? nativeCapabilitySource.capabilities
    : [];
  const capabilityRow = (id: string, fallback: string) =>
    skippedOr(nativeCapabilitiesSkipped, nativeCapabilityStatus(nativeCapabilityRows, id, fallback));
  line('SKS Native Capabilities:');
  line(`  image generation: ${capabilityRow('image_generation', 'repair_required')}`);
  line(`  image follow-up edit: ${capabilityRow('image_followup_edit', 'degraded')}`);
  line(`  computer use: ${capabilityRow('computer_use', 'manual_required')}`);
  line(`  Chrome/web review: ${capabilityRow('chrome_web_review', 'manual_required')}`);
  line(`  app screenshot: ${capabilityRow('codex_app_screenshot', 'degraded')}`);
  line(`  app handoff: ${capabilityRow('app_handoff', 'unavailable')}`);
  line(`  image path exposure: ${capabilityRow('image_path_exposure', 'fallback')}`);
  const nativeManualActions = uniqueNativeManualActions(nativeCapabilityRows);
  if (nativeManualActions.length) {
    line('  manual next actions:');
    for (const action of nativeManualActions) line(`    - ${action}`);
  }
  line('SKS Skills:');
  line(`  core skills: ${doctorSkillStatus(doctorNativeCapabilityRepair?.core_skills)}`);
  line(`  duplicate project skills: ${doctorDedupeStatus(doctorNativeCapabilityRepair?.skill_dedupe)}`);
  line('SKS Current Command Surface:');
  line(`  status: ${commandAliasCleanup.status || (commandAliasCleanup.ok ? 'clean' : 'blocked')}`);
  line(`  canonical commands: ${commandAliasCleanup.canonical_command_count ?? 0}`);
  const managedRuntimeCleanup = commandAliasCleanup.cleanup?.managed_runtime;
  if (managedRuntimeCleanup) {
    line(`  managed items reconciled: ${managedRuntimeCleanup.removed_managed_artifact_count ?? 0}`);
    line(`  user-authored collisions preserved: ${managedRuntimeCleanup.preserved_user_file_count ?? 0}`);
  }
  if (commandAliasCleanup.report_path) line(`  report: ${commandAliasCleanup.report_path}`);
  line('Secret preservation:');
  line(`  Supabase keys: ${doctorNativeCapabilityRepair?.ok === false && String((doctorNativeCapabilityRepair?.blockers || []).join(' ')).includes('secret_preservation_failed') ? 'blocked' : 'preserved'}`);
  line('  raw secret values: never recorded');
  line(`  migration journal: ${doctorNativeCapabilityRepair?.secret_preservation_guard || '.sneakoscope/reports/secret-preservation-guard.json'}`);
  const harnessSkipped = codexAppHarnessMatrix.skipped === true;
  const appFeatures = codexAppHarnessMatrix.app_features || {};
  const sksIntegrations = codexAppHarnessMatrix.sks_integrations || {};
  line('Codex App Harness:');
  line(`  plugins: ${skippedOr(harnessSkipped, appFeatures.plugin_json ? 'ok' : 'degraded')}`);
  line(`  hook approval: ${skippedOr(harnessSkipped, appFeatures.hook_approval_state_detectable ? 'ok' : 'unknown')}`);
  line(`  skills: ${skippedOr(harnessSkipped, sksIntegrations.dollar_skills_synced ? 'ok' : 'degraded')}`);
  line(`  agent roles: ${skippedOr(harnessSkipped, sksIntegrations.agent_roles_synced ? 'ok' : 'degraded')}`);
  line(`  native agent_type: ${skippedOr(harnessSkipped, appFeatures.agent_type_supported ? 'ok' : 'fallback message-role')}`);
  line(`  init-deep memory: ${skippedOr(harnessSkipped, sksIntegrations.init_deep_available ? 'available' : 'missing')}`);
  line(`  loop mesh app profile: ${skippedOr(harnessSkipped, sksIntegrations.loop_mesh_app_profile_available ? 'available' : 'missing')}`);
  line('Codex App UI:');
  line(`  fast selector: ${codexAppUi.fast_selector || 'unknown'}`);
  line(`  provider selector: ${codexAppUi.provider_selector || 'unknown'}`);
  if (Array.isArray(codexAppUi.provider_blockers) && codexAppUi.provider_blockers.length) {
    line(`  provider blockers: ${codexAppUi.provider_blockers.join(', ')}`);
  }
  if (Array.isArray(codexAppUi.provider_actions) && codexAppUi.provider_actions.length) {
    line('  provider actions:');
    for (const action of codexAppUi.provider_actions) line(`    - ${action}`);
  }
  line(`  host-owned config: ${codexAppUi.host_owned_config || 'unknown'}`);
  if (Array.isArray(codexAppUi.actions) && codexAppUi.actions.some((action: any) => action.changed)) {
    line('  repaired files:');
    for (const action of codexAppUi.actions.filter((entry: any) => entry.changed)) line(`    - ${action.file}${action.backup_path ? ` (backup ${action.backup_path})` : ''}`);
  }
  if (codexAppUi.next_action) line(`  next action: ${codexAppUi.next_action}`);
  line('SKS Menu Bar:');
  line(`  status: ${sksMenuBar.status || (sksMenuBar.ok ? 'ok' : 'blocked')}`);
  for (const versionLine of sksMenuBarRunningVersionConsoleLines(sksMenuBar)) line(versionLine);
  const menubarPhase = result.doctor_fix_transaction?.phases?.find((phase: any) => phase?.id === 'sks_menubar');
  if (menubarPhase) {
    const menubarSummary = menubarPhase.ok
      ? (menubarPhase.repaired ? 'repaired' : 'verified')
      : `blocked(${(menubarPhase.blockers || []).join(', ') || 'unknown'})`;
    line(`  menubar: ${menubarSummary}`);
  }
  if (sksMenuBar.app_path) line(`  app: ${sksMenuBar.app_path}`);
  if (sksMenuBar.launch_agent_path) line(`  launch agent: ${sksMenuBar.launch_agent_path}`);
  if (Array.isArray(sksMenuBar.blockers) && sksMenuBar.blockers.length) line(`  blockers: ${sksMenuBar.blockers.join(', ')}`);
  if (Array.isArray(sksMenuBar.warnings) && sksMenuBar.warnings.length) line(`  warnings: ${sksMenuBar.warnings.join(', ')}`);
  line(`Provider: ${providerContext.provider || 'unknown'} ${providerContext.service_tier || ''} (${providerContext.source || 'unknown'}, ${providerContext.confidence || 'low'})`);
  const imagegenReady = imagegen.auth_readiness;
  if (imagegenReady) {
    const paths = imagegenReady.available_paths?.length ? imagegenReady.available_paths.join(', ') : 'none';
    line(`Image Gen: auth=${imagegenReady.auth_mode} | headless_auto=${imagegenReady.headless_auto_available ? 'available' : 'unavailable'} | paths: ${paths}`);
    if (!imagegenReady.headless_auto_available) {
      for (const action of imagegenReady.next_actions || []) line(`  - ${action}`);
    }
  }
  line(`Image Gen repair: ${skippedOr(imagegenRepair.skipped === true, String(extras.nativeCapabilityReadiness?.imagegen?.status))}`);
  for (const action of imagegenRepair.manual_actions || []) line(`  - ${action}`);
  line(`Computer Use repair: ${skippedOr(computerUseRepair.skipped === true, computerUseRepair.recovered ? 'ok' : computerUseRepair.attempted ? 'blocked' : 'not-needed')}`);
  for (const action of computerUseRepair.next_actions || []) line(`  - ${action}`);
  line(`Browser Use repair: ${skippedOr(browserUseRepair.skipped === true, browserUseRepair.recovered ? 'ok' : browserUseRepair.attempted ? 'blocked' : 'not-needed')}`);
  for (const action of browserUseRepair.next_actions || []) line(`  - ${action}`);
  if (mcpTransportCollisionRepair) {
    const collisionCount = (mcpTransportCollisionRepair.servers || []).filter((server: any) => server.status === 'collision_resolved').length;
    line(`MCP transport collision repair: ${mcpTransportCollisionRepair.ok ? 'ok' : 'blocked'}${collisionCount ? ` (${collisionCount} resolved)` : ''}`);
  }
  line(`Agent bridge: ${extras.agentBridgeManifestExists ? 'manifest present' : 'not set up'}${extras.agentBridgeManifestExists ? '' : ' — run `sks agent-bridge setup` to publish the manifest and register with an MCP host'}`);
  const codexCurrentApp = extras.codexCurrentAppCapability?.report || {};
  const currentAppSkipped = extras.codexCurrentAppCapability?.skipped === true;
  line('Codex current compatibility:');
  line(`  target: ${CURRENT_CODEX_RUNTIME_CONTRACT.targetTag}`);
  line(`  runtime: ${codex.version || 'unknown'}`);
  line(`  multi-agent mode: ${skippedOr(featureMatrixSkipped, codexNativeFeatureMatrix.features?.multi_agent_mode?.ok ? 'verified' : 'unverified')}`);
  line(`  rollout budget: ${skippedOr(featureMatrixSkipped, codexNativeFeatureMatrix.features?.rollout_budget?.ok ? 'verified' : 'unverified')}`);
  line(`  indexed search: ${skippedOr(featureMatrixSkipped, codexNativeFeatureMatrix.features?.indexed_web_search?.ok ? 'verified' : 'unverified')}`);
  line(`  current time: ${skippedOr(featureMatrixSkipped, codexNativeFeatureMatrix.features?.current_time_read?.ok ? 'verified' : 'unverified')}`);
  line('Current Codex app features:');
  line(`  /app handoff: ${skippedOr(currentAppSkipped, codexCurrentApp.supports_app_handoff ? 'ok' : 'unavailable')}`);
  line(`  plugin JSON: ${skippedOr(currentAppSkipped, codexCurrentApp.supports_plugin_json ? 'ok' : 'unavailable')}`);
  line(`  image path exposure: ${skippedOr(currentAppSkipped, codexCurrentApp.supports_image_path_exposure ? 'ok' : 'unavailable')}`);
  line(`  OAuth MCP pre-refresh: ${skippedOr(currentAppSkipped, codexCurrentApp.supports_oauth_mcp_prerefresh ? 'ok' : 'unavailable')}`);
  const pluginInventorySkipped = extras.pluginInventory?.skipped === true;
  const pluginReport = extras.pluginInventory?.report;
  const plugins = pluginReport?.plugins || [];
  const remoteMcpCount = plugins.flatMap((plugin: any) => plugin.remote_mcp_servers || []).length;
  const unavailableTemplates = pluginPolicy?.unavailable_app_templates?.length || 0;
  line(`Codex plugins: ${skippedOr(pluginInventorySkipped, pluginReport ? 'ok' : 'warning')}`);
  line(`  Remote MCP servers: ${pluginInventorySkipped ? DOCTOR_CONSOLE_NOT_MEASURED : `${remoteMcpCount} candidates`}`);
  line(`  Unavailable app templates: ${pluginInventorySkipped ? DOCTOR_CONSOLE_NOT_MEASURED : unavailableTemplates}`);
  for (const warning of pluginPolicy?.doctor_warnings || []) line(`  warning: ${warning}`);
  if (codexCurrentAppDoctor.fixed?.length) line(`  doctor --fix repaired: ${codexCurrentAppDoctor.fixed.join(', ')}`);
  line(`Desktop Bridge: ${desktopBridge.ok ? 'ready' : 'blocked'} (${desktopBridge.status?.readiness?.state || 'unavailable'})`);
  for (const providerId of ['codex-lb', 'openrouter']) {
    const provider = desktopBridge.providers?.[providerId];
    if (!provider) continue;
    line(`  ${providerId}: ${provider.enabled ? 'enabled' : 'disabled'}; credential ${provider.credential?.state || 'unknown'} (${provider.credential?.source || 'none'}); endpoint ${provider.endpoint?.configured ? 'configured' : 'missing'}`);
  }
  for (const warning of desktopBridge.warnings || []) line(`  warning: ${warning}`);
  for (const blocker of desktopBridge.blockers || []) line(`  blocker: ${blocker}`);
  if (!desktopBridge.ok) for (const action of desktopBridge.recovery_actions || []) line(`  action: ${action}`);
  line(`Permissions: config profile and permission profile are tracked separately (${permissionProfiles.codex_config_profile_field}, ${permissionProfiles.codex_permission_profile_field})`);
  line('Ready:');
  line(`  cli_ready: ${ready.cli_ready ? 'yes' : 'no'}`);
  line(`  mad_ready: ${ready.mad_ready ? 'yes' : 'no'}`);
  line(`  managed_state_current: ${ready.managed_state_current ? 'yes' : 'no'}`);
  line(`  core_ready: ${ready.core_ready ? 'yes' : 'no'}`);
  line(`  center_ready: ${ready.center_ready ? 'yes' : 'no'}${ready.center_attempted ? ' (repair attempted)' : ' (not attempted)'}`);
  line(`  ready:     ${ready.ready ? 'yes' : 'no'}`);
  if (!ready.ready) {
    line('Primary blocker:');
    line(`  ${ready.primary_blocker || 'unknown'}`);
  }
  if (configRepair?.repair_actions?.length) {
    line('What I fixed:');
    for (const action of configRepair.repair_actions) line(`  - ${action.name}: ${action.ok ? 'ok' : 'failed'}`);
  }
  if (migrationJournal?.journal_path) {
    line(`Migration journal: ${migrationJournal.journal_path} (${migrationJournal.event_count} events, ${migrationJournal.mutations_without_rollback} without rollback)`);
  }
  if (sksUpdate) {
    line(`SKS update: ${sksUpdate.status}${sksUpdate.latest ? ` latest ${sksUpdate.latest}` : ''}${sksUpdate.error ? ` (${sksUpdate.error})` : ''}`);
  }
  if (globalSksInstallCleanup) {
    line(`Global SKS installs: kept ${globalSksInstallCleanup.kept?.length ?? 0}, removed ${globalSksInstallCleanup.removed?.filter((entry: any) => entry.ok).length ?? 0}, source repo exempt ${globalSksInstallCleanup.candidates?.filter((entry: any) => entry.source_repo_exempt).length ?? 0}`);
    if (globalSksInstallCleanup.npm_cache) line(`NPM cache cleanup: ${globalSksInstallCleanup.npm_cache.status}`);
  }
  if (!ready.ready && ready.next_actions?.length) {
    line('What still needs you:');
    for (const action of ready.next_actions) line(`  - ${action}`);
  }
  return lines;
}
