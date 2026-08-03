# MAD-SKS

MAD-SKS is the single current, explicitly authorized high-risk route. It widens
only the scopes named by the operator and includes a mission-bound SQL-plane
executor for database work. It does not create a second orchestration runtime,
redirect retired DB commands, or carry authority into later routes.

## Authority Model

```bash
sks mad-sks plan --target-root <path> --json
sks mad-sks permissions --json
sks mad-sks run --target-root <path> --json
sks mad-sks apply --target-root <path> --yes --json
sks mad-sks sql "<statement>" --json
sks mad-sks apply-migration <file> --json
sks mad-sks rollback-apply --rollback-plan <path> --yes --json
sks mad-sks status --json
sks mad-sks proof --json
```

MAD-SKS starts disabled. Write-capable work requires an authorization manifest
that binds user intent, target root, allowed and forbidden scopes, timestamp,
and hash. `run` is dry-run by default; `apply` performs only the sealed executor
operation. Separate consent is required for system access, database writes,
package installation, service control, admin operations, network operations,
Computer Use, destructive delete, browser automation, generated asset edits,
and file-permission changes.

## SQL-Plane Boundary

SQL and migration operations use a mission-local capability and runtime
profile. The executor validates target identity and tool inventory, records the
operation lifecycle, performs read-back verification, closes the capability in
`finally`, and proves that the persistent MCP configuration is read-only again.
Catastrophic SQL classes are allowed only when the sealed user request
explicitly names the operation and target; control-plane account, billing,
credential, token, project, organization, and branch operations remain denied.

## Official Subagent Cockpit

MAD-SKS uses the native Codex CLI and official subagent lifecycle events for the
current workflow. A trustworthy structured parent outcome remains the only
terminal success or failure authority.

## Evidence And Boundaries

Every full-system action records action type, before/after hashes where
available, exit code, duration, risk, rollback availability, secret-redaction
status, and protected-core impact. Completion Proof, Trust Report, Evidence
Router, Wrongness Memory, and rollback plans link to those receipts.

MAD-SKS may change only the user-authorized target and scopes. It must not store
sudo passwords, leak secrets, perform destructive deletion without exact
confirmation, or treat third-party systems as implicitly authorized. Installed
SKS package roots remain protected; the Sneakoscope engine source repository is
the explicit development exception for normal verified release work.
