import Darwin
import Foundation

enum TelegramProcessGatewayError: Error, Equatable {
    case processFailed(String)
    case invalidResponse
    case auditLedgerUnsafe
    case auditLedgerWriteFailed
}

/// Concrete native bridge to the canonical TypeScript command-contract
/// registry. Only these fixed argv vectors are allowed; user text is bounded
/// JSON on stdin and is never interpolated into a shell command.
final class TelegramProcessCommandGateway: TelegramTypedCommandGateway, @unchecked Sendable {
    typealias ProcessRunner = (
        _ arguments: [String], _ stdin: String, _ timeout: TimeInterval,
        _ completion: @escaping (ProcessResult) -> Void
    ) -> Void
    private struct Preparation: Decodable {
        let allowed: Bool
        let confirmation_required: Bool
        let public_error: String?
    }

    private let processRunner: ProcessRunner

    init(processClient: ProcessClient) {
        self.processRunner = { arguments, stdin, timeout, completion in
            processClient.run(
                arguments,
                stdin: stdin,
                environment: [
                    "TELEGRAM_BOT_TOKEN": "",
                    "SKS_TELEGRAM_BOT_TOKEN": ""
                ],
                timeout: timeout,
                maxOutputBytes: 1024 * 1024,
                logOutput: false,
                completion: completion
            )
        }
    }

    init(processRunner: @escaping ProcessRunner) {
        self.processRunner = processRunner
    }

    func prepare(_ request: TelegramTypedCommandRequest) async -> TelegramTypedCommandDecision {
        do {
            let output = try await run(
                arguments: ["telegram", "prepare", "--stdin-json", "--json"],
                request: request,
                timeout: 20
            )
            let decoded = try JSONDecoder().decode(Preparation.self, from: Data(output.utf8))
            return TelegramTypedCommandDecision(
                allowed: decoded.allowed,
                confirmationRequired: decoded.confirmation_required,
                publicError: decoded.public_error
            )
        } catch {
            return TelegramTypedCommandDecision(
                allowed: false,
                confirmationRequired: false,
                publicError: telegramGatewayPublicError(error)
            )
        }
    }

    func execute(_ request: TelegramTypedCommandRequest) async throws -> String {
        let output = try await run(
            arguments: ["telegram", "execute", "--stdin-json", "--confirmed", "--json"],
            request: request,
            timeout: 190
        )
        guard let data = output.data(using: .utf8),
              let row = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              row["ok"] as? Bool == true,
              let value = row["output"] else { throw TelegramProcessGatewayError.invalidResponse }
        if let string = value as? String { return String(string.prefix(4_000)) }
        guard JSONSerialization.isValidJSONObject(value),
              let encoded = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
              let rendered = String(data: encoded, encoding: .utf8) else {
            throw TelegramProcessGatewayError.invalidResponse
        }
        return String(rendered.prefix(4_000))
    }

    private func run(
        arguments: [String],
        request: TelegramTypedCommandRequest,
        timeout: TimeInterval
    ) async throws -> String {
        guard let input = request.inputJSON.data(using: .utf8),
              input.count <= 16 * 1024,
              let object = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
            throw TelegramProcessGatewayError.invalidResponse
        }
        let payload = try JSONSerialization.data(withJSONObject: ["name": request.name, "input": object], options: [.sortedKeys])
        guard payload.count <= 32 * 1024, let stdin = String(data: payload, encoding: .utf8) else {
            throw TelegramProcessGatewayError.invalidResponse
        }
        return try await withCheckedThrowingContinuation { continuation in
            processRunner(arguments, stdin, timeout) { result in
                guard result.code == 0, !result.timedOut, !result.truncated, !result.emptyOutput else {
                    continuation.resume(throwing: TelegramProcessGatewayError.processFailed(
                        result.timedOut ? "timeout" : result.truncated ? "output_limit" : "exit_\(result.code)"
                    ))
                    return
                }
                continuation.resume(returning: result.output)
            }
        }
    }
}

final class TelegramAuditLedger: @unchecked Sendable {
    private struct Row: Encodable {
        let schema = "sks.telegram-audit.v1"
        let at: String
        let actor: String
        let action: String
        let command: String?
        let outcome: String
        let detail: String?
    }

    private let url: URL
    private let maximumBytes: Int64
    private let lock = NSLock()

    init(url: URL, maximumBytes: Int64 = 4 * 1024 * 1024) {
        self.url = url
        self.maximumBytes = max(64 * 1024, min(maximumBytes, 16 * 1024 * 1024))
    }

    func record(_ event: TelegramNativeAuditEvent) throws {
        try lock.withTelegramAuditLock {
            let directory = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let descriptor = open(url.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw TelegramProcessGatewayError.auditLedgerUnsafe }
            defer { close(descriptor) }
            var metadata = stat()
            guard fstat(descriptor, &metadata) == 0,
                  (metadata.st_mode & S_IFMT) == S_IFREG,
                  metadata.st_uid == getuid(),
                  (metadata.st_mode & 0o077) == 0 else {
                throw TelegramProcessGatewayError.auditLedgerUnsafe
            }
            guard flock(descriptor, LOCK_EX) == 0 else { throw TelegramProcessGatewayError.auditLedgerWriteFailed }
            defer { flock(descriptor, LOCK_UN) }
            if metadata.st_size >= maximumBytes {
                guard ftruncate(descriptor, 0) == 0 else { throw TelegramProcessGatewayError.auditLedgerWriteFailed }
            }
            let row = Row(
                at: telegramGatewayISODate(), actor: event.actor, action: event.action,
                command: event.command, outcome: event.outcome,
                detail: event.detail.map { String($0.prefix(512)) }
            )
            var data = try JSONEncoder().encode(row)
            data.append(0x0a)
            let wrote = data.withUnsafeBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return -1 }
                return Darwin.write(descriptor, base, buffer.count)
            }
            guard wrote == data.count, fsync(descriptor) == 0 else {
                throw TelegramProcessGatewayError.auditLedgerWriteFailed
            }
        }
    }
}

/// Small lifecycle surface for AppDelegate. The existing menu-bar process owns
/// this object; it creates no daemon, listener, tunnel, or config file.
final class TelegramMenuBarService {
    private let runtime: TelegramMenuBarRuntime

    init(runtime: TelegramMenuBarRuntime) { self.runtime = runtime }

    @discardableResult
    func start() -> Task<TelegramLivenessReceipt, Error> {
        Task { try await runtime.start() }
    }

    @discardableResult
    func restart() -> Task<TelegramLivenessReceipt, Error> {
        Task { try await runtime.restart() }
    }

    @discardableResult
    func stop() -> Task<Void, Never> {
        Task { await runtime.stop() }
    }

    /// App termination is synchronous. Wait only long enough for the actor to
    /// cancel polling and persist the final `running=false` receipt.
    @discardableResult
    func stopAndWait(timeout: TimeInterval = 2) -> Bool {
        let signal = DispatchSemaphore(value: 0)
        Task.detached { [runtime] in
            await runtime.stop()
            signal.signal()
        }
        return signal.wait(timeout: .now() + max(0.1, min(timeout, 5))) == .success
    }
}

enum TelegramRuntimeFactory {
    static func make(processClient: ProcessClient, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> TelegramMenuBarService {
        let install = home.appendingPathComponent(".codex/sks-menubar", isDirectory: true)
        let ledger = TelegramAuditLedger(url: install.appendingPathComponent("logs/telegram-audit.jsonl"))
        let runtime = TelegramMenuBarRuntime(
            access: TelegramPrivateFileStore(homeDirectory: home),
            gateway: TelegramProcessCommandGateway(processClient: processClient),
            receiptURL: install.appendingPathComponent("telegram-liveness.json")
        ) { event in try ledger.record(event) }
        return TelegramMenuBarService(runtime: runtime)
    }
}

private extension NSLock {
    func withTelegramAuditLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

private func telegramGatewayISODate() -> String { ISO8601DateFormatter().string(from: Date()) }

private func telegramGatewayPublicError(_ error: Error) -> String {
    String(String(describing: error).prefix(512))
}
