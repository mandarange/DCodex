import { findCodexBinary } from '../codex-adapter.js';
import { nowIso, runProcess } from '../fsx.js';
import { redactSecrets, redactString } from '../secret-redaction.js';
import { buildCodexPluginInventory, type CodexPluginInventory } from './codex-plugin-json.js';
import { messageOf } from '../errors/message.js';

export const CODEX_PLUGIN_REPAIR_SCHEMA = 'sks.codex-plugin-repair.v1';

export async function ensureCodexPlugins(input: {
  pluginIds: string[];
  apply?: boolean;
  codexBin?: string | null;
  timeoutMs?: number;
  inventoryFactory?: () => Promise<CodexPluginInventory>;
  run?: (bin: string, args: string[]) => Promise<any>;
}) {
  const pluginIds = [...new Set((input.pluginIds || []).map(String))];
  const invalid = pluginIds.filter((id) => !/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/i.test(id));
  if (invalid.length) {
    return report({
      ok: false,
      apply: input.apply === true,
      codexBin: null,
      pluginIds,
      before: null,
      after: null,
      installs: [],
      blockers: invalid.map((id) => `invalid_plugin_selector:${id}`)
    });
  }

  const codexBin = input.codexBin === undefined ? await findCodexBinary() : input.codexBin;
  const inventory = input.inventoryFactory || (() => buildCodexPluginInventory({ codexBin }));
  const before = await inventory().catch((err: unknown) => failedInventory(err));
  const missingBefore = pluginIds.filter((id) => !pluginReady(before, id));
  const catalogMisses = before.catalog_complete
    ? missingBefore.filter((id) => !pluginListed(before, id))
    : [];
  const installableBefore = missingBefore.filter((id) => !catalogMisses.includes(id));
  const catalogCandidates = Object.fromEntries(catalogMisses.map((id) => [id, pluginCatalogCandidates(before, id)]));
  const installs: any[] = [];

  if (input.apply === true && codexBin) {
    const run = input.run || (async (bin: string, args: string[]) => runProcess(bin, args, {
      timeoutMs: input.timeoutMs || 30_000,
      maxOutputBytes: 128 * 1024
    }));
    for (const pluginId of installableBefore) {
      const result = await run(codexBin, ['plugin', 'add', pluginId, '--json']).catch((err: unknown) => ({
        code: 1,
        stdout: '',
        stderr: messageOf(err)
      }));
      installs.push({
        plugin_id: pluginId,
        attempted: true,
        ok: result.code === 0,
        command: `${codexBin} plugin add ${pluginId} --json`,
        exit_code: result.code,
        stdout_tail: tail(result.stdout),
        stderr_tail: tail(result.stderr)
      });
    }
  }

  const after = installs.length ? await inventory().catch((err: unknown) => failedInventory(err)) : before;
  const missingAfter = pluginIds.filter((id) => !pluginReady(after, id));
  const blockers = [
    ...(!codexBin && missingAfter.length ? ['codex_cli_missing'] : []),
    ...(input.apply !== true ? missingAfter.map((id) => `codex_plugin_repair_not_applied:${id}`) : []),
    ...catalogMisses.map((id) => `codex_plugin_selector_not_in_catalog:${id}`),
    ...missingAfter.filter((id) => !catalogMisses.includes(id)).map((id) => `codex_plugin_not_ready_after_recheck:${id}`),
    ...installs.filter((step) => !step.ok).map((step) => `codex_plugin_add_failed:${step.plugin_id}`)
  ];
  return report({
    ok: missingAfter.length === 0,
    apply: input.apply === true,
    codexBin,
    pluginIds,
    before,
    after,
    installs,
    catalogCandidates,
    blockers: [...new Set(blockers)]
  });
}

function report(input: any) {
  const changed = input.installs.some((step: any) => step.ok);
  const catalogCandidateActions = Object.entries(input.catalogCandidates || {})
    .filter(([, candidates]) => Array.isArray(candidates) && candidates.length > 0)
    .map(([requested, candidates]) => `Requested selector ${requested} is not in the current Codex CLI catalog. Use one of: ${(candidates as string[]).join(', ')}.`);
  return redactSecrets({
    schema: CODEX_PLUGIN_REPAIR_SCHEMA,
    generated_at: nowIso(),
    ok: input.ok,
    apply: input.apply,
    codex_bin: input.codexBin,
    plugin_ids: input.pluginIds,
    before: input.before,
    after: input.after,
    installs: input.installs,
    catalog_candidates: input.catalogCandidates || {},
    changed,
    rechecked_after_install: input.installs.length > 0,
    current_task_tool_manifest_verified: false,
    requires_new_task: changed,
    restart_app_if_stale: changed,
    next_actions: [
      ...(changed ? [
          'Start a new Codex/Work task so the repaired plugin skills and tools are attached to a fresh task manifest.',
          'If the plugin is still missing in the new task, restart the ChatGPT/Codex desktop app and re-run `sks doctor --fix --repair-native-capabilities --yes`.'
        ] : []),
      ...catalogCandidateActions
    ],
    blockers: input.blockers
  });
}

function pluginReady(inventory: CodexPluginInventory, pluginId: string) {
  return inventory.plugins.some((plugin) => plugin.id === pluginId && plugin.installed === true && plugin.enabled === true);
}

function pluginListed(inventory: CodexPluginInventory, pluginId: string) {
  return inventory.plugins.some((plugin) => plugin.id === pluginId);
}

function pluginCatalogCandidates(inventory: CodexPluginInventory, pluginId: string) {
  const requestedName = pluginId.slice(0, pluginId.lastIndexOf('@'));
  return inventory.plugins
    .filter((plugin) => plugin.name === requestedName || plugin.id.startsWith(`${requestedName}@`))
    .map((plugin) => plugin.id)
    .filter((id, index, values) => values.indexOf(id) === index)
    .sort();
}

function failedInventory(err: unknown): CodexPluginInventory {
  return {
    schema: 'sks.codex-plugin-inventory.v1',
    generated_at: nowIso(),
    codex_current_app_capability: null,
    fetch_concurrency: 0,
    detail_fetch_count: 0,
    detail_fetch_failed_count: 0,
    detail_json_supported: false,
    catalog_complete: false,
    installed_count: 0,
    available_count: 0,
    duration_ms: 0,
    plugins: [],
    marketplace_available: false,
    blockers: [`codex_plugin_inventory_failed:${redactString(messageOf(err))}`]
  };
}

function tail(value: unknown, max = 2000) {
  const text = redactString(String(value || ''));
  return text.length > max ? text.slice(-max) : text;
}
