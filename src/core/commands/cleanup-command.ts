import { printJson } from '../../cli/output.js';
import { projectRoot } from '../fsx.js';
import {
  applyTriWikiCleanup,
  inspectTriWikiBlankState,
  planTriWikiCleanup,
  TRIWIKI_CLEANUP_RECEIPT_REL,
  validateTriWikiCleanupReceipt
} from '../triwiki/triwiki-cleanup.js';
import { flag } from './command-utils.js';

const ACTIONS = new Set(['plan', 'run', 'status', 'proof', 'help', '--help', '-h']);

export async function cleanupCommand(sub: any = 'plan', args: any[] = []) {
  const action = String(sub || 'plan').toLowerCase();
  if (action === 'help' || action === '--help' || action === '-h') return printHelp();
  if (!ACTIONS.has(action)) return invalid(args);
  const root = await projectRoot();

  if (action === 'plan') {
    const plan = await planTriWikiCleanup(root);
    if (!plan.ok) process.exitCode = 1;
    return output(args, plan, () => {
      console.log(`TriWiki cleanup plan: ${plan.ok ? 'ready' : 'blocked'}`);
      console.log(`Active targets: ${plan.totals.targets}; files: ${plan.totals.files}; bytes: ${plan.totals.bytes}`);
      console.log('Apply: sks cleanup run --apply');
    });
  }

  if (action === 'run') {
    if (!flag(args, '--apply')) {
      process.exitCode = 1;
      return output(args, {
        schema: 'sks.triwiki-cleanup-command.v1',
        ok: false,
        status: 'blocked',
        error: 'explicit_apply_required',
        hint: 'Review `sks cleanup plan`, then run `sks cleanup run --apply`.'
      }, () => console.error('TriWiki cleanup blocked: pass --apply after reviewing the plan.'));
    }
    const receipt = await applyTriWikiCleanup(root);
    return output(args, {
      schema: 'sks.triwiki-cleanup-command.v1',
      ok: receipt.ok,
      status: receipt.ok ? 'blank' : 'blocked',
      receipt_path: TRIWIKI_CLEANUP_RECEIPT_REL,
      receipt
    }, () => {
      console.log('TriWiki cleanup: blank active state verified');
      console.log(`Deleted: ${receipt.files_deleted} files / ${receipt.bytes_deleted} bytes; retained backup: no`);
      console.log('Align is optional and may be run at any time: sks align run');
    });
  }

  if (action === 'status') {
    const blank = await inspectTriWikiBlankState(root);
    return output(args, { schema: 'sks.triwiki-cleanup-status.v1', ok: true, status: blank.blank ? 'blank' : 'populated', blank }, () => {
      console.log(`TriWiki active state: ${blank.blank ? 'blank' : 'populated'}`);
      for (const target of blank.active_targets) console.log(`- ${target.path}`);
      for (const file of blank.projected_agents_blocks) console.log(`- projected block: ${file}`);
    });
  }

  const proof = await validateTriWikiCleanupReceipt(root);
  if (!proof.ok) process.exitCode = 1;
  return output(args, { schema: 'sks.triwiki-cleanup-proof.v1', ...proof }, () => {
    console.log(`TriWiki cleanup proof: ${proof.ok ? 'pass' : 'blocked'}`);
    for (const blocker of proof.blockers) console.log(`- ${blocker}`);
  });
}

function output(args: any[], value: any, textOutput: () => void) {
  if (flag(args, '--json')) printJson(value);
  else textOutput();
  return value;
}

function invalid(args: any[]) {
  process.exitCode = 1;
  return output(args, {
    schema: 'sks.triwiki-cleanup-command.v1',
    ok: false,
    error: 'unsupported_cleanup_action'
  }, () => console.error('Usage: sks cleanup plan|run|status|proof [--apply] [--json]'));
}

function printHelp() {
  console.log(`SKS Cleanup — blank the active TriWiki without deleting source or audit history

Usage:
  sks cleanup plan [--json]
  sks cleanup run --apply [--json]
  sks cleanup status [--json]
  sks cleanup proof [--json]

The R3 run command permanently removes active TriWiki memory, graph, packs,
caches, reports, stale TriWiki staging generations, and managed AGENTS.md
projections after a content-bound plan/apply check. It does not retain an old
generation. Repository source, ordinary documentation, missions, evidence, and
the release proof bank are preserved. Align is independent: run \`sks align run\`
whenever a fresh code-navigation index is wanted.`);
}
