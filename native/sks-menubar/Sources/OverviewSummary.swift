import Foundation

enum OverviewSummary {
    static func render(
        update: [String: Any]?,
        mcp: [String: Any]?,
        menuBarBuild: String,
        codexRunning: Bool?,
        operationSummary: String
    ) -> String {
        let codexAppState = codexRunning.map { $0 ? "Running" : "Not running" } ?? "Not configured"
        var lines: [String] = []
        let update = validatedUpdate(update)
        let mcp = validatedMCP(mcp)

        if let update = update {
            let sks = update["sks"] as? [String: Any]
            let codex = update["codex_cli"] as? [String: Any]
            let menu = update["menubar"] as? [String: Any]
            lines.append("SKS install: \(versionSummary(sks))")
            lines.append("Codex CLI: \(versionSummary(codex)) · Codex app: \(codexAppState)")
            if let inducement = codexUpdateInducement(codex) {
                lines.append(inducement)
            }

            var menuParts = ["running build \(menuBarBuild)"]
            if let expected = menu?["expected_version"] as? String { menuParts.append("expected \(expected)") }
            if let installed = menu?["installed_version"] as? String, installed != menuBarBuild {
                menuParts.append("snapshot installed \(installed)")
            }
            if let rebuildRequired = menu?["rebuild_required"] as? Bool {
                menuParts.append(rebuildRequired ? "rebuild required" : "current")
            } else {
                menuParts.append("rebuild state unknown")
            }
            menuParts.append("signature \(verificationState(menu?["signature_ok"]))")
            menuParts.append("resources \(verificationState(menu?["resources_ok"]))")
            lines.append("Menu Bar: \(menuParts.joined(separator: " · "))")

            let source = snapshotSource(update["source"] as? String)
            var updateParts = [integer(update["update_count"]).map { "\($0) pending" } ?? "pending count unknown", "\(source) snapshot"]
            if let error = diagnosticNotice(update["public_error"] as? String, update: update) {
                updateParts.append("notice: \(error)")
            } else if let warnings = update["warnings"] as? [String], !warnings.isEmpty {
                updateParts.append("\(warnings.count) warning\(warnings.count == 1 ? "" : "s")")
            }
            lines.append("Updates: \(updateParts.joined(separator: " · "))")
        } else {
            lines.append("SKS install: unavailable")
            lines.append("Codex CLI: unavailable · Codex app: \(codexAppState)")
            lines.append("Menu Bar: running build \(menuBarBuild) · update status unavailable")
            lines.append("Updates: unavailable")
        }

        if let mcp = mcp,
           let enabled = integer(mcp["enabled_count"]),
           let failed = integer(mcp["failed_count"]) {
            lines.append("MCP: \(enabled) enabled · \(failed) failed")
        } else {
            lines.append("MCP: unavailable")
        }

        lines.append("Last operation: \(operationSummary) · Logs and snapshots use mode 0600")
        return lines.joined(separator: "\n")
    }

    private static func validatedUpdate(_ value: [String: Any]?) -> [String: Any]? {
        guard value?["schema"] as? String == "sks.update-status.v3",
              value?["source"] is String,
              integer(value?["update_count"]) != nil,
              let sks = value?["sks"] as? [String: Any],
              let codex = value?["codex_cli"] as? [String: Any],
              let menu = value?["menubar"] as? [String: Any],
              sks["update_available"] is Bool,
              codex["update_available"] is Bool,
              menu["expected_version"] is String,
              menu["rebuild_required"] is Bool else { return nil }
        return value
    }

    private static func validatedMCP(_ value: [String: Any]?) -> [String: Any]? {
        guard value?["schema"] as? String == "sks.mcp-inventory.v2",
              integer(value?["enabled_count"]) != nil,
              integer(value?["failed_count"]) != nil else { return nil }
        return value
    }

    static func versionSummary(_ value: [String: Any]?) -> String {
        guard let current = nonEmpty(value?["current"] as? String) else { return "not detected" }
        guard let latest = nonEmpty(value?["latest"] as? String) else { return current }
        if value?["update_available"] as? Bool == true, latest != current { return "\(current) → \(latest) available" }
        if latest == current { return "\(current) (current)" }
        return "\(current) · registry last seen \(latest)"
    }

    private static func codexUpdateInducement(_ value: [String: Any]?) -> String? {
        guard value?["update_available"] as? Bool == true else { return nil }
        let current = nonEmpty(value?["current"] as? String) ?? "installed"
        let latest = nonEmpty(value?["latest"] as? String) ?? "preferred latest"
        return "Action: update Codex CLI (\(current) → \(latest)) from Updates, or choose Update Codex CLI Now in the menu bar."
    }

    private static func verificationState(_ value: Any?) -> String {
        guard let value = value as? Bool else { return "unknown" }
        return value ? "verified" : "needs attention"
    }

    private static func snapshotSource(_ value: String?) -> String {
        guard let value = nonEmpty(value) else { return "unknown" }
        return value.replacingOccurrences(of: "_", with: " ")
    }

    private static func diagnosticNotice(_ value: String?, update: [String: Any]) -> String? {
        guard let value = nonEmpty(value) else { return nil }
        let versions = [
            (update["sks"] as? [String: Any])?["current"] as? String,
            (update["sks"] as? [String: Any])?["latest"] as? String,
            (update["codex_cli"] as? [String: Any])?["current"] as? String,
            (update["codex_cli"] as? [String: Any])?["latest"] as? String
        ].compactMap { $0 }
        if versions.contains(value) { return nil }
        if value.range(of: #"^v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$"#, options: .regularExpression) != nil { return nil }
        return value
    }

    private static func integer(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        return (value as? NSNumber)?.intValue
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}
