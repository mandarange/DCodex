import Cocoa

/// Shared visual components for Control Center pages.
///
/// Core layout and disclosure components live in NativeView.swift; this file
/// supplies the optional visual helpers used by individual Center pages.
enum ControlKitTone {
    case ok, warning, error, neutral, busy

    var color: NSColor {
        switch self {
        case .ok: return .systemGreen
        case .warning: return .systemOrange
        case .error: return .systemRed
        case .neutral: return .secondaryLabelColor
        case .busy: return .systemBlue
        }
    }
}

enum ControlKit {
    /// Small colored dot + short state text, for scannable card status lines.
    static func badge(_ text: String, tone: ControlKitTone) -> NSView {
        let dot = NSTextField(labelWithString: "●")
        dot.font = NSFont.systemFont(ofSize: 10)
        dot.textColor = tone.color
        dot.setAccessibilityHidden(true)
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setAccessibilityLabel(text)
        let row = NSStackView(views: [dot, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        return row
    }

    /// Update an existing badge row produced by `badge(_:tone:)` in place.
    static func setBadge(_ view: NSView, text: String, tone: ControlKitTone) {
        guard let row = view as? NSStackView, row.arrangedSubviews.count >= 2,
              let dot = row.arrangedSubviews[0] as? NSTextField,
              let label = row.arrangedSubviews[1] as? NSTextField else { return }
        dot.textColor = tone.color
        label.stringValue = text
        label.setAccessibilityLabel(text)
    }

    /// Fixed-width key + wrapping value row for status details.
    static func keyValueRow(_ key: String, _ value: NSTextField) -> NSStackView {
        let keyLabel = NSTextField(labelWithString: key)
        keyLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        keyLabel.textColor = .secondaryLabelColor
        keyLabel.setContentHuggingPriority(.required, for: .horizontal)
        keyLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 92).isActive = true
        let row = NSStackView(views: [keyLabel, value])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 8
        return row
    }

    /// A visually prominent recommended action. Return-key activation is
    /// opt-in so a page can never acquire several competing default buttons.
    static func primaryButton(_ title: String, target: AnyObject, action: Selector, isDefault: Bool = false) -> NSButton {
        let button = NSButton(title: title, target: target, action: action)
        button.bezelStyle = .rounded
        button.bezelColor = .controlAccentColor
        if isDefault { button.keyEquivalent = "\r" }
        button.setAccessibilityLabel(title)
        button.setAccessibilityIdentifier("sks-center-primary-\(identifier(title))")
        return button
    }

    /// Page header: large title + one-line subtitle, replacing per-page ad hoc stacks.
    static func header(_ title: String, _ subtitle: String) -> NSStackView {
        let heading = NativeView.title(title)
        let detail = NativeView.detail(subtitle)
        let stack = NSStackView(views: [heading, detail])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.setAccessibilityIdentifier("sks-center-header-\(identifier(title))")
        return stack
    }

    /// Horizontal action row that keeps a visual gap between the primary
    /// action group and trailing (destructive or rarely used) actions.
    static func actionRow(_ leading: [NSView], trailing: [NSView] = []) -> NSStackView {
        let row = NSStackView(views: leading)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if !trailing.isEmpty {
            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            spacer.widthAnchor.constraint(greaterThanOrEqualToConstant: 24).isActive = true
            row.addArrangedSubview(spacer)
            for view in trailing { row.addArrangedSubview(view) }
        }
        return row
    }

    private static func identifier(_ value: String) -> String {
        value.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
    }
}
