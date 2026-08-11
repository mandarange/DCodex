import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_BRIDGE_DRAIN_GRACE_MS
} from '../../dist/core/codex-lb/desktop-bridge/server.js';
import {
  migrationFailureBlocker
} from '../../dist/core/codex-lb/desktop-bridge-migration.js';
import { CATALOG_REPAIR_MAX_ATTEMPTS } from '../../dist/commands/doctor.js';

test('shutdown allows in-flight work a bounded grace period', () => {
  // Shutdown destroyed every open socket immediately, so anything the bridge
  // was carrying died mid-flight — reported by the client as
  // "error sending request for url" or "stream disconnected before completion"
  // while the bridge logged `bridge_client_disconnected`. A configuration
  // change restarts the service, so this fired during ordinary operation.
  assert.ok(Number.isInteger(DESKTOP_BRIDGE_DRAIN_GRACE_MS));
  assert.ok(DESKTOP_BRIDGE_DRAIN_GRACE_MS >= 1_000, 'a grace period below a second cannot drain a real request');
  assert.ok(DESKTOP_BRIDGE_DRAIN_GRACE_MS <= 30_000, 'a stuck request must not hold a restart open indefinitely');
});

test('a failed migration names its cause without leaking request data', () => {
  // The cause used to live only in an `error` field nothing surfaced, so every
  // failure reached the operator as the same opaque code.
  assert.equal(
    migrationFailureBlocker(Object.assign(new Error('x'), { code: 'ENOENT' })),
    'desktop_bridge_unification_migration_failed:ENOENT',
  );
  assert.equal(
    migrationFailureBlocker(new Error('bridge_config_locked')),
    'desktop_bridge_unification_migration_failed:bridge_config_locked',
  );
  // Free-form text is never appended: this blocker is rendered to the operator
  // and written to reports, and a message can carry a path or a value.
  const freeform = migrationFailureBlocker(new Error('failed writing /Users/someone/.codex/config.toml token=abc123'));
  assert.equal(freeform, 'desktop_bridge_unification_migration_failed');
  assert.ok(!freeform.includes('/Users/'));
  assert.ok(!freeform.includes('token'));
});

test('the catalog repair retries, because one attempt demonstrably is not enough', () => {
  // The unification migration inside `catalog.sync` was observed failing (its
  // rollback failing too) and then succeeding on the very next attempt, on two
  // separate machines — leaving users a stale catalog behind a green check.
  assert.ok(CATALOG_REPAIR_MAX_ATTEMPTS >= 2, 'a single attempt is what left the catalog stale');
  assert.ok(CATALOG_REPAIR_MAX_ATTEMPTS <= 3, 'a broken catalog must still be reported promptly');
});
