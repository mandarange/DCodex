/**
 * Fixture repository description types.
 *
 * Fixtures are stored as data, not as thousands of committed files: a definition
 * lists workspace-relative paths and their contents, and the builder materializes
 * them into a temp directory that is deleted again when the case finishes.
 */
import type { ContextGraphBenchmarkFixtureFamily } from '../types.js';

export interface FixtureFile {
  /** Workspace-relative POSIX path inside the materialized fixture. */
  readonly path: string;
  readonly content: string;
}

export interface FixtureSymlink {
  readonly path: string;
  /** Relative target. When `escapesWorkspace` is true the target resolves outside the fixture root. */
  readonly target: string;
  readonly escapesWorkspace: boolean;
}

export interface FixtureGitPlan {
  /** Appended to an already-committed file so the working tree becomes dirty. */
  readonly dirtyAppend: readonly FixtureFile[];
  /** Written after the commit so the paths stay untracked. */
  readonly untracked: readonly FixtureFile[];
}

export interface FixtureDefinition {
  readonly family: ContextGraphBenchmarkFixtureFamily;
  readonly description: string;
  readonly files: readonly FixtureFile[];
  readonly symlinks?: readonly FixtureSymlink[];
  /** Generated files for volume families; keeps the committed definition small. */
  readonly generated?: (index: number) => readonly FixtureFile[];
  readonly generatedCount?: number;
  readonly git?: FixtureGitPlan;
}

export function lines(...values: readonly string[]): string {
  return `${values.join('\n')}\n`;
}

export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
