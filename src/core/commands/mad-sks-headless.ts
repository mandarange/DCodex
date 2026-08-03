import path from 'node:path';
import { appendJsonlBounded, nowIso, writeJsonAtomic } from '../fsx.js';

export async function writeMadNativeSession(madLaunch: any, workspace: string) {
  const report = {
    schema: 'sks.mad-native-session.v1',
    generated_at: nowIso(),
    ok: true,
    kind: 'mad',
    status: 'native-codex-ready',
    mission_id: madLaunch.mission_id,
    workspace,
    root: madLaunch.root,
    cwd: path.resolve(process.cwd()),
    execution_surface: 'base-codex-cli',
    blockers: [],
    warnings: []
  };
  await writeJsonAtomic(path.join(madLaunch.dir, 'mad-native-session.json'), report);
  await appendJsonlBounded(path.join(madLaunch.dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'mad_sks.native_session_ready',
    execution_surface: report.execution_surface
  });
  return report;
}
