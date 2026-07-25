import { projectRoot } from '../fsx.js';
import { searchCapabilities } from './provider.js';
import { search } from './provider.js';
import { SEARCH_SCHEMA_VERSION } from './types.js';

export async function buildSearchDoctorReport(args: string[] = []) {
  const root = await projectRoot(process.cwd());
  const capabilities = await searchCapabilities(root);
  const smokeFiles = await search({
    schemaVersion: SEARCH_SCHEMA_VERSION,
    mode: 'files',
    root,
    query: 'package.json',
    limits: { maxMatches: 5, timeoutMs: 10_000 }
  });
  const smokeText = await search({
    schemaVersion: SEARCH_SCHEMA_VERSION,
    mode: 'text',
    root,
    pattern: 'SearchProvider|sks\\.search-provider',
    include: ['src/core/search/**'],
    limits: { maxMatches: 20, timeoutMs: 15_000 }
  });
  const smokeStructure = await search({
    schemaVersion: SEARCH_SCHEMA_VERSION,
    mode: 'structure',
    root,
    pattern: 'function_declaration search',
    language: 'typescript',
    include: ['src/core/search/**'],
    limits: { maxMatches: 20, timeoutMs: 15_000 }
  });

  const blockers: string[] = [];
  if (!smokeFiles.ok) blockers.push('files_engine_failed');
  if (!smokeText.ok) blockers.push('text_engine_failed');
  if (!smokeStructure.ok) blockers.push(...smokeStructure.errors.map((e) => `structure:${e}`));
  if (capabilities.warnings.includes('sks_rs_search_unavailable')) {
    // warning only — JS fallback is valid
  }

  const report = {
    schema: 'sks.search-doctor.v1',
    ok: blockers.length === 0,
    root,
    capabilities,
    smoke: {
      files: { ok: smokeFiles.ok, provider: smokeFiles.provider, matches: smokeFiles.matches.length, processSpawns: smokeFiles.processSpawns },
      text: { ok: smokeText.ok, provider: smokeText.provider, matches: smokeText.matches.length, processSpawns: smokeText.processSpawns },
      structure: { ok: smokeStructure.ok, provider: smokeStructure.provider, matches: smokeStructure.matches.length, errors: smokeStructure.errors }
    },
    external_binaries: {
      rg_required: false,
      ast_grep_required: false,
      fd_required: false
    },
    blockers,
    args
  };
  return report;
}

export function printSearchDoctorReport(report: Awaited<ReturnType<typeof buildSearchDoctorReport>>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Search doctor: ${report.ok ? 'ok' : 'blocked'}`);
  console.log(`Root: ${report.root}`);
  console.log(`Rust search: ${report.capabilities.rust.available ? report.capabilities.rust.version : 'js_fallback'}`);
  console.log(`Files smoke: ${report.smoke.files.provider} matches=${report.smoke.files.matches} spawns=${report.smoke.files.processSpawns}`);
  console.log(`Text smoke: ${report.smoke.text.provider} matches=${report.smoke.text.matches} spawns=${report.smoke.text.processSpawns}`);
  console.log(`Structure smoke: ${report.smoke.structure.provider} matches=${report.smoke.structure.matches}`);
  if (report.blockers.length) console.log(`Blockers: ${report.blockers.join(', ')}`);
}
