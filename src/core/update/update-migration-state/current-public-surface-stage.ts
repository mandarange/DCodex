import os from 'node:os';
import path from 'node:path';
import type { UpdateMigrationStageRun } from '../update-migration-state.js';

type StageOutcome = Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>;

export async function runCurrentPublicSurfaceReconcileStage(root: string): Promise<StageOutcome> {
  const [
    { runDoctorCommandAliasCleanup },
    { migrateSksProfilesToPerFile },
    { cleanupRetiredRemoteBridgeLaunchAgent, quarantineRetiredRemoteBridgeBindings }
  ] = await Promise.all([
    import('../../doctor/command-alias-cleanup.js'),
    import('../../auto-review.js'),
    import('../../codex-app/menubar/migration.js')
  ]);
  const home = path.resolve(process.env.HOME || os.homedir());
  const globalRuntimeRoot = path.resolve(process.env.SKS_GLOBAL_ROOT || path.join(home, '.sneakoscope-global'));
  // Serialize config writers: public-surface guidance and profile migration both touch ~/.codex/config.toml.
  const publicSurface = await runDoctorCommandAliasCleanup({
    root,
    home,
    globalRuntimeRoot,
    fix: true,
    managedGenerationAlreadyConverged: true
  });
  const profileMigration = await migrateSksProfilesToPerFile({ env: process.env }).catch((err: any) => ({
    error: err?.message || String(err),
    retired_profile_table_count: 0,
    retired_profile_file_removed_count: 0
  }));
  const retiredLaunchAgent = await cleanupRetiredRemoteBridgeLaunchAgent({ home, env: process.env });
  const retiredBindings = await quarantineRetiredRemoteBridgeBindings(root);
  const remainingCount = Number(publicSurface.cleanup?.remaining_count || 0)
    + Number(publicSurface.cleanup?.managed_runtime?.remaining_managed_artifact_count || 0)
    + Number(publicSurface.cleanup?.project_guidance?.remaining_count || 0);
  const blockers = [
    ...(publicSurface.ok === true ? [] : ['public_surface_reconcile_failed']),
    ...(retiredLaunchAgent.ok ? [] : retiredLaunchAgent.blockers),
    ...(retiredBindings.ok ? [] : retiredBindings.blockers),
    ...((profileMigration as any).error ? [`retired_profile_migration_failed:${(profileMigration as any).error}`] : []),
    ...(remainingCount > 0 ? [`public_surface_remaining:${remainingCount}`] : [])
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'failed' : 'ok',
    actions: [
      'reconciled_current_public_surface',
      ...(retiredLaunchAgent.status === 'removed' ? ['retired_remote_bridge_launch_agent_removed'] : []),
      ...(retiredBindings.status === 'quarantined' ? ['retired_remote_bridge_bindings_quarantined'] : [])
    ],
    blockers,
    warnings: [
      ...(publicSurface.warnings || []),
      ...retiredLaunchAgent.warnings,
      ...retiredBindings.warnings
    ],
    detail: {
      removed_skill_count: Number(publicSurface.cleanup?.removed_count || 0),
      quarantined_skill_collision_count: Number(publicSurface.cleanup?.preserved_user_collision_count || 0),
      removed_runtime_artifact_count: Number(publicSurface.cleanup?.managed_runtime?.removed_managed_artifact_count || 0),
      quarantined_runtime_collision_count: Number(publicSurface.cleanup?.managed_runtime?.preserved_user_file_count || 0),
      reconciled_guidance_count: Number(publicSurface.cleanup?.project_guidance?.reconciled_count || 0),
      quarantined_guidance_collision_count: Number(publicSurface.cleanup?.project_guidance?.preserved_user_file_count || 0),
      removed_retired_role_count: 0,
      quarantined_retired_role_collision_count: 0,
      retired_profile_table_count: Number((profileMigration as any).retired_profile_table_count || 0),
      retired_profile_file_removed_count: Number((profileMigration as any).retired_profile_file_removed_count || 0),
      retired_remote_bridge_launch_agent_status: retiredLaunchAgent.status,
      retired_remote_bridge_binding_status: retiredBindings.status,
      retired_remote_bridge_binding_count: retiredBindings.retired_binding_count,
      retired_remote_bridge_binding_quarantine_path: retiredBindings.quarantine_path,
      remaining_count: remainingCount
    }
  };
}
