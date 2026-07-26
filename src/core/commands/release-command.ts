import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { flag } from '../../cli/args.js';
import { printJson } from '../../cli/output.js';
import { exists, projectRoot, readJson, writeJsonAtomic, writeTextAtomic } from '../fsx.js';
import { createMission } from '../mission.js';
import { type ProcessRunner, stagePublish } from '../release/stage-publish.js';

export function usage(): string {
  return [
    'Usage: sks release affected|full|background|stage [--json]',
    '',
    'Run affected release proof, full release proof, or background release proof explicitly.',
    '',
    'Subcommands:',
    '  affected     Changed-scope release proof (default)',
    '  full         Full foreground release gate graph',
    '  background   Full release gate graph, detached logs',
    '  stage        Drive the staged npm publish up to the human approval step',
    '',
    'Options for stage:',
    '  --confirm            Perform the outward steps: push main, dispatch the',
    '                       stage workflow, wait, download and verify the tarball.',
    '                       Without it, stage only reports what it would do.',
    '  --version <semver>   Version to stage (defaults to package.json).',
    '',
    'stage never runs `npm stage approve`; that approval is a human 2FA step.'
  ].join('\n');
}

export async function releaseCommand(args: string[] = []): Promise<unknown> {
  const root = await projectRoot();
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'affected';
  const json = flag(args, '--json');
  if (sub === 'stage') return runStageSubcommand(root, args, json);
  const command = commandForSubcommand(sub);
  if (!command) {
    console.error(usage());
    process.exitCode = 1;
    return null;
  }
  const mission = await createMission(root, { mode: 'release-review', prompt: `Release review ${sub}` });
  const result = spawnSync(process.execPath, command.args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
    env: { ...process.env, CI: process.env.CI || 'true' }
  });
  const stdoutPath = path.join(mission.dir, 'release-command-stdout.log');
  const stderrPath = path.join(mission.dir, 'release-command-stderr.log');
  await writeTextAtomic(stdoutPath, String(result.stdout || ''));
  await writeTextAtomic(stderrPath, String(result.stderr || ''));
  const readiness = await findReleaseReadinessReport(root);
  const requiredSections: string[] = [];
  const missingSections = requiredSections.filter((section) => readiness.report?.[section] == null);
  if (readiness.report) await writeJsonAtomic(path.join(mission.dir, 'release-readiness-report.json'), readiness.report);
  const report = {
    schema: 'sks.release-command.v1',
    ok: result.status === 0 && readiness.valid === true && missingSections.length === 0,
    subcommand: sub,
    mission_id: mission.id,
    command: [process.execPath, ...command.args],
    status: result.status,
    release_report: readiness.path,
    release_report_valid: readiness.valid,
    missing_sections: missingSections,
    blockers: [
      ...(result.status === 0 ? [] : ['release_subprocess_failed']),
      ...(readiness.valid ? [] : ['release_report_missing_or_invalid']),
      ...missingSections.map((section) => `release_report_missing_section:${section}`)
    ],
    logs: {
      stdout: path.relative(root, stdoutPath),
      stderr: path.relative(root, stderrPath)
    },
    stdout_tail: tail(String(result.stdout || '')),
    stderr_tail: tail(String(result.stderr || ''))
  };
  if (!report.ok) process.exitCode = result.status || 1;
  if (json) return printJson(report);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return report;
}

async function runStageSubcommand(root: string, args: string[], json: boolean): Promise<unknown> {
  const report = stagePublish({
    root,
    confirm: flag(args, '--confirm'),
    run: spawnRunner(root),
    ...(readOption(args, '--version') ? { version: readOption(args, '--version')! } : {})
  });
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'release-stage-publish.json'), report).catch(() => {});
  if (!report.ok) process.exitCode = 1;
  if (json) return printJson(report);
  for (const step of report.steps) {
    const mark = step.blocker ? '✖' : step.attempted ? '✔' : '·';
    console.log(`${mark} ${step.id}${step.detail ? ` — ${step.detail}` : ''}${step.blocker ? ` (${step.blocker})` : ''}`);
  }
  if (report.stage_id) console.log(`\nStage id: ${report.stage_id}`);
  for (const action of report.next_actions) console.log(`- ${action}`);
  return report;
}

function spawnRunner(root: string): ProcessRunner {
  return (command, commandArgs, opts = {}) => {
    const result = spawnSync(command, [...commandArgs], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {})
    });
    return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  };
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : null;
  return value && !value.startsWith('-') ? value : null;
}

async function findReleaseReadinessReport(root: string) {
  const candidates = [
    path.join(root, 'release-readiness-report.json'),
    path.join(root, '.sneakoscope', 'reports', 'release-readiness-report.json')
  ];
  const reportsDir = path.join(root, '.sneakoscope', 'reports');
  const entries = await fsp.readdir(reportsDir).catch(() => []);
  for (const entry of entries) {
    if (/^release-readiness.*\.json$/.test(entry)) candidates.push(path.join(reportsDir, entry));
  }
  const existing = [];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      const stat = await fsp.stat(candidate).catch(() => null);
      existing.push({ path: candidate, mtime: stat?.mtimeMs || 0 });
    }
  }
  existing.sort((a, b) => b.mtime - a.mtime);
  const selected = existing[0]?.path || null;
  const report = selected ? await readJson(selected, null) : null;
  return {
    path: selected ? path.relative(root, selected) : null,
    report,
    valid: Boolean(report && typeof report.schema === 'string' && /release-readiness/.test(report.schema))
  };
}

function commandForSubcommand(sub: string): { args: string[] } | null {
  if (sub === 'affected') return { args: ['dist/scripts/release-gate-dag-runner.js', '--preset', 'affected', '--changed-since', 'auto', '--sla', '5m'] };
  if (sub === 'full') return { args: ['dist/scripts/release-gate-dag-runner.js', '--preset', 'release', '--full'] };
  if (sub === 'background') return { args: ['dist/scripts/release-gate-dag-runner.js', '--preset', 'release', '--full'] };
  return null;
}

function tail(value: string, limit = 4000): string {
  return value.length > limit ? value.slice(-limit) : value;
}
