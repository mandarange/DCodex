import Foundation
protocol TelegramBotAPI: Sendable {
    func getMe(token: String) async throws -> TelegramNativeUser
    func getUpdates(token: String, offset: Int64, timeoutSeconds: Int) async throws -> [TelegramNativeUpdate]
    func sendMessage(token: String, chatID: Int64, text: String) async throws
}

enum TelegramTransportError: Error, Equatable {
    case invalidToken
    case invalidResponse
    case responseTooLarge
    case auditUnavailable
    case apiFailure(Int?, String)
}

final class TelegramHTTPSBotAPI: TelegramBotAPI, @unchecked Sendable {
    private struct ResponseEnvelope<T: Decodable>: Decodable {
        let ok: Bool
        let result: T?
        let error_code: Int?
        let description: String?
    }

    private let session: URLSession
    private let baseURL: URL
    private let maximumResponseBytes = 2 * 1024 * 1024

    init(baseURL: URL = URL(string: "https://api.telegram.org")!, session: URLSession? = nil) {
        self.baseURL = baseURL
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration, delegate: TelegramNoRedirectDelegate(), delegateQueue: nil)
        }
    }

    func getMe(token: String) async throws -> TelegramNativeUser {
        try await call(token: token, method: "getMe", body: [:], timeout: 20)
    }

    func getUpdates(token: String, offset: Int64, timeoutSeconds: Int) async throws -> [TelegramNativeUpdate] {
        let timeout = max(1, min(timeoutSeconds, 50))
        return try await call(token: token, method: "getUpdates", body: [
            "offset": offset,
            "timeout": timeout,
            "allowed_updates": ["message"]
        ], timeout: TimeInterval(timeout + 10))
    }

    func sendMessage(token: String, chatID: Int64, text: String) async throws {
        let bounded = String(text.prefix(4_000))
        guard !bounded.isEmpty else { return }
        let _: TelegramNativeMessage = try await call(token: token, method: "sendMessage", body: [
            "chat_id": chatID,
            "text": bounded
        ], timeout: 20)
    }

    private func call<T: Decodable>(
        token: String,
        method: String,
        body: [String: Any],
        timeout: TimeInterval
    ) async throws -> T {
        guard token.range(of: #"^\d+:[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
            throw TelegramTransportError.invalidToken
        }
        guard baseURL.scheme == "https",
              let endpoint = URL(string: "bot\(token)/\(method)", relativeTo: baseURL)?.absoluteURL else {
            throw TelegramTransportError.invalidResponse
        }
        var request = URLRequest(url: endpoint, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard data.count <= maximumResponseBytes,
              let http = response as? HTTPURLResponse else {
            throw data.count > maximumResponseBytes ? TelegramTransportError.responseTooLarge : TelegramTransportError.invalidResponse
        }
        let envelope: ResponseEnvelope<T>
        do { envelope = try JSONDecoder().decode(ResponseEnvelope<T>.self, from: data) }
        catch { throw TelegramTransportError.invalidResponse }
        guard http.statusCode >= 200, http.statusCode < 300, envelope.ok, let result = envelope.result else {
            throw TelegramTransportError.apiFailure(envelope.error_code ?? http.statusCode, telegramPublicError(envelope.description, secret: token))
        }
        return result
    }
}

private final class TelegramNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

actor TelegramMenuBarRuntime {
    private struct IdentityProbe {
        let identity: TelegramNativeUser; let checkedAt: String; let latencyMilliseconds: Int
    }
    private let api: TelegramBotAPI
    private let access: TelegramAccessStoring
    private let gateway: TelegramTypedCommandGateway
    private let writer: TelegramLivenessWriter
    private let auditSink: @Sendable (TelegramNativeAuditEvent) throws -> Void
    private let identityRefreshIntervalSeconds: TimeInterval
    private var pollTask: Task<Void, Never>?
    private var activeStartID: String?
    private var desiredRunning = false
    private var token: String?
    private var tokenSource: TelegramTokenSource = .none
    private var botID: Int64?
    private var botIdentityValid = false
    private var getMeCheckedAt: String?
    private var getMeLatencyMilliseconds: Int?
    private var generation = UUID().uuidString
    private var startedAt = telegramISODate()
    private var offset: Int64 = 0
    private var failures = 0
    private var lastPollAt: String?
    private var lastSuccessAt: String?
    private var lastUpdateAt: String?
    private var lastError: String?
    private var auditHealthy = true
    private var auditLastError: String?
    init(
        api: TelegramBotAPI = TelegramHTTPSBotAPI(),
        access: TelegramAccessStoring = TelegramPrivateFileStore(),
        gateway: TelegramTypedCommandGateway,
        receiptURL: URL,
        identityRefreshIntervalSeconds: TimeInterval = 5 * 60,
        audit: @escaping @Sendable (TelegramNativeAuditEvent) throws -> Void
    ) {
        self.api = api
        self.access = access
        self.gateway = gateway
        self.writer = TelegramLivenessWriter(url: receiptURL)
        self.identityRefreshIntervalSeconds = identityRefreshIntervalSeconds
        self.auditSink = audit
    }
    @discardableResult
    func start() async throws -> TelegramLivenessReceipt {
        if pollTask != nil || activeStartID != nil { throw TelegramTransportError.apiFailure(nil, "telegram_poller_already_running") }
        let startID = UUID().uuidString
        activeStartID = startID
        desiredRunning = true
        defer { if activeStartID == startID { activeStartID = nil } }
        token = nil
        tokenSource = .none
        botID = nil
        botIdentityValid = false
        let resolvedToken: TelegramResolvedAccessToken
        do {
            resolvedToken = try access.resolveToken()
            tokenSource = resolvedToken.source
        } catch let error as TelegramTokenResolutionError {
            if case .invalid(let source) = error { tokenSource = source }
            try? writer.write(snapshot(running: false))
            throw error
        } catch {
            try? writer.write(snapshot(running: false))
            throw error
        }
        guard let loadedToken = resolvedToken.token, !loadedToken.isEmpty else {
            token = nil
            let receipt = snapshot(running: false)
            try? writer.write(receipt)
            throw TelegramTransportError.invalidToken
        }
        token = loadedToken
        let identityProbe: IdentityProbe
        do { identityProbe = try await probeIdentity(token: loadedToken) }
        catch {
            guard desiredRunning, activeStartID == startID else { throw TelegramTransportError.apiFailure(nil, "telegram_poller_start_cancelled") }
            getMeCheckedAt = telegramISODate()
            botIdentityValid = false
            try? writer.write(snapshot(running: false))
            throw error
        }
        guard desiredRunning, activeStartID == startID else { throw TelegramTransportError.apiFailure(nil, "telegram_poller_start_cancelled") }
        try applyIdentityProbe(identityProbe)
        auditHealthy = true
        auditLastError = nil
        guard recordAudit(TelegramNativeAuditEvent(
            actor: "system", action: "poller_start", command: nil,
            outcome: "allowed", detail: nil
        )) else {
            try? writer.write(snapshot(running: false))
            throw TelegramTransportError.auditUnavailable
        }
        generation = UUID().uuidString
        startedAt = telegramISODate()
        failures = 0
        lastError = nil
        let pollGeneration = generation
        let receipt = snapshot(running: true)
        do {
            try writer.write(receipt)
        } catch {
            lastError = "telegram_liveness_unavailable"
            _ = recordAudit(TelegramNativeAuditEvent(
                actor: "system", action: "poller_start", command: nil,
                outcome: "failed", detail: "telegram_liveness_unavailable"
            ))
            throw error
        }
        guard desiredRunning, activeStartID == startID else {
            try? writer.write(snapshot(running: false)); throw TelegramTransportError.apiFailure(nil, "telegram_poller_start_cancelled")
        }
        pollTask = Task { [weak self] in await self?.pollLoop(token: loadedToken, generation: pollGeneration) }
        return receipt
    }

    func stop() {
        desiredRunning = false
        activeStartID = nil
        generation = UUID().uuidString
        pollTask?.cancel()
        pollTask = nil
        _ = recordAudit(TelegramNativeAuditEvent(
            actor: "system", action: "poller_stop", command: nil,
            outcome: "allowed", detail: nil
        ))
        try? writer.write(snapshot(running: false))
    }

    func restart() async throws -> TelegramLivenessReceipt {
        stop()
        return try await start()
    }

    func liveness() -> TelegramLivenessReceipt { snapshot(running: pollTask != nil) }

    private func pollLoop(token: String, generation pollGeneration: String) async {
        defer {
            if generation == pollGeneration {
                pollTask = nil
                try? writer.write(snapshot(running: false))
            }
        }
        while !Task.isCancelled {
            lastPollAt = telegramISODate()
            try? writer.write(snapshot(running: true))
            do {
                if shouldRefreshIdentity() { try await validateIdentity(token: token) }
                let updates = try await api.getUpdates(token: token, offset: offset, timeoutSeconds: 30)
                for update in updates.sorted(by: { $0.update_id < $1.update_id }) where update.update_id >= offset {
                    guard !Task.isCancelled else { return }
                    // Persist the claim before any typed command can cause an
                    // external effect. This makes restart behavior at-most-once.
                    guard let botID, update.update_id < Int64.max else {
                        throw TelegramTransportError.invalidResponse
                    }
                    let nextOffset = update.update_id + 1
                    try access.persistPollOffset(nextOffset, botID: botID)
                    offset = nextOffset
                    lastUpdateAt = telegramISODate()
                    try writer.write(snapshot(running: true))
                    await handle(update: update, token: token)
                    if !auditHealthy { return }
                }
                failures = 0
                lastSuccessAt = telegramISODate()
                lastError = nil
                try? writer.write(snapshot(running: true))
            } catch is CancellationError {
                return
            } catch {
                failures += 1
                lastError = telegramPublicError(String(describing: error))
                try? writer.write(snapshot(running: true))
                let exponent = min(max(failures - 1, 0), 6)
                let delayMilliseconds = min(30_000, 500 * (1 << exponent))
                try? await Task.sleep(nanoseconds: UInt64(delayMilliseconds) * 1_000_000)
            }
        }
    }

    private func handle(update: TelegramNativeUpdate, token: String) async {
        guard let message = update.message, let sender = message.from, let text = message.text else { return }
        guard auditHealthy else { return }
        let actor = telegramRedactedActor(chatID: message.chat.id, senderID: sender.id)
        let authorized = (try? access.isAuthorized(chatID: message.chat.id, senderID: sender.id)) == true
        if !authorized {
            let code = telegramPairingCode(text: text, chatType: message.chat.type)
            if code == nil {
                _ = recordAudit(TelegramNativeAuditEvent(
                    actor: actor, action: "unauthorized_chat", command: nil,
                    outcome: "denied", detail: nil
                ))
                return
            }
            guard recordAudit(TelegramNativeAuditEvent(
                actor: actor, action: "pair_attempt", command: nil,
                outcome: "allowed", detail: nil
            )) else { return }
            let paired: Bool
            do {
                paired = try code.map {
                    try access.stagePairing(
                        code: $0, chatID: message.chat.id,
                        senderID: sender.id, chatType: message.chat.type
                    )
                } ?? false
            } catch {
                guard recordAudit(TelegramNativeAuditEvent(
                    actor: actor, action: "pair", command: nil,
                    outcome: "failed", detail: "pairing_state_unavailable"
                )) else { return }
                return
            }
            guard recordAudit(TelegramNativeAuditEvent(
                actor: actor, action: paired ? "pair" : "unauthorized_chat", command: nil,
                outcome: paired ? "allowed" : "denied", detail: nil
            )) else {
                if paired {
                    try? access.abandonPendingPairing(chatID: message.chat.id, senderID: sender.id)
                }
                return
            }
            if paired {
                let activated: Bool
                do {
                    activated = try access.activatePairing(
                        chatID: message.chat.id, senderID: sender.id
                    )
                } catch {
                    guard recordAudit(TelegramNativeAuditEvent(
                        actor: actor, action: "pair_activation", command: nil,
                        outcome: "failed", detail: "pairing_state_unavailable"
                    )) else { return }
                    return
                }
                guard activated else {
                    guard recordAudit(TelegramNativeAuditEvent(
                        actor: actor, action: "pair_activation", command: nil,
                        outcome: "failed", detail: "pending_pairing_missing"
                    )) else { return }
                    return
                }
                await send(
                    token: token,
                    chatID: message.chat.id,
                    text: "SKS Telegram control paired. Try /sks status {}. Confirm prompted actions with /confirm <nonce>.",
                    actor: actor
                )
            }
            return
        }
        if let nonce = telegramConfirmationNonce(text) {
            guard let pending = try? access.consumeConfirmation(
                nonce: nonce,
                chatID: message.chat.id,
                senderID: sender.id
            ) else {
                guard recordAudit(TelegramNativeAuditEvent(actor: actor, action: "confirm", command: nil, outcome: "denied", detail: "invalid_or_expired_nonce")) else { return }
                await send(token: token, chatID: message.chat.id, text: "Confirmation is invalid or expired.", actor: actor)
                return
            }
            guard recordAudit(TelegramNativeAuditEvent(actor: actor, action: "confirm", command: pending.request.name, outcome: "confirmed", detail: nil)) else { return }
            await execute(pending.request, token: token, chatID: message.chat.id, actor: actor, outcome: "confirmed")
            return
        }
        guard let request = telegramCommandRequest(text) else {
            _ = recordAudit(TelegramNativeAuditEvent(actor: actor, action: "invalid_command", command: nil, outcome: "denied", detail: nil))
            return
        }
        let decision = await gateway.prepare(request)
        guard decision.allowed else {
            let denial = telegramPublicError(decision.publicError)
            guard recordAudit(TelegramNativeAuditEvent(actor: actor, action: "execute", command: request.name, outcome: "denied", detail: denial)) else { return }
            await send(token: token, chatID: message.chat.id, text: "Command denied: \(denial)", actor: actor)
            return
        }
        if decision.confirmationRequired {
            let expiration = Date().addingTimeInterval(120)
            guard let nonce = try? access.issueConfirmation(
                chatID: message.chat.id,
                senderID: sender.id,
                request: request,
                expiresAt: expiration
            ) else {
                _ = recordAudit(TelegramNativeAuditEvent(actor: actor, action: "confirmation_issued", command: request.name, outcome: "failed", detail: "confirmation_state_unavailable"))
                return
            }
            guard recordAudit(TelegramNativeAuditEvent(actor: actor, action: "confirmation_issued", command: request.name, outcome: "allowed", detail: nil)) else { return }
            await send(token: token, chatID: message.chat.id, text: "Confirm once with /confirm \(nonce) before \(telegramISODate(expiration)).", actor: actor)
            return
        }
        await execute(request, token: token, chatID: message.chat.id, actor: actor, outcome: "allowed")
    }

    private func execute(_ request: TelegramTypedCommandRequest, token: String, chatID: Int64, actor: String, outcome: String) async {
        guard recordAudit(TelegramNativeAuditEvent(
            actor: actor, action: "execute_started", command: request.name,
            outcome: outcome, detail: nil
        )) else { return }
        do {
            let result = try await gateway.execute(request)
            guard recordAudit(TelegramNativeAuditEvent(actor: actor, action: "execute", command: request.name, outcome: outcome, detail: nil)) else { return }
            await send(token: token, chatID: chatID, text: String(result.prefix(4_000)), actor: actor)
        } catch {
            let detail = telegramPublicError(String(describing: error))
            guard recordAudit(TelegramNativeAuditEvent(actor: actor, action: "execute", command: request.name, outcome: "failed", detail: detail)) else { return }
            await send(token: token, chatID: chatID, text: "Command failed: \(detail)", actor: actor)
        }
    }

    private func send(token: String, chatID: Int64, text: String, actor: String) async {
        do { try await api.sendMessage(token: token, chatID: chatID, text: text) }
        catch {
            _ = recordAudit(TelegramNativeAuditEvent(actor: actor, action: "reply", command: nil, outcome: "failed", detail: telegramPublicError(String(describing: error))))
        }
    }

    @discardableResult
    private func recordAudit(_ event: TelegramNativeAuditEvent) -> Bool {
        guard auditHealthy else { return false }
        do {
            try auditSink(event)
            return true
        } catch {
            auditHealthy = false
            auditLastError = "telegram_audit_unavailable"
            lastError = "telegram_audit_unavailable"
            try? writer.write(snapshot(running: false))
            return false
        }
    }

    private func shouldRefreshIdentity() -> Bool {
        guard botIdentityValid else { return true }
        guard let checked = getMeCheckedAt.flatMap({ ISO8601DateFormatter().date(from: $0) }) else { return true }
        return Date().timeIntervalSince(checked) >= identityRefreshIntervalSeconds
    }

    private func validateIdentity(token: String) async throws {
        do {
            try applyIdentityProbe(await probeIdentity(token: token))
        } catch {
            getMeCheckedAt = telegramISODate()
            botIdentityValid = false
            throw error
        }
    }

    private func probeIdentity(token: String) async throws -> IdentityProbe {
        let started = Date()
        let identity = try await api.getMe(token: token)
        guard identity.is_bot, identity.id > 0 else { throw TelegramTransportError.invalidResponse }
        return IdentityProbe(identity: identity, checkedAt: telegramISODate(), latencyMilliseconds: max(0, Int(Date().timeIntervalSince(started) * 1_000)))
    }

    private func applyIdentityProbe(_ probe: IdentityProbe) throws {
        let binding = try access.bindBotIdentity(probe.identity.id)
        getMeCheckedAt = probe.checkedAt
        getMeLatencyMilliseconds = probe.latencyMilliseconds
        botID = binding.botID
        offset = binding.pollOffset
        botIdentityValid = true
    }

    private func snapshot(running: Bool) -> TelegramLivenessReceipt {
        TelegramLivenessReceipt(
            schema: "sks.telegram-liveness.v1",
            generation: generation,
            pid: ProcessInfo.processInfo.processIdentifier,
            running: running,
            token_configured: token != nil,
            token_source: tokenSource,
            bot_id: botID,
            bot_identity_valid: botIdentityValid,
            getme_checked_at: getMeCheckedAt,
            getme_latency_ms: getMeLatencyMilliseconds,
            paired_chat_count: (try? access.authorizedCount()) ?? 0,
            started_at: startedAt,
            heartbeat_at: telegramISODate(),
            stale_after_seconds: 120,
            audit_healthy: auditHealthy,
            audit_last_error: auditLastError,
            poller: TelegramPollerReceipt(
                schema: "sks.telegram-poller-state.v1", running: running, offset: offset,
                consecutive_failures: failures, last_poll_at: lastPollAt,
                last_success_at: lastSuccessAt, last_update_at: lastUpdateAt,
                last_error: lastError
            )
        )
    }
}
