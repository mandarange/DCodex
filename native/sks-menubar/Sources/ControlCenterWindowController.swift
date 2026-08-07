import Cocoa

final class ControlCenterWindowController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    private let sidebar = NSTableView()
    private let contentHost = NSView()
    private let controllers: [SidebarItem: NSViewController]
    private let overviewController: OverviewViewController
    private var selected: SidebarItem = .overview
    private var hasPresented = false

    init(
        processClient: ProcessClient,
        operations: OperationCoordinator,
        notifications: NotificationCoordinator
    ) {
        let overview = OverviewViewController(processClient: processClient, operations: operations)
        overviewController = overview
        defer {
            // Overview quick navigation: section names only, so the standalone
            // Overview compile harness never needs the SidebarItem type.
            overview.openSection = { [weak self] name in
                guard let item = SidebarItem.allCases.first(where: { $0.rawValue == name }) else { return }
                self?.show(section: item)
            }
        }
        controllers = [
            .overview: overview,
            .updates: UpdatesViewController(processClient: processClient, operations: operations, notifications: notifications),
            .mcpServers: MCPServersViewController(processClient: processClient, operations: operations, notifications: notifications),
            .providers: ProvidersViewController(processClient: processClient, operations: operations),
            .remoteCoding: RemoteCodingViewController(),
            .diagnostics: DiagnosticsViewController(processClient: processClient, operations: operations),
            .settings: SettingsViewController(notifications: notifications)
        ]
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 860, height: 560),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "SKS Control Center"
        window.minSize = NSSize(width: 760, height: 480)
        window.isReleasedWhenClosed = false
        window.setAccessibilityLabel("SKS Control Center")
        super.init(window: window)
        build()
    }

    required init?(coder: NSCoder) { nil }

    func show(section: SidebarItem) {
        selected = section
        if let row = SidebarItem.allCases.firstIndex(of: section) { sidebar.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false) }
        display(section)
        NSApp.activate(ignoringOtherApps: true)
        if !hasPresented {
            window?.center()
            hasPresented = true
        }
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    func setNotificationAuthorizationDenied(_ denied: Bool) {
        overviewController.setNotificationAuthorizationDenied(denied)
    }

    override func cancelOperation(_ sender: Any?) {
        window?.orderOut(sender)
    }

    private func build() {
        guard let root = window?.contentView else { return }
        let split = NSSplitView()
        split.isVertical = true
        split.dividerStyle = .thin
        split.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(split)
        NSLayoutConstraint.activate([
            split.leadingAnchor.constraint(equalTo: root.leadingAnchor), split.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            split.topAnchor.constraint(equalTo: root.topAnchor), split.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])
        let sidebarScroll = NSScrollView()
        sidebarScroll.hasVerticalScroller = true
        sidebar.headerView = nil
        sidebar.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("sidebar")))
        sidebar.dataSource = self
        sidebar.delegate = self
        sidebar.rowSizeStyle = .medium
        sidebar.setAccessibilityLabel("Control Center sections")
        sidebarScroll.documentView = sidebar
        split.addArrangedSubview(sidebarScroll)
        split.setHoldingPriority(.defaultHigh, forSubviewAt: 0)
        sidebarScroll.widthAnchor.constraint(equalToConstant: 190).isActive = true
        contentHost.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        split.addArrangedSubview(contentHost)
        sidebar.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        display(.overview)
    }

    func numberOfRows(in tableView: NSTableView) -> Int { SidebarItem.allCases.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = SidebarItem.allCases[row]
        let field = NSTextField(labelWithString: item.rawValue)
        field.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: item.symbolName, accessibilityDescription: nil)
        icon.contentTintColor = .secondaryLabelColor
        icon.setAccessibilityHidden(true)
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
        let cell = NSStackView(views: [icon, field])
        cell.orientation = .horizontal
        cell.alignment = .centerY
        cell.spacing = 7
        cell.edgeInsets = NSEdgeInsets(top: 0, left: 6, bottom: 0, right: 0)
        cell.setAccessibilityLabel(item.rawValue)
        cell.setAccessibilityIdentifier("sks-center-sidebar-\(item.rawValue.lowercased().replacingOccurrences(of: " ", with: "-"))")
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        let row = sidebar.selectedRow
        guard row >= 0, row < SidebarItem.allCases.count else { return }
        selected = SidebarItem.allCases[row]
        display(selected)
    }

    private func display(_ section: SidebarItem) {
        let preservedFrame = window?.frame
        contentHost.subviews.forEach { $0.removeFromSuperview() }
        guard let controller = controllers[section] else { return }
        controller.view.setAccessibilityIdentifier("sks-center-page-\(section.rawValue.lowercased().replacingOccurrences(of: " ", with: "-"))")
        let page = NativeView.scrollable(controller.view)
        contentHost.addSubview(page)
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: contentHost.leadingAnchor),
            page.trailingAnchor.constraint(equalTo: contentHost.trailingAnchor),
            page.topAnchor.constraint(equalTo: contentHost.topAnchor),
            page.bottomAnchor.constraint(equalTo: contentHost.bottomAnchor)
        ])
        // AppKit may temporarily widen an auto-layout-backed window when a
        // newly selected page first needs a vertical scroller. Restore the
        // user's exact pre-navigation frame after that layout pass.
        if let preservedFrame {
            DispatchQueue.main.async { [weak self] in
                self?.window?.setFrame(preservedFrame, display: true)
            }
        }
        (controller as? ControlCenterPage)?.refreshOnAppear()
    }
}
