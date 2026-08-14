import os from 'node:os';
import path from 'node:path';
import { exists } from '../../fsx.js';
import { desktopBridgeServicePaths } from '../../codex-lb/desktop-service.js';
import { repairDoctorDesktopBridgeCatalog } from '../../doctor/desktop-bridge-catalog-repair.js';

export interface DesktopBridgeCatalogRepairStageRun {
  ok: boolean;
  status: 'ok' | 'skipped' | 'failed';
  actions: string[];
  blockers: string[];
  warnings: string[];
}

/**
 * Clear a stale codex-lb combined catalog as part of the update itself.
 *
 * `sks update` restarts a stale bridge runtime (desktop-bridge-restage, 9.0.1)
 * but used to leave a stale combined catalog for the user to DISCOVER: the
 * next Doctor run reported `codex_lb_catalog_stale` for an update that had
 * just printed success. This stage runs the same self-guarding repair Doctor
 * `--fix` uses (status read, then sync + read-back verification only when a
 * `*_catalog_stale` blocker is present), so an update finishes with the same
 * catalog state a follow-up `sks doctor --fix` would produce.
 *
 * Guards, in order, and why each one exists:
 * - not under `node --test` (NODE_TEST_CONTEXT) and not SKS_TEST_ISOLATION:
 *   the repair can reach `/bin/launchctl`, which addresses the real gui domain
 *   regardless of any HOME redirection; harnessed runs must never touch the
 *   operator's actual service or catalog.
 * - bridge settings file must exist: it is HOME-derived and written only by a
 *   managed bridge — absent means there is no catalog to repair.
 * - a failed repair NEVER fails the update: bridge readiness is deliberately
 *   not a migration-profile gate, so the stage reports a warning that NAMES
 *   the follow-up command instead of voiding an otherwise good update.
 */
export async function runDesktopBridgeCatalogRepairStage(): Promise<DesktopBridgeCatalogRepairStageRun> {
  const skip = (reason: string): DesktopBridgeCatalogRepairStageRun =>
    ({ ok: true, status: 'ok', actions: [reason], blockers: [], warnings: [] });
  if (process.platform !== 'darwin') return skip('desktop_bridge_catalog_repair_not_macos');
  if (process.env.NODE_TEST_CONTEXT !== undefined) return skip('desktop_bridge_catalog_repair_skipped_under_tests');
  if (process.env.SKS_TEST_ISOLATION === '1') return skip('desktop_bridge_catalog_repair_skipped_under_tests');
  if (process.env.SKS_SKIP_BRIDGE_CATALOG_REPAIR === '1') return skip('desktop_bridge_catalog_repair_disabled');
  const home = path.resolve(process.env.HOME || os.homedir());
  if (!(await exists(desktopBridgeServicePaths(home).settings_path))) {
    return skip('desktop_bridge_catalog_repair_no_managed_bridge');
  }
  const repair = await repairDoctorDesktopBridgeCatalog({ fix: true }).catch((error: any) => ({
    ok: false,
    repaired: false,
    warnings: [] as string[],
    blockers: [`desktop_bridge_catalog_repair_failed:${error?.message || String(error)}`]
  }));
  if (repair.ok) {
    return {
      ok: true,
      status: 'ok',
      actions: [repair.repaired ? 'desktop_bridge_catalog_repaired' : 'desktop_bridge_catalog_clean'],
      blockers: [],
      warnings: repair.warnings || []
    };
  }
  return {
    ok: true,
    status: 'ok',
    actions: [],
    blockers: [],
    warnings: [
      ...(repair.blockers || []).map((blocker: string) => `desktop_bridge_catalog_repair_incomplete:${blocker}`),
      'Desktop Bridge catalog still needs repair: run `sks doctor --fix`'
    ]
  };
}
