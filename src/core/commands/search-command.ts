import { flag } from '../../cli/args.js';
import { printJson } from '../../cli/output.js';
import { projectRoot } from '../fsx.js';
import {
  buildSearchDoctorReport,
  printSearchDoctorReport,
  runSearchEngineBenchmark,
  search,
  searchCapabilities,
  SEARCH_SCHEMA_VERSION,
  type SearchMode
} from '../search/index.js';

export async function searchCommand(subcommand = 'status', args: string[] = []) {
  const action = subcommand || 'status';
  if (action === 'status') return statusCommand(args);
  if (action === 'files') return modeCommand('files', args);
  if (action === 'text') return modeCommand('text', args);
  if (action === 'structure') return modeCommand('structure', args);
  if (action === 'symbol') return modeCommand('symbol', args);
  if (action === 'context') return modeCommand('context', args);
  if (action === 'benchmark' || action === 'bench') return benchmarkCommand(args);
  if (action === 'doctor') return doctorCommand(args);
  if (action === 'help') return helpCommand();
  return helpCommand();
}

async function statusCommand(args: string[]) {
  const root = await projectRoot(process.cwd());
  const caps = await searchCapabilities(root);
  if (flag(args, '--json') || args.includes('--json')) return printJson(caps);
  console.log(`Search engines schemaVersion=${caps.schemaVersion}`);
  for (const [mode, info] of Object.entries(caps.modes)) {
    console.log(`- ${mode}: ${info.available ? 'available' : 'unavailable'} via ${info.provider}/${info.engine}`);
  }
  console.log(`Rust: ${caps.rust.available ? caps.rust.version : 'js_fallback'}`);
  if (caps.warnings.length) console.log(`Warnings: ${caps.warnings.join(', ')}`);
  return caps;
}

async function modeCommand(mode: SearchMode, args: string[]) {
  const root = readOption(args, '--root') || (await projectRoot(process.cwd()));
  const pattern = readOption(args, '--pattern') || positional(args).join(' ').trim();
  const language = readOption(args, '--language') || undefined;
  const include = readMulti(args, '--include');
  const exclude = readMulti(args, '--exclude');
  const json = flag(args, '--json') || args.includes('--json');
  if (!pattern && mode !== 'files') {
    throw new Error(`Usage: sks search ${mode} <pattern> [--json] [--include glob] [--exclude glob]`);
  }
  const request: Parameters<typeof search>[0] = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    mode,
    root,
    caseSensitive: !args.includes('--ignore-case'),
    limits: {
      maxMatches: numOption(args, '--max-matches', 500),
      timeoutMs: numOption(args, '--timeout-ms', 30_000)
    }
  };
  if (mode === 'files' || mode === 'symbol' || mode === 'context') request.query = pattern;
  if (mode === 'text' || mode === 'structure') request.pattern = pattern;
  if (language) request.language = language;
  if (include.length) request.include = include;
  if (exclude.length) request.exclude = exclude;
  // `--changed` names where to start, `--include` filters what comes back. The
  // context kernel cannot infer the files a question is about from the question,
  // so a caller that already knows them has to be able to say so.
  const changed = readMulti(args, '--changed');
  if (mode === 'context' && changed.length) request.changedPaths = changed;
  const why = readOption(args, '--why');
  if (why) request.why = why;
  const result = await search(request);
  if (json) return printJson(result);
  console.log(`${mode}: ${result.ok ? 'ok' : 'failed'} provider=${result.provider} matches=${result.matches.length} spawns=${result.processSpawns}`);
  for (const m of result.matches.slice(0, 30)) {
    const loc = m.line ? `:${m.line}${m.column ? `:${m.column}` : ''}` : '';
    console.log(`  ${m.path}${loc} [${m.confidence}] ${m.text || ''}`.trim());
  }
  if (result.matches.length > 30) console.log(`  ... ${result.matches.length - 30} more`);
  if (result.errors.length) console.log(`Errors: ${result.errors.join(', ')}`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function benchmarkCommand(args: string[]) {
  const report = await runSearchEngineBenchmark({ writeArtifacts: true });
  if (flag(args, '--json') || args.includes('--json')) return printJson(report);
  console.log(`Benchmark: ${report.summary.ok_count}/${report.summary.scenario_count} ok`);
  console.log(`Artifacts: .sneakoscope/reports/search-engine-benchmark.json, docs/performance/search-engine-benchmark.md`);
  return report;
}

async function doctorCommand(args: string[]) {
  const report = await buildSearchDoctorReport(args);
  printSearchDoctorReport(report, flag(args, '--json') || args.includes('--json'));
  if (!report.ok) process.exitCode = 1;
  return report;
}

function helpCommand() {
  console.log(`sks search status --json
sks search files <query> [--json]
sks search text <pattern> [--json] [--ignore-case]
sks search structure <kind> [name] --language typescript [--json]
sks search symbol <ident> [--json]
sks search context <query> [--changed path]... [--why reason] [--json]
sks search benchmark --json
sks search doctor --json`);
}

function readOption(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] || null;
}

function readMulti(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) {
      out.push(args[i + 1]!);
      i += 1;
    }
  }
  return out;
}

function numOption(args: string[], name: string, fallback: number): number {
  const raw = readOption(args, name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      if (a === '--json' || a === '--ignore-case') continue;
      i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}
