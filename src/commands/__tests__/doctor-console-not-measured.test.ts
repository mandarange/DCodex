import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCTOR_CONSOLE_NOT_MEASURED, renderDoctorConsoleReport } from '../doctor-console.js';

const NOT_MEASURED = DOCTOR_CONSOLE_NOT_MEASURED;

function row(lines: string[], prefix: string): string {
  const matches = lines.filter((line) => line.startsWith(prefix));
  assert.equal(matches.length, 1, `expected exactly one row starting with ${JSON.stringify(prefix)}, got ${JSON.stringify(matches)}`);
  return matches[0]!;
}

/** The composed result shape a default `sks doctor --fix` run produces: the deep Codex App/harness measurements are deliberately skipped. */
function skippedProfileResult(): any {
  return {
    ok: true,
    root: '/tmp/example-project',
    arg_warnings: [],
    official_subagent_config: { warnings: [] },
    node: { ok: true, version: 'v24.0.2' },
    codex: { bin: '/opt/homebrew/bin/codex', version: '0.145.0', available: true },
    oauth_callback_port_diagnostic: { conflict: false, listeners: [], warnings: [] },
    codex_config: { checks: [] },
    ready: {
      ready: true,
      cli_ready: true,
      mad_ready: true,
      managed_state_current: true,
      core_ready: true,
      center_ready: true,
      center_attempted: false,
      codex_config_readable_by_node: true,
      codex_config_readable_by_codex_cli: true,
      codex_app_ready: false,
      next_actions: []
    },
    context7_repair: { ok: true, preferred_transport: 'remote', actions: [], warnings: [] },
    codex_startup_repair: { ok: true, actions: [], manual_actions: [], warnings: [] },
    codex_config_syntax_repair: null,
    codex_doctor: null,
    rust: { available: true, mode: 'rust_accelerated', version: '1.0.0' },
    codex_app: { ok: false, skipped: true, warnings: ['codex_app_optional_diagnostic_skipped'] },
    runtime_readiness: {
      codex_native: 'ok',
      loop_mesh: 'fallback',
      qa_visual: 'route-gated',
      research_sources: 'local-files',
      image_followup: 'artifact-path',
      notes: ['message-role fallback active'],
      repair_actions: ['Project memory: sks codex-native init-deep --apply --directory-local']
    },
    codex_native_feature_matrix: { ok: true, skipped: true, features: {} },
    command_aliases: { ok: true, status: 'clean', canonical_command_count: 12 },
    codex_app_harness_matrix: { ok: true, skipped: true, app_features: {}, sks_integrations: {} },
    codex_app_ui: { fast_selector: 'fast_selected', provider_selector: 'ok', host_owned_config: 'ok', actions: [] },
    sks_menubar: { ok: true, status: 'ok', blockers: [], warnings: [] },
    doctor_fix_transaction: null,
    provider_context: { provider: 'codex-lb', service_tier: 'fast', source: 'bridge', confidence: 'high' },
    imagegen: { auth_readiness: null },
    imagegen_repair: { ok: true, skipped: true, manual_actions: [] },
    codex_current_app: { doctor: { ok: true, skipped: true }, plugin_app_template_policy: null },
    desktop_bridge: { ok: true, status: { readiness: { state: 'ready' } }, providers: {}, warnings: [], blockers: [] },
    codex_permission_profiles: { codex_config_profile_field: 'profile', codex_permission_profile_field: 'permission_profile' },
    repair: {
      doctor_native_capability: {
        ok: true,
        core_skills: { restored: [], blockers: [] },
        skill_dedupe: { actions: [], blockers: [] },
        native_capabilities: { ok: true, skipped: true, capabilities: [] },
        secret_preservation_guard: '.sneakoscope/reports/secret-preservation-guard.json'
      },
      computer_use: { ok: true, skipped: true, attempted: false, recovered: false, next_actions: [] },
      browser_use: { ok: true, skipped: true, attempted: false, recovered: false, next_actions: [] },
      mcp_transport_collision: null,
      codex_config: null,
      migration_journal: null,
      sks_update: null,
      global_sks_installs: null
    }
  };
}

function skippedProfileExtras(): any {
  return {
    oauthCallbackOperatorActions: [],
    nativeCapabilityReadiness: { imagegen: { status: 'deferred_to_explicit_native_capability_probe' } },
    agentBridgeManifestExists: true,
    codexCurrentAppCapability: { skipped: true, report: null },
    pluginInventory: { skipped: true, report: null, artifact: null },
    rootIsHome: false
  };
}

test('every console row fed by a skipped source says not-measured, never a failure spelling', () => {
  const lines = renderDoctorConsoleReport(skippedProfileResult(), skippedProfileExtras());

  // The customer-visible rows from the field report.
  assert.equal(row(lines, '  plugins: '), `  plugins: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  skills: '), `  skills: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  agent roles: '), `  agent roles: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  init-deep memory: '), `  init-deep memory: ${NOT_MEASURED}`);
  assert.equal(row(lines, 'Codex App: '), `Codex App: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  codex doctor:    '), `  codex doctor:    ${NOT_MEASURED}`);

  // The rest of the sweep: every other row fed by a skipped source.
  assert.equal(row(lines, '  hook approval: '), `  hook approval: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  native agent_type: '), `  native agent_type: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  loop mesh app profile: '), `  loop mesh app profile: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  Codex Native: '), `  Codex Native: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  Loop Mesh: '), `  Loop Mesh: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  image generation: '), `  image generation: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  computer use: '), `  computer use: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  app handoff: '), `  app handoff: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  multi-agent mode: '), `  multi-agent mode: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  /app handoff: '), `  /app handoff: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  plugin JSON: '), `  plugin JSON: ${NOT_MEASURED}`);
  assert.equal(row(lines, 'Codex plugins: '), `Codex plugins: ${NOT_MEASURED}`);
  assert.equal(row(lines, '  Remote MCP servers: '), `  Remote MCP servers: ${NOT_MEASURED}`);
  assert.equal(row(lines, 'Image Gen repair: '), `Image Gen repair: ${NOT_MEASURED}`);
  assert.equal(row(lines, 'Computer Use repair: '), `Computer Use repair: ${NOT_MEASURED}`);
  assert.equal(row(lines, 'Browser Use repair: '), `Browser Use repair: ${NOT_MEASURED}`);

  // A skipped source stub's defaults are not measurements: no notes or repair
  // guidance derived from them may print as if they were.
  assert.ok(!lines.some((line) => line.includes('message-role fallback active')), 'stub-derived notes must not print for a skipped matrix');
  assert.ok(!lines.some((line) => line.includes('init-deep --apply')), 'stub-derived repair actions must not print for a skipped matrix');

  // Join-level truth: with everything measured green and the deep checks
  // skipped, no failure spelling may appear anywhere in the report.
  for (const banned of [/degraded/, /optional_missing/, /unavailable/, /\bmissing\b/, /drift_detected/]) {
    assert.ok(!lines.some((line) => banned.test(line)), `no row may say ${banned} in a green skipped-profile report:\n${lines.filter((line) => banned.test(line)).join('\n')}`);
  }

  // Skipped is not success either: the verdict rows stay, but no skipped row claims ok.
  assert.equal(row(lines, '  ready:     '), '  ready:     yes');
});

test('a measured run still renders genuine failures as failures (control for the skip branch)', () => {
  const result = skippedProfileResult();
  result.codex_doctor = { available: false, disposition: 'warn', exit_code: 1 };
  result.codex_app = { ok: false };
  result.codex_native_feature_matrix = { ok: true, features: { multi_agent_mode: { ok: true } } };
  result.codex_app_harness_matrix = {
    ok: true,
    app_features: { plugin_json: false, hook_approval_state_detectable: true, agent_type_supported: true },
    sks_integrations: { dollar_skills_synced: true, agent_roles_synced: false, init_deep_available: true, loop_mesh_app_profile_available: true }
  };
  result.repair.doctor_native_capability.native_capabilities = { ok: true, capabilities: [] };
  result.repair.computer_use = { ok: false, attempted: true, recovered: false, next_actions: [] };
  result.repair.browser_use = { ok: true, attempted: false, recovered: false, next_actions: [] };
  result.imagegen_repair = { ok: true, manual_actions: [] };
  const extras = skippedProfileExtras();
  extras.codexCurrentAppCapability = { report: { supports_app_handoff: true } };
  extras.pluginInventory = { report: null };
  extras.nativeCapabilityReadiness = { imagegen: { status: 'ok' } };

  const lines = renderDoctorConsoleReport(result, extras);

  assert.equal(row(lines, '  plugins: '), '  plugins: degraded');
  assert.equal(row(lines, '  agent roles: '), '  agent roles: degraded');
  assert.equal(row(lines, '  skills: '), '  skills: ok');
  assert.equal(row(lines, '  init-deep memory: '), '  init-deep memory: available');
  assert.equal(row(lines, 'Codex App: '), 'Codex App: optional_missing');
  assert.equal(row(lines, '  codex doctor:    '), '  codex doctor:    unavailable');
  assert.equal(row(lines, '  multi-agent mode: '), '  multi-agent mode: verified');
  assert.equal(row(lines, '  rollout budget: '), '  rollout budget: unverified');
  assert.equal(row(lines, '  image generation: '), '  image generation: repair_required');
  assert.equal(row(lines, '  /app handoff: '), '  /app handoff: ok');
  assert.equal(row(lines, '  plugin JSON: '), '  plugin JSON: unavailable');
  assert.equal(row(lines, 'Codex plugins: '), 'Codex plugins: warning');
  assert.equal(row(lines, 'Image Gen repair: '), 'Image Gen repair: ok');
  assert.equal(row(lines, 'Computer Use repair: '), 'Computer Use repair: blocked');
  assert.equal(row(lines, 'Browser Use repair: '), 'Browser Use repair: not-needed');

  assert.ok(!lines.some((line) => line.includes(NOT_MEASURED)), 'a fully measured report must contain no not-measured rows');
});

test('the home-directory note prints only when the doctor root is the home directory', () => {
  const withNote = renderDoctorConsoleReport(skippedProfileResult(), { ...skippedProfileExtras(), rootIsHome: true });
  assert.ok(withNote.some((line) => line.includes('cd <your-project> && sks doctor')), 'home-rooted report must tell the user to run from a project');
  const withoutNote = renderDoctorConsoleReport(skippedProfileResult(), skippedProfileExtras());
  assert.ok(!withoutNote.some((line) => line.includes('cd <your-project>')));
});
