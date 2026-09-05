import Cocoa

private struct McpRow {
    let name: String
    let scope: String
    let enabled: Bool
    let transport: String
    let oauthSupported: Bool?
    let authenticated: Bool?
    let legacyInlineSecret: Bool
    let shadowedCount: Int
    let startupTimeout: Int
    let toolTimeout: Int
    let enabledTools: [String]
    let disabledTools: [String]
    let approvalMode: String
    let required: Bool
    let envNames: [String]
    let legacyEnvKeys: [String]
    let managedBy: String
    var healthStatus: String?
    var healthDetail: String?

    init?(json: [String: Any]) {
        guard let name = json["name"] as? String else { return nil }
        self.name = name
        scope = json["scope"] as? String ?? "effective"
        enabled = json["enabled"] as? Bool != false
        transport = json["transport"] as? String ?? "unknown"
        let oauth = json["oauth"] as? [String: Any]
        oauthSupported = oauth?["supported"] as? Bool
        authenticated = oauth?["authenticated"] as? Bool
        legacyInlineSecret = json["legacy_inline_secret_present"] as? Bool == true
        shadowedCount = (json["shadowed_sources"] as? [[String: Any]])?.count ?? 0
        startupTimeout = json["startup_timeout_sec"] as? Int ?? 10
        toolTimeout = json["tool_timeout_sec"] as? Int ?? 60
        enabledTools = json["enabled_tools"] as? [String] ?? []
        disabledTools = json["disabled_tools"] as? [String] ?? []
        approvalMode = json["default_tools_approval_mode"] as? String ?? "prompt"
        required = json["required"] as? Bool == true
        envNames = json["env_vars"] as? [String] ?? []
        legacyEnvKeys = json["legacy_env_keys"] as? [String] ?? []
        managedBy = json["managed_by"] as? String ?? "user"
        healthStatus = nil
        healthDetail = nil
    }

    var state: String {
        if let healthStatus = healthStatus { return healthStatus.replacingOccurrences(of: "_", with: " ").capitalized }
        if !enabled { return "Disabled" }
        if authenticated == false { return "OAuth Required" }
        return "Enabled"
    }

    var configuration: String {
        var parts = [scope.capitalized]
        if shadowedCount > 0 { parts.append("Shadows \(shadowedCount)") }
        if legacyInlineSecret { parts.append("Legacy inline secret (values hidden)") }
        if authenticated == true { parts.append("OAuth signed in") }
        else if oauthSupported == true { parts.append("OAuth available") }
        parts.append("\(startupTimeout)s/\(toolTimeout)s")
        return parts.joined(separator: " · ")
    }
}

private struct McpDraft { let scope: String; let payload: [String: Any] }

final class MCPServersViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate, ControlCenterPage {
    private let processClient: ProcessClient
    private let operations: OperationCoordinator
    private let notifications: NotificationCoordinator
    private let table = NSTableView()
    private let status = NativeView.detail("Loading effective MCP configuration…")
    private let scopePopup = NSPopUpButton()
    private var rows: [McpRow] = []
    private var mutating = false
    private var refreshGeneration = 0
    private var editor: McpEditorSheet?
    private lazy var addButton = actionButton("Add…", #selector(addServer))
    private lazy var editButton = actionButton("Edit…", #selector(editServer))
    private lazy var duplicateButton = actionButton("Duplicate…", #selector(duplicateServer))
    private lazy var toggleButton = actionButton("Enable/Disable", #selector(toggleServer))
    private lazy var removeButton = actionButton("Remove", #selector(removeServer))
    private lazy var testButton = actionButton("Test Connection", #selector(testConnection))
    private lazy var oauthButton = actionButton("OAuth Login/Logout", #selector(toggleOAuth))
    private lazy var legacySecretButton = actionButton("Legacy Secret…", #selector(reviewLegacySecret))
    private lazy var backupsButton = actionButton("Backups…", #selector(showBackups))
    private lazy var refreshButton = actionButton("Refresh", #selector(refresh))

    init(processClient: ProcessClient, operations: OperationCoordinator, notifications: NotificationCoordinator) {
        self.processClient = processClient; self.operations = operations; self.notifications = notifications
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { nil }

    override func loadView() {
        for (id, title, width, minimum) in [
            ("state", "State", 90.0, 72.0),
            ("name", "Name", 150.0, 110.0),
            ("transport", "Transport", 110.0, 86.0),
            ("configuration", "Configuration", 230.0, 150.0)
        ] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            column.title = title; column.width = width; column.minWidth = minimum
            table.addTableColumn(column)
        }
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.dataSource = self; table.delegate = self; table.usesAlternatingRowBackgroundColors = true
        table.allowsMultipleSelection = false; table.setAccessibilityLabel("Effective MCP servers")
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true
        scroll.borderType = .bezelBorder; scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
        scopePopup.addItems(withTitles: ["Effective", "Global", "Project"]); scopePopup.selectItem(withTitle: "Effective")
        scopePopup.target = self; scopePopup.action = #selector(scopeChanged); scopePopup.setAccessibilityLabel("MCP inventory scope")
        let scopeRow = NSStackView(views: [NSTextField(labelWithString: "View:"), scopePopup])
        scopeRow.orientation = .horizontal; scopeRow.spacing = 8
        // Destructive Remove sits apart from routine edit actions; connection
        // and maintenance actions live on their own labeled row.
        let primary = ControlKit.actionRow([addButton, editButton, duplicateButton])
        let stateActions = ControlKit.actionRow([toggleButton], trailing: [removeButton])
        let manageLabel = NSTextField(labelWithString: "Manage"); manageLabel.textColor = .secondaryLabelColor
        let connectLabel = NSTextField(labelWithString: "Connection"); connectLabel.textColor = .secondaryLabelColor
        for label in [manageLabel, connectLabel] { label.font = NSFont.systemFont(ofSize: 11, weight: .medium) }
        let secondary = ControlKit.actionRow([testButton, oauthButton, legacySecretButton])
        let maintenance = ControlKit.actionRow([backupsButton, refreshButton])
        let inventoryCard = NativeView.card(
            title: "Server inventory",
            subtitle: "Select one row before using edit, connection, authentication, or removal actions.",
            views: [scroll, status, manageLabel, primary, stateActions, connectLabel, secondary, maintenance]
        )
        view = NativeView.page([
            ControlKit.header("MCP Servers", "Manage the tools available to Codex. Choose Global or Project to make changes; Effective shows the combined configuration."),
            scopeRow,
            inventoryCard
        ])
        updateButtons()
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let column = tableColumn, row >= 0, row < rows.count else { return nil }
        let item = rows[row]
        let text: String
        switch column.identifier.rawValue {
        case "name": text = item.name
        case "transport": text = item.transport
        case "configuration": text = item.configuration
        default: text = item.state
        }
        let field = NSTextField(labelWithString: text); field.lineBreakMode = .byTruncatingTail
        field.setAccessibilityLabel("\(column.title): \(text)")
        return field
    }

    func tableViewSelectionDidChange(_ notification: Notification) { updateButtons() }

    @objc private func scopeChanged() { refresh() }

    @objc private func refresh() {
        guard !mutating else { return }
        refreshGeneration += 1
        let requestGeneration = refreshGeneration
        let scope = selectedScope()
        status.stringValue = "Loading \(scope) MCP configuration…"
        refreshButton.isEnabled = false
        processClient.run(["mcp", "config", "list", "--scope", scope] + scopeContext(scope, mutation: false) + ["--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self, self.refreshGeneration == requestGeneration else { return }
            guard let json = self.json(result.output), let servers = json["servers"] as? [[String: Any]] else {
                self.rows = []; self.table.reloadData(); self.status.stringValue = "MCP inventory unavailable. No configuration was changed."
                self.updateButtons(); return
            }
            self.rows = servers.compactMap(McpRow.init).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            self.table.reloadData()
            let enabled = json["enabled_count"] as? Int ?? self.rows.filter(\.enabled).count
            let failed = json["failed_count"] as? Int ?? 0
            let warnings = (json["warnings"] as? [String] ?? []).filter { !$0.hasPrefix("public_error:") }
            self.status.stringValue = self.rows.isEmpty
                ? "No MCP servers are configured in the \(scope) scope."
                : "\(self.rows.count) servers · \(enabled) enabled · \(failed) need attention" + (warnings.isEmpty ? "" : " · \(warnings.count) advisory")
            self.updateButtons()
        }
    }

    @objc private func addServer() {
        guard let window = view.window else { return }
        let defaultScope = selectedScope() == "project" ? "project" : "global"
        editor = McpEditorSheet(row: nil, defaultScope: defaultScope)
        editor?.begin(on: window) { [weak self] draft in
            self?.editor = nil; guard let self = self, let draft = draft, let input = self.jsonText(draft.payload) else { return }
            self.mutate(["mcp", "config", "add", "--scope", draft.scope] + self.scopeContext(draft.scope, mutation: true) + ["--stdin-json", "--json"], stdin: input)
        }
    }

    @objc private func editServer() {
        guard let selection = selected(), isWritable(selection.row), let window = view.window else { return }
        editor = McpEditorSheet(row: selection.row, defaultScope: selection.row.scope)
        editor?.begin(on: window) { [weak self] draft in
            self?.editor = nil; guard let self = self, let draft = draft, let input = self.jsonText(draft.payload) else { return }
            self.mutate(["mcp", "config", "edit", selection.row.name, "--scope", selection.row.scope] + self.scopeContext(selection.row.scope, mutation: true) + ["--stdin-json", "--json"], stdin: input)
        }
    }

    @objc private func duplicateServer() {
        guard let selection = selected(), isWritable(selection.row), let window = view.window else { return }
        AlertFactory.textSheet(window: window, title: "Duplicate \(selection.row.name)", message: "Enter a new Codex MCP server name. Inline legacy secrets cannot be duplicated.") { [weak self] name in
            guard let self = self, let name = name else { return }
            self.mutate(["mcp", "config", "duplicate", selection.row.name, "--new-name", name, "--scope", selection.row.scope] + self.scopeContext(selection.row.scope, mutation: true) + ["--json"])
        }
    }

    @objc private func toggleServer() {
        guard let selection = selected(), isWritable(selection.row) else { return }
        let action = selection.row.enabled ? "disable" : "enable"
        mutate(["mcp", "config", action, selection.row.name, "--scope", selection.row.scope] + scopeContext(selection.row.scope, mutation: true) + ["--json"])
    }

    @objc private func removeServer() {
        guard let selection = selected(), isWritable(selection.row), let window = view.window else { return }
        AlertFactory.confirmSheet(window: window, title: "Remove \(selection.row.name)?", message: "This \(selection.row.scope) server will be removed after a protected backup and guarded-write check.", destructive: true) { [weak self] approved in
            guard approved, let self = self else { return }
            self.mutate(["mcp", "config", "remove", selection.row.name, "--scope", selection.row.scope] + self.scopeContext(selection.row.scope, mutation: true) + ["--json"])
        }
    }

    func refreshOnAppear() { refresh() }

    @objc private func testConnection() {
        guard let selection = selected(), selection.row.managedBy != "plugin" else { return }
        status.stringValue = "Testing \(selection.row.name) with bounded discovery and tools/list…"
        processClient.run(["mcp", "config", "test", selection.row.name, "--scope", selection.row.scope] + scopeContext(selection.row.scope, mutation: false) + ["--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self, let json = self.json(result.output) else {
                self?.status.stringValue = result.code == 0
                    ? "Connection test failed without a readable receipt."
                    : "Connection test failed · \(NativeView.redactPreview(result.output))"
                return
            }
            let state = json["status"] as? String ?? "unknown"
            let latency = json["latency_ms"] as? Int
            let tools = json["tool_count"] as? Int
            let detail = [latency.map { "\($0) ms" }, tools.map { "\($0) tools" }].compactMap { $0 }.joined(separator: " · ")
            if selection.index < self.rows.count {
                self.rows[selection.index].healthStatus = state
                self.rows[selection.index].healthDetail = detail
            }
            let publicState = state.replacingOccurrences(of: "_", with: " ")
            self.table.reloadData(); self.status.stringValue = "\(selection.row.name): \(publicState)" + (detail.isEmpty ? "" : " · \(detail)")
        }
    }

    @objc private func toggleOAuth() {
        guard let selection = selected(), isWritable(selection.row) else { return }
        let action = selection.row.authenticated == true ? "logout" : "login"
        mutate(["mcp", "config", action, selection.row.name, "--scope", selection.row.scope] + scopeContext(selection.row.scope, mutation: true) + ["--json"])
    }

    @objc private func reviewLegacySecret() {
        guard selectedScope() != "effective", let selection = selected(), isWritable(selection.row), selection.row.legacyInlineSecret, let window = view.window else { return }
        let alert = NSAlert()
        alert.messageText = "Legacy inline secret detected"
        alert.informativeText = "This server still contains one or more inline environment values. Secret values are hidden. Choose whether to move them to environment-name references or preserve the existing configuration exactly."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Move to secure reference…")
        alert.addButton(withTitle: "Leave unchanged")
        AppIdentity.applyIcon(to: alert)
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self = self else { return }
            if response == .alertFirstButtonReturn {
                self.reviewLegacySecretMigration(selection.row, window: window)
            } else {
                self.status.stringValue = "Legacy inline secret left unchanged. No configuration was written."
            }
        }
    }

    private func reviewLegacySecretMigration(_ row: McpRow, window: NSWindow) {
        let names = Array(Set(row.legacyEnvKeys)).sorted()
        guard !names.isEmpty else {
            status.stringValue = "This legacy value cannot be moved automatically because no valid environment-variable name is available. No configuration was written."
            return
        }
        let alert = NSAlert()
        alert.messageText = "Review secure-reference migration"
        alert.informativeText = "Apply removes the hidden inline values and stores only these environment-variable names: \(names.joined(separator: ", ")). Ensure those variables are available to new Codex sessions. A protected backup is created first."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Apply Migration")
        alert.addButton(withTitle: "Cancel")
        AppIdentity.applyIcon(to: alert)
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self = self else { return }
            let payload: [String: Any] = [
                "legacy_inline_secret_action": "move_to_secure_reference",
                "reviewed_legacy_env_keys": names
            ]
            guard let input = self.jsonText(payload) else { return }
            self.mutate(["mcp", "config", "edit", row.name, "--scope", row.scope] + self.scopeContext(row.scope, mutation: true) + ["--stdin-json", "--json"], stdin: input)
        }
    }

    @objc private func showBackups() {
        guard let scope = writableScopeForBackup(), let window = view.window else { status.stringValue = "Choose Global or Project, or select a writable server, before restoring backups."; return }
        processClient.run(["mcp", "config", "backups", "--scope", scope] + scopeContext(scope, mutation: false) + ["--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self, let backups = self.json(result.output)?["backups"] as? [[String: Any]], !backups.isEmpty else { self?.status.stringValue = "No protected MCP backups are available for this scope."; return }
            let choices = backups.compactMap { item -> (String, String)? in
                guard let id = item["id"] as? String else { return nil }
                let label = "\(item["created_at"] as? String ?? "Unknown date") · \(item["operation"] as? String ?? "change") · \(item["server"] as? String ?? "server")"
                return (id, label)
            }
            AlertFactory.choiceSheet(window: window, title: "Restore MCP Backup", message: "Select a \(scope) backup. Current config is backed up again before restore.", choices: choices) { [weak self] id in
                guard let self = self, let id = id else { return }
                AlertFactory.confirmSheet(window: window, title: "Restore \(id)?", message: "Guarded concurrent-change checks remain active. New Codex sessions may be required.", destructive: false) { approved in
                    guard approved else { return }
                    self.mutate(["mcp", "config", "restore", id, "--scope", scope] + self.scopeContext(scope, mutation: true) + ["--json"])
                }
            }
        }
    }

    private func mutate(_ args: [String], stdin: String? = nil) {
        guard !mutating, let operation = operations.begin(kind: "mcp-config", mutationGroup: "mcp", summary: "MCP configuration change") else { status.stringValue = "An update or MCP mutation is already running."; return }
        refreshGeneration += 1
        mutating = true; updateButtons(); _ = operations.update(operation, state: .running, stage: "apply", progress: nil, summary: "Applying scoped MCP change")
        processClient.run(args, stdin: stdin, timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.mutating = false
            _ = self.operations.update(operation, state: result.code == 0 ? .succeeded : .failed, stage: "complete", progress: 1, summary: result.code == 0 ? "MCP change complete" : "MCP change failed")
            self.notifications.send(PublicNotificationEvent(category: "SKS_OPERATION_RESULT", title: result.code == 0 ? "MCP configuration updated" : "MCP configuration needs attention", body: result.code == 0 ? "The exact scoped MCP change completed." : "The MCP change failed. The previous configuration remains authoritative."))
            self.status.stringValue = result.code == 0 ? "Change complete. Open a new Codex session, then Test Connection." : "Change failed. The guarded previous config remains authoritative."
            self.updateButtons(); self.refresh()
        }
    }

    private func selected() -> (index: Int, row: McpRow)? { let index = table.selectedRow; return index >= 0 && index < rows.count ? (index, rows[index]) : nil }
    private func selectedScope() -> String { scopePopup.titleOfSelectedItem?.lowercased() ?? "effective" }
    private func isWritable(_ row: McpRow) -> Bool { row.managedBy != "plugin" && (row.scope == "global" || row.scope == "project") }
    private func selectedWritableRow() -> McpRow? { guard selectedScope() != "effective", let row = selected()?.row, isWritable(row) else { return nil }; return row }
    private func writableScopeForBackup() -> String? { let scope = selectedScope(); return scope == "global" || scope == "project" ? scope : nil }
    private func scopeContext(_ scope: String, mutation: Bool) -> [String] { scope == "project" ? projectContext(mutation: mutation) : [] }
    private func projectContext(mutation: Bool) -> [String] { var args = ["--project-root", AppRuntime.projectRoot, "--trusted-project"]; if mutation { args.append("--confirm-project") }; return args }
    private func json(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { return object }
        guard let start = text.range(of: "{", options: [.backwards])?.lowerBound else { return nil }
        let slice = String(text[start...])
        guard let sliced = slice.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: sliced) as? [String: Any]
    }
    private func jsonText(_ payload: [String: Any]) -> String? { guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }; return String(data: data, encoding: .utf8).map { $0 + "\n" } }
    private func actionButton(_ title: String, _ action: Selector) -> NSButton { NativeView.button(title, target: self, action: action) }
    private func updateButtons() {
        let row = selected()?.row; let writable = selectedWritableRow() != nil
        toggleButton.title = row?.enabled == true ? "Disable Selected" : "Enable Selected"
        removeButton.title = "Remove Selected"
        testButton.title = "Test Selected"
        oauthButton.title = row?.authenticated == true ? "Sign Out OAuth" : "Sign In with OAuth"
        legacySecretButton.title = "Review Legacy Secret…"
        addButton.isEnabled = !mutating; refreshButton.isEnabled = !mutating; scopePopup.isEnabled = !mutating
        for button in [editButton, duplicateButton, toggleButton, removeButton] { button.isEnabled = !mutating && writable }
        testButton.isEnabled = !mutating && row != nil && row?.managedBy != "plugin"
        oauthButton.isEnabled = !mutating && writable && (row?.transport == "streamable-http" || row?.oauthSupported == true)
        legacySecretButton.isEnabled = !mutating && writable && row?.legacyInlineSecret == true
        backupsButton.isEnabled = !mutating && (writableScopeForBackup() != nil)
    }
}

private final class McpEditorSheet: NSObject {
    private let row: McpRow?
    private let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 650, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
    private let scope = NSPopUpButton(); private let transport = NSPopUpButton(); private let name = NSTextField()
    private let command = NSTextField(); private let url = NSTextField(); private let cwd = NSTextField(); private let bearer = NSTextField()
    private let args = NSTextView(); private let env = NSTextView(); private let enabledTools = NSTextView(); private let disabledTools = NSTextView()
    private let startup = NSTextField(); private let tool = NSTextField(); private let approval = NSPopUpButton()
    private let remote = NSButton(checkboxWithTitle: "Use Codex remote environment", target: nil, action: nil)
    private let required = NSButton(checkboxWithTitle: "Required server", target: nil, action: nil)
    private let review = NativeView.detail("Review is required before Apply. Raw secret values and environment name/value assignments are not accepted.")
    private let apply = NSButton(title: "Review", target: nil, action: nil)
    private var reviewed: Data?; private var completion: ((McpDraft?) -> Void)?
    private var keyMonitor: Any?

    init(row: McpRow?, defaultScope: String) {
        self.row = row; super.init()
        scope.addItems(withTitles: ["Global", "Project"]); scope.selectItem(withTitle: (row?.scope ?? defaultScope).capitalized); scope.isEnabled = row == nil
        transport.addItems(withTitles: ["Local command", "Remote URL"]); transport.selectItem(at: row?.transport == "streamable-http" ? 1 : 0)
        name.stringValue = row?.name ?? ""; name.isEnabled = row == nil
        command.placeholderString = row == nil ? "Executable path or command" : "Leave blank to preserve configured executable"
        url.placeholderString = row == nil ? "https://example.com/mcp" : "Leave blank to preserve configured URL"
        cwd.placeholderString = "Optional absolute working directory"; bearer.placeholderString = "Optional environment-variable name"
        startup.stringValue = String(row?.startupTimeout ?? 10); tool.stringValue = String(row?.toolTimeout ?? 60)
        approval.addItems(withTitles: ["auto", "prompt", "writes", "approve"]); approval.selectItem(withTitle: row?.approvalMode ?? "prompt")
        env.string = row?.envNames.joined(separator: "\n") ?? ""; enabledTools.string = row?.enabledTools.joined(separator: "\n") ?? ""; disabledTools.string = row?.disabledTools.joined(separator: "\n") ?? ""
        required.state = row?.required == true ? .on : .off; apply.target = self; apply.action = #selector(reviewOrApply)
        transport.target = self; transport.action = #selector(transportChanged)
        build(); transportChanged()
    }

    func begin(on host: NSWindow, completion: @escaping (McpDraft?) -> Void) {
        self.completion = completion
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }
            self?.cancelSheet()
            return nil
        }
        host.beginSheet(panel) { [weak self] response in
            guard let self = self else { return }
            if let monitor = self.keyMonitor { NSEvent.removeMonitor(monitor); self.keyMonitor = nil }
            self.completion?(response == .OK ? self.draft() : nil)
        }
    }

    private func build() {
        panel.title = row == nil ? "Add MCP Server" : "Edit \(row!.name)"
        panel.styleMask = [.titled, .resizable]
        panel.minSize = NSSize(width: 560, height: 480)
        let grid = NSGridView(views: [
            pair("Scope", scope), pair("Transport", transport), pair("Name", name), pair("Executable", command), pair("Remote URL", url),
            pair("Arguments — one per line", area(args, "Command arguments")), pair("Working directory", cwd), pair("Environment names — no values", area(env, "Environment-variable names")),
            pair("Bearer token env name", bearer), pair("Startup timeout (1–30s)", startup), pair("Tool timeout (1–3600s)", tool),
            pair("Enabled tools — one per line", area(enabledTools, "Enabled tool allowlist")), pair("Disabled tools — one per line", area(disabledTools, "Disabled tool denylist")),
            pair("Default approval mode", approval), pair("Environment", remote), pair("Requirement", required)
        ])
        grid.rowSpacing = 6; grid.columnSpacing = 12; grid.column(at: 0).xPlacement = .trailing; grid.column(at: 1).xPlacement = .fill
        grid.column(at: 1).width = 300
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelSheet)); let buttons = NSStackView(views: [cancel, apply])
        buttons.orientation = .horizontal; buttons.spacing = 8
        let stack = NativeView.page([NativeView.detail("Connection values are used only for the selected transport. Edit fields may be left blank to preserve existing connection data."), grid, review, buttons])
        let scroll = NativeView.scrollable(stack)
        panel.contentView = NSView(); panel.contentView?.addSubview(scroll)
        NSLayoutConstraint.activate([scroll.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor), scroll.topAnchor.constraint(equalTo: panel.contentView!.topAnchor), scroll.bottomAnchor.constraint(equalTo: panel.contentView!.bottomAnchor)])
    }

    @objc private func transportChanged() { let local = transport.indexOfSelectedItem == 0; command.isEnabled = local; args.isEditable = local; cwd.isEnabled = local; env.isEditable = local; remote.isEnabled = local; url.isEnabled = !local; bearer.isEnabled = !local; reviewed = nil; apply.title = "Review" }
    @objc private func cancelSheet() { panel.sheetParent?.endSheet(panel, returnCode: .cancel) }
    @objc private func reviewOrApply() {
        guard let draft = draft(), JSONSerialization.isValidJSONObject(draft.payload), let data = try? JSONSerialization.data(withJSONObject: draft.payload, options: [.sortedKeys]) else { review.stringValue = validationMessage(); return }
        if reviewed == data { panel.sheetParent?.endSheet(panel, returnCode: .OK); return }
        reviewed = data; apply.title = "Apply"
        let envCount = (draft.payload["env_vars"] as? [String])?.count ?? 0; let allowCount = (draft.payload["enabled_tools"] as? [String])?.count ?? 0; let denyCount = (draft.payload["disabled_tools"] as? [String])?.count ?? 0
        let reviewName = draft.payload["name"] as? String ?? "server"
        let reviewTransport = draft.payload["transport"] as? String ?? "transport"
        review.stringValue = "Review: \(draft.scope) · \(reviewName) · \(reviewTransport) · \(envCount) env names · \(allowCount) allowed tools · \(denyCount) denied tools. No secret values are included."
    }

    private func draft() -> McpDraft? {
        let server = name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard server.range(of: #"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"#, options: .regularExpression) != nil else { return nil }
        let selectedTransport = transport.indexOfSelectedItem == 0 ? "stdio" : "streamable-http"
        var payload: [String: Any] = ["name": server, "transport": selectedTransport, "startup_timeout_sec": Int(startup.stringValue) ?? 0, "tool_timeout_sec": Int(tool.stringValue) ?? 0, "default_tools_approval_mode": approval.titleOfSelectedItem ?? "prompt", "required": required.state == .on]
        guard (payload["startup_timeout_sec"] as? Int).map({ 1...30 ~= $0 }) == true, (payload["tool_timeout_sec"] as? Int).map({ 1...3600 ~= $0 }) == true else { return nil }
        if selectedTransport == "stdio" {
            let executable = command.stringValue.trimmingCharacters(in: .whitespacesAndNewlines); if row == nil || row?.transport != selectedTransport { guard !executable.isEmpty else { return nil } }; if !executable.isEmpty { payload["command"] = executable }
            let argv = orderedLines(args.string); if argv.contains(where: { $0.contains("=") || $0.lowercased().contains("token") || $0.lowercased().contains("secret") }) { return nil }; if !argv.isEmpty { payload["args"] = argv }
            let names = uniqueSortedLines(env.string); guard names.allSatisfy({ $0.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil }) else { return nil }; if !names.isEmpty { payload["env_vars"] = names }
            let directory = cwd.stringValue.trimmingCharacters(in: .whitespacesAndNewlines); if !directory.isEmpty { guard directory.hasPrefix("/") else { return nil }; payload["cwd"] = directory }
            if remote.state == .on { payload["experimental_environment"] = "remote" }
        } else {
            let endpoint = url.stringValue.trimmingCharacters(in: .whitespacesAndNewlines); if row == nil || row?.transport != selectedTransport { guard !endpoint.isEmpty else { return nil } }; if !endpoint.isEmpty { guard let parsed = URL(string: endpoint), ["http", "https"].contains(parsed.scheme?.lowercased() ?? ""), parsed.user == nil, parsed.password == nil else { return nil }; payload["url"] = endpoint }
            let envName = bearer.stringValue.trimmingCharacters(in: .whitespacesAndNewlines); if !envName.isEmpty { guard envName.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil else { return nil }; payload["bearer_token_env_var"] = envName }
        }
        let allow = uniqueSortedLines(enabledTools.string); let deny = uniqueSortedLines(disabledTools.string); guard Set(allow).isDisjoint(with: Set(deny)) else { return nil }; if !allow.isEmpty { payload["enabled_tools"] = allow }; if !deny.isEmpty { payload["disabled_tools"] = deny }
        return McpDraft(scope: scope.titleOfSelectedItem?.lowercased() ?? "global", payload: payload)
    }

    private func validationMessage() -> String {
        let server = name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if server.range(of: #"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"#, options: .regularExpression) == nil {
            return "Fix the server name: use 1–64 letters, numbers, underscores, or hyphens."
        }
        if transport.indexOfSelectedItem == 0 {
            let executable = command.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if (row == nil || row?.transport != "stdio") && executable.isEmpty { return "Executable is required for a local command server." }
            if orderedLines(args.string).contains(where: { $0.contains("=") || $0.lowercased().contains("token") || $0.lowercased().contains("secret") }) {
                return "Arguments must stay secret-free. Remove token/secret values and inline assignments."
            }
            if !uniqueSortedLines(env.string).allSatisfy({ $0.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil }) {
                return "Environment names must be bare variable names with no values."
            }
        } else {
            let endpoint = url.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if (row == nil || row?.transport != "streamable-http") && endpoint.isEmpty { return "Remote URL is required for a remote MCP server." }
        }
        let startupSec = Int(startup.stringValue) ?? 0
        let toolSec = Int(tool.stringValue) ?? 0
        if !(1...30 ~= startupSec) { return "Startup timeout must be between 1 and 30 seconds." }
        if !(1...3600 ~= toolSec) { return "Tool timeout must be between 1 and 3600 seconds." }
        let allow = uniqueSortedLines(enabledTools.string); let deny = uniqueSortedLines(disabledTools.string)
        if !Set(allow).isDisjoint(with: Set(deny)) { return "Enabled and disabled tool lists must not overlap." }
        return "Check the selected connection field, timeout ranges, environment names, tool lists, and secret-free arguments before review."
    }
    private func pair(_ label: String, _ control: NSView) -> [NSView] { [NSTextField(labelWithString: label), control] }
    private func area(_ text: NSTextView, _ label: String) -> NSScrollView { text.isRichText = false; text.font = NSFont.systemFont(ofSize: 12); text.setAccessibilityLabel(label); let scroll = NSScrollView(); scroll.documentView = text; scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder; scroll.heightAnchor.constraint(equalToConstant: 52).isActive = true; return scroll }
    private func uniqueSortedLines(_ value: String) -> [String] { Array(Set(rawLines(value))).sorted() }
    private func orderedLines(_ value: String) -> [String] {
        var seen = Set<String>()
        return rawLines(value).filter { seen.insert($0).inserted }
    }
    private func rawLines(_ value: String) -> [String] {
        value.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}
