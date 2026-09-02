export async function runSks(args: string[]): Promise<void> {
  if (args[0] === 'commands' && args.includes('--json')) {
    const { commandsJsonFast } = await import('../cli/commands-fast.js');
    commandsJsonFast();
  } else if (args[0] === 'dollar-commands' && args.includes('--json')) {
    const { dollarCommandsJsonFast } = await import('../core/routes/dollar-manifest-lite.js');
    dollarCommandsJsonFast();
  } else if (args[0] === 'root' && args.includes('--json')) {
    const getBuiltinModule = (process as unknown as { getBuiltinModule?: (name: string) => any }).getBuiltinModule;
    const fs = typeof getBuiltinModule === 'function' ? getBuiltinModule('node:fs') : await import('node:fs');
    const { rootJsonFastInline } = await import('./fast-inline.js');
    rootJsonFastInline(fs);
  } else if (args[0] === 'doctor' && args.includes('--json') && !args.includes('--report-file') && !args.includes('--fix') && !args.includes('--full') && !args.includes('--capabilities') && !args.includes('--profile') && !args.includes('--search')) {
    const { doctorJsonFastInline } = await import('./fast-inline.js');
    await doctorJsonFastInline();
  } else if (args[0] === 'super-search' && args[1] === 'doctor') {
    const superSearchDoctorModule = '../core/super-search/doctor.js';
    const { buildSuperSearchDoctorReport, printSuperSearchDoctorReport } = await import(superSearchDoctorModule);
    const doctorArgs = args.slice(2);
    printSuperSearchDoctorReport(await buildSuperSearchDoctorReport(doctorArgs), doctorArgs.includes('--json'));
  } else if (args[0] === 'hook' && args[1] === 'user-prompt-submit' && process.env.SKS_PERF_MEASURE === '1') {
    const { hookUserPromptSubmitPerfInline } = await import('./fast-inline.js');
    await hookUserPromptSubmitPerfInline();
  } else if (args[0] === 'hook' && args[1] && (await import('../core/verification-profile.js')).hookDaemonEnabled()) {
    // Daemon-accelerated hook path: identical decisions, ~150 ms instead of a
    // ~600 ms cold start per hook. On by default; SKS_HOOK_DAEMON=0 opts out,
    // and the test harness stays on the cold path so no detached daemon leaks.
    const { hookDaemonInline } = await import('../core/daemon/sksd-hook-dispatch.js');
    await hookDaemonInline(args[1]);
  } else if (args.length === 3 && args[0] === 'naruto' && args[1] === 'help' && args[2] === '--json') {
    const { narutoHelpJsonFastInline } = await import('./fast-inline.js');
    await narutoHelpJsonFastInline();
  } else if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    // `sks help --help` asks for help about help; the flag is not a usage topic,
    // so it must not be reported as an unknown one.
    const topics = args.slice(1).filter((arg) => arg !== '--help' && arg !== '-h');
    if (topics.length > 0) {
      const { helpCommand } = await import('../core/commands/basic-cli.js');
      await (helpCommand as (args: string[]) => Promise<unknown> | unknown)(topics);
    } else {
      const { helpFast } = await import('../cli/help-fast.js');
      helpFast();
    }
  } else {
    const { main } = await import('../cli/main.js');
    await main(args);
  }
}
