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
    private let canonicalProjectRoot: String

    init(
        processClient: ProcessClient,
        canonicalProjectRoot: String
    ) {
        self.canonicalProjectRoot = canonicalProjectRoot
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

    init(
        canonicalProjectRoot: String,
        processRunner: @escaping ProcessRunner
    ) {
        self.canonicalProjectRoot = canonicalProjectRoot
        self.processRunner = processRunner
    }

    func prepare(_ request: TelegramTypedCommandRequest) async -> TelegramTypedCommandDecision {
        do {
            let output = try await run(
                arguments: [
                    "telegram", "prepare", "--stdin-json", "--json",
                    "--project-root", canonicalProjectRoot
                ],
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
            arguments: [
                "telegram", "execute", "--stdin-json", "--confirmed", "--json",
                "--project-root", canonicalProjectRoot
            ],
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
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var recentUnauthorized: [Date] = []
    private var recentUnauthorizedByActor: [String: [Date]] = [:]

    private static let unauthorizedWindow: TimeInterval = 60
    private static let unauthorizedGlobalLimit = 64
    private static let unauthorizedPerActorLimit = 4
    private static let maximumRetainedSegments = 4

    init(
        url: URL,
        maximumBytes: Int64 = 4 * 1024 * 1024,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.url = url
        self.maximumBytes = max(64 * 1024, min(maximumBytes, 16 * 1024 * 1024))
        self.now = now
    }

    func record(_ event: TelegramNativeAuditEvent) throws {
        try lock.withTelegramAuditLock {
            let directory = url.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let directoryDescriptor = try openValidatedDirectory(directory)
            defer { close(directoryDescriptor) }
            let lockURL = directory.appendingPathComponent(".\(url.lastPathComponent).lock")
            let lockDescriptor = open(lockURL.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard lockDescriptor >= 0 else { throw TelegramProcessGatewayError.auditLedgerUnsafe }
            defer { close(lockDescriptor) }
            _ = try validatedFile(lockDescriptor, at: lockURL)
            guard flock(lockDescriptor, LOCK_EX) == 0 else {
                throw TelegramProcessGatewayError.auditLedgerWriteFailed
            }
            defer { flock(lockDescriptor, LOCK_UN) }

            var descriptor = open(url.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw TelegramProcessGatewayError.auditLedgerUnsafe }
            defer { if descriptor >= 0 { close(descriptor) } }
            var metadata = try validatedFile(descriptor, at: url)

            // Rejected-input noise is evidence, but it must not be able to evict
            // meaningful history or force rapid segment rotation.
            guard shouldPersist(event, at: now()) else { return }
            let row = Row(
                at: telegramGatewayISODate(), actor: event.actor, action: event.action,
                command: event.command, outcome: event.outcome,
                detail: event.detail.map { String($0.prefix(512)) }
            )
            var data = try JSONEncoder().encode(row)
            data.append(0x0a)

            if metadata.st_size > 0 && metadata.st_size + Int64(data.count) > maximumBytes {
                try rotateRetainingSegment(
                    metadata: metadata,
                    directory: directory,
                    directoryDescriptor: directoryDescriptor
                )
                close(descriptor)
                descriptor = open(
                    url.path,
                    O_WRONLY | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                    0o600
                )
                guard descriptor >= 0 else { throw TelegramProcessGatewayError.auditLedgerWriteFailed }
                metadata = try validatedFile(descriptor, at: url)
                guard metadata.st_size == 0 else { throw TelegramProcessGatewayError.auditLedgerUnsafe }
            }

            try writeAll(data, descriptor: descriptor)
            guard fsync(descriptor) == 0 else {
                throw TelegramProcessGatewayError.auditLedgerWriteFailed
            }
        }
    }

    private func shouldPersist(_ event: TelegramNativeAuditEvent, at current: Date) -> Bool {
        guard event.action == "unauthorized_chat" || event.action == "pair_attempt"
            || event.action == "invalid_command" else { return true }
        let cutoff = current.addingTimeInterval(-Self.unauthorizedWindow)
        recentUnauthorized.removeAll { $0 <= cutoff }
        recentUnauthorizedByActor = recentUnauthorizedByActor.compactMapValues { dates in
            let retained = dates.filter { $0 > cutoff }
            return retained.isEmpty ? nil : retained
        }
        let actorDates = recentUnauthorizedByActor[event.actor] ?? []
        guard recentUnauthorized.count < Self.unauthorizedGlobalLimit,
              actorDates.count < Self.unauthorizedPerActorLimit else { return false }
        recentUnauthorized.append(current)
        recentUnauthorizedByActor[event.actor] = actorDates + [current]
        return true
    }

    private func openValidatedDirectory(_ directory: URL) throws -> Int32 {
        var pathMetadata = stat()
        guard lstat(directory.path, &pathMetadata) == 0,
              (pathMetadata.st_mode & S_IFMT) == S_IFDIR,
              pathMetadata.st_uid == geteuid(),
              (pathMetadata.st_mode & 0o022) == 0 else {
            throw TelegramProcessGatewayError.auditLedgerUnsafe
        }
        let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw TelegramProcessGatewayError.auditLedgerUnsafe }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              metadata.st_dev == pathMetadata.st_dev,
              metadata.st_ino == pathMetadata.st_ino,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == geteuid(),
              (metadata.st_mode & 0o022) == 0 else {
            close(descriptor)
            throw TelegramProcessGatewayError.auditLedgerUnsafe
        }
        return descriptor
    }

    private func validatedFile(_ descriptor: Int32, at fileURL: URL) throws -> stat {
        var pathMetadata = stat()
        var metadata = stat()
        guard lstat(fileURL.path, &pathMetadata) == 0,
              fstat(descriptor, &metadata) == 0,
              metadata.st_dev == pathMetadata.st_dev,
              metadata.st_ino == pathMetadata.st_ino,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == geteuid(),
              (metadata.st_mode & 0o077) == 0 else {
            throw TelegramProcessGatewayError.auditLedgerUnsafe
        }
        return metadata
    }

    private func rotateRetainingSegment(
        metadata: stat,
        directory: URL,
        directoryDescriptor: Int32
    ) throws {
        let segmentURL = directory.appendingPathComponent(
            "\(url.lastPathComponent).\(UUID().uuidString).segment"
        )
        guard link(url.path, segmentURL.path) == 0 else {
            throw TelegramProcessGatewayError.auditLedgerWriteFailed
        }
        var segmentMetadata = stat()
        guard lstat(segmentURL.path, &segmentMetadata) == 0,
              segmentMetadata.st_dev == metadata.st_dev,
              segmentMetadata.st_ino == metadata.st_ino,
              (segmentMetadata.st_mode & S_IFMT) == S_IFREG,
              segmentMetadata.st_uid == geteuid(),
              (segmentMetadata.st_mode & 0o077) == 0 else {
            _ = unlink(segmentURL.path)
            throw TelegramProcessGatewayError.auditLedgerUnsafe
        }
        // The newest retained link must be durable before any older segment
        // is evicted or the active name is removed.
        guard fsync(directoryDescriptor) == 0 else {
            throw TelegramProcessGatewayError.auditLedgerWriteFailed
        }
        try pruneRetainedSegments(in: directory, directoryDescriptor: directoryDescriptor)
        guard unlink(url.path) == 0, fsync(directoryDescriptor) == 0 else {
            throw TelegramProcessGatewayError.auditLedgerWriteFailed
        }
    }

    private func pruneRetainedSegments(
        in directory: URL,
        directoryDescriptor: Int32
    ) throws {
        struct Segment {
            let url: URL
            let metadata: stat
        }
        let prefix = "\(url.lastPathComponent)."
        let candidates = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ).filter {
            $0.lastPathComponent.hasPrefix(prefix) && $0.lastPathComponent.hasSuffix(".segment")
        }
        var segments: [Segment] = []
        for candidate in candidates {
            var metadata = stat()
            guard lstat(candidate.path, &metadata) == 0,
                  (metadata.st_mode & S_IFMT) == S_IFREG,
                  metadata.st_uid == geteuid(),
                  (metadata.st_mode & 0o077) == 0,
                  metadata.st_size >= 0,
                  metadata.st_size <= maximumBytes else {
                throw TelegramProcessGatewayError.auditLedgerUnsafe
            }
            segments.append(Segment(url: candidate, metadata: metadata))
        }
        segments.sort {
            if $0.metadata.st_mtimespec.tv_sec != $1.metadata.st_mtimespec.tv_sec {
                return $0.metadata.st_mtimespec.tv_sec < $1.metadata.st_mtimespec.tv_sec
            }
            if $0.metadata.st_mtimespec.tv_nsec != $1.metadata.st_mtimespec.tv_nsec {
                return $0.metadata.st_mtimespec.tv_nsec < $1.metadata.st_mtimespec.tv_nsec
            }
            return $0.url.lastPathComponent < $1.url.lastPathComponent
        }
        let maximumRetainedBytes = maximumBytes * Int64(Self.maximumRetainedSegments)
        var retainedBytes = segments.reduce(Int64(0)) { $0 + Int64($1.metadata.st_size) }
        while segments.count > Self.maximumRetainedSegments || retainedBytes > maximumRetainedBytes {
            let oldest = segments.removeFirst()
            var current = stat()
            guard lstat(oldest.url.path, &current) == 0,
                  current.st_dev == oldest.metadata.st_dev,
                  current.st_ino == oldest.metadata.st_ino,
                  (current.st_mode & S_IFMT) == S_IFREG,
                  current.st_uid == geteuid(),
                  (current.st_mode & 0o077) == 0 else {
                throw TelegramProcessGatewayError.auditLedgerUnsafe
            }
            guard unlink(oldest.url.path) == 0 else {
                throw TelegramProcessGatewayError.auditLedgerWriteFailed
            }
            retainedBytes -= Int64(oldest.metadata.st_size)
        }
        guard fsync(directoryDescriptor) == 0 else {
            throw TelegramProcessGatewayError.auditLedgerWriteFailed
        }
    }

    private func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let wrote = Darwin.write(descriptor, base.advanced(by: offset), buffer.count - offset)
                if wrote < 0 && errno == EINTR { continue }
                guard wrote > 0 else { throw TelegramProcessGatewayError.auditLedgerWriteFailed }
                offset += wrote
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
    static func make(
        processClient: ProcessClient,
        canonicalProjectRoot: String,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> TelegramMenuBarService {
        let install = home.appendingPathComponent(".codex/sks-menubar", isDirectory: true)
        let ledger = TelegramAuditLedger(url: install.appendingPathComponent("logs/telegram-audit.jsonl"))
        let runtime = TelegramMenuBarRuntime(
            access: TelegramPrivateFileStore(homeDirectory: home),
            gateway: TelegramProcessCommandGateway(
                processClient: processClient,
                canonicalProjectRoot: canonicalProjectRoot
            ),
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
