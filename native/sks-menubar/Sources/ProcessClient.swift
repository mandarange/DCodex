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
    private let actionScript: String
    private let logPath: String
    private let projectRoot: String
    private let outputLimit = 64 * 1024

    init(actionScript: String, logPath: String, projectRoot: String) {
        self.actionScript = actionScript
        self.logPath = logPath
        self.projectRoot = projectRoot
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
        let effectiveTimeout = timeout
        let execution = ProcessExecutionState()
        process.executableURL = URL(fileURLWithPath: actionScript)
        process.arguments = arguments
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
            output.fileHandleForWriting.closeFile()
            if let stdin = stdin, let input = input {
                input.fileHandleForWriting.write(Data(stdin.utf8))
                input.fileHandleForWriting.closeFile()
            }
            var timeoutWorkItem: DispatchWorkItem?
            if let timeout = effectiveTimeout, timeout > 0 {
                let item = DispatchWorkItem {
                    guard process.isRunning else { return }
                    execution.markTimedOut()
                    let pid = process.processIdentifier
                    process.terminate()
                    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) {
                        if process.isRunning { Darwin.kill(pid, SIGKILL) }
                    }
                }
                timeoutWorkItem = item
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: item)
            }
            DispatchQueue.global(qos: .utility).async {
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                timeoutWorkItem?.cancel()
                let truncated = data.count > effectiveOutputLimit
                let bounded = Data(data.suffix(effectiveOutputLimit))
                let rawText = String(data: bounded, encoding: .utf8) ?? ""
                let timedOut = execution.timedOut
                let emptyOutput = !timedOut
                    && rawText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                let resultCode: Int32 = timedOut ? -2 : emptyOutput ? -3 : process.terminationStatus
                let text = timedOut
                    ? self.timeoutOutput(rawText, sensitiveValues: sensitiveValues)
                    : emptyOutput
                        ? Self.nativeFailureOutput("native_process_empty_output")
                        : self.publicOutput(rawText, code: resultCode, sensitiveValues: sensitiveValues)
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
            let text = publicOutput(String(describing: error), code: -1, sensitiveValues: sensitiveValues)
            if logOutput {
                writeLog(command: arguments, output: text, sensitiveValues: sensitiveValues)
            }
            completion(ProcessResult(
                code: -1,
                output: text,
                truncated: false,
                timedOut: false,
                emptyOutput: false
            ))
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

    private func homeDirectory(for environment: [String: String]) -> URL {
        guard let home = environment["HOME"], !home.isEmpty else {
            return FileManager.default.homeDirectoryForCurrentUser
        }
        return URL(fileURLWithPath: home, isDirectory: true)
    }

    static func nativeFailureOutput(_ error: String) -> String {
        #"{"schema":"sks.native-process-error.v1","ok":false,"error":"\#(error)"}"#
    }

    private func timeoutOutput(_ partialOutput: String, sensitiveValues: [String]) -> String {
        let failure = Self.nativeFailureOutput("native_process_timeout")
        guard !partialOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return failure
        }
        let partial = publicOutput(partialOutput, code: -2, sensitiveValues: sensitiveValues)
        return "\(partial)\n\(failure)"
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
        guard arguments.contains("--api-key-stdin"), let stdin = stdin else { return [] }
        let normalized = stdin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return [] }
        return normalized == stdin ? [normalized] : [normalized, stdin]
    }

    private func publicOutput(_ value: String, code: Int32, sensitiveValues: [String]) -> String {
        let redacted = redact(value, sensitiveValues: sensitiveValues)
        guard sensitiveValues.isEmpty else {
            let payload = extractJsonPayload(redacted)
            var envelope: [String: Any] = [
                "schema": "sks.secure-input-operation.v1",
                "ok": code == 0,
                "output_suppressed": true
            ]
            if let data = payload.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let sourceSchema = object["schema"] as? String, !sourceSchema.isEmpty {
                    envelope["source_schema"] = String(sourceSchema.prefix(120))
                }
                if let status = object["status"] as? String, !status.isEmpty {
                    envelope["status"] = String(status.prefix(160))
                }
                if code != 0, let error = object["error"] as? String, !error.isEmpty {
                    envelope["error"] = String(error.prefix(240))
                }
            }
            if code != 0, envelope["error"] == nil {
                envelope["error"] = "secure_input_operation_failed_exit_\(code)"
            }
            if let data = try? JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys]),
               let text = String(data: data, encoding: .utf8) {
                return text
            }
            return code == 0
                ? #"{"schema":"sks.secure-input-operation.v1","ok":true,"output_suppressed":true}"#
                : #"{"schema":"sks.secure-input-operation.v1","ok":false,"error":"secure_input_operation_failed","output_suppressed":true}"#
        }
        return extractJsonPayload(redacted)
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

private final class ProcessExecutionState {
    private let lock = NSLock()
    private var didTimeOut = false

    var timedOut: Bool {
        lock.lock()
        defer { lock.unlock() }
        return didTimeOut
    }

    func markTimedOut() {
        lock.lock()
        didTimeOut = true
        lock.unlock()
    }
}
