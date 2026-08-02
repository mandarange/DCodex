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
        switch (arguments[0], arguments[1]) {
        case ("codex-lb", "setup"):
            return ["sks.codex-lb-setup.v2"]
        case ("codex-lb", "set-key"),
             ("codex-lb", "update-key"),
             ("codex-lb", "rotate-key"):
            return ["sks.codex-lb-set-key.v1", "sks.codex-lb-set-key.v2"]
        case ("codex-app", "set-openrouter-key"),
             ("codex-app", "openrouter-key"):
            return ["sks.codex-app-openrouter-key.v1"]
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
