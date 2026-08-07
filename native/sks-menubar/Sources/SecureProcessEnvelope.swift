import Foundation

enum SecureProcessEnvelope {
    static func render(payload: String, code: Int32, arguments: [String]) -> String {
        let expectedSchemas = expectedSourceSchemas(arguments: arguments)
        let object: [String: Any]? = {
            guard let data = payload.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }()
        let sourceSchema = object?["schema"] as? String
        let sourceOk = object?["ok"] as? Bool == true
        let schemaOk = sourceSchema.map(expectedSchemas.contains) == true
        let secureOk = code == 0 && object != nil && schemaOk && sourceOk
        var envelope: [String: Any] = [
            "schema": "sks.secure-input-operation.v1",
            "ok": secureOk,
            "output_suppressed": true
        ]
        if let object {
            if let sourceSchema = object["schema"] as? String, !sourceSchema.isEmpty {
                envelope["source_schema"] = String(sourceSchema.prefix(120))
            }
            if let status = object["status"] as? String, !status.isEmpty {
                envelope["status"] = String(status.prefix(160))
            }
            if !secureOk, let error = object["error"] as? String, !error.isEmpty {
                envelope["error"] = String(error.prefix(240))
            }
            if schemaOk {
                for (key, recoveryValue) in recoveryFields(from: object) {
                    envelope[key] = recoveryValue
                }
                if sourceSchema == "sks.desktop-bridge-command-result.v1" {
                    if let operation = boundedString(object["operation"], limit: 160) {
                        envelope["operation"] = operation
                    }
                    if let recoveryAction = boundedString(object["recovery_action"], limit: 360) {
                        envelope["recovery_action"] = recoveryAction
                    }
                    for key in ["execution", "readiness"] {
                        if let source = object[key] as? [String: Any] {
                            var publicStatus: [String: Any] = [:]
                            if let ok = source["ok"] as? Bool { publicStatus["ok"] = ok }
                            if let ready = source["ready"] as? Bool { publicStatus["ready"] = ready }
                            if let status = boundedString(source["status"], limit: 120) { publicStatus["status"] = status }
                            for listKey in ["blockers", "warnings"] {
                                let rows = boundedStrings(source[listKey], maxCount: 24, maxLength: 240)
                                if !rows.isEmpty { publicStatus[listKey] = rows }
                            }
                            if !publicStatus.isEmpty { envelope[key] = publicStatus }
                        }
                    }
                }
                if sourceSchema == "sks.telegram-setup-command.v1" {
                    for key in [
                        "getme_verified", "token_stored", "partial_success",
                        "storage_attempted", "webhook_removed", "pending_updates_dropped",
                        "bot_rotated", "bot_state_reset", "restart_required"
                    ] {
                        if let value = object[key] as? Bool { envelope[key] = value }
                    }
                    if let source = object["token_source"] as? String,
                       ["env", "user_secret_file", "none", "unchanged"].contains(source) {
                        envelope["token_source"] = source
                    }
                    if let stage = boundedString(object["failure_stage"], limit: 40),
                       ["getme", "webhook", "storage", "state"].contains(stage) {
                        envelope["failure_stage"] = stage
                    }
                    if let botID = object["bot_id"] as? NSNumber,
                       botID.int64Value > 0 {
                        envelope["bot_id"] = botID
                    }
                    if let username = boundedString(object["bot_username"], limit: 64),
                       username.range(of: #"^[A-Za-z0-9_]{5,64}$"#, options: .regularExpression) != nil {
                        envelope["bot_username"] = username
                    }
                    if let expectedUsername = boundedString(object["expected_bot_username"], limit: 64),
                       expectedUsername.range(of: #"^[A-Za-z0-9_]{5,64}$"#, options: .regularExpression) != nil {
                        envelope["expected_bot_username"] = expectedUsername
                    }
                    if let action = boundedString(object["operator_action"], limit: 480) {
                        envelope["operator_action"] = action
                    }
                    if let recovery = object["recovery"] as? [String: Any] {
                        var publicRecovery: [String: String] = [:]
                        for key in ["action", "command", "note"] {
                            if let value = boundedString(recovery[key], limit: 480) {
                                publicRecovery[key] = value
                            }
                        }
                        if !publicRecovery.isEmpty { envelope["recovery"] = publicRecovery }
                    }
                }
            }
        }
        if !secureOk, envelope["error"] == nil {
            if code != 0 {
                envelope["error"] = "secure_input_operation_failed_exit_\(code)"
            } else if object == nil {
                envelope["error"] = "secure_input_operation_invalid_json"
            } else if !schemaOk {
                envelope["error"] = expectedSchemas.isEmpty
                    ? "secure_input_operation_schema_unrecognized"
                    : "secure_input_operation_unexpected_schema"
            } else {
                envelope["error"] = "secure_input_operation_rejected"
            }
        }
        if let data = try? JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            return text
        }
        return #"{"schema":"sks.secure-input-operation.v1","ok":false,"error":"secure_input_operation_failed","output_suppressed":true}"#
    }

    private static func expectedSourceSchemas(arguments: [String]) -> Set<String> {
        guard arguments.count >= 2 else { return [] }
        if arguments.count >= 3,
           arguments[0] == "bridge",
           arguments[1] == "provider",
           arguments[2] == "configure" {
            return ["sks.desktop-bridge-command-result.v1"]
        }
        switch (arguments[0], arguments[1]) {
        case ("telegram", "setup"):
            return ["sks.telegram-setup-command.v1"]
        default:
            return []
        }
    }

    private static func recoveryFields(from object: [String: Any]) -> [String: Any] {
        var fields: [String: Any] = [:]
        var recoveryPaths: [String] = []
        var secretRecoveryPaths: [String] = []

        if let partial = object["partial_configuration"] as? [String: Any] {
            var publicPartial: [String: Any] = [:]
            for key in [
                "schema",
                "failure_stage",
                "filesystem_state",
                "process_environment_state",
                "keychain_state",
                "external_environment_state"
            ] {
                if let value = boundedString(partial[key], limit: 240) {
                    publicPartial[key] = value
                }
            }
            for key in ["durable_applied_state", "recovery_actions"] {
                let values = boundedStrings(partial[key], maxCount: 16, maxLength: 360)
                if !values.isEmpty { publicPartial[key] = values }
            }
            recoveryPaths.append(contentsOf: boundedStrings(
                partial["recovery_paths"],
                maxCount: 24,
                maxLength: 480
            ))
            secretRecoveryPaths.append(contentsOf: boundedStrings(
                partial["secret_recovery_paths"],
                maxCount: 24,
                maxLength: 480
            ))
            if !recoveryPaths.isEmpty { publicPartial["recovery_paths"] = unique(recoveryPaths) }
            if !secretRecoveryPaths.isEmpty {
                publicPartial["secret_recovery_paths"] = unique(secretRecoveryPaths)
            }
            if !publicPartial.isEmpty { fields["partial_configuration"] = publicPartial }
        }

        if let rollback = object["rollback"] as? [String: Any] {
            recoveryPaths.append(contentsOf: boundedStrings(
                rollback["recovery_paths"],
                maxCount: 24,
                maxLength: 480
            ))
            secretRecoveryPaths.append(contentsOf: boundedStrings(
                rollback["secret_recovery_paths"],
                maxCount: 24,
                maxLength: 480
            ))
            if let backupPath = boundedString(rollback["config_backup_path"], limit: 480) {
                recoveryPaths.append(backupPath)
            }
        }

        recoveryPaths.append(contentsOf: boundedStrings(
            object["recovery_paths"],
            maxCount: 24,
            maxLength: 480
        ))
        secretRecoveryPaths.append(contentsOf: boundedStrings(
            object["secret_recovery_paths"],
            maxCount: 24,
            maxLength: 480
        ))
        let uniqueRecoveryPaths = unique(recoveryPaths)
        let uniqueSecretRecoveryPaths = unique(secretRecoveryPaths)
        if !uniqueRecoveryPaths.isEmpty { fields["recovery_paths"] = uniqueRecoveryPaths }
        if !uniqueSecretRecoveryPaths.isEmpty {
            fields["secret_recovery_paths"] = uniqueSecretRecoveryPaths
        }
        return fields
    }

    private static func boundedString(_ value: Any?, limit: Int) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(limit))
    }

    private static func boundedStrings(
        _ value: Any?,
        maxCount: Int,
        maxLength: Int
    ) -> [String] {
        guard let values = value as? [Any] else { return [] }
        return values.prefix(maxCount).compactMap {
            boundedString($0, limit: maxLength)
        }
    }

    private static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
}
