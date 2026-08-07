import { flag, readOption } from '../cli/args.js';
import { printJson } from '../cli/output.js';
import { codexCompatibilityReport, codexDoctorReport } from '../core/codex-compat/codex-compat-report.js';
import { codexVersionReport } from '../core/codex-compat/codex-version.js';
import { codexSchemaSnapshotReport } from '../core/codex-compat/codex-schema-snapshot.js';
import { detectCodexCurrentCapability } from '../core/codex-control/codex-current-capability.js';
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../core/codex-compat/codex-runtime-contract.js';
import { codexCliUpdateConsoleLines, inspectCodexCliUpdate, updateCodexCliNow } from '../core/codex/codex-cli-update.js';

export async function run(_command: any, args: any = []) {
  const action = args[0] || 'compatibility';
  if (action === 'compatibility' || action === 'compat') {
    const requiredBaseline = readOption(args, '--require', null);
    const result = await codexCompatibilityReport({ requiredBaseline, require: requiredBaseline });
    if (flag(args, '--json')) return printJson(result);
    console.log(`Codex compatibility: ${result.ok ? result.status : 'blocked'} (${result.required_baseline})`);
    for (const warning of result.warnings || []) console.log(`- ${warning}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'version') {
    const result = await codexVersionReport();
    if (flag(args, '--json')) return printJson(result);
    console.log(`Codex detected: ${result.detected.version || 'not installed'} (${result.policy.status})`);
    return;
  }
  if (action === 'update-status' || action === 'update-check') {
    const result = await inspectCodexCliUpdate({ force: flag(args, '--refresh') || flag(args, '--force') });
    if (flag(args, '--json')) {
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    console.log(`Codex CLI: ${result.current_version || 'not installed'}${result.latest_version ? ` (latest ${result.latest_version})` : ''}`);
    console.log(`Update: ${result.update_available === true ? 'available' : result.update_available === false ? 'current' : 'unverified'}`);
    for (const warning of result.warnings) console.log(`- warning: ${warning}`);
    for (const actionLine of result.guidance) console.log(`- ${actionLine}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'update' || action === 'update-now') {
    const result = await updateCodexCliNow();
    if (flag(args, '--json')) {
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    for (const line of codexCliUpdateConsoleLines(result)) console.log(line);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'current' || action === CURRENT_CODEX_RUNTIME_CONTRACT.targetTag) {
    const result = await detectCodexCurrentCapability({ requireReal: flag(args, '--require-real') });
    if (flag(args, '--json')) return printJson(result);
    console.log(`Codex ${CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion} compatibility: ${result.ok ? 'ok' : 'blocked'} (${result.probe_mode})`);
    for (const blocker of result.blockers || []) console.log(`- blocker: ${blocker}`);
    for (const warning of result.warnings || []) console.log(`- warning: ${warning}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'doctor') {
    const result = await codexDoctorReport();
    if (flag(args, '--json')) return printJson(result);
    console.log(`Codex doctor: ${result.ok ? 'ok' : 'blocked'}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'schema' || action === 'snapshot') {
    const result = await codexSchemaSnapshotReport();
    if (flag(args, '--json')) return printJson(result);
    console.log(`Codex hook schema snapshot: ${result.ok ? 'ok' : 'blocked'} (${result.baseline})`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  console.error('Usage: sks codex compatibility|version|update-status [--refresh]|update|doctor|schema|current [--json]');
  process.exitCode = 1;
}
