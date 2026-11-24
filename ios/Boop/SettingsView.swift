import SwiftUI

/// Full-screen settings: a short menu, each row opening its own page.
struct SettingsView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var config: RuntimeConfig?
    @State private var reachable: Bool?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { AppearancePage() } label: {
                        SettingsRow(title: "Appearance", symbol: "paintpalette") {
                            Circle().fill(settings.bubbleColor.fill).frame(width: 12, height: 12)
                        }
                    }
                    NavigationLink { ChatPage() } label: {
                        SettingsRow(title: "Chat", symbol: "bubble.left.and.bubble.right") {
                            Text(settings.typingSpeed.title)
                        }
                    }
                }

                Section {
                    NavigationLink { ModelPage() } label: {
                        SettingsRow(title: "Model", symbol: "cpu") {
                            if let config, let model = config.currentModels.first(where: { $0.value == config.model }) {
                                Text(model.shortLabel)
                            }
                        }
                    }
                    NavigationLink { CheckinsPage() } label: {
                        SettingsRow(title: "Check-ins", symbol: "bell.badge") {
                            if let raw = config?.checkinDestination,
                               let destination = CheckinDestination(rawValue: raw) {
                                Text(destination.shortTitle)
                            }
                        }
                    }
                    NavigationLink { ServerPage() } label: {
                        SettingsRow(title: "Server", symbol: "server.rack") {
                            if let reachable {
                                Circle().fill(reachable ? .green : .red).frame(width: 8, height: 8)
                            } else {
                                ProgressView().controlSize(.mini)
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(settings.background.color.ignoresSafeArea())
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "chevron.down") { dismiss() }
                }
            }
            .task(id: "\(settings.serverURL)|\(settings.token)") { await load() }
            .onAppear { Task { await load() } }
        }
        .tint(settings.bubbleColor.fill)
    }

    /// Current model and reachability for the row summaries.
    private func load() async {
        guard let client = try? BoopClient(settings: settings) else {
            config = nil
            reachable = false
            return
        }
        do {
            config = try await client.config()
            reachable = true
        } catch {
            config = nil
            reachable = false
        }
    }
}

private struct SettingsRow<Value: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder var value: Value

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(.white.opacity(0.12), in: .rect(cornerRadius: 8, style: .continuous))
            Text(title)
            Spacer()
            value
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

/// Shared look for each settings page.
private struct SettingsPage<Content: View>: View {
    @Environment(AppSettings.self) private var settings
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        Form { content }
            .scrollContentBackground(.hidden)
            .background(settings.background.color.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
    }
}

private struct AppearancePage: View {
    @Environment(AppSettings.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        SettingsPage(title: "Appearance") {
            Section {
                AppearancePreview(appearance: settings.bubbleAppearance, background: settings.background.color)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            Section("Color") {
                SwatchRow(selection: $settings.bubbleColor)
            }
            Section("Style") {
                Picker("Background", selection: $settings.background) {
                    ForEach(BackgroundStyle.allCases) { Text($0.title).tag($0) }
                }
                Picker("Replies", selection: $settings.assistantStyle) {
                    ForEach(AssistantStyle.allCases) { Text($0.title).tag($0) }
                }
                LabeledContent("Corners") {
                    Slider(value: $settings.bubbleRadius, in: 6...24, step: 1)
                        .frame(maxWidth: 180)
                }
            }
            Section("Text Size") {
                Picker("Text Size", selection: $settings.textSize) {
                    ForEach(TextSize.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
        }
    }
}

private struct ChatPage: View {
    @Environment(AppSettings.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        SettingsPage(title: "Chat") {
            Section {
                Picker("Typing", selection: $settings.typingSpeed) {
                    ForEach(TypingSpeed.allCases) { Text($0.title).tag($0) }
                }
                Toggle("Activity Labels", isOn: $settings.showActivity)
                Toggle("Haptics", isOn: $settings.haptics)
            }
        }
    }
}

private struct ModelPage: View {
    var body: some View {
        SettingsPage(title: "Model") { ModelSection() }
    }
}

private struct CheckinsPage: View {
    var body: some View {
        SettingsPage(title: "Check-ins") { CheckinsSection() }
    }
}

private struct ServerPage: View {
    @Environment(AppSettings.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        SettingsPage(title: "Server") {
            Section {
                TextField("https://boop.example.ts.net", text: $settings.serverURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Token", text: $settings.token)
                    .textContentType(.oneTimeCode) // keeps iOS from offering to save a password
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Section {
                ConnectionStatus()
            }
        }
    }
}

// MARK: - Appearance

private struct AppearancePreview: View {
    let appearance: BubbleAppearance
    let background: Color

    var body: some View {
        VStack(spacing: 0) {
            MessageBubble(
                message: Message(id: "a", role: .user, content: "What's on today?", createdAt: .now),
                groupStart: true, appearance: appearance
            )
            MessageBubble(
                message: Message(id: "b", role: .assistant, content: "Two meetings, gym at 6.", createdAt: .now),
                groupStart: true, appearance: appearance
            )
        }
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity)
        .background(background, in: .rect(cornerRadius: 26, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(.white.opacity(0.08))
        }
        .animation(.smooth, value: appearance)
    }
}

private struct SwatchRow: View {
    @Binding var selection: BubbleColor

    var body: some View {
        HStack {
            ForEach(BubbleColor.allCases) { color in
                Button {
                    selection = color
                } label: {
                    Circle()
                        .fill(color.fill)
                        .frame(width: 30, height: 30)
                        .padding(4)
                        .overlay {
                            Circle()
                                .strokeBorder(.white.opacity(selection == color ? 0.9 : 0), lineWidth: 2)
                        }
                        .scaleEffect(selection == color ? 1.05 : 0.92)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(color.rawValue.capitalized)
                if color != BubbleColor.allCases.last { Spacer(minLength: 0) }
            }
        }
        .padding(.vertical, 4)
        .animation(.spring(duration: 0.3, bounce: 0.4), value: selection)
        .sensoryFeedback(.selection, trigger: selection)
    }
}

// MARK: - Model

private struct ModelSection: View {
    @Environment(AppSettings.self) private var settings
    @State private var config: RuntimeConfig?
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        Section {
            if let config {
                Picker("Provider", selection: binding(\.runtime, key: "runtime")) {
                    Text("Claude").tag("claude")
                    Text("Codex").tag("codex")
                }
                .pickerStyle(.segmented)

                Picker("Model", selection: binding(\.model, key: "model")) {
                    ForEach(config.currentModels) { Text($0.shortLabel).tag($0.value) }
                }

                if config.runtime == "codex" {
                    Picker("Effort", selection: binding(\.reasoningEffort, key: "reasoningEffort")) {
                        ForEach(config.reasoningEfforts, id: \.self) { Text($0.capitalized).tag(Optional($0)) }
                    }
                }
            } else if error == nil {
                HStack {
                    Text("Model")
                    Spacer()
                    ProgressView()
                }
            }
            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } footer: {
            if saving { ProgressView().controlSize(.mini) }
        }
        .task(id: "\(settings.serverURL)|\(settings.token)") { await load() }
    }

    private func load() async {
        guard let client = try? BoopClient(settings: settings) else {
            config = nil
            error = BoopError.notConfigured.localizedDescription
            return
        }
        do {
            config = try await client.config()
            error = nil
        } catch {
            config = nil
            self.error = error.localizedDescription
        }
    }

    private func binding<T: Equatable>(_ path: WritableKeyPath<RuntimeConfig, T>, key: String) -> Binding<T> {
        Binding(
            get: { config![keyPath: path] },
            set: { newValue in
                guard config?[keyPath: path] != newValue else { return }
                let previous = config
                config?[keyPath: path] = newValue
                Task { await save([key: newValue as Any], revertTo: previous) }
            }
        )
    }

    private func save(_ changes: [String: Any], revertTo previous: RuntimeConfig?) async {
        guard let client = try? BoopClient(settings: settings) else { return }
        saving = true
        defer { saving = false }
        do {
            config = try await client.updateConfig(changes)
            error = nil
        } catch {
            config = previous
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Check-ins

private struct CheckinsSection: View {
    @Environment(AppSettings.self) private var settings
    @State private var config: RuntimeConfig?
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        Section {
            if let config, let current = CheckinDestination(rawValue: config.checkinDestination ?? "") {
                Picker("Send To", selection: selection(current)) {
                    ForEach(options(config, current: current)) { Text($0.title).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } else if config != nil {
                Text("Update the server to change this.")
                    .foregroundStyle(.secondary)
            } else if error == nil {
                HStack {
                    Text("Check-ins")
                    Spacer()
                    ProgressView()
                }
            }
            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } footer: {
            if saving {
                ProgressView().controlSize(.mini)
            } else {
                Text("Where scheduled check-ins and reminders are sent.")
            }
        }
        .task(id: "\(settings.serverURL)|\(settings.token)") { await load() }
    }

    /// Telegram choices only show when the server has Telegram set up
    /// (or one is already chosen).
    private func options(_ config: RuntimeConfig, current: CheckinDestination) -> [CheckinDestination] {
        CheckinDestination.allCases.filter {
            !$0.needsTelegram || config.telegramAvailable != false || $0 == current
        }
    }

    private func selection(_ current: CheckinDestination) -> Binding<CheckinDestination> {
        Binding(
            get: { current },
            set: { newValue in
                guard newValue != current else { return }
                let previous = config
                config?.checkinDestination = newValue.rawValue
                Task { await save(newValue, revertTo: previous) }
            }
        )
    }

    private func load() async {
        guard let client = try? BoopClient(settings: settings) else {
            config = nil
            error = BoopError.notConfigured.localizedDescription
            return
        }
        do {
            config = try await client.config()
            error = nil
        } catch {
            config = nil
            self.error = error.localizedDescription
        }
    }

    private func save(_ destination: CheckinDestination, revertTo previous: RuntimeConfig?) async {
        guard let client = try? BoopClient(settings: settings) else { return }
        saving = true
        defer { saving = false }
        do {
            config = try await client.updateConfig(["checkinDestination": destination.rawValue])
            error = nil
        } catch {
            config = previous
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Connection

private struct ConnectionStatus: View {
    @Environment(AppSettings.self) private var settings
    @State private var state: Status = .checking

    enum Status: Equatable { case checking, connected, failed(String) }

    var body: some View {
        HStack(spacing: 8) {
            switch state {
            case .checking:
                ProgressView().controlSize(.small)
                Text("Connecting").foregroundStyle(.secondary)
            case .connected:
                Circle().fill(.green).frame(width: 8, height: 8)
                Text("Connected").foregroundStyle(.secondary)
            case .failed(let message):
                Circle().fill(.red).frame(width: 8, height: 8)
                Text(message).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .font(.subheadline)
        .task(id: "\(settings.serverURL)|\(settings.token)") {
            state = .checking
            try? await Task.sleep(for: .milliseconds(400)) // debounce typing
            guard !Task.isCancelled else { return }
            do {
                let client = try BoopClient(settings: settings)
                _ = try await client.config()
                state = .connected
            } catch is CancellationError {
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }
}
