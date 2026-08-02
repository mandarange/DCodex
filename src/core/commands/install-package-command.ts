import { spawnSync } from 'node:child_process';
import { PACKAGE_VERSION } from '../version.js';
import { inspectInstalledCliResolution } from '../update/installed-cli-resolution.js';
import { compareSemVer, extractSemVer } from '../update/semver.js';

const LATEST_INSTALL_COMMAND = 'npm exec --yes --package=sneakoscope@latest -- sneakoscope install --yes';

export async function installPackageCommand(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = args.find((arg) => !arg.startsWith('-')) || 'install';
  const autonomous = args.includes('--no-tui') || args.includes('--yes') || args.includes('-y');

  if (!['install', 'setup', 'bootstrap'].includes(command)) {
    console.error('Usage: npm exec --yes --package=sneakoscope@latest -- sneakoscope install [--yes|--no-tui]');
    process.exitCode = 2;
    return;
  }

  console.log('SKS installer - proof-first Codex harness');
  const previousProbe = spawnSync('sks', ['--version'], { encoding: 'utf8' });
  const previousVersion = previousProbe.status === 0
    ? extractSemVer(`${previousProbe.stdout || ''}\n${previousProbe.stderr || ''}`)
    : null;

  const latestProbe = spawnSync('npm', [
    'view',
    'sneakoscope',
    'version',
    '--silent',
    '--prefer-online'
  ], { encoding: 'utf8' });
  const registryLatest = latestProbe.status === 0
    ? extractSemVer(`${latestProbe.stdout || ''}\n${latestProbe.stderr || ''}`)
    : null;
  if (!registryLatest) {
    console.error('Could not verify the current sneakoscope@latest version; refusing to install from an unverified cache.');
    console.error(`Retry with network access: ${LATEST_INSTALL_COMMAND}`);
    process.exitCode = 1;
    return;
  }
  if (compareSemVer(registryLatest, PACKAGE_VERSION) === 1) {
    console.error(`This installer package is stale (${PACKAGE_VERSION}); the registry latest is ${registryLatest}.`);
    console.error(`Run the current package explicitly: ${LATEST_INSTALL_COMMAND}`);
    process.exitCode = 1;
    return;
  }

  console.log(`> installing exact global package (npm i -g sneakoscope@${PACKAGE_VERSION})...`);
  if (run('npm', ['install', '-g', `sneakoscope@${PACKAGE_VERSION}`]) !== 0) {
    console.error('global install failed - check npm permissions');
    process.exitCode = 1;
    return;
  }

  const globalRootProbe = spawnSync('npm', ['root', '--global', '--silent'], { encoding: 'utf8' });
  const globalRoot = globalRootProbe.status === 0
    ? String(globalRootProbe.stdout || '').trim().split(/\r?\n/).pop() || null
    : null;
  let installed = await inspectInstalledCliResolution({
    packageName: 'sneakoscope',
    expectedVersion: PACKAGE_VERSION,
    globalRoot,
    env: process.env,
    cwd: process.cwd()
  });
  const exactPackageInstalled = installed.manifest_name === 'sneakoscope'
    && installed.manifest_version === PACKAGE_VERSION
    && installed.entrypoint_version === PACKAGE_VERSION
    && Boolean(installed.entrypoint);
  if (!exactPackageInstalled) {
    console.error(`installed package identity verification failed: ${installed.blockers.join(', ') || 'unknown blocker'}`);
    printRollback(previousVersion);
    process.exitCode = 1;
    return;
  }

  console.log('> repairing/validating environment (exact installed SKS doctor --fix)...');
  if (run(process.execPath, [installed.entrypoint!, 'doctor', '--fix', ...(autonomous ? ['--yes'] : [])]) !== 0) {
    console.error('doctor reported blockers - see report above');
    printRollback(previousVersion);
    process.exitCode = 1;
    return;
  }

  installed = await inspectInstalledCliResolution({
    packageName: 'sneakoscope',
    expectedVersion: PACKAGE_VERSION,
    globalRoot,
    env: process.env,
    cwd: process.cwd()
  });
  if (!installed.ok) {
    console.error(`SKS ${PACKAGE_VERSION} was installed, but your PATH still resolves ${installed.path_version || 'no SKS'} at ${installed.path_binary || 'no path'}.`);
    console.error(`verification blockers: ${installed.blockers.join(', ')}`);
    console.error('Remove or reorder the older npm prefix on PATH, then rerun this installer. The installer will not claim success while an older command wins.');
    printRollback(previousVersion);
    process.exitCode = 1;
    return;
  }

  console.log(`
SKS ready. 다음 3개만 기억하세요 (Codex 입력창에서):
   $sks-plan "무엇을 만들지" - 계획만 세움 (코드 안 건드림)
   $sks-work                 - 계획을 증거 기반으로 실행
   실행 상태: sks status --json / zellij 세션은 자동
`);
}

function run(cmd: string, cmdArgs: string[]): number {
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
  return result.status ?? 1;
}

function printRollback(previousVersion: string | null): void {
  if (previousVersion && previousVersion !== PACKAGE_VERSION) {
    console.error(`Recover the prior package with: npm install -g sneakoscope@${previousVersion}`);
  }
}
