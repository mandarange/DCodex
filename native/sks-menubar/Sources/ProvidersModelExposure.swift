import Cocoa

/// One selectable OpenRouter model row as reported by `sks bridge models list`.
struct ExposureModelRow: Equatable {
    let publicId: String
    let displayName: String
    let selected: Bool
}

enum ExposureModelDecoder {
    /// Decodes the strict `models.list` receipt. codex-lb exposure is always
    /// "all"; anything else means the CLI contract drifted and the UI must not
    /// silently present a partial list as authoritative.
    static func rows(from json: [String: Any]) throws -> (rows: [ExposureModelRow], selected: Int, max: Int, available: Int) {
        guard json["schema"] as? String == "sks.desktop-bridge-command-result.v1",
              json["operation"] as? String == "models.list",
              let result = json["result"] as? [String: Any],
              result["codex_lb_exposure"] as? String == "all",
              let openrouter = result["openrouter"] as? [String: Any],
              openrouter["mode"] as? String == "selected",
              let selected = openrouter["selected_count"] as? Int,
              let max = openrouter["max_selected"] as? Int,
              let available = openrouter["available_count"] as? Int,
              let rawModels = openrouter["models"] as? [[String: Any]] else {
            throw ProviderFacadeError.schemaInvalid("bridge_models_list_schema_invalid")
        }
        let rows: [ExposureModelRow] = rawModels.compactMap { row in
            guard let publicId = (row["public_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !publicId.isEmpty else { return nil }
            let displayName = (row["display_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? publicId
            return ExposureModelRow(publicId: publicId, displayName: displayName, selected: row["selected"] as? Bool == true)
        }
        return (rows, selected, max, available)
    }
}

enum ExposureModelFilter {
    static func matching(_ rows: [ExposureModelRow], query: String) -> [ExposureModelRow] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return rows }
        return rows.filter { $0.displayName.lowercased().contains(needle) || $0.publicId.lowercased().contains(needle) }
    }

    /// Selected models stay visible regardless of the filter so an operator can
    /// never lose track of a pick they are about to apply.
    static func display(_ rows: [ExposureModelRow], query: String, pending: Set<String>) -> [ExposureModelRow] {
        let matched = matching(rows, query: query)
        let matchedIds = Set(matched.map(\.publicId))
        let pinned = rows.filter { pending.contains($0.publicId) && !matchedIds.contains($0.publicId) }
        return pinned + matched
    }
}

extension ProvidersViewController: NSTableViewDataSource, NSTableViewDelegate {
    func makeModelExposureCard() -> NSBox {
        exposureSearchField.placeholderString = "Filter OpenRouter models"
        exposureSearchField.target = self
        exposureSearchField.action = #selector(exposureSearchChanged)
        exposureSearchField.setAccessibilityIdentifier("sks-provider-exposure-search")
        exposureTable.headerView = nil
        exposureTable.rowSizeStyle = .default
        exposureTable.dataSource = self
        exposureTable.delegate = self
        exposureTable.setAccessibilityIdentifier("sks-provider-exposure-table")
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("model"))
        column.width = 420
        exposureTable.addTableColumn(column)
        let scroll = NSScrollView()
        scroll.documentView = exposureTable
        scroll.hasVerticalScroller = true
        scroll.borderType = .lineBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 220).isActive = true
        exposureApplyButton = NativeView.button("Apply to Codex Picker", target: self, action: #selector(applyModelExposure))
        exposureApplyButton.setAccessibilityIdentifier("sks-provider-exposure-apply")
        let clear = NativeView.button("Clear Selection", target: self, action: #selector(clearModelExposure))
        clear.setAccessibilityIdentifier("sks-provider-exposure-clear")
        let card = NativeView.card(
            title: "Codex Picker Exposure",
            subtitle: "Every Codex-LB model is always exposed. Choose which OpenRouter models join them, then apply — the Codex model picker reads the rebuilt catalog on its next launch.",
            views: [exposureStatus, exposureSearchField, scroll, ControlKit.actionRow([exposureApplyButton, clear])]
        )
        card.setAccessibilityIdentifier("sks-provider-card-model-exposure")
        return card
    }

    func refreshModelExposure() {
        processClient.run(["bridge", "models", "list", "--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self else { return }
            guard let json = self.json(result.output),
                  let decoded = try? ExposureModelDecoder.rows(from: json) else {
                self.exposureStatus.stringValue = "Model exposure list unavailable · no selection was assumed."
                self.exposureStatus.textColor = .systemOrange
                return
            }
            self.exposureRows = decoded.rows
            self.exposurePending = Set(decoded.rows.filter(\.selected).map(\.publicId))
            self.exposureMaxSelected = decoded.max
            self.exposureStatus.stringValue = "Codex-LB: all models exposed · OpenRouter: \(decoded.selected) of \(decoded.available) selected (max \(decoded.max))."
            self.exposureStatus.textColor = .secondaryLabelColor
            self.exposureTable.reloadData()
        }
    }

    @objc func exposureSearchChanged() {
        exposureQuery = exposureSearchField.stringValue
        exposureTable.reloadData()
    }

    @objc func clearModelExposure() {
        exposurePending.removeAll()
        exposureTable.reloadData()
        exposureStatus.stringValue = "OpenRouter selection cleared · choose Apply to rebuild the catalog."
        exposureStatus.textColor = .systemOrange
    }

    @objc func applyModelExposure() {
        guard exposurePending.count <= exposureMaxSelected else {
            exposureStatus.stringValue = "Select at most \(exposureMaxSelected) OpenRouter models."
            exposureStatus.textColor = .systemRed
            return
        }
        guard let snapshot = operations.begin(kind: "bridge-models-select", mutationGroup: "codex-config", summary: "Apply Codex picker exposure") else {
            exposureStatus.stringValue = "Another guarded mutation is running."
            return
        }
        exposureApplyButton.isEnabled = false
        exposureStatus.stringValue = "Applying exposure…"
        exposureStatus.textColor = .secondaryLabelColor
        _ = operations.update(snapshot, state: .running, stage: "applying", progress: nil, summary: "Apply Codex picker exposure")
        let payload = exposurePending.sorted().joined(separator: ",")
        processClient.run(["bridge", "models", "select", "--set", payload, "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.exposureApplyButton.isEnabled = true
            let truth = self.json(result.output).flatMap {
                try? DesktopBridgeCommandResultTruth.decode(from: $0, expectedOperation: "models.select")
            }
            let completed = result.code == 0 && truth?.completed == true
            let blocker = truth?.blockers.first.map(ProviderSecretRedactor.redact)
            let summary = completed
                ? "Exposure applied · \(self.exposurePending.count) OpenRouter model(s) plus every Codex-LB model. Restart Codex to refresh its picker."
                : blocker.map { "Exposure not applied · \($0)" } ?? "Exposure result schema invalid"
            _ = self.operations.update(snapshot, state: completed ? .succeeded : .failed, stage: "complete", progress: 1, summary: summary)
            self.exposureStatus.stringValue = summary
            self.exposureStatus.textColor = completed ? .systemGreen : .systemRed
            self.refreshModelExposure()
            self.refresh()
        }
    }

    private var visibleExposureRows: [ExposureModelRow] {
        ExposureModelFilter.display(exposureRows, query: exposureQuery, pending: exposurePending)
    }

    public func numberOfRows(in tableView: NSTableView) -> Int {
        visibleExposureRows.count
    }

    public func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let rows = visibleExposureRows
        guard row >= 0, row < rows.count else { return nil }
        let model = rows[row]
        let checkbox = NSButton(checkboxWithTitle: "\(model.displayName)  ·  \(model.publicId)", target: self, action: #selector(toggleExposureRow(_:)))
        checkbox.state = exposurePending.contains(model.publicId) ? .on : .off
        checkbox.tag = row
        checkbox.setAccessibilityLabel(model.publicId)
        return checkbox
    }

    @objc func toggleExposureRow(_ sender: NSButton) {
        let rows = visibleExposureRows
        guard sender.tag >= 0, sender.tag < rows.count else { return }
        let publicId = rows[sender.tag].publicId
        if sender.state == .on { exposurePending.insert(publicId) } else { exposurePending.remove(publicId) }
        exposureStatus.stringValue = "\(exposurePending.count) OpenRouter model(s) staged · choose Apply to rebuild the catalog."
        exposureStatus.textColor = .systemOrange
    }
}
