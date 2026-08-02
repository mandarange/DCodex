import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('compiled Telegram runtime binds persisted offsets to bot identity and routes only paired chats', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift Telegram runtime harness is macOS-only');

  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sks-telegram-runtime-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const harness = path.join(temp, 'Harness.swift');
  const binary = path.join(temp, 'telegram-runtime-harness');
  const isolatedEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: temp,
    CFFIXED_USER_HOME: temp,
    TMPDIR: temp,
    CLANG_MODULE_CACHE_PATH: path.join(temp, 'clang-module-cache'),
    SWIFT_MODULECACHE_PATH: path.join(temp, 'swift-module-cache')
  };
  delete isolatedEnvironment.TELEGRAM_BOT_TOKEN;
  delete isolatedEnvironment.SKS_TELEGRAM_BOT_TOKEN;

  await fs.writeFile(harness, `
import Foundation

private enum HarnessError: Error {
    case timedOut
}

private final class HarnessAccess: TelegramAccessStoring, @unchecked Sendable {
    private var botID: Int64?
    private var pollOffset: Int64

    init(botID: Int64? = 1, pollOffset: Int64 = 0) {
        self.botID = botID
        self.pollOffset = pollOffset
    }

    func resolveToken() throws -> TelegramResolvedAccessToken {
        TelegramResolvedAccessToken(
            token: "123456:abcdefghijklmnopqrstuvwxyzABCDE",
            source: .userSecretFile
        )
    }

    func bindBotIdentity(_ botID: Int64) throws -> TelegramBotBinding {
        let previous = self.botID
        let reset = previous != botID
        if reset { pollOffset = 0 }
        self.botID = botID
        return TelegramBotBinding(
            botID: botID, previousBotID: previous,
            pollOffset: pollOffset, stateReset: reset
        )
    }

    func persistPollOffset(_ offset: Int64, botID: Int64) throws {
        precondition(self.botID == botID)
        pollOffset = offset
    }

    func consumePairing(
        code: String,
        chatID: Int64,
        senderID: Int64,
        chatType: String
    ) throws -> Bool { false }

    func isAuthorized(chatID: Int64, senderID: Int64) throws -> Bool {
        chatID == 10 && senderID == 20
    }

    func authorizedCount() throws -> Int { 1 }

    func issueConfirmation(
        chatID: Int64,
        senderID: Int64,
        request: TelegramTypedCommandRequest,
        expiresAt: Date
    ) throws -> String { "unused-confirmation" }

    func consumeConfirmation(
        nonce: String,
        chatID: Int64,
        senderID: Int64
    ) throws -> TelegramStoredConfirmation? { nil }
}

private actor HarnessAPI: TelegramBotAPI {
    private let identityBotID: Int64
    private var pending: [TelegramNativeUpdate] = []
    private var sent: [(chatID: Int64, text: String)] = []
    private var offsets: [Int64] = []

    init(identityBotID: Int64 = 1) {
        self.identityBotID = identityBotID
    }

    func getMe(token: String) async throws -> TelegramNativeUser {
        TelegramNativeUser(id: identityBotID, is_bot: true, first_name: "SKS")
    }

    func getUpdates(
        token: String,
        offset: Int64,
        timeoutSeconds: Int
    ) async throws -> [TelegramNativeUpdate] {
        offsets.append(offset)
        guard !pending.isEmpty else {
            try await Task.sleep(nanoseconds: 5_000_000)
            return []
        }
        let updates = pending
        pending.removeAll()
        return updates
    }

    func sendMessage(token: String, chatID: Int64, text: String) async throws {
        sent.append((chatID, text))
    }

    func enqueue(_ update: TelegramNativeUpdate) {
        pending.append(update)
    }

    func messages(for chatID: Int64) -> [String] {
        sent.filter { $0.chatID == chatID }.map(\\.text)
    }

    func messageCount() -> Int { sent.count }
    func observedOffsets() -> [Int64] { offsets }
}

private actor HarnessProcessGateway: TelegramTypedCommandGateway {
    private var prepared: [TelegramTypedCommandRequest] = []
    private var executed: [TelegramTypedCommandRequest] = []

    func prepare(_ request: TelegramTypedCommandRequest) async -> TelegramTypedCommandDecision {
        prepared.append(request)
        return TelegramTypedCommandDecision(
            allowed: true,
            confirmationRequired: false,
            publicError: nil
        )
    }

    func execute(_ request: TelegramTypedCommandRequest) async throws -> String {
        executed.append(request)
        return "gateway-ok"
    }

    func preparedNames() -> [String] { prepared.map(\\.name) }
    func executedNames() -> [String] { executed.map(\\.name) }
}

private final class HarnessAuditRows: @unchecked Sendable {
    private let lock = NSLock()
    private var rows: [TelegramNativeAuditEvent] = []

    func record(_ row: TelegramNativeAuditEvent) {
        lock.lock()
        defer { lock.unlock() }
        rows.append(row)
    }

    func unauthorizedDenialCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return rows.filter {
            $0.action == "unauthorized_chat" &&
            $0.outcome == "denied" &&
            $0.command == nil
        }.count
    }
}

@main
private enum Harness {
    static func main() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("telegram-runtime-\\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }

        try await verifyFirstPollOffset(
            directory: directory,
            persistedBotID: 41,
            persistedOffset: 73,
            liveBotID: 41,
            expectedOffset: 73
        )
        try await verifyFirstPollOffset(
            directory: directory,
            persistedBotID: 41,
            persistedOffset: 73,
            liveBotID: 42,
            expectedOffset: 0
        )
        print("telegram-offset-binding-ok")

        let api = HarnessAPI()
        let gateway = HarnessProcessGateway()
        let audit = HarnessAuditRows()
        let runtime = TelegramMenuBarRuntime(
            api: api,
            access: HarnessAccess(),
            gateway: gateway,
            receiptURL: directory.appendingPathComponent("liveness.json"),
            audit: { audit.record($0) }
        )
        _ = try await runtime.start()

        await api.enqueue(update(id: 1, chatID: 99, senderID: 99))
        try await eventually { audit.unauthorizedDenialCount() == 1 }
        let unauthorizedMessageCount = await api.messageCount()
        let unauthorizedPrepared = await gateway.preparedNames()
        let unauthorizedExecuted = await gateway.executedNames()
        precondition(unauthorizedMessageCount == 0, "unauthorized chat triggered sendMessage")
        precondition(unauthorizedPrepared.isEmpty, "unauthorized chat reached prepare")
        precondition(unauthorizedExecuted.isEmpty, "unauthorized chat reached execute")

        await api.enqueue(update(id: 2, chatID: 10, senderID: 20))
        try await eventually { await gateway.executedNames() == ["status"] }
        try await eventually { await api.messages(for: 10) == ["gateway-ok"] }
        let pairedPrepared = await gateway.preparedNames()
        precondition(pairedPrepared == ["status"], "paired chat missed prepare gateway")

        await runtime.stop()
        print("telegram-runtime-harness-ok")
    }

    private static func verifyFirstPollOffset(
        directory: URL,
        persistedBotID: Int64,
        persistedOffset: Int64,
        liveBotID: Int64,
        expectedOffset: Int64
    ) async throws {
        let api = HarnessAPI(identityBotID: liveBotID)
        let runtime = TelegramMenuBarRuntime(
            api: api,
            access: HarnessAccess(botID: persistedBotID, pollOffset: persistedOffset),
            gateway: HarnessProcessGateway(),
            receiptURL: directory.appendingPathComponent("offset-\\(liveBotID).json"),
            audit: { _ in }
        )
        _ = try await runtime.start()
        try await eventually { !(await api.observedOffsets()).isEmpty }
        await runtime.stop()
        let offsets = await api.observedOffsets()
        precondition(
            offsets.first == expectedOffset,
            "first poll offset \\(String(describing: offsets.first)) did not equal \\(expectedOffset)"
        )
    }

    private static func update(id: Int64, chatID: Int64, senderID: Int64) -> TelegramNativeUpdate {
        TelegramNativeUpdate(
            update_id: id,
            message: TelegramNativeMessage(
                message_id: id,
                date: 1,
                chat: TelegramNativeChat(id: chatID, type: "private"),
                from: TelegramNativeUser(
                    id: senderID,
                    is_bot: false,
                    first_name: "Operator"
                ),
                text: "/sks status {}"
            )
        )
    }

    private static func eventually(
        _ condition: @escaping @Sendable () async -> Bool
    ) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        throw HarnessError.timedOut
    }
}
`);

  const source = (name: string): string => path.join(
    process.cwd(),
    'native',
    'sks-menubar',
    'Sources',
    name
  );
  const sources = [
    source('TelegramStateLock.swift'),
    source('TelegramPrivateFileSupport.swift'),
    source('TelegramPrivateFileStore.swift'),
    source('TelegramSupport.swift'),
    source('TelegramRuntimeSupport.swift'),
    source('TelegramTransport.swift')
  ];
  const compiled = await run(
    'swiftc',
    [...sources, harness, '-o', binary],
    isolatedEnvironment,
    30_000
  );
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);

  const executed = await run(binary, [], isolatedEnvironment, 20_000);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /telegram-offset-binding-ok/);
  assert.match(executed.stdout, /telegram-runtime-harness-ok/);
});

test('compiled SecureProcessEnvelope preserves Telegram partial recovery without secret fields', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift secure-envelope harness is macOS-only');

  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sks-telegram-envelope-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const harness = path.join(temp, 'Harness.swift');
  const binary = path.join(temp, 'telegram-envelope-harness');
  const isolatedEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: temp,
    CFFIXED_USER_HOME: temp,
    TMPDIR: temp,
    CLANG_MODULE_CACHE_PATH: path.join(temp, 'clang-module-cache'),
    SWIFT_MODULECACHE_PATH: path.join(temp, 'swift-module-cache')
  };

  await fs.writeFile(harness, `
import Foundation

@main
private enum Harness {
    static func main() throws {
        let tokenSentinel = "987654:sentinel_secret_abcdefghijklmnop"
        let rawSentinel = "RAW_SENTINEL_MUST_NOT_ESCAPE"
        let payloadSentinel = "PAYLOAD_SENTINEL_MUST_NOT_ESCAPE"
        let detailSentinel = "DETAIL_SENTINEL_MUST_NOT_ESCAPE"
        let partial: [String: Any] = [
            "schema": "sks.telegram-setup-command.v1",
            "ok": false,
            "error": "telegram_token_store_failed_after_webhook_removed",
            "partial_success": true,
            "webhook_removed": true,
            "bot_state_reset": true,
            "token_source": "unchanged",
            "operator_action": "Remove the environment override before retrying secure setup.",
            "recovery": [
                "action": "rerun_secure_setup",
                "command": "sks telegram setup --token-stdin",
                "note": "Supply the token again through non-TTY standard input."
            ],
            "token": tokenSentinel,
            "raw": rawSentinel,
            "payload": payloadSentinel,
            "detail": detailSentinel + " token=" + tokenSentinel
        ]
        let bytes = try JSONSerialization.data(withJSONObject: partial, options: [.sortedKeys])
        let payload = String(decoding: bytes, as: UTF8.self)
        let rendered = SecureProcessEnvelope.render(
            payload: payload,
            code: 1,
            arguments: ["telegram", "setup", "--token-stdin", "--json"]
        )
        let outputBytes = rendered.data(using: .utf8)!
        let output = try JSONSerialization.jsonObject(with: outputBytes) as! [String: Any]
        precondition(output["schema"] as? String == "sks.secure-input-operation.v1")
        precondition(output["ok"] as? Bool == false)
        precondition(output["source_schema"] as? String == "sks.telegram-setup-command.v1")
        precondition(output["partial_success"] as? Bool == true)
        precondition(output["webhook_removed"] as? Bool == true)
        precondition(output["bot_state_reset"] as? Bool == true)
        precondition(output["token_source"] as? String == "unchanged")
        precondition(
            output["operator_action"] as? String
                == "Remove the environment override before retrying secure setup."
        )
        let recovery = output["recovery"] as? [String: Any]
        precondition(recovery?["action"] as? String == "rerun_secure_setup")
        precondition(recovery?["command"] as? String == "sks telegram setup --token-stdin")
        precondition(
            recovery?["note"] as? String
                == "Supply the token again through non-TTY standard input."
        )
        precondition(output["token"] == nil)
        precondition(output["raw"] == nil)
        precondition(output["payload"] == nil)
        precondition(output["detail"] == nil)
        for sentinel in [tokenSentinel, rawSentinel, payloadSentinel, detailSentinel] {
            precondition(!rendered.contains(sentinel), "secret sentinel escaped secure envelope")
        }
        print("secure-envelope-partial-ok")
    }
}
`);

  const compiled = await run(
    'swiftc',
    [
      path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'SecureProcessEnvelope.swift'),
      harness,
      '-o',
      binary
    ],
    isolatedEnvironment,
    30_000
  );
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);

  const executed = await run(binary, [], isolatedEnvironment, 20_000);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /secure-envelope-partial-ok/);
  for (const sentinel of [
    '987654:sentinel_secret_abcdefghijklmnop',
    'RAW_SENTINEL_MUST_NOT_ESCAPE',
    'PAYLOAD_SENTINEL_MUST_NOT_ESCAPE',
    'DETAIL_SENTINEL_MUST_NOT_ESCAPE'
  ]) {
    assert.equal(executed.stdout.includes(sentinel), false);
    assert.equal(executed.stderr.includes(sentinel), false);
  }
});

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
