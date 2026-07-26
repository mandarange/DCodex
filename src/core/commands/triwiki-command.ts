import { flag } from '../../cli/args.js';
import { printJson } from '../../cli/output.js';
import { projectRoot } from '../fsx.js';
import { computeTriWikiAffectedGraph } from '../triwiki/triwiki-affected-graph.js';
import { buildTriWikiGateImpactMap } from '../triwiki/triwiki-gate-impact-map.js';
import { DEFAULT_TRIWIKI_MODULE_CARDS } from '../triwiki/triwiki-module-card.js';
import { summarizeTriWikiProofBank } from '../triwiki/triwiki-proof-bank.js';
import { isTriWikiGraphSubcommand, triwikiGraphCommand } from './triwiki-graph-command.js';

export async function triwikiCommand(args: string[] = []): Promise<unknown> {
  const root = await projectRoot();
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'index';
  const json = flag(args, '--json');
  let result: unknown;
  if (isTriWikiGraphSubcommand(sub)) {
    const answer = await triwikiGraphCommand(root, sub, args.slice(1));
    process.exitCode = answer.ok ? 0 : 2;
    if (json) return printJson(answer.result);
    for (const line of answer.lines) console.log(line);
    return answer.result;
  }
  if (sub === 'index') {
    result = {
      schema: 'sks.triwiki-index.v1',
      ok: true,
      modules: DEFAULT_TRIWIKI_MODULE_CARDS,
      impact_map: buildTriWikiGateImpactMap(root),
      proof_bank: summarizeTriWikiProofBank(root)
    };
  } else if (sub === 'affected') {
    result = computeTriWikiAffectedGraph({ root, tier: 'affected' });
  } else if (sub === 'proof-bank') {
    result = summarizeTriWikiProofBank(root);
  } else {
    console.error('Usage: sks triwiki index|affected|proof-bank|graph-status|graph-lint|graph-query [--json]');
    process.exitCode = 1;
    return null;
  }
  if (json) return printJson(result);
  console.log(JSON.stringify(result, null, 2));
  return result;
}
