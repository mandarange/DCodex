#!/usr/bin/env node
import path from 'node:path';
import { writeJsonAtomic } from '../core/fsx.js';
import {
  desktopBridgeStatusV3,
  verifyDesktopBridgeV3
} from '../core/codex-lb/desktop-controller.js';

const args = process.argv.slice(2);
const home = readArg('--home') || process.env.HOME || undefined;
const reportPath = path.join(
  process.cwd(),
  '.sneakoscope',
  'reports',
  'desktop-bridge-real-evidence-check.json'
);

let status: Awaited<ReturnType<typeof desktopBridgeStatusV3>> | null = null;
let capabilities: Awaited<ReturnType<typeof verifyDesktopBridgeV3>> | null = null;
const blockers: string[] = [];
try {
  status = await desktopBridgeStatusV3({ ...(home ? { home } : {}) });
  if (!status.management.managed) blockers.push('desktop_bridge_not_managed');
  if (!status.service.running) blockers.push('desktop_bridge_not_running');
  if (status.service.running) {
    capabilities = await verifyDesktopBridgeV3('deep', { ...(home ? { home } : {}) });
    if (!capabilities.execution.ok) blockers.push(...capabilities.execution.blockers);
    if (!capabilities.summary.deep_level_satisfied) blockers.push('desktop_bridge_deep_level_not_satisfied');
    if (!capabilities.summary.full_feature_verified) blockers.push('desktop_bridge_full_feature_not_verified');
  }
  if (!status.readiness.ready) blockers.push(...status.readiness.blockers);
} catch (error: unknown) {
  blockers.push(safeError(error));
}

const uniqueBlockers = [...new Set(blockers)];
const ok = status?.readiness.ready === true
  && capabilities?.execution.ok === true
  && capabilities.summary.deep_level_satisfied === true
  && capabilities.summary.full_feature_verified === true
  && uniqueBlockers.length === 0;
const report = {
  schema: 'sks.desktop-bridge-real-evidence-check.v1' as const,
  ok,
  status: ok ? 'passed' : 'real_required_missing',
  release_authorizing: ok,
  managed_runtime: status?.management.runtime || null,
  bridge_running: status?.service.running === true,
  readiness: status?.readiness || null,
  capabilities,
  blockers: uniqueBlockers,
  warnings: status?.readiness.warnings || [],
  report_path: path.relative(process.cwd(), reportPath).split(path.sep).join('/')
};
await writeJsonAtomic(reportPath, report);
console.log(JSON.stringify(report, null, 2));
if (!ok) process.exitCode = 1;

function readArg(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]+$/i.test(message)
    ? message
    : 'desktop_bridge_real_evidence_check_failed';
}
