import path from 'node:path';
import { nowIso, writeJsonAtomic } from '../fsx.js';
import { repairAgentRoleConfigs } from '../agents/agent-role-config.js';
import { repairAgentConfigFileReferences } from '../codex/agent-config-file-repair.js';
import { postcheckCodexStartupConfig } from '../codex/codex-startup-config-postcheck.js';
import { messageOf } from '../errors/message.js';

type CodexStartupConfigRepairReport = {
  schema: string
  generated_at: string
  ok: boolean
  apply: boolean
  role_repair: Awaited<ReturnType<typeof repairAgentRoleConfigs>>
  config_file_repair: Awaited<ReturnType<typeof repairAgentConfigFileReferences>>
  postcheck: Awaited<ReturnType<typeof postcheckCodexStartupConfig>>
  blockers: string[]
  report_write_failed?: boolean
}

export async function repairCodexStartupConfig(input: {
  root: string
  apply?: boolean
  reportPath?: string | null
  home?: string
  codexHome?: string
  globalRuntimeRoot?: string
}): Promise<CodexStartupConfigRepairReport> {
  const root = path.resolve(input.root);
  const roleRepair = await repairAgentRoleConfigs({
    root,
    apply: input.apply === true,
    reportPath: path.join(root, '.sneakoscope', 'reports', 'agent-role-config-repair.json'),
    ...(input.home ? { home: input.home } : {}),
    ...(input.codexHome ? { codexHome: input.codexHome } : {}),
    ...(input.globalRuntimeRoot ? { globalRuntimeRoot: input.globalRuntimeRoot } : {})
  });
  const fileRepair = await repairAgentConfigFileReferences({
    root,
    apply: input.apply === true,
    reportPath: path.join(root, '.sneakoscope', 'reports', 'agent-config-file-repair.json'),
    ...(input.home ? { home: input.home } : {}),
    ...(input.codexHome ? { codexHome: input.codexHome } : {})
  });
  const postcheck = await postcheckCodexStartupConfig({
    root,
    reportPath: path.join(root, '.sneakoscope', 'reports', 'codex-startup-config-postcheck.json'),
    ...(input.home ? { home: input.home } : {}),
    ...(input.codexHome ? { codexHome: input.codexHome } : {})
  });
  let report: CodexStartupConfigRepairReport = {
    schema: 'sks.codex-startup-config-repair.v1',
    generated_at: nowIso(),
    ok: roleRepair.ok && fileRepair.ok && postcheck.ok,
    apply: input.apply === true,
    role_repair: roleRepair,
    config_file_repair: fileRepair,
    postcheck,
    blockers: [
      ...((roleRepair as { blockers?: string[] }).blockers || []),
      ...fileRepair.blockers,
      ...postcheck.blockers
    ]
  };
  if (input.reportPath !== null) {
    const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'codex-startup-config-repair.json');
    try {
      await writeJsonAtomic(reportPath, report);
    } catch (err: unknown) {
      report = { ...report, report_write_failed: true };
      process.stderr.write(`SKS doctor warning: failed to write Codex startup repair report ${reportPath}: ${messageOf(err)}\n`);
    }
  }
  return report;
}
