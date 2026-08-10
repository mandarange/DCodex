import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inspectOfficialSubagentToml,
  readOfficialSubagentConfig
} from '../subagents/official-subagent-config.js';
import { type DoctorFixTransaction } from './doctor-transaction.js';

export interface DoctorConfigDiskVerification {
  schema: 'sks.doctor-config-disk-verification.v1';
  ok: boolean;
  project_config_path: string;
  codex_home_config_path: string;
  project_config_present: boolean;
  codex_home_config_present: boolean;
  multi_agent_v2_enabled: boolean | null;
  agents_enabled: boolean | null;
  blockers: string[];
}

/**
 * Re-read both Codex configs FROM DISK after every repair has run.
 *
 * `doctorRepairPostcheck` is a pure function over the transaction object: it
 * restates fields the phases already reported and can only ever agree with
 * them. It also runs before the post-transaction mutators
 * (`mcpTransportCollisionRepair`, `codexNativeRepair`), so a repair that broke
 * a config after the transaction closed was invisible. This is the one check
 * that reads the real files and can contradict a phase that claimed success.
 */
export async function verifyCodexConfigsOnDisk(input: {
  root: string;
  home?: string;
  codexHome?: string;
}): Promise<DoctorConfigDiskVerification> {
  const root = path.resolve(input.root);
  const home = input.home || process.env.HOME || os.homedir();
  const codexHome = input.codexHome || process.env.CODEX_HOME || path.join(home, '.codex');
  const projectConfigPath = path.join(root, '.codex', 'config.toml');
  const codexHomeConfigPath = path.join(codexHome, 'config.toml');
  const blockers: string[] = [];

  const [projectText, homeText] = await Promise.all([
    fs.readFile(projectConfigPath, 'utf8').catch(() => null),
    fs.readFile(codexHomeConfigPath, 'utf8').catch(() => null)
  ]);
  if (projectText !== null && !inspectOfficialSubagentToml(projectText).ok) {
    blockers.push('project_codex_config_unparseable_after_repair');
  }
  if (homeText !== null && !inspectOfficialSubagentToml(homeText).ok) {
    blockers.push('codex_home_config_unparseable_after_repair');
  }

  let multiAgentV2Enabled: boolean | null = null;
  let agentsEnabled: boolean | null = null;
  if (!blockers.length) {
    const config = await readOfficialSubagentConfig(root, { home, codexHome }).catch(() => null);
    if (config) {
      multiAgentV2Enabled = config.multiAgentV2.enabled;
      agentsEnabled = config.enabled;
      for (const blocker of config.blockers) blockers.push(`official_subagent_config:${blocker}`);
      // Codex resolves an enabled `multi_agent_v2` to V2 regardless of
      // `agents.enabled`, so only the combination leaves the lane off.
      if (multiAgentV2Enabled === false) {
        blockers.push('official_subagent_multi_agent_v2_disabled_after_repair');
        if (agentsEnabled === false) blockers.push('official_subagent_agents_disabled_after_repair');
      }
    }
  }

  return {
    schema: 'sks.doctor-config-disk-verification.v1',
    ok: blockers.length === 0,
    project_config_path: projectConfigPath,
    codex_home_config_path: codexHomeConfigPath,
    project_config_present: projectText !== null,
    codex_home_config_present: homeText !== null,
    multi_agent_v2_enabled: multiAgentV2Enabled,
    agents_enabled: agentsEnabled,
    blockers: [...new Set(blockers)]
  };
}

export function doctorRepairPostcheck(transaction: DoctorFixTransaction | null | undefined) {
  const phases = transaction?.phases || [];
  const requiredBlockers = phases
    .filter((phase) => phase.required_for_ready !== false && phase.ok !== true)
    .flatMap((phase) => phase.blockers.length ? phase.blockers : [`required_phase_not_ready:${phase.id}`]);
  const optionalWarnings = phases
    .filter((phase) => phase.required_for_ready === false && phase.ok !== true)
    .flatMap((phase) => phase.blockers.length ? phase.blockers.map((blocker) => `optional:${blocker}`) : [`optional_phase_not_ready:${phase.id}`]);
  const routeBlockers = Object.fromEntries(phases
    .flatMap((phase) => Object.entries((phase as any).route_blockers || {}))
    .map(([scope, blockers]) => [scope, Array.isArray(blockers) ? blockers.map(String) : []]));
  return {
    schema: 'sks.doctor-repair-postcheck.v2',
    ok: transaction?.postcheck_ok === true && requiredBlockers.length === 0 && Number(transaction?.mutations_without_rollback || 0) === 0,
    transaction_ok: transaction?.ok === true,
    required_ready: requiredBlockers.length === 0,
    mutations_without_rollback: Number(transaction?.mutations_without_rollback || 0),
    manual_required: phases.filter((phase) => phase.manual_required).map((phase) => phase.id),
    pending_manual: [
      ...phases.filter((phase) => phase.manual_required).map((phase) => phase.id),
      ...requiredBlockers.map((blocker) => `postcheck:${blocker}`)
    ],
    optional_manual_required: phases.filter((phase) => phase.manual_required && phase.required_for_ready === false).map((phase) => phase.id),
    required_blockers: [...new Set(requiredBlockers)],
    optional_warnings: [...new Set(optionalWarnings)],
    route_blockers: routeBlockers,
    blockers: [...new Set(requiredBlockers)]
  };
}
