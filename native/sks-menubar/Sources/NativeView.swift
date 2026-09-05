import Cocoa

/// Pages that should reload local status whenever the Control Center section becomes visible.
protocol ControlCenterPage: AnyObject {
    func refreshOnAppear()
}

final class TopAlignedStackView: NSStackView {
    override var isFlipped: Bool { true }
}

/// Keyboard-operable disclosure that removes collapsed content from stack layout.
final class NativeDisclosure: NSStackView {
    let toggle: NSButton
    let body: NSStackView

    init(_ title: String, views: [NSView], expanded: Bool = false) {
        toggle = NSButton(checkboxWithTitle: title, target: nil, action: nil)
        body = NSStackView(views: views)
        super.init(frame: .zero)
        orientation = .vertical
        alignment = .width
        spacing = 10
        toggle.setButtonType(.pushOnPushOff)
        toggle.bezelStyle = .inline
        toggle.imagePosition = .imageLeading
        toggle.alignment = .left
        toggle.font = .systemFont(ofSize: 13, weight: .medium)
        toggle.target = self
        toggle.action = #selector(toggleExpanded)
        toggle.setAccessibilityLabel(title)
        toggle.setAccessibilityIdentifier("sks-disclosure-" + title.lowercased().replacingOccurrences(of: " ", with: "-"))
        body.orientation = .vertical
        body.alignment = .width
        body.spacing = 12
        addArrangedSubview(toggle)
        addArrangedSubview(body)
        toggle.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        body.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        for content in views {
            content.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
        setExpanded(expanded)
    }
    required init?(coder: NSCoder) { nil }

    func setExpanded(_ expanded: Bool) {
        toggle.state = expanded ? .on : .off
        toggle.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        body.isHidden = !expanded
        toggle.setAccessibilityValue(expanded ? "Expanded" : "Collapsed")
    }
    @objc private func toggleExpanded() { setExpanded(toggle.state == .on) }
}

enum NativeView {
    static let statusTimeout: TimeInterval = 8
    static let mutationTimeout: TimeInterval = 90
    static let longMutationTimeout: TimeInterval = 60 * 60

    static func title(_ value: String) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.font = NSFont.systemFont(ofSize: 18, weight: .semibold)
        field.alignment = .left
        field.setAccessibilityLabel(value)
        field.setAccessibilityIdentifier("sks-center-heading-\(identifier(value))")
        return field
    }

    static func detail(_ value: String) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: value)
        field.font = NSFont.systemFont(ofSize: 12)
        field.textColor = .secondaryLabelColor
        field.alignment = .left
        // Long status and help copy must wrap inside the current window instead
        // of contributing an intrinsic minimum width while users change pages.
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    static func sectionTitle(_ value: String) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        field.alignment = .left
        field.setAccessibilityLabel(value)
        return field
    }

    static func button(_ title: String, target: AnyObject, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: target, action: action)
        button.bezelStyle = .rounded
        button.setAccessibilityLabel(title)
        button.setAccessibilityIdentifier("sks-center-button-\(identifier(title))")
        return button
    }

    static func stack(_ views: [NSView]) -> NSStackView {
        let stack = TopAlignedStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 22, right: 24)
        return stack
    }

    static func page(_ views: [NSView]) -> NSStackView {
        let stack = stack(views)
        stack.alignment = .width
        for view in stack.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true
        }
        return stack
    }

    static func row(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let row = NSStackView(views: views)
        row.orientation = .horizontal; row.alignment = .centerY; row.spacing = spacing
        row.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return row
    }

    static func card(title: String, subtitle: String, views: [NSView], fullWidthLeadingContent: Bool = false) -> NSBox {
        let box = NSBox()
        box.boxType = .custom; box.titlePosition = .noTitle
        box.cornerRadius = 10; box.borderWidth = 1
        box.borderColor = .separatorColor; box.fillColor = .controlBackgroundColor
        box.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let heading = sectionTitle(title); let help = detail(subtitle)
        let content = NSStackView(views: (subtitle.isEmpty ? [heading] : [heading, help]) + views)
        content.orientation = .vertical; content.alignment = .width
        content.spacing = 10; content.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        content.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in content.arrangedSubviews {
            view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            view.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -32).isActive = true
        }
        content.translatesAutoresizingMaskIntoConstraints = false
        box.contentView?.addSubview(content)
        if let host = box.contentView {
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                content.topAnchor.constraint(equalTo: host.topAnchor),
                content.bottomAnchor.constraint(equalTo: host.bottomAnchor)
            ])
        }
        box.setAccessibilityLabel(title)
        box.setAccessibilityHelp(subtitle)
        box.setAccessibilityRole(.group)
        box.setAccessibilityIdentifier("sks-center-card-\(identifier(title))")
        return box
    }

    static func badge(_ text: String, color: NSColor) -> NSView {
        let dot = NSTextField(labelWithString: "●")
        dot.font = NSFont.systemFont(ofSize: 10)
        dot.textColor = color
        dot.setAccessibilityHidden(true)
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        label.alignment = .left
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setAccessibilityLabel(text)
        let row = NSStackView(views: [dot, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        return row
    }

    static func setBadge(_ view: NSView, text: String, color: NSColor) {
        guard let row = view as? NSStackView, row.arrangedSubviews.count >= 2,
              let dot = row.arrangedSubviews[0] as? NSTextField,
              let label = row.arrangedSubviews[1] as? NSTextField else { return }
        dot.textColor = color
        label.stringValue = text
        label.setAccessibilityLabel(text)
    }

    static func spinner(label: String) -> NSProgressIndicator {
        let indicator = NSProgressIndicator()
        indicator.style = .spinning
        indicator.controlSize = .small
        indicator.isDisplayedWhenStopped = false
        indicator.setAccessibilityLabel(label)
        return indicator
    }

    static func scrollable(_ document: NSView) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        document.translatesAutoresizingMaskIntoConstraints = false
        document.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        scroll.documentView = document
        if let content = scroll.contentView.documentView {
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
                content.topAnchor.constraint(equalTo: scroll.contentView.topAnchor)
            ])
        }
        return scroll
    }

    static func redactPreview(_ output: String, limit: Int = 160) -> String {
        let compact = output.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !compact.isEmpty else { return "No public detail was returned." }
        if compact.count <= limit { return compact }
        return String(compact.prefix(limit)) + "…"
    }

    private static func identifier(_ value: String) -> String {
        value.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
    }
}
