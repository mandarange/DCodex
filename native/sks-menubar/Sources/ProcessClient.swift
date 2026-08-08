import Cocoa
import Darwin

struct ProcessResult {
    let code: Int32
    let output: String
    let truncated: Bool
    let timedOut: Bool
    let emptyOutput: Bool
}

final class ProcessClient {
    private static let defaultTimeout: TimeInterval = 90
    private static let maximumTimeout: TimeInterval = 60 * 60
    private static let readChunkBytes = 16 * 1024
    private let actionScript: String
    private let logPath: String
    private let projectRoot: String
    // Bridge status/repair JSON scales with the combined catalog (395+ models
    // ≈ 120KB today); 64KB truncated every routing-aware command result.
    private let outputLimit = 1024 * 1024
    private let processIdentityGuard: ProcessIdentityGuard
    private let ownedProcessRegistry: OwnedProcessRegistry

    init(
        actionScript: String,
        logPath: String,
        projectRoot: String,
        processIdentityGuard: ProcessIdentityGuard = ProcessIdentityGuard()
    ) {
        self.actionScript = actionScript
        self.logPath = logPath
        self.projectRoot = projectRoot
        self.processIdentityGuard = processIdentityGuard
        self.ownedProcessRegistry = OwnedProcessRegistry(identityGuard: processIdentityGuard)
    }

    func run(
        _ arguments: [String],
        stdin: String? = nil,
        environment: [String: String] = [:],
        timeout: TimeInterval? = nil,
        maxOutputBytes: Int? = nil,
        logOutput: Bool = true,
        completion: @escaping (ProcessResult) -> Void
    ) {
        let process = Process()
        let output = Pipe()
        let effectiveOutputLimit = max(1024, min(1024 * 1024, maxOutputBytes ?? outputLimit))
        let sensitiveValues = sensitiveStdinValues(arguments: arguments, stdin: stdin)
        let childEnvironment = ProcessInfo.processInfo.environment.merging(environment) { _, override in override }
        let effectiveTimeout = min(Self.maximumTimeout, max(1, timeout ?? Self.defaultTimeout))
        let execution = ProcessExecutionState()
        let terminationSignal = DispatchSemaphore(value: 0)
        process.executableURL = URL(fileURLWithPath: actionScript)
        process.arguments = arguments
        process.terminationHandler = { _ in terminationSignal.signal() }
        if !environment.isEmpty {
            process.environment = childEnvironment
        }
        // The action script intentionally starts from HOME. Launching zsh with a
        // protected project directory as its initial cwd can block in getcwd()
        // before the script runs (for example when the project lives on Desktop).
        // Commands that need project context pass --project-root explicitly.
        process.currentDirectoryURL = homeDirectory(for: childEnvironment)
        process.standardOutput = output
        process.standardError = output
        var input: Pipe?
        if stdin != nil {
            input = Pipe()
            process.standardInput = input
        } else {
            // GUI/launchd stdin can remain open indefinitely. Commands that do
            // not explicitly receive input must observe EOF instead of keeping
            // Node's event loop alive after their JSON result is ready.
            process.standardInput = FileHandle.nullDevice
        }
        do {
            try process.run()
            ownedProcessRegistry.track(process, reader: output.fileHandleForReading)
            observeDescendants(of: process, until: execution)
            output.fileHandleForWriting.closeFile()
            if let stdin = stdin, let input = input {
                input.fileHandleForWriting.write(Data(stdin.utf8))
                input.fileHandleForWriting.closeFile()
            }
            let timeoutWorkItem = DispatchWorkItem {
                guard execution.markTimedOut() else { return }
                self.terminate(process, reader: output.fileHandleForReading)
            }
            let timeoutDeadline = DispatchTime.now() + effectiveTimeout
            let terminationDeadline = timeoutDeadline + 2
            DispatchQueue.global(qos: .utility).asyncAfter(
                deadline: timeoutDeadline,
                execute: timeoutWorkItem
            )
            DispatchQueue.global(qos: .utility).async {
                let data = self.readBoundedOutput(
                    from: output.fileHandleForReading,
                    limit: effectiveOutputLimit,
                    process: process,
                    execution: execution
                )
                // Registering a termination handler before launch avoids a
                // Foundation race where waitUntilExit() can miss an exit that
                // occurs while the bounded reader is being closed. The wait
                // itself is also deadline-bounded in case Foundation never
                // delivers the termination callback after forced termination.
                if terminationSignal.wait(timeout: terminationDeadline) == .timedOut {
                    if execution.markTimedOut() {
                        self.terminate(process, reader: output.fileHandleForReading)
                    }
                }
                self.waitForForceKilledDescendants(of: process, timeout: 1)
                self.waitForOwnedProcessGroup(of: process, timeout: 1)
                execution.markCompleted()
                self.ownedProcessRegistry.untrack(process)
                timeoutWorkItem.cancel()
                let terminationReason = execution.terminationReason
                let timedOut = terminationReason == .timeout
                let truncated = terminationReason == .outputLimit
                let rawText = String(data: data, encoding: .utf8) ?? ""
                let emptyOutput = !timedOut
                    && !truncated
                    && rawText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                let resultCode: Int32 = timedOut ? -2 : truncated ? -4 : emptyOutput ? -3 : process.terminationStatus
                let text = timedOut
                    ? self.timeoutOutput(
                        rawText,
                        sensitiveValues: sensitiveValues,
                        arguments: arguments
                    )
                    : truncated
                        ? self.outputLimitOutput(
                            rawText,
                            sensitiveValues: sensitiveValues,
                            arguments: arguments
                        )
                    : emptyOutput
                        ? Self.nativeFailureOutput("native_process_empty_output")
                        : self.publicOutput(
                            rawText,
                            code: resultCode,
                            sensitiveValues: sensitiveValues,
                            arguments: arguments
                        )
                if logOutput {
                    self.writeLog(command: arguments, output: text, sensitiveValues: sensitiveValues)
                }
                DispatchQueue.main.async {
                    completion(ProcessResult(
                        code: resultCode,
                        output: text,
                        truncated: truncated,
                        timedOut: timedOut,
                        emptyOutput: emptyOutput
                    ))
                }
            }
        } catch {
            let text = publicOutput(
                String(describing: error),
                code: -1,
                sensitiveValues: sensitiveValues,
                arguments: arguments
            )
            if logOutput {
                writeLog(command: arguments, output: text, sensitiveValues: sensitiveValues)
            }
            DispatchQueue.main.async {
                completion(ProcessResult(
                    code: -1,
                    output: text,
                    truncated: false,
                    timedOut: false,
                    emptyOutput: false
                ))
            }
        }
    }

    func runDetached(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: actionScript)
        process.arguments = arguments
        process.currentDirectoryURL = homeDirectory(for: ProcessInfo.processInfo.environment)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
    }

    func terminateAll() {
        let active = ownedProcessRegistry.activeExecutions()
        for execution in active {
            terminate(execution.process, reader: execution.reader, scheduleRootHardKill: false)
        }
        guard !active.isEmpty else { return }

        // applicationWillTerminate cannot rely on a queued one-second fallback:
        // the app may exit before it runs. Give cooperative roots a short,
        // bounded grace period, then synchronously hard-kill survivors.
        waitForRootsToExit(active.map(\.process), timeout: 0.25)
        for execution in active where execution.process.isRunning {
            if let rootIdentity = execution.rootIdentity {
                processIdentityGuard.signalIfCurrent(rootIdentity, signal: SIGKILL)
            }
        }
        waitForRootsToExit(active.map(\.process), timeout: 0.25)
    }

    private func homeDirectory(for environment: [String: String]) -> URL {
        guard let home = environment["HOME"], !home.isEmpty else {
            return FileManager.default.homeDirectoryForCurrentUser
        }
        return URL(fileURLWithPath: home, isDirectory: true)
    }

    static func nativeFailureOutput(_ error: String) -> String {
        #"{"schema":"sks.native-process-error.v1","ok":false,"error":"\#(error)"}"#
    }

    private func timeoutOutput(
        _ partialOutput: String,
        sensitiveValues: [String],
        arguments: [String]
    ) -> String {
        let failure = Self.nativeFailureOutput("native_process_timeout")
        guard !partialOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return failure
        }
        let partial = publicOutput(
            partialOutput,
            code: -2,
            sensitiveValues: sensitiveValues,
            arguments: arguments
        )
        return "\(partial)\n\(failure)"
    }

    private func outputLimitOutput(
        _ partialOutput: String,
        sensitiveValues: [String],
        arguments: [String]
    ) -> String {
        let failure = Self.nativeFailureOutput("native_process_output_limit")
        guard !partialOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return failure
        }
        let partial = publicOutput(
            partialOutput,
            code: -4,
            sensitiveValues: sensitiveValues,
            arguments: arguments
        )
        return "\(partial)\n\(failure)"
    }

    private func readBoundedOutput(
        from handle: FileHandle,
        limit: Int,
        process: Process,
        execution: ProcessExecutionState
    ) -> Data {
        var tail = Data()
        while execution.terminationReason == nil {
            guard let chunk = try? handle.read(upToCount: Self.readChunkBytes),
                  !chunk.isEmpty else { break }
            tail.append(chunk)
            guard tail.count > limit else { continue }
            tail = Data(tail.suffix(limit))
            if execution.markOutputLimitExceeded() {
                terminate(process, reader: handle)
            }
            break
        }
        try? handle.close()
        return tail
    }

    private func terminate(
        _ process: Process,
        reader: FileHandle,
        scheduleRootHardKill: Bool = true
    ) {
        // A command may spawn a descendant that inherits stdout. Closing our
        // reader independently ensures that inherited descriptors cannot keep
        // read(upToCount:) blocked after the owned command reaches its deadline.
        try? reader.close()
        let pid = process.processIdentifier
        // A descendant can ignore SIGTERM and keep mutating after the owned
        // root exits. Once the command has exceeded a hard bound, terminate
        // every descendant observed throughout the command, including one
        // that was reparented after the direct root exited.
        let currentlyOwned = process.isRunning ? descendantProcessIdentifiers(of: pid) : []
        ownedProcessRegistry.rememberDescendants(currentlyOwned, of: process)
        let identitySnapshot = ownedProcessRegistry.identitySnapshot(of: process)
        signalOwnedProcessGroup(identitySnapshot, signal: SIGKILL)
        for descendant in identitySnapshot?.descendants.reversed() ?? [] {
            processIdentityGuard.signalIfCurrent(descendant, signal: SIGKILL)
        }
        if process.isRunning { process.terminate() }
        guard scheduleRootHardKill else { return }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) {
            let delayedSnapshot = self.ownedProcessRegistry.identitySnapshot(of: process)
            self.signalOwnedProcessGroup(delayedSnapshot, signal: SIGKILL)
            for descendant in delayedSnapshot?.descendants.reversed() ?? [] {
                self.processIdentityGuard.signalIfCurrent(descendant, signal: SIGKILL)
            }
            if process.isRunning, let rootIdentity = identitySnapshot?.rootIdentity {
                self.processIdentityGuard.signalIfCurrent(rootIdentity, signal: SIGKILL)
            }
        }
    }

    private func waitForRootsToExit(_ processes: [Process], timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(max(0, timeout))
        while Date() < deadline {
            if processes.allSatisfy({ !$0.isRunning }) { return }
            usleep(10_000)
        }
    }

    private func signalOwnedProcessGroup(
        _ snapshot: OwnedProcessIdentitySnapshot?,
        signal: Int32
    ) {
        guard let snapshot, let processGroupID = snapshot.processGroupID else { return }
        processIdentityGuard.signalProcessGroupIfOwned(
            processGroupID,
            rootIdentity: snapshot.rootIdentity,
            descendants: snapshot.descendants,
            signal: signal
        )
    }

    private func observeDescendants(
        of process: Process,
        until execution: ProcessExecutionState
    ) {
        DispatchQueue.global(qos: .utility).async {
            while !execution.isCompleted {
                self.ownedProcessRegistry.rememberDescendants(
                    self.descendantProcessIdentifiers(of: process.processIdentifier),
                    of: process
                )
                usleep(10_000)
            }
        }
    }

    private func waitForForceKilledDescendants(of process: Process, timeout: TimeInterval) {
        let descendants = ownedProcessRegistry.identitySnapshot(of: process)?.descendants ?? []
        guard !descendants.isEmpty else { return }
        let deadline = Date().addingTimeInterval(max(0, timeout))
        while Date() < deadline {
            let anyRemain = descendants.contains { processIdentityGuard.isCurrent($0) }
            if !anyRemain { return }
            usleep(10_000)
        }
    }

    private func waitForOwnedProcessGroup(of process: Process, timeout: TimeInterval) {
        guard let snapshot = ownedProcessRegistry.identitySnapshot(of: process),
              let processGroupID = snapshot.processGroupID else { return }
        let deadline = Date().addingTimeInterval(max(0, timeout))
        while Date() < deadline {
            if !processIdentityGuard.processGroupIsOwned(
                processGroupID,
                rootIdentity: snapshot.rootIdentity,
                descendants: snapshot.descendants
            ) {
                return
            }
            usleep(10_000)
        }
    }

    private func descendantProcessIdentifiers(of root: pid_t) -> [pid_t] {
        var pending = [root]
        var seen = Set([root])
        var descendants: [pid_t] = []
        while let parent = pending.popLast(), descendants.count < 256 {
            for child in directChildProcessIdentifiers(of: parent)
                where seen.insert(child).inserted {
                descendants.append(child)
                pending.append(child)
                if descendants.count == 256 { break }
            }
        }
        return descendants
    }

    private func directChildProcessIdentifiers(of parent: pid_t) -> [pid_t] {
        var values = [pid_t](repeating: 0, count: 256)
        let count = values.withUnsafeMutableBytes { buffer in
            proc_listchildpids(parent, buffer.baseAddress, Int32(buffer.count))
        }
        guard count > 0 else { return [] }
        return Array(values.prefix(min(Int(count), values.count))).filter { $0 > 0 }
    }

    func redact(_ value: String, sensitiveValues: [String] = []) -> String {
        var text = value
        for sensitiveValue in sensitiveValues where !sensitiveValue.isEmpty {
            text = text.replacingOccurrences(of: sensitiveValue, with: "[redacted]")
        }
        let patterns = [
            #"sk-(?:proj|or-v1|clb)?-?[A-Za-z0-9_-]{12,}"#,
            #"gh[pousr]_[A-Za-z0-9_]{20,}"#,
            #"github_pat_[A-Za-z0-9_]{20,}"#,
            #"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"#,
            #"(?i)(api[_-]?key|secret|token)\s*[:=]\s*[^\s\"',}]+"#,
            #"(?:\\/|/)Users(?:\\/|/)[A-Za-z0-9._-]+"#,
            NSRegularExpression.escapedPattern(for: projectRoot)
        ]
        for pattern in patterns where !pattern.isEmpty {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            text = regex.stringByReplacingMatches(in: text, range: range, withTemplate: "[redacted]")
        }
        return text
    }

    private func sensitiveStdinValues(arguments: [String], stdin: String?) -> [String] {
        let receivesSensitiveStdin = arguments.contains("--api-key-stdin")
            || arguments.contains("--token-stdin")
        guard receivesSensitiveStdin, let stdin = stdin else { return [] }
        let normalized = stdin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return [] }
        return normalized == stdin ? [normalized] : [normalized, stdin]
    }

    private func publicOutput(
        _ value: String,
        code: Int32,
        sensitiveValues: [String],
        arguments: [String] = []
    ) -> String {
        let redacted = redact(value, sensitiveValues: sensitiveValues)
        let payload = extractJsonPayload(redacted)
        guard !sensitiveValues.isEmpty else { return payload }
        return SecureProcessEnvelope.render(payload: payload, code: code, arguments: arguments)
    }

    /// stdout+stderr are merged; keep the JSON object when Node prints warnings first.
    private func extractJsonPayload(_ value: String) -> String {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.first == "{" || text.first == "[" { return text }
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}") else { return text }
        return String(text[start...end])
    }

    private func writeLog(command: [String], output: String, sensitiveValues: [String] = []) {
        let url = URL(fileURLWithPath: logPath)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let text = "$ sks \(redact(command.joined(separator: " "), sensitiveValues: sensitiveValues))\n\(redact(output, sensitiveValues: sensitiveValues))\n"
        try? Data(text.utf8).write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logPath)
    }
}
