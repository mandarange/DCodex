import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  scopeCatalogBlockersToActiveProviders
} from '../../dist/core/codex-lb/desktop-controller-v3/status.js';
import {
  COMBINED_BRIDGE_CATALOG_TTL_MS
} from '../../dist/core/codex-lb/combined-catalog/contracts.js';
import {
  SELF_GUARDING_DOCTOR_PHASES,
  markDoctorPhaseClean,
  planDoctorDirtyRepair
} from '../../dist/core/doctor/doctor-dirty-planner.js';

const DOCTOR_SOURCE = fs.readFileSync('src/commands/doctor.ts', 'utf8');
const DOCTOR_CONSOLE_SOURCE = fs.readFileSync('src/commands/doctor-console.ts', 'utf8');
// The repair body moved to core (9.0.6) so the project fix transaction, the
// global-only fix, and the update migration stage execute the SAME code path.
const CATALOG_REPAIR_SOURCE = fs.readFileSync('src/core/doctor/desktop-bridge-catalog-repair.ts', 'utf8');

test('a problem only an inactive provider has never blocks bridge readiness', () => {
  const scoped = scopeCatalogBlockersToActiveProviders(
    ['codex_lb_catalog_stale', 'openrouter_credential_missing', 'catalog_route_index_stale'],
    new Set(['codex_lb_catalog_stale']),
    new Set(['openrouter_credential_missing'])
  );
  // The active provider's stale catalog still blocks,
  assert.ok(scoped.includes('codex_lb_catalog_stale'));
  // an aggregate blocker owned by no single provider still blocks,
  assert.ok(scoped.includes('catalog_route_index_stale'));
  // and the inactive provider's missing credential does not. Readiness demoted
  // it to `inactive_provider:openrouter:...` and the combined catalog promoted
  // the same fact straight back, so one report carried it as a warning AND a
  // blocker. Nothing routes to that provider and `--fix` cannot invent an API
  // key, so it was a blocker no run could ever clear.
  assert.ok(!scoped.includes('openrouter_credential_missing'));
});

test('a problem an active provider shares stays a blocker', () => {
  assert.deepEqual(
    scopeCatalogBlockersToActiveProviders(['shared'], new Set(['shared']), new Set(['shared'])),
    ['shared']
  );
});

function catalogRepairPhaseSource() {
  const start = CATALOG_REPAIR_SOURCE.indexOf("id: 'desktop_bridge_catalog_repair'");
  assert.ok(start > 0, 'the desktop_bridge_catalog_repair phase moved or was renamed');
  const end = CATALOG_REPAIR_SOURCE.indexOf('desktop_bridge_catalog_sync_failed', start);
  assert.ok(end > start, 'the catalog repair phase no longer ends where this test expects');
  return CATALOG_REPAIR_SOURCE.slice(start, end);
}

test('the catalog repair addresses the bridge under HOME, never the project root', () => {
  const phase = catalogRepairPhaseSource();
  // Every bridge path is derived from HOME (`<home>/.codex/...`). Passing the
  // project root found no managed bridge whenever doctor ran from inside a
  // project — the common case — so the repair concluded there was nothing to
  // do, returned a green check, and the stale catalog survived every `--fix`.
  assert.ok(!/home:\s*root\b/.test(phase), 'the catalog repair passed the project root as a bridge home');
  assert.match(phase, /const bridgeHome = path\.resolve\(process\.env\.HOME/);
  assert.equal(
    (phase.match(/home:\s*bridgeHome/g) || []).length,
    4,
    'the restart, the status read, the sync, and the read-back must all address the same resolved home'
  );
});

test('every --fix entry point executes the one shared bridge repair', () => {
  // 9.0.2 split the routes: project --fix kept the repair while the home-rooted
  // global-only fix kept only the STATUS read — reporting `codex_lb_catalog_stale`
  // with the remedy `retry_catalog_sync` as the one fix run that never executed
  // that remedy. Both doctor routes and the update migration stage must call the
  // single core implementation.
  // The transaction phase is the LAST id occurrence in doctor.ts; the first is
  // the global-only fix's catch fallback.
  const phaseWiring = DOCTOR_SOURCE.lastIndexOf("id: 'desktop_bridge_catalog_repair'");
  assert.ok(phaseWiring > 0, 'the project fix transaction no longer wires the catalog repair phase');
  const transactionSlice = DOCTOR_SOURCE.slice(phaseWiring, phaseWiring + 900);
  assert.match(transactionSlice, /repairDoctorDesktopBridgeCatalog\(\{ fix: doctorFix \}\)/);
  const globalOnly = DOCTOR_SOURCE.slice(
    DOCTOR_SOURCE.indexOf('export async function executeDoctorGlobalOnlyFix'),
    DOCTOR_SOURCE.indexOf('async function runDoctorGlobalOnlyFix')
  );
  assert.match(
    globalOnly,
    /deps\.desktopBridgeRepairImpl \|\| repairDoctorDesktopBridgeCatalog/,
    'the global-only fix must run the shared bridge repair (injectable for tests)'
  );
  // Repair BEFORE the status read: the report must be the post-repair snapshot
  // (the 8.6.6 lesson — doctor once printed the very blockers it had just cleared).
  const repairAt = globalOnly.indexOf('desktopBridgeRepairImpl(');
  const statusAt = globalOnly.indexOf('inspectDoctorDesktopBridgeStatus(');
  assert.ok(repairAt > 0 && statusAt > repairAt, 'global-only must repair first and report the post-repair status');
  const migrationStage = fs.readFileSync('src/core/update/update-migration-state/desktop-bridge-catalog-repair-stage.ts', 'utf8');
  assert.match(migrationStage, /repairDoctorDesktopBridgeCatalog\(\{ fix: true \}\)/);
});

test('doctor reports the bridge as it is AFTER the repair transaction', () => {
  const before = DOCTOR_SOURCE.indexOf('const desktopBridgeBeforeFix =');
  const transaction = DOCTOR_SOURCE.indexOf('const doctorFixTransaction =');
  const after = DOCTOR_SOURCE.indexOf('const desktopBridge = doctorFixTransaction');
  const bound = DOCTOR_SOURCE.lastIndexOf('desktop_bridge: desktopBridge,');
  assert.ok(before > 0 && transaction > before, 'the pre-fix snapshot must be taken before the transaction');
  assert.ok(after > transaction, 'the reported bridge must be re-read after the repair transaction closes');
  assert.ok(bound > after, 'the composed result must bind the post-repair snapshot');
  // The console renderer prints from the composed result — the same object the
  // JSON view serializes — so the human summary cannot diverge from it.
  assert.match(DOCTOR_CONSOLE_SOURCE, /const desktopBridge = result\.desktop_bridge/);
  assert.match(DOCTOR_CONSOLE_SOURCE, /`Desktop Bridge: \$\{desktopBridge\.ok/);
  // Doctor used to report the pre-repair snapshot, so a catalog repair that
  // succeeded still printed `Desktop Bridge: blocked` listing the blockers it
  // had just cleared — from the user's side indistinguishable from a repair
  // that never ran, and identical no matter how often they re-ran `--fix`.
  assert.equal(
    (DOCTOR_SOURCE.match(/desktopBridgeBeforeFix/g) || []).length,
    2,
    'nothing downstream may read the pre-fix snapshot: it is the declaration plus the no-fix fallback'
  );
});

test('a provider catalog stays fresh longer than a working session', () => {
  // At 15 minutes every install reported `<provider>_catalog_stale` a quarter of
  // an hour after its last sync, and nothing refreshes the catalog in the
  // background — the running bridge never reads `expires_at`. So doctor synced
  // it, verified it, went green, and the next run showed the identical blocker:
  // the `--fix` treadmill users hit as "the bridge never gets fixed".
  assert.ok(
    COMBINED_BRIDGE_CATALOG_TTL_MS >= 8 * 60 * 60 * 1000,
    'a catalog nothing refreshes in the background must not expire inside a working day'
  );
  assert.ok(
    COMBINED_BRIDGE_CATALOG_TTL_MS <= 7 * 24 * 60 * 60 * 1000,
    'it must still expire, or a model withdrawn upstream keeps being routed'
  );
});

test('the catalog repair is re-evaluated even when its clean marker matches', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-catalog-phase-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const proofId = markDoctorPhaseClean(root, 'desktop_bridge_catalog_repair', 'doctor-catalog-clean-fixture', true);
  await fsp.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
  await fsp.writeFile(
    path.join(root, '.sneakoscope', 'reports', 'doctor-fix-transaction.json'),
    JSON.stringify({ proof_ids_used: [proofId] }),
    'utf8'
  );
  // A catalog lapses with the passage of time, which nothing this planner hashes
  // can observe. The marker written while it was fresh made `doctor --fix` skip
  // the repair the user was running it for and print a green check over an
  // expired catalog — every run, indefinitely.
  const plan = planDoctorDirtyRepair(root, ['desktop_bridge_catalog_repair']);
  const phase = plan.phases.find((entry) => entry.id === 'desktop_bridge_catalog_repair');
  assert.equal(phase?.status, 'dirty');
  assert.equal(phase?.reason, 'self_guarding_phase');
  assert.ok(SELF_GUARDING_DOCTOR_PHASES.has('desktop_bridge_catalog_repair'));
});
