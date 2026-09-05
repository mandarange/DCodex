import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function run(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('error', (error) => resolve({ code: 1, output: error.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

test('progress recovery policy never terminates by time and only auto-resumes bounded network failures', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift policy verification is macOS-only')
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-progress-recovery-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const sourceRoot = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources')
  const models = path.join(sourceRoot, 'OperationModels.swift')
  const source = path.join(sourceRoot, 'OperationCoordinator.swift')
  const main = path.join(temp, 'main.swift')
  const executable = path.join(temp, 'progress-recovery')
  await fs.writeFile(main, String.raw`
import Foundation

enum AppRuntime { static let lastActionLogPath = "/private/tmp/sks-public-operation.log" }

let now = Date(timeIntervalSince1970: 1_800_000_000)
let progressing = OperationRecoveryPolicy.evaluate(
    cause: nil, sameCauseRetryCount: 0, progressSignal: .testResult,
    progressObserved: true, secondsWithoutProgress: 99_999, warningAfter: 10,
    pinnedMode: "codex-lb", pinnedModel: "gpt-5.6-sol", now: now
)
precondition(progressing.state == .active)
precondition(!progressing.automaticResume)
precondition(progressing.accountBinding == "pinned_unchanged")
precondition(progressing.evidenceIntegrity == "preserved")

let warningOnly = OperationRecoveryPolicy.evaluate(
    cause: nil, sameCauseRetryCount: 0, progressSignal: .none,
    progressObserved: false, secondsWithoutProgress: 3_600, warningAfter: 60, now: now
)
precondition(warningOnly.state == .warning)
precondition(!warningOnly.automaticResume)
precondition(warningOnly.stallReason?.contains("warning-only") == true)

for retry in 0..<2 {
    let network = OperationRecoveryPolicy.evaluate(
        cause: .transientNetwork, sameCauseRetryCount: retry,
        progressSignal: .toolResponse, progressObserved: false,
        secondsWithoutProgress: 60, warningAfter: 30,
        pinnedMode: "openrouter", pinnedModel: "registered/model", now: now
    )
    precondition(network.state == .autoResumePending)
    precondition(network.automaticResume)
    precondition(network.retryCount == retry + 1)
    precondition(network.pinnedMode == "openrouter")
    precondition(network.pinnedModel == "registered/model")
}
let exhaustedNetwork = OperationRecoveryPolicy.evaluate(
    cause: .transientNetwork, sameCauseRetryCount: 2,
    progressSignal: .none, progressObserved: false,
    secondsWithoutProgress: 60, warningAfter: 30, now: now
)
precondition(exhaustedNetwork.state == .pausedResumable)
precondition(!exhaustedNetwork.automaticResume)
precondition(exhaustedNetwork.retryCount == 2)

for cause in [OperationRecoveryCause.authentication, .providerMode, .accountBinding, .externalConfiguration, .unknown] {
    let decision = OperationRecoveryPolicy.evaluate(
        cause: cause, sameCauseRetryCount: 0, progressSignal: .none,
        progressObserved: false, secondsWithoutProgress: 60, warningAfter: 30,
        pinnedMode: "chatgpt-oauth", pinnedModel: nil, now: now
    )
    precondition(decision.state == .pausedResumable)
    precondition(!decision.automaticResume)
    precondition(decision.retryCount == 0)
    precondition(decision.pinnedMode == "chatgpt-oauth")
}

let operationDirectory = CommandLine.arguments[1]
let coordinator = OperationCoordinator(directory: operationDirectory)
guard let first = coordinator.begin(kind: "provider-mode-switch", mutationGroup: "codex-config", summary: "Switch mode") else {
    preconditionFailure("first operation did not start")
}
let authPause = OperationRecoveryPolicy.evaluate(
    cause: .authentication, sameCauseRetryCount: 0,
    progressSignal: .modelResponse, progressObserved: false,
    secondsWithoutProgress: 90, warningAfter: 30,
    pinnedMode: "codex-lb", pinnedModel: "gpt-5.6-sol", now: now
)
let paused = coordinator.recordRecovery(first, status: authPause, summary: "Authentication review required")
precondition(paused.state == .waitingForConfirmation)
precondition(paused.recovery?.state == .pausedResumable)
// A resumable manual pause releases the mutation guard so the operator can fix
// settings. It does not silently run or change the pinned session.
precondition(coordinator.begin(kind: "credential-repair", mutationGroup: "codex-config", summary: "Repair") != nil)

let latest = coordinator.latestSnapshot()
precondition(latest != nil)
let files = try FileManager.default.contentsOfDirectory(atPath: operationDirectory)
let receipts = try files.filter { $0.hasSuffix(".json") }.map {
    try String(contentsOfFile: operationDirectory + "/" + $0, encoding: .utf8)
}.joined(separator: "\n")
precondition(!receipts.lowercased().contains("api_key"))
precondition(!receipts.lowercased().contains("request_body"))
precondition(!receipts.lowercased().contains("account_id"))
precondition(receipts.contains("pinned_unchanged"))
precondition(receipts.contains("preserved"))

func waitUntil(_ done: @escaping () -> Bool) {
    let deadline = Date().addingTimeInterval(2)
    while !done(), Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    precondition(done())
}

// The reusable executor performs the same retry-safe request twice after the
// initial transient network failure and then reports real progress.
let networkCoordinator = OperationCoordinator(directory: operationDirectory + "-network")
let networkOperation = networkCoordinator.begin(kind: "catalog-refresh", mutationGroup: nil, summary: "Refresh")!
var networkAttempts = 0
var networkDone = false
var networkFinal: OperationSnapshot?
networkCoordinator.executeWithRecovery(
    networkOperation,
    pinnedMode: "codex-lb",
    pinnedModel: "gpt-5.6-sol",
    retryDelay: 0,
    attempt: { _, finish in
        networkAttempts += 1
        finish(networkAttempts < 3 ? .failure(.transientNetwork) : .success(.toolResponse))
    },
    onStatus: { _ in },
    completion: { succeeded, snapshot in
        precondition(succeeded)
        networkFinal = snapshot
        networkDone = true
    }
)
waitUntil { networkDone }
precondition(networkAttempts == 3)
precondition(networkFinal?.recovery?.state == .active)
precondition(networkFinal?.recovery?.retryCount == 2)
precondition(networkFinal?.recovery?.pinnedMode == "codex-lb")

// Authentication never consumes an automatic retry.
let authCoordinator = OperationCoordinator(directory: operationDirectory + "-auth")
let authOperation = authCoordinator.begin(kind: "auth-check", mutationGroup: nil, summary: "Auth")!
var authAttempts = 0
var authDone = false
var authFinal: OperationSnapshot?
authCoordinator.executeWithRecovery(
    authOperation,
    pinnedMode: "openrouter",
    pinnedModel: "registered/model",
    retryDelay: 0,
    attempt: { _, finish in
        authAttempts += 1
        finish(.failure(.authentication))
    },
    onStatus: { _ in },
    completion: { succeeded, snapshot in
        precondition(!succeeded)
        authFinal = snapshot
        authDone = true
    }
)
waitUntil { authDone }
precondition(authAttempts == 1)
precondition(authFinal?.recovery?.state == .pausedResumable)
precondition(authFinal?.recovery?.automaticResume == false)
`, 'utf8')

  const compiled = await run('swiftc', [models, source, main, '-o', executable])
  assert.equal(compiled.code, 0, compiled.output)
  const executed = await run(executable, [path.join(temp, 'operations')])
  assert.equal(executed.code, 0, executed.output)
})

test('SKS Center shows relevant recovery and an explicit review path', async () => {
  const sourceRoot = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources')
  const [models, coordinatorSource, overview] = await Promise.all([
    fs.readFile(path.join(sourceRoot, 'OperationModels.swift'), 'utf8'),
    fs.readFile(path.join(sourceRoot, 'OperationCoordinator.swift'), 'utf8'),
    fs.readFile(path.join(sourceRoot, 'OverviewViewController.swift'), 'utf8')
  ])
  const coordinator = `${models}\n${coordinatorSource}`
  assert.match(coordinator, /maxAutomaticNetworkRetries = 2/)
  assert.match(coordinator, /if progressObserved/)
  assert.match(coordinator, /cause == \.transientNetwork, retryCount < maxAutomaticNetworkRetries/)
  assert.match(coordinator, /case \.pausedResumable: nextState = \.waitingForConfirmation/)
  assert.match(coordinator, /func executeWithRecovery/)
  assert.match(coordinator, /guard decision\.state == \.autoResumePending else/)
  assert.match(coordinator, /accountBinding: "pinned_unchanged"/)
  assert.match(coordinator, /evidenceIntegrity: "preserved"/)
  assert.doesNotMatch(coordinator, /apiKey|requestBody|accountIdentifier/)
  assert.match(overview, /Progress, pause & recovery/)
  assert.match(overview, /recoveryCard\.isHidden = !active && !needsReview/)
  assert.match(overview, /recovery\.state == \.pausedResumable \|\| recovery\.state == \.warning/)
  assert.ok(overview.includes('\\(operation.publicSummary)\\n\\(recovery.nextAction)'))
  assert.match(overview, /Review & Resume…/)
  assert.match(overview, /Nothing resumed automatically/)
})
