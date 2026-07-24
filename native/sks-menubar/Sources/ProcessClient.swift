import Cocoa
import Darwin

struct ProcessResult {
    let code: Int32
    let output: String
    let truncated: Bool
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
        completion: @escaping (ProcessResult) -> Void
    ) {
        let process = Process()
        let output = Pipe()
        let sensitiveValues = sensitiveStdinValues(arguments: arguments, stdin: stdin)
        let childEnvironment = ProcessInfo.processInfo.environment.merging(environment) { _, override in override }
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
            if let timeout = timeout, timeout > 0 {
                let item = DispatchWorkItem {
                    guard process.isRunning else { return }
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
                let truncated = data.count > self.outputLimit
                let bounded = Data(data.suffix(self.outputLimit))
                let rawText = String(data: bounded, encoding: .utf8) ?? ""
                let text = self.publicOutput(rawText, code: process.terminationStatus, sensitiveValues: sensitiveValues)
                self.writeLog(command: arguments, output: text, sensitiveValues: sensitiveValues)
                DispatchQueue.main.async { completion(ProcessResult(code: process.terminationStatus, output: text, truncated: truncated)) }
            }
        } catch {
            let text = publicOutput(String(describing: error), code: -1, sensitiveValues: sensitiveValues)
            writeLog(command: arguments, output: text, sensitiveValues: sensitiveValues)
            completion(ProcessResult(code: -1, output: text, truncated: false))
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
            #"/Users/[^/\s]+"#,
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
        guard (arguments.contains("--api-key-stdin") || arguments.contains("--bot-token-stdin")), let stdin = stdin else { return [] }
        let normalized = stdin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return [] }
        return normalized == stdin ? [normalized] : [normalized, stdin]
    }

    private func publicOutput(_ value: String, code: Int32, sensitiveValues: [String]) -> String {
        let redacted = redact(value, sensitiveValues: sensitiveValues)
        guard sensitiveValues.isEmpty else {
            return code == 0
                ? "Secure input operation completed. Child output was suppressed."
                : "Secure input operation failed with exit code \(code). Child output was suppressed."
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
