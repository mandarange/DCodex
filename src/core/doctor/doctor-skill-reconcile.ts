import os from 'node:os';
import path from 'node:path';
import { reconcileLegacyManagedGeneration } from '../init/legacy-generation-convergence.js';

export async function reconcileDoctorSkills(root: string, doctorFix: boolean): Promise<any> {
  if (!doctorFix) return { skipped: true, reason: 'doctor_without_fix' };

  const home = path.resolve(process.env.HOME || os.homedir());
  const convergence = await reconcileLegacyManagedGeneration({ root, home, fix: true });
  const projectTarget = path.resolve(root, '.agents', 'skills');
  const project = convergence.project_skills.find(
    (report) => path.resolve(report.target_dir) === projectTarget
  ) || {
    schema: 'sks.skill-reconcile.v1',
    ok: true,
    scope: 'project',
    target_dir: projectTarget,
    fix: true,
    skipped: true,
    reason: 'same_as_authoritative_global_skill_root'
  };
  return {
    global: convergence.global_skills,
    project,
    convergence
  };
}
