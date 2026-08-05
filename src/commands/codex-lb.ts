import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { projectRoot, readStdin, readText } from '../core/fsx.js';
import { flag, readOption } from '../cli/args.js';
import { printJson } from '../cli/output.js';
import { printCodexLbSetupWarnings } from '../cli/codex-lb-setup-warning-output.js';
import { testCodexLbConnection } from '../cli/install-helpers-codex-lb-chain.js';
import { codexLbMetrics, readCodexLbCircuit, recordCodexLbHealthEvent, resetCodexLbCircuit, codexLbProofEvidence } from '../core/codex-lb-circuit.js';
import {
  checkCodexLbResponseChain,
  codexLbStatus,
  configureCodexLb,
  repairCodexLbAuth
} from '../cli/install-helpers.js';
import { buildCodexLbSetupPlan, renderCodexLbSetupPlan } from '../core/codex-lb/codex-lb-setup.js';
import {
  CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_FLAG,
  codexLbToolOutputRecoveryOverrideAcknowledged
} from '../core/codex-lb/codex-lb-tool-output-recovery.js';
import { loadCodexLbEnv } from '../core/codex-lb/codex-lb-env.js';
import {
  activateCodexLbDesktopMode,
  buildCodexLbDesktopCapabilities,
  codexLbDesktopStatusV2,
  configureCodexLbCliMode,
  disableCodexLbDesktopRouting,
  migrateLegacyCodexLbDesktopMode,
  readCodexLbDesktopDeepEvidence,
  readCodexLbDesktopDeepEvidenceTrustAnchors,
  rollbackCodexLbDesktopMode,
  type CodexLbDesktopControllerOptions
} from '../core/codex-lb/desktop-controller.js';
import { serveDesktopBridge } from '../core/codex-lb/desktop-service.js';
import {
  parseCodexLbGatewayAuthTransport,
  type CodexLbDesktopMode,
  type CodexLbGatewayAuthTransport
} from '../core/codex-lb/desktop-mode.js';
import type {
  CapabilityProbeLevel,
  CodexLbDesktopCapabilityReport
} from '../core/codex-lb/capability-types.js';
import {
  codexLbRoutingTruthIsActive,
  measureAndWriteCodexLbRoutingTruth
} from '../core/codex-lb/routing-truth.js';

export async function run(command: any, args: any = []) {
  const root = await projectRoot();
  const action = args[0] || 'status';
  if (action === 'metrics') {
    const result = codexLbMetrics(await readCodexLbCircuit(root));
    if (flag(args, '--json')) return printJson(result);
    console.log(`codex-lb circuit: ${result.circuit.state}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'status' || action === 'check') {
    const options = controllerOptions(args);
    options.networkProbes = action === 'check'
      || flag(args, '--deep')
      || flag(args, '--fix')
      || flag(args, '--remeasure');
    const result = await codexLbDesktopStatusV2(options);
    if (result.ok !== true) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    process.stdout.write(formatCodexLbDesktopStatusText(result));
    return;
  }
  if (action === 'doctor') {
    const status = await codexLbDesktopStatusV2(controllerOptions(args));
    const metrics = codexLbMetrics(await readCodexLbCircuit(root));
    const result = buildCodexLbDoctorResult(status, metrics, flag(args, '--deep'));
    if (flag(args, '--json')) return printJson(result);
    console.log(`codex-lb doctor: ${result.ok ? 'diagnostic_ok' : 'blocked'}; full capability: ${result.full_capability_verified ? 'verified' : 'unverified'}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'connect-test') {
    const options = controllerOptions(args);
    const status = await codexLbStatus(options);
    const modelSelection = await resolveCodexLbHealthModel(status);
    const loadedEnv = await loadCodexLbEnv({
      home: options.home || path.dirname(path.dirname(status.env_path)),
      envPath: options.envPath || status.env_path,
      ...(options.metadataPath ? { metadataPath: options.metadataPath } : {})
    });
    const result = await testCodexLbConnection(status, {
      requireSelected: true,
      model: modelSelection.model,
      baseUrl: loadedEnv.base_url,
      apiKey: loadedEnv.secret_api_key,
      credentialBindingBlockers: loadedEnv.credential_binding.blockers,
      gatewayAuthTransport: options.gatewayAuthTransport
        || (directGatewayProbeTransport(status, loadedEnv) === 'x-codex-lb-api-key'
          ? 'x-codex-lb-api-key'
          : 'authorization-bearer-compat')
    });
    if (!result.ok) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(result.ok
      ? `codex-lb connect test: ok (${result.model}, ${result.latency_ms}ms): ${result.result || ''}`
      : `codex-lb connect test: failed (${result.status})`);
    return;
  }
  if (action === 'health' || action === 'verify-chain' || action === 'chain') {
    const allowUnverifiedToolOutputRecovery = codexLbToolOutputRecoveryOverrideAcknowledged({ args });
    const status = await codexLbStatus({ probeToolOutputRecovery: true, allowUnverifiedToolOutputRecovery });
    const modelSelection = await resolveCodexLbHealthModel(status);
    const loadedEnv = await loadCodexLbEnv({ home: path.dirname(path.dirname(status.env_path)), envPath: status.env_path });
    const bindingBlocker = loadedEnv.credential_binding.blockers[0] || null;
    const providerUrlMismatch = status.provider_configured === true && status.provider_base_url_matches_credential !== true;
    const blocker = bindingBlocker
      || (providerUrlMismatch ? 'provider_base_url_mismatch' : null)
      || (!status.env_key_configured
      ? 'missing_env_key'
      : !status.base_url
        ? 'missing_base_url'
        : !modelSelection.model
          ? 'model_unselected'
          : 'not_configured');
    const chain = status.selected && status.tool_output_recovery?.ok !== true
      ? { ok: false, status: 'tool_output_recovery_blocked', codex_lb: status, tool_output_recovery: status.tool_output_recovery }
      : !bindingBlocker && !providerUrlMismatch && status.env_key_configured && loadedEnv.base_url && loadedEnv.secret_api_key && modelSelection.model
        ? await checkCodexLbResponseChain(status, {
            force: true,
            root,
            fastMode: flag(args, '--fast') || flag(args, '--priority'),
            model: modelSelection.model,
            baseUrl: loadedEnv.base_url,
            apiKey: loadedEnv.secret_api_key
          })
        : { ok: false, status: blocker, codex_lb: status };
    const routingTruth = await measureAndWriteCodexLbRoutingTruth({
      selected: status.selected === true,
      baseUrl: loadedEnv.base_url,
      apiKey: loadedEnv.secret_api_key,
      authTransport: directGatewayProbeTransport(status, loadedEnv)
    }, {
      home: path.dirname(path.dirname(status.env_path))
    });
    const result = {
      ...chain,
      ok: chain.ok === true && routingTruth.ok,
      codex_lb: status,
      model_selection: modelSelection,
      routing_truth: routingTruth
    };
    if (!result.ok) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(`codex-lb response chain: ${result.ok ? 'ok' : `failed (${result.status})`}`);
    return;
  }
  if (action === 'fast-check' || action === 'fast' || action === 'verify-fast') {
    const allowUnverifiedToolOutputRecovery = codexLbToolOutputRecoveryOverrideAcknowledged({ args });
    const status = await codexLbStatus({ probeToolOutputRecovery: true, allowUnverifiedToolOutputRecovery });
    const loadedEnv = await loadCodexLbEnv({ home: path.dirname(path.dirname(status.env_path)), envPath: status.env_path });
    const bindingBlocker = loadedEnv.credential_binding.blockers[0] || null;
    const providerUrlMismatch = status.provider_configured === true && status.provider_base_url_matches_credential !== true;
    const blocker = bindingBlocker || (providerUrlMismatch ? 'provider_base_url_mismatch' : null)
      || (!status.env_key_configured ? 'missing_env_key' : !status.base_url ? 'missing_base_url' : !status.provider_contract_ok ? 'provider_contract_drift' : 'not_configured');
    const modelSelection = await resolveCodexLbFastCheckModel(status);
    const chain = status.selected && status.tool_output_recovery?.ok !== true
      ? { ok: false, status: 'tool_output_recovery_blocked', codex_lb: status, tool_output_recovery: status.tool_output_recovery }
      : !bindingBlocker && !providerUrlMismatch && status.env_key_configured && loadedEnv.base_url && loadedEnv.secret_api_key && modelSelection.model
      ? await checkCodexLbResponseChain(status, { force: true, cache: false, root, fastMode: true, model: modelSelection.model, baseUrl: loadedEnv.base_url, apiKey: loadedEnv.secret_api_key })
      : { ok: false, status: modelSelection.model ? blocker : 'model_unselected', codex_lb: status };
    const evidence = await fastEvidenceFromChain(chain, readOption(args, '--request-log', readOption(args, '--request-log-json', null)));
    const providerReady = status.provider_contract_ok === true;
    const chainVerified = isCodexLbFastChainVerified(chain);
    const routingTruth = await measureAndWriteCodexLbRoutingTruth({
      selected: status.selected === true,
      baseUrl: loadedEnv.base_url,
      apiKey: loadedEnv.secret_api_key,
      authTransport: directGatewayProbeTransport(status, loadedEnv)
    }, {
      home: path.dirname(path.dirname(status.env_path))
    });
    const result = {
      schema: 'sks.codex-lb-fast-check.v1',
      ok: Boolean(providerReady && chainVerified && routingTruth.ok && evidence.fast_requested && evidence.fast_actual),
      status: !providerReady
        ? 'provider_contract_drift'
        : chain.skipped === true
          ? 'fast_check_chain_skipped'
        : chainVerified
        ? evidence.fast_actual
          ? 'fast_verified'
          : evidence.fast_requested
            ? 'fast_requested_but_actual_unverified'
            : 'fast_not_requested'
        : chain.status,
      codex_lb: status,
      model_selection: modelSelection,
      chain,
      routing_truth: routingTruth,
      evidence,
      degraded_models: Array.isArray((chain as any).degraded_models) ? (chain as any).degraded_models : [],
      quota_low: Boolean((chain as any).quota_low),
      blockers: [
        ...(providerReady ? [] : ['codex_lb_provider_contract_drift']),
        ...routingTruth.blockers,
        ...modelSelection.blockers,
        ...(chain.skipped === true
          ? ['codex_lb_fast_check_chain_skipped']
          : chainVerified
          ? evidence.fast_actual
            ? []
            : [evidence.fast_requested ? 'codex_lb_actual_fast_service_tier_unverified' : 'codex_lb_fast_service_tier_not_requested']
          : [chain.status || blocker])
      ]
    };
    if (flag(args, '--json')) return printJson(result);
    console.log(`codex-lb fast check: ${result.ok ? 'ok' : `blocked (${result.status})`}`);
    if (!result.ok) {
      console.log('Need codex-lb request evidence: requestedServiceTier=priority and actualServiceTier/serviceTier=priority.');
      process.exitCode = 1;
    }
    return;
  }
  if (action === 'repair' || action === 'resync' || action === 'login') {
    const result = await repairCodexLbAuth(controllerOptions(args));
    if (result.ok !== true) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(`codex-lb repair: ${result.ok === true ? 'ok' : String(result.status || 'failed')}`);
    return;
  }
  if (action === 'set-key' || action === 'update-key' || action === 'rotate-key') {
    const current = await codexLbDesktopStatusV2(controllerOptions(args));
    const loaded = await loadCodexLbEnv();
    const host = loaded.base_url;
    if (!host) {
      const result = { schema: 'sks.codex-lb-set-key.v1', ok: false, status: 'not_configured' };
      if (flag(args, '--json')) {
        process.exitCode = 1;
        return printJson(result);
      }
      console.error('codex-lb is not configured yet. Run: sks codex-lb setup --host <domain> --api-key-stdin');
      process.exitCode = 1;
      return;
    }
    const newKey = await resolveNewApiKey(args);
    if (!newKey) {
      const result = { schema: 'sks.codex-lb-set-key.v1', ok: false, status: 'missing_api_key' };
      if (flag(args, '--json')) {
        process.exitCode = 1;
        return printJson(result);
      }
      console.error('No new API key provided. Run: sks codex-lb set-key --api-key-stdin');
      process.exitCode = 1;
      return;
    }
    const result = await configureCodexLb({
      host,
      apiKey: newKey,
      keychain: false,
      storeKeychain: false,
      writeEnvFile: true,
      syncLaunchctl: true,
      desktopMode: 'cli-provider',
      useDefaultProvider: current.mode === 'cli-provider' && current.routing_active === true,
      allowUnverifiedToolOutputRecovery: codexLbToolOutputRecoveryOverrideAcknowledged({ args })
    });
    let routing: Record<string, unknown> | null = null;
    const restartRequested = flag(args, '--restart-app') || flag(args, '--restart')
      || current.mode === 'desktop-native-bridge';
    if (result.ok && current.mode === 'desktop-native-bridge') {
      routing = await activateCodexLbDesktopMode({
        ...controllerOptions(args),
        mode: 'desktop-native-bridge',
        restartApp: restartRequested
      });
    }
    const ok = Boolean(result.ok && routing?.ok !== false);
    const output = {
      ...result,
      schema: 'sks.codex-lb-set-key.v2',
      ok,
      action: 'set-key',
      provider_ready: result.ok === true,
      routing_active: Boolean(
        result.ok
        && (
          (current.mode === 'desktop-native-bridge' && routing?.ok !== false)
          || (current.mode === 'cli-provider' && (result as any).codex_lb?.selected === true)
        )
      ),
      activation_required: Boolean(
        result.ok
        && current.mode !== 'desktop-native-bridge'
        && current.mode !== 'desktop-dual-auth-compat'
      ),
      desktop_auth_mutated: false,
      fast_mode_mutated: false,
      desktop_routing: routing,
      center_credentials: routing?.center_credentials || null
    };
    if (!ok) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(output);
    console.log(result.ok ? `codex-lb API key updated (${result.base_url || host}).` : `codex-lb key update failed: ${result.status}${result.error ? `: ${result.error}` : ''}`);
    printCodexLbSetupWarnings(result);
    if (!ok) process.exitCode = 1;
    return;
  }
  if (
    action === 'use-desktop-full'
    || action === 'use-codex-lb'
    || action === 'use-lb'
  ) {
    if (action !== 'use-desktop-full') {
      printDeprecationWarning(action, 'sks codex-lb use-desktop-full');
    }
    const result = await activateCodexLbDesktopMode({
      ...controllerOptions(args),
      mode: 'desktop-native-bridge'
    });
    if (result.ok !== true) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(result.ok === true
      ? 'Codex Desktop Full Capability routing enabled; ChatGPT OAuth remains active.'
      : `Desktop Full Capability activation failed: ${String(result.status || 'failed')}`);
    return;
  }
  if (action === 'use-cli') {
    const result = await configureCodexLbCliMode(controllerOptions(args));
    if (result.ok !== true) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(result.ok === true
      ? `codex-lb CLI provider active (${String((result.routing_truth as any)?.actual_host || 'verified route')}).`
      : `codex-lb CLI provider setup failed: ${String(result.status || 'failed')}`);
    return;
  }
  if (
    action === 'disable'
    || action === 'release'
    || action === 'unselect'
    || action === 'use-oauth'
    || action === 'use-chatgpt'
  ) {
    if (action !== 'disable') {
      printDeprecationWarning(action, 'sks codex-lb disable');
    }
    const result = await disableCodexLbDesktopRouting(controllerOptions(args));
    if (result.ok !== true) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(result.ok === true
      ? 'codex-lb Desktop routing disabled; existing ChatGPT OAuth was left untouched.'
      : `codex-lb Desktop routing disable failed: ${String(result.status || 'failed')}`);
    return;
  }
  if (action === 'capabilities') {
    const level = normalizeCapabilityLevel(readOption(args, '--level', 'shallow'));
    if (!level) {
      const result = {
        schema: 'sks.codex-lb-capabilities-command.v2',
        ok: false,
        status: 'invalid_level',
        blockers: ['capability_level_must_be_shallow_transport_or_deep']
      };
      process.exitCode = 1;
      if (flag(args, '--json')) return printJson(result);
      console.error('Invalid capability level. Use shallow, transport, or deep.');
      return;
    }
    const { deepEvidence, deepEvidenceTrustAnchors } = await readDeepEvidenceOptions(args);
    const report = await buildCodexLbDesktopCapabilities({
      ...controllerOptions(args),
      level,
      deepEvidence,
      deepEvidenceTrustAnchors,
      networkProbes: !flag(args, '--no-network')
    });
    const diagnosticOk = report.overall !== 'blocked' && report.overall !== 'unsupported';
    const result = {
      ...report,
      ok: diagnosticOk,
      diagnostic_ok: diagnosticOk,
      level,
      full_capability_verified: report.overall === 'verified'
    };
    if (!diagnosticOk) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(`codex-lb capabilities (${level}): ${diagnosticOk ? 'diagnostic_ok' : 'blocked'}; overall=${report.overall}`);
    printCapabilityRows(report);
    return;
  }
  if (action === 'migrate-legacy-desktop') {
    const { deepEvidence, deepEvidenceTrustAnchors } = await readDeepEvidenceOptions(args);
    const toRaw = String(readOption(args, '--to', readOption(args, '--target', 'bridge')) || 'bridge')
      .trim()
      .toLowerCase();
    const mode = toRaw === 'bridge'
        || toRaw === 'desktop-full'
        || toRaw === 'desktop-native-bridge'
        || toRaw === ''
        ? 'desktop-native-bridge' as const
        : null;
    if (!mode) {
      const result = {
        schema: 'sks.codex-lb-legacy-migration-command.v2',
        ok: false,
        status: 'invalid_migration_target',
        blockers: ['migration_target_must_be_bridge']
      };
      process.exitCode = 1;
      if (flag(args, '--json')) return printJson(result);
      console.error('Invalid --to value. Use bridge.');
      return;
    }
    const result = await migrateLegacyCodexLbDesktopMode({
      ...controllerOptions(args),
      mode,
      deepEvidence,
      deepEvidenceTrustAnchors
    });
    if (result.ok !== true) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(result.ok === true
      ? `Legacy codex-lb Desktop state migrated (${String(result.receipt_path || '')}).`
      : `Legacy migration blocked: ${String(result.status || 'failed')}`);
    return;
  }
  if (action === 'rollback') {
    const receiptId = String(args[1] || readOption(args, '--receipt', '')).trim();
    const result = await rollbackCodexLbDesktopMode(receiptId, controllerOptions(args));
    if (result.ok !== true) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(result.ok === true
      ? `codex-lb Desktop rollback completed (${receiptId}).`
      : `codex-lb Desktop rollback failed: ${String(result.status || 'failed')}`);
    return;
  }
  if ((action === 'bridge' || action === 'desktop-bridge') && args[1] === 'serve') {
    const result = await serveDesktopBridge(controllerOptions(args));
    if (!result.ok) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(result);
    console.log(`codex-lb Desktop bridge: ${result.status}`);
    return;
  }
  if (action === 'setup' || action === 'reconfigure') {
    const options = await codexLbSetupOptions(args);
    if (options.desktopMode === 'cli-provider' && options.gatewayAuthTransport === 'x-codex-lb-api-key') {
      // Fail closed: the atomic CLI provider is env_key ⇒ Authorization: Bearer
      // only. Recording an unusable custom-header transport would make probes
      // measure a route real Codex traffic cannot take.
      const result = {
        schema: 'sks.codex-lb-setup.v1',
        ok: false,
        status: 'custom_header_transport_requires_desktop_bridge',
        guidance: [
          'The atomic CLI provider always sends Authorization: Bearer (Codex env_key).',
          'For a gateway that only accepts the X-Codex-LB-API-Key header, use Desktop Bridge mode:',
          'sks codex-lb setup --host <domain> --desktop-mode desktop-full --gateway-auth custom-header --api-key-stdin --yes'
        ]
      };
      if (flag(args, '--json')) {
        process.exitCode = 1;
        return printJson(result);
      }
      console.error('codex-lb setup rejected: --gateway-auth custom-header only applies to Desktop Bridge mode; the CLI provider always uses Authorization: Bearer.');
      process.exitCode = 1;
      return;
    }
    const plan = buildCodexLbSetupPlan({
      host_or_base_url: options.host || '',
      api_key_source: options.apiKeySource,
      desktop_mode: options.desktopMode,
      gateway_auth_transport: options.gatewayAuthTransport,
      write_env_file: options.writeEnvFile,
      store_keychain: options.keychain,
      sync_launchctl: options.syncLaunchctl,
      install_shell_profile: options.shellProfile,
      run_health_check: options.health,
      allow_insecure_localhost: options.allowInsecureLocalhost
    });
    if (!options.host || !options.apiKey) {
      const result = {
        schema: 'sks.codex-lb-setup.v1',
        ok: false,
        status: 'setup_needed',
        reason: !options.host ? 'missing_host_or_base_url' : 'missing_api_key',
        guidance: [
          'Run: sks codex-lb setup',
          'Or: sks codex-lb setup --host <domain> --api-key-stdin --yes'
        ]
      };
      if (flag(args, '--json')) {
        process.exitCode = 1;
        return printJson(result);
      }
      console.error('codex-lb API key is not configured.');
      console.error('Run:');
      console.error('  sks codex-lb setup');
      console.error('or:');
      console.error('  sks codex-lb setup --host <domain> --api-key-stdin --yes');
      process.exitCode = 1;
      return;
    }
    if (flag(args, '--plan')) {
      const result = { schema: 'sks.codex-lb-setup-plan-result.v1', ok: plan.blockers.length === 0, plan, writes: false, expected_actions: plan.expected_actions, persistence: plan.persistence };
      if (!result.ok) process.exitCode = 1;
      if (flag(args, '--json')) return printJson(result);
      process.stdout.write(renderCodexLbSetupPlan(plan));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    const processOnly = plan.persistence.effective_mode === 'process_only_ephemeral';
    if (options.interactive && !options.yes) {
      process.stdout.write(renderCodexLbSetupPlan(plan));
      const confirm = (await ask('Apply this codex-lb setup plan? [y/N] ')).trim();
      if (!/^(y|yes|예|네|응)$/i.test(confirm)) {
        const result = { schema: 'sks.codex-lb-setup.v1', ok: false, status: 'cancelled', plan, applied_actions: [] };
        if (flag(args, '--json')) {
          process.exitCode = 1;
          return printJson(result);
        }
        console.log('codex-lb setup cancelled.');
        process.exitCode = 1;
        return;
      }
      if (processOnly) {
        const confirmProcessOnly = (await ask('This setup keeps credentials only in the current process. Type process-only to continue: ')).trim();
        if (confirmProcessOnly !== 'process-only') {
          const result = { schema: 'sks.codex-lb-setup.v1', ok: false, status: 'process_only_cancelled', plan, applied_actions: [], persistence: plan.persistence };
          if (flag(args, '--json')) {
            printJson(result);
            process.exitCode = 1;
            return;
          }
          console.log('codex-lb setup cancelled: process-only ephemeral setup was not confirmed.');
          process.exitCode = 1;
          return;
        }
      }
    } else if (processOnly && !options.yes) {
      const result = {
        schema: 'sks.codex-lb-setup.v1',
        ok: false,
        status: 'process_only_requires_yes',
        plan,
        applied_actions: [],
        persistence: plan.persistence,
        guidance: ['Pass --yes to acknowledge process_only_ephemeral setup, or enable --write-env-file, --launchctl, or --shell-profile.']
      };
      if (flag(args, '--json')) {
        printJson(result);
        process.exitCode = 1;
        return;
      }
      console.error('codex-lb setup would be process-only ephemeral. Pass --yes to acknowledge, or enable a durable persistence mode.');
      process.exitCode = 1;
      return;
    }
    const result = await configureCodexLb({
      host: options.host,
      apiKey: options.apiKey,
      desktopMode: 'cli-provider',
      useDefaultProvider: options.useDefaultProvider,
      gatewayAuthTransport: options.gatewayAuthTransport,
      keychain: options.keychain,
      storeKeychain: options.keychain,
      writeEnvFile: options.writeEnvFile,
      syncLaunchctl: options.syncLaunchctl,
      shellProfile: options.shellProfile,
      runHealth: false,
      apiKeySource: options.apiKeySource,
      allowInsecureHttp: options.allowInsecureLocalhost,
      allowUnverifiedToolOutputRecovery: codexLbToolOutputRecoveryOverrideAcknowledged({ args })
    });
    let desktopActivation: Record<string, unknown> | null = null;
    if (result.ok && options.desktopMode === 'desktop-native-bridge') {
      desktopActivation = await activateCodexLbDesktopMode({
        ...controllerOptions(args),
        mode: 'desktop-native-bridge',
        gatewayAuthTransport: options.gatewayAuthTransport
      });
    }
    const capabilities = options.health && result.ok
      ? await buildCodexLbDesktopCapabilities({
          ...controllerOptions(args),
          level: 'transport',
          networkProbes: true
        })
      : null;
    const capabilityDiagnosticOk = codexLbSetupCapabilityDiagnosticOk(capabilities);
    const setupRoutingTruth = result.ok && options.desktopMode === 'cli-provider'
      ? await measureAndWriteCodexLbRoutingTruth({
          selected: result.codex_lb?.selected === true,
          baseUrl: result.base_url || null,
          apiKey: options.apiKey,
          // cli-provider setup is always env_key ⇒ Authorization: Bearer.
          authTransport: 'authorization-bearer'
        }, {
          home: path.dirname(path.dirname(result.env_path))
        })
      : (desktopActivation?.post_activation_status as any)?.routing_truth || null;
    const cliRoutingActive = codexLbRoutingTruthIsActive(setupRoutingTruth);
    const shaped: any = {
      ...result,
      schema: 'sks.codex-lb-setup.v2',
      ok: Boolean(
        result.ok
        && desktopActivation?.ok !== false
        && capabilityDiagnosticOk
      ),
      diagnostic_ok: capabilityDiagnosticOk,
      requested_desktop_mode: options.desktopMode,
      gateway_auth_transport: options.gatewayAuthTransport,
      api_key: { present: Boolean(options.apiKey), redacted: true },
      env_file_chmod: options.writeEnvFile ? '0600' : null,
      desktop_auth_mutated: false,
      fast_mode_mutated: false,
      provider_ready: result.ok === true,
      routing_active: Boolean(result.ok && (desktopActivation?.ok === true || cliRoutingActive)),
      routing_truth: setupRoutingTruth,
      activation_required: Boolean(
        result.ok
        && options.desktopMode === 'cli-provider'
        && !cliRoutingActive
        && desktopActivation === null
      ),
      desktop_activation: desktopActivation,
      capabilities
    };
    if (options.health) {
      shaped.applied_actions = [
        ...(shaped.applied_actions || []),
        {
          type: 'run_capability_check',
          target: 'codex-lb Desktop capability matrix',
          ok: capabilityDiagnosticOk,
          overall: capabilities?.overall || null
        }
      ];
    }
    if (!shaped.ok) process.exitCode = 1;
    if (flag(args, '--json')) return printJson(shaped);
    if (!shaped.ok) {
      console.error(`codex-lb setup failed: ${String(result.status || 'configuration_failed')}`);
      const recoveryPaths = Array.isArray(result.rollback?.recovery_paths)
        ? result.rollback.recovery_paths.map((value: unknown) => String(value || '')).filter(Boolean)
        : [];
      if (recoveryPaths.length > 0) {
        console.error('Recovery files retained:');
        for (const recoveryPath of recoveryPaths) console.error(`  ${recoveryPath}`);
      }
      const secretRecoveryPaths = Array.isArray(result.rollback?.secret_recovery_paths)
        ? result.rollback.secret_recovery_paths.map((value: unknown) => String(value || '')).filter(Boolean)
        : [];
      if (secretRecoveryPaths.length > 0) {
        console.error('Warning: the following owner-only recovery files may contain the submitted API key:');
        for (const recoveryPath of secretRecoveryPaths) console.error(`  ${recoveryPath}`);
      }
      if (result.keychain?.keychain_state_verified === false) {
        console.error('Keychain state is indeterminate; do not assume the previous credential was restored.');
      }
      printCodexLbSetupWarnings(result);
      return;
    }
    console.log(`codex-lb configured: ${result.base_url || result.status}`);
    console.log(`Desktop mode: ${options.desktopMode}${desktopActivation ? ` (${String(desktopActivation.status || 'applied')})` : ' (routing unchanged)'}`);
    const retainedRecoveryPaths = Array.isArray(result.recovery_paths)
      ? result.recovery_paths.map((value: unknown) => String(value || '')).filter(Boolean)
      : [];
    const retainedSecretRecoveryPaths = Array.isArray(result.secret_recovery_paths)
      ? result.secret_recovery_paths.map((value: unknown) => String(value || '')).filter(Boolean)
      : [];
    const secretRecoverySet = new Set(retainedSecretRecoveryPaths);
    const nonSecretRecoveryPaths = retainedRecoveryPaths.filter((value: string) => !secretRecoverySet.has(value));
    if (nonSecretRecoveryPaths.length > 0) {
      console.log('Recovery backups retained:');
      for (const recoveryPath of nonSecretRecoveryPaths) console.log(`  ${recoveryPath}`);
    }
    if (retainedSecretRecoveryPaths.length > 0) {
      console.error('Warning: owner-only recovery files may contain a previous API key and require secure review:');
      for (const recoveryPath of retainedSecretRecoveryPaths) console.error(`  ${recoveryPath}`);
    }
    printCodexLbSetupWarnings(shaped);
    if (!shaped.ok) process.exitCode = 1;
    return;
  }
  if (action === 'circuit' && args[1] === 'reset') {
    const result = await resetCodexLbCircuit(root);
    if (flag(args, '--json')) return printJson({ ok: true, circuit: result });
    console.log('codex-lb circuit reset');
    return;
  }
  if (action === 'circuit' && args[1] === 'record-fixture') {
    const fixturePath = args[2] || readOption(args, '--fixture', null);
    if (!fixturePath) {
      console.error('Usage: sks codex-lb circuit record-fixture <fixture.json> [--json]');
      process.exitCode = 1;
      return;
    }
    const { readJson } = await import('../core/fsx.js');
    const event = await readJson(path.isAbsolute(fixturePath) ? fixturePath : path.resolve(root, fixturePath), {});
    const circuit = await recordCodexLbHealthEvent(root, event);
    const result = { schema: 'sks.codex-lb-circuit-record-fixture.v1', ok: true, fixture: fixturePath, circuit };
    if (flag(args, '--json')) return printJson(result);
    console.log(`codex-lb circuit: ${circuit.state}`);
    return;
  }
  if (action === 'proof-evidence') {
    const result = await codexLbProofEvidence(root);
    if (flag(args, '--json')) return printJson(result);
    console.log(`codex-lb proof evidence: ${result.status}`);
    return;
  }
  console.error('Usage: sks codex-lb status|setup|set-key|connect-test|use-desktop-full|use-cli|disable|capabilities [--level shallow|transport|deep] [--evidence <file> --trust-anchors <file>]|migrate-legacy-desktop|rollback <receipt-id>|health|metrics|doctor|repair|circuit reset|circuit record-fixture|proof-evidence [--json]');
  console.error(`  ${CODEX_LB_TOOL_OUTPUT_RECOVERY_OVERRIDE_FLAG}  explicitly acknowledge an old/unverified proxy for this command (unsafe)`);
  console.error('  set-key       swap the codex-lb API key (reuses the stored host): sks codex-lb set-key --api-key-stdin');
  console.error('  --keychain    fail-closed until a dedicated signed SKS Keychain helper is available; the default 0600 env file is used');
  console.error('  use-desktop-full   keep ChatGPT OAuth/built-in OpenAI and route data through the local bridge');
  console.error('  use-cli            verify, write, and atomically select the CLI codex-lb provider');
  console.error('  disable            remove only SKS-managed Desktop routing; auth.json is untouched');
  process.exitCode = 1;
}

export function codexLbRestartPostcondition(restart: any = {}, required = false) {
  const performed = restart?.status === 'restarted';
  return {
    required: Boolean(required),
    performed,
    satisfied: !required || performed
  };
}

export function buildCodexLbDoctorResult(
  status: Record<string, unknown>,
  metrics: Record<string, unknown>,
  deep = false
) {
  const diagnosticOk = status.ok === true;
  return {
    schema: 'sks.codex-lb-doctor.v2',
    ok: diagnosticOk && metrics.ok === true,
    diagnostic_ok: diagnosticOk,
    full_capability_verified: status.full_capability_verified === true,
    deep,
    status,
    metrics
  };
}

export function codexLbSetupCapabilityDiagnosticOk(
  capabilities: CodexLbDesktopCapabilityReport | null
): boolean {
  return capabilities === null
    || (capabilities.overall !== 'blocked' && capabilities.overall !== 'unsupported');
}

export function isCodexLbFastChainVerified(chain: any = {}) {
  return chain.ok === true && chain.skipped !== true;
}

export async function resolveCodexLbFastCheckModel(status: any = {}, env: NodeJS.ProcessEnv = process.env) {
  return resolveCodexLbModel(status, env, { requirePriority: true, blockerPrefix: 'codex_lb_fast_check' });
}

export async function resolveCodexLbHealthModel(status: any = {}, env: NodeJS.ProcessEnv = process.env) {
  return resolveCodexLbModel(status, env, { requirePriority: false, blockerPrefix: 'codex_lb_health' });
}

async function resolveCodexLbModel(status: any = {}, env: NodeJS.ProcessEnv = process.env, opts: any = {}) {
  const explicit = String(env.SKS_CODEX_MODEL || env.CODEX_MODEL || '').trim();
  if (explicit) return { model: explicit, source: env.SKS_CODEX_MODEL ? 'SKS_CODEX_MODEL' : 'CODEX_MODEL', blockers: [] };

  const configPath = String(status.config_path || '').trim();
  const config = configPath ? await readText(configPath, '').catch(() => '') : '';
  const configured = topLevelTomlString(config, 'model');
  if (configured) return { model: configured, source: 'global_config', blockers: [] };

  const home = String(env.HOME || '').trim();
  const configuredCatalogPath = topLevelTomlString(config, 'model_catalog_json');
  const defaultCatalogPath = configPath
    ? path.join(path.dirname(configPath), 'models_cache.json')
    : home
      ? path.join(home, '.codex', 'models_cache.json')
      : '';
  const requestedCatalogPath = configuredCatalogPath || defaultCatalogPath;
  if (!requestedCatalogPath) return { model: null, source: null, blockers: [`${opts.blockerPrefix}_model_unselected`] };
  const expandedCatalogPath = requestedCatalogPath.startsWith('~/') && home
    ? path.join(home, requestedCatalogPath.slice(2))
    : requestedCatalogPath;
  const catalogPath = path.isAbsolute(expandedCatalogPath)
    ? expandedCatalogPath
    : path.resolve(path.dirname(configPath), expandedCatalogPath);
  try {
    const catalogText = await readText(catalogPath, '');
    if (!catalogText.trim()) {
      return { model: null, source: null, blockers: [`${opts.blockerPrefix}_model_unselected`] };
    }
    const payload = JSON.parse(catalogText);
    const model = selectCatalogModel(payload, opts.requirePriority === true);
    return model
      ? { model, source: configuredCatalogPath ? 'model_catalog_json' : 'codex_models_cache', blockers: [] }
      : { model: null, source: configuredCatalogPath ? 'model_catalog_json' : 'codex_models_cache', blockers: [`${opts.blockerPrefix}_${opts.requirePriority === true ? 'priority_' : ''}model_unavailable`] };
  } catch {
    return { model: null, source: configuredCatalogPath ? 'model_catalog_json' : 'codex_models_cache', blockers: [`${opts.blockerPrefix}_catalog_invalid`] };
  }
}

function topLevelTomlString(text: string, key: string) {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (topLevel.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*=\\s*"([^"]+)"`))?.[1] || '').trim();
}

function selectCatalogModel(payload: any = {}, requirePriority = false) {
  const models = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
  return models
    .filter((row: any) => {
      if (!row || typeof row !== 'object' || row.supported_in_api !== true || typeof row.slug !== 'string' || !row.slug.trim()) return false;
      if (!requirePriority) return true;
      const serviceTiers = Array.isArray(row.service_tiers) ? row.service_tiers : [];
      const speedTiers = Array.isArray(row.additional_speed_tiers) ? row.additional_speed_tiers : [];
      return serviceTiers.some((tier: any) => normalizeTier(typeof tier === 'string' ? tier : tier?.id) === 'priority')
        || speedTiers.some((tier: any) => normalizeTier(tier) === 'priority');
    })
    .sort((left: any, right: any) => Number(left.priority ?? Number.MAX_SAFE_INTEGER) - Number(right.priority ?? Number.MAX_SAFE_INTEGER)
      || String(left.slug).localeCompare(String(right.slug)))[0]?.slug || null;
}

export async function fastEvidenceFromChain(chain: any = {}, requestLogPath: any = null) {
  const chainEvidence = chain.service_tier_evidence || {};
  const logRows = requestLogPath ? await readRequestLogRows(String(requestLogPath)) : [];
  const logEvidence = serviceTierEvidenceFromRows(logRows);
  const requested = logEvidence.requested_service_tier || chainEvidence.requested_service_tier || chain.requested_service_tier || null;
  const actual = logEvidence.actual_service_tier || chainEvidence.actual_service_tier || null;
  const effective = logEvidence.effective_service_tier || chainEvidence.effective_service_tier || null;
  return {
    requested_service_tier: requested,
    actual_service_tier: actual,
    effective_service_tier: effective,
    fast_requested: requested === 'priority' || chain.requested_service_tier === 'priority' || chainEvidence.fast_requested === true,
    fast_actual: actual === 'priority' || effective === 'priority' || logEvidence.fast_actual === true || chainEvidence.fast_actual === true,
    chain_evidence: chainEvidence,
    request_log_path: requestLogPath || null,
    request_log_rows: logRows.length
  };
}

async function readRequestLogRows(file: string) {
  if (!file) return [];
  const text = await readText(path.isAbsolute(file) ? file : path.resolve(process.cwd(), file), '').catch(() => '');
  const rows: any[] = [];
  const trimmed = text.trim();
  if (!trimmed) return rows;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.rows)) return parsed.rows;
    if (Array.isArray(parsed?.requests)) return parsed.requests;
    return [parsed];
  } catch {}
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    try { rows.push(JSON.parse(candidate)); } catch {}
  }
  return rows;
}

export function serviceTierEvidenceFromRows(rows: any[] = []) {
  let requested: string | null = null;
  let actual: string | null = null;
  let effective: string | null = null;
  for (const row of rows) {
    requested ||= normalizeTier(row?.requestedServiceTier || row?.requested_service_tier || row?.request?.service_tier || row?.body?.service_tier);
    actual ||= normalizeTier(row?.actualServiceTier || row?.actual_service_tier || row?.response?.actualServiceTier || row?.response?.actual_service_tier);
    effective ||= responseServiceTier(row);
  }
  return {
    requested_service_tier: requested,
    actual_service_tier: actual,
    effective_service_tier: effective,
    fast_actual: actual === 'priority' || effective === 'priority'
  };
}

function responseServiceTier(row: any) {
  const nested = normalizeTier(row?.response?.serviceTier || row?.response?.service_tier || row?.event?.response?.serviceTier || row?.event?.response?.service_tier);
  if (nested) return nested;
  const responseKind = String(row?.direction || row?.phase || row?.kind || row?.type || '').trim().toLowerCase();
  const responseBody = row?.object === 'response' || /^resp[_-]/i.test(String(row?.id || '')) || Array.isArray(row?.output);
  if (responseBody || responseKind === 'response' || responseKind === 'inbound' || responseKind.startsWith('response.')) {
    return normalizeTier(row?.serviceTier || row?.service_tier);
  }
  return null;
}

function normalizeTier(value: unknown) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'fast') return 'priority';
  if (text === 'priority' || text === 'default' || text === 'flex') return text;
  return null;
}

async function readDeepEvidenceOptions(args: any[] = []): Promise<{
  deepEvidence: unknown | null;
  deepEvidenceTrustAnchors: Awaited<ReturnType<typeof readCodexLbDesktopDeepEvidenceTrustAnchors>>;
}> {
  const evidencePath = readOption(args, '--evidence', null);
  const trustAnchorsPath = readOption(
    args,
    '--trust-anchors',
    readOption(args, '--evidence-trust-anchors', null)
  );
  return {
    deepEvidence: evidencePath
      ? await readCodexLbDesktopDeepEvidence(String(evidencePath))
      : null,
    deepEvidenceTrustAnchors: trustAnchorsPath
      ? await readCodexLbDesktopDeepEvidenceTrustAnchors(String(trustAnchorsPath))
      : []
  };
}

export function controllerOptions(args: any[] = []): CodexLbDesktopControllerOptions {
  // Only an explicit flag may pin the transport. Defaulting here would shadow the
  // stored Center choice (`sks-codex-lb.json` / bridge settings) for every command
  // SKS Center runs without `--gateway-auth`, silently forcing the custom header
  // onto gateways that only accept `Authorization: Bearer`.
  const rawGatewayAuth = flag(args, '--compat-bearer')
    ? 'authorization-bearer-compat'
    : (() => {
        const explicit = readOption(
          args,
          '--gateway-auth',
          readOption(args, '--gateway-auth-transport', null)
        );
        return explicit === null ? null : normalizeGatewayAuthChoice(explicit);
      })();
  const gatewayAuthTransport = rawGatewayAuth === null
    ? null
    : parseCodexLbGatewayAuthTransport(rawGatewayAuth);
  const home = readOption(args, '--home', null);
  const configPath = readOption(args, '--config', readOption(args, '--config-path', null));
  const authPath = readOption(args, '--auth', readOption(args, '--auth-path', null));
  const envPath = readOption(args, '--env-file', readOption(args, '--env-path', null));
  const metadataPath = readOption(args, '--metadata', readOption(args, '--metadata-path', null));
  const receiptDir = readOption(args, '--receipt-dir', null);
  const routingTruthReceiptPath = readOption(args, '--routing-truth-receipt', null);
  const listenHost = readOption(args, '--listen-host', null);
  const normalizedListenHost = listenHost === null
    ? null
    : listenHost === '127.0.0.1' || listenHost === '::1'
      ? listenHost
      : (() => { throw new Error(`unsupported_codex_lb_desktop_listen_host:${listenHost}`); })();
  const listenPortText = readOption(args, '--listen-port', null);
  const listenPort = listenPortText === null ? null : Number(listenPortText);
  const capabilityTimeoutText = readOption(args, '--capability-timeout-ms', null);
  const capabilityTimeoutMs = capabilityTimeoutText === null ? null : Number(capabilityTimeoutText);
  return {
    ...(gatewayAuthTransport ? { gatewayAuthTransport } : {}),
    restartApp: flag(args, '--restart-app') || flag(args, '--restart'),
    networkProbes: !flag(args, '--no-network'),
    ...(home ? { home: String(home) } : {}),
    ...(configPath ? { configPath: String(configPath) } : {}),
    ...(authPath ? { authPath: String(authPath) } : {}),
    ...(envPath ? { envPath: String(envPath) } : {}),
    ...(metadataPath ? { metadataPath: String(metadataPath) } : {}),
    ...(receiptDir ? { receiptDir: String(receiptDir) } : {}),
    ...(routingTruthReceiptPath ? { routingTruthReceiptPath: String(routingTruthReceiptPath) } : {}),
    ...(capabilityTimeoutMs !== null && Number.isFinite(capabilityTimeoutMs) && capabilityTimeoutMs > 0
      ? { capabilityTimeoutMs }
      : {}),
    ...(normalizedListenHost || (listenPort !== null && Number.isInteger(listenPort))
      ? {
          settings: {
            ...(normalizedListenHost ? { listen_host: normalizedListenHost } : {}),
            ...(listenPort !== null && Number.isInteger(listenPort) ? { listen_port: listenPort } : {}),
            ...(gatewayAuthTransport ? { gateway_auth_transport: gatewayAuthTransport } : {})
          }
        }
      : {})
  };
}

export function formatCodexLbDesktopStatusText(
  status: Record<string, unknown>,
  opts: { home?: string } = {}
): string {
  const oauth = asRecord(status.oauth);
  const provider = asRecord(status.provider);
  const bridge = asRecord(status.bridge);
  const capabilities = asRecord(status.capabilities);
  const resolution = asRecord(status.secret_resolution);
  const resolutionSource = String(resolution.source || 'missing');
  const resolutionPath = resolution.path
    ? displayHomePath(String(resolution.path), opts.home || process.env.HOME || '')
    : '';
  const resolutionLabel = resolutionPath
    ? `${resolutionSource} (${resolutionPath})`
    : resolutionSource;
  const blockers = stringArray(status.blockers);
  const guidance = stringArray(status.guidance);
  const lines = [
    'SKS codex-lb Desktop',
    '',
    `Configured: ${status.configured === true ? 'yes' : 'no'}`,
    `Credentials ready: ${status.credentials_ready === true ? 'yes' : 'no'}`,
    `Routing active: ${status.routing_active === true ? 'yes' : 'no'}`,
    `Mode: ${String(status.mode || 'disabled')}`,
    `ChatGPT OAuth: ${oauth.present === true ? 'present and preserved' : 'missing'}`,
    `Provider: ${String(provider.contract || 'missing')} (${provider.contract_ok === true ? 'ok' : 'blocked'})`,
    `Bridge: ${String(bridge.status || 'unknown')}${bridge.running === true ? ' (running)' : ''}`,
    `Gateway auth: ${String(status.gateway_auth_transport || 'inactive')}`,
    `Key source: ${resolutionLabel} · keychain: not used · prompt risk: ${String(resolution.prompt_risk || 'none')}`,
    `Capabilities: ${String(status.overall || capabilities.state || 'unverified')}`,
    `Full capability: ${status.full_capability_verified === true ? 'verified' : 'unverified'}`
  ];
  if (blockers.length) {
    lines.push('', 'Blockers:');
    for (const blocker of blockers) lines.push(`- ${blocker}`);
  }
  if (guidance.length) {
    lines.push('', 'Next:');
    for (const item of guidance) lines.push(`- ${item}`);
  }
  return `${lines.join('\n')}\n`;
}

function displayHomePath(file: string, home: string): string {
  const resolvedFile = path.resolve(file);
  const resolvedHome = home ? path.resolve(home) : '';
  return resolvedHome && (resolvedFile === resolvedHome || resolvedFile.startsWith(`${resolvedHome}${path.sep}`))
    ? `~${resolvedFile.slice(resolvedHome.length)}`
    : resolvedFile;
}

function printDeprecationWarning(oldAction: string, replacement: string): void {
  console.error(`warning: \`sks codex-lb ${oldAction}\` is deprecated; use \`${replacement}\`.`);
}

function normalizeCapabilityLevel(value: unknown): CapabilityProbeLevel | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'shallow' || normalized === 'transport' || normalized === 'deep') {
    return normalized;
  }
  return null;
}

function printCapabilityRows(report: CodexLbDesktopCapabilityReport): void {
  const keys = [
    'gateway_auth_transport',
    'provider_identity',
    'bridge',
    'catalog',
    'model_picker',
    'fast_mode',
    'text_responses',
    'image_generation',
    'computer_use',
    'browser_use',
    'voice_mode',
    'plugins',
    'auxiliary_surfaces'
  ] as const;
  for (const key of keys) {
    const capability = report[key];
    const suffix = capability.blockers.length
      ? ` (${capability.blockers.join(', ')})`
      : '';
    console.log(`- ${key}: ${capability.state}${suffix}`);
  }
}

function normalizeDesktopSetupMode(value: unknown): CodexLbDesktopMode {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'desktop-full'
    || normalized === 'full'
    || normalized === 'native'
    || normalized === 'desktop-native-bridge'
  ) {
    return 'desktop-native-bridge';
  }
  if (
    normalized === 'desktop-compat'
    || normalized === 'compat'
    || normalized === 'desktop-dual-auth-compat'
  ) {
    throw new Error('desktop_dual_auth_compat_unavailable');
  }
  if (
    !normalized
    || normalized === 'cli'
    || normalized === 'cli-only'
    || normalized === 'cli-provider'
  ) {
    return 'cli-provider';
  }
  throw new Error(`unsupported_codex_lb_desktop_mode:${normalized}`);
}

/**
 * Plane rule for direct-to-gateway probes: the atomic CLI provider always
 * authenticates like Codex itself (env_key ⇒ Authorization: Bearer). Only
 * desktop-bridge installs emulate the stored transport the bridge forwards.
 */
function directGatewayProbeTransport(
  status: any,
  loadedEnv: any
): 'authorization-bearer' | 'x-codex-lb-api-key' {
  return status?.desktop_mode === 'desktop-native-bridge'
      && loadedEnv?.gateway_auth_transport === 'x-codex-lb-api-key'
    ? 'x-codex-lb-api-key'
    : 'authorization-bearer';
}

function normalizeGatewayAuthChoice(value: unknown): CodexLbGatewayAuthTransport {
  const normalized = String(value || '').trim().toLowerCase();
  // Default is Authorization: Bearer; the custom header is an explicit,
  // desktop-bridge-only escape.
  if (
    !normalized
    || normalized === 'bearer'
    || normalized === 'bearer-compat'
    || normalized === 'authorization-bearer'
    || normalized === 'authorization-bearer-compat'
  ) {
    return 'authorization-bearer-compat';
  }
  if (
    normalized === 'custom-header'
    || normalized === 'header'
    || normalized === 'x-codex-lb-api-key'
  ) {
    return 'x-codex-lb-api-key';
  }
  throw new Error(`unsupported_codex_lb_gateway_auth_transport:${normalized}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter(Boolean) : [];
}

async function resolveNewApiKey(args: any = []): Promise<string> {
  if (flag(args, '--api-key-stdin')) return String(await readStdin()).trim();
  if (input.isTTY && !flag(args, '--yes')) {
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question('New codex-lb API key (sk-clb-...): ')).trim();
    } finally {
      rl.close();
    }
  }
  return '';
}

async function codexLbSetupOptions(args: any = []) {
  const baseUrl = readOption(args, '--base-url', null);
  let host = baseUrl || readOption(args, '--host', readOption(args, '--domain', null));
  let apiKey: string | null = null;
  let apiKeySource: 'hidden_prompt' | 'stdin' | 'keychain_existing' = 'hidden_prompt';
  let desktopMode = normalizeDesktopSetupMode(
    readOption(args, '--desktop-mode', readOption(args, '--mode', 'cli-provider'))
  );
  let gatewayAuthTransport = parseCodexLbGatewayAuthTransport(
    normalizeGatewayAuthChoice(flag(args, '--compat-bearer')
      ? 'authorization-bearer-compat'
      : readOption(args, '--gateway-auth', readOption(args, '--gateway-auth-transport', 'bearer-compat')))
  );
  let keychain = flag(args, '--keychain');
  if (flag(args, '--api-key-stdin')) apiKey = (await readStdin()).trim();
  if (flag(args, '--api-key-stdin')) apiKeySource = 'stdin';
  let health = (flag(args, '--health') || flag(args, '--check')) && !flag(args, '--no-health');
  let writeEnvFile = flag(args, '--no-env-file') ? false : true;
  if (flag(args, '--write-env-file')) writeEnvFile = true;
  if (flag(args, '--no-keychain')) keychain = false;
  let syncLaunchctl = false;
  if (flag(args, '--launchctl')) syncLaunchctl = true;
  const shellProfile = normalizeShellProfile(readOption(args, '--shell-profile', 'skip'));
  const allowInsecureLocalhost = flag(args, '--allow-insecure-localhost') || flag(args, '--allow-insecure-http');
  const useDefaultProvider = !flag(args, '--no-default-provider');
  const interactive = (!host || !apiKey || canAskInteractive(args)) && canAskInteractive(args);
  if ((!host || !apiKey) && canAskInteractive(args)) {
    console.log('SKS codex-lb setup\n');
    host ||= (await ask('1. codex-lb domain or base URL?\n   Example: lb.example.com or https://lb.example.com/backend-api/codex\n> ')).trim();
    apiKey ||= (await askHidden('2. API key?\n   Input hidden. Value will be stored securely and never printed.\n> ')).trim();
    apiKeySource = 'hidden_prompt';
    desktopMode = normalizeDesktopSetupMode(
      (await ask('3. Configure which mode? [cli-only/desktop-full] (cli-only)\n> ')).trim()
      || 'cli-only'
    );
    if (desktopMode === 'desktop-native-bridge') {
      gatewayAuthTransport = parseCodexLbGatewayAuthTransport(
        normalizeGatewayAuthChoice(
          (await ask('4. Gateway key transport? [bearer-compat/custom-header] (bearer-compat)\n> ')).trim()
        )
      );
    } else {
      // The atomic CLI provider always authenticates with Authorization:
      // Bearer (env_key); there is no transport choice on this plane.
      gatewayAuthTransport = 'authorization-bearer-compat';
    }
    writeEnvFile = parseYesNo(await ask('5. Write shell env loader to ~/.codex/sks-codex-lb.env? [Y/n] '), true);
    keychain = false;
    console.log('6. Key storage: ~/.codex/sks-codex-lb.env (owner-only mode 0600).');
    syncLaunchctl = parseYesNo(await ask('7. Sync non-secret macOS launchctl base URL only? API keys are never stored in launchd. [y/N] '), false);
    const profile = (await ask('8. Install shell profile snippet? [zsh/bash/fish/all/skip] ')).trim();
    const interactiveShellProfile = normalizeShellProfile(profile || 'skip');
    const runHealth = (await ask('9. Run capability diagnostics now? [Y/n] ')).trim();
    health = !/^(n|no|아니|아니요|ㄴ)$/i.test(runHealth || 'y');
    return {
      host,
      apiKey,
      health,
      keychain,
      desktopMode,
      gatewayAuthTransport,
      writeEnvFile,
      syncLaunchctl,
      shellProfile: interactiveShellProfile,
      allowInsecureLocalhost,
      apiKeySource,
      useDefaultProvider,
      interactive: true,
      yes: flag(args, '--yes')
    };
  }
  return {
    host,
    apiKey,
    health,
    keychain,
    desktopMode,
    gatewayAuthTransport,
    writeEnvFile,
    syncLaunchctl,
    shellProfile,
    allowInsecureLocalhost,
    apiKeySource,
    useDefaultProvider,
    interactive,
    yes: flag(args, '--yes')
  };
}

function normalizeShellProfile(value: any): 'zsh' | 'bash' | 'fish' | 'all' | 'skip' {
  const raw = String(value || 'skip').toLowerCase();
  return raw === 'zsh' || raw === 'bash' || raw === 'fish' || raw === 'all' ? raw : 'skip';
}

function parseYesNo(value: unknown, fallback: boolean): boolean {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^(y|yes|예|네|응)$/i.test(raw)) return true;
  if (/^(n|no|아니|아니요|ㄴ)$/i.test(raw)) return false;
  return fallback;
}

function canAskInteractive(args: any = []) {
  return !flag(args, '--json') && !flag(args, '--yes') && Boolean(input.isTTY && output.isTTY && process.env.CI !== 'true');
}

async function ask(question: string) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function askHidden(question: string) {
  if (!input.isTTY || !output.isTTY) return ask(question);
  const rl: any = readline.createInterface({ input, output, terminal: true });
  rl.stdoutMuted = true;
  const original = rl._writeToOutput;
  rl._writeToOutput = function writeToOutput(value: string) {
    if (rl.stdoutMuted && !/\n|\r/.test(value)) return;
    return original.call(rl, value);
  };
  try {
    const answer = await rl.question(question);
    output.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}
