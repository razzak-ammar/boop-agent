import Foundation
import Observation
import Security

/// User preferences. Appearance lives in UserDefaults; the server token in the Keychain.
@Observable
final class AppSettings {
    private let defaults = UserDefaults.standard

    var serverURL: String { didSet { defaults.set(serverURL, forKey: "serverURL") } }
    var token: String { didSet { Keychain.set(token, for: "appToken") } }

    var background: BackgroundStyle { didSet { defaults.set(background.rawValue, forKey: "background") } }
    var bubbleColor: BubbleColor { didSet { defaults.set(bubbleColor.rawValue, forKey: "bubbleColor") } }
    var assistantStyle: AssistantStyle { didSet { defaults.set(assistantStyle.rawValue, forKey: "assistantStyle") } }
    var bubbleRadius: Double { didSet { defaults.set(bubbleRadius, forKey: "bubbleRadius") } }
    var textSize: TextSize { didSet { defaults.set(textSize.rawValue, forKey: "textSize") } }
    var typingSpeed: TypingSpeed { didSet { defaults.set(typingSpeed.rawValue, forKey: "typingSpeed") } }
    var showActivity: Bool { didSet { defaults.set(showActivity, forKey: "showActivity") } }
    var haptics: Bool { didSet { defaults.set(haptics, forKey: "haptics") } }

    init() {
        let d = UserDefaults.standard
        #if DEBUG && targetEnvironment(simulator)
        let defaultURL = "http://localhost:3456"
        #else
        let defaultURL = ""
        #endif
        serverURL = d.string(forKey: "serverURL") ?? defaultURL
        token = Keychain.get("appToken") ?? ""
        background = d.string(forKey: "background").flatMap(BackgroundStyle.init) ?? .graphite
        bubbleColor = d.string(forKey: "bubbleColor").flatMap(BubbleColor.init) ?? .amber
        assistantStyle = d.string(forKey: "assistantStyle").flatMap(AssistantStyle.init) ?? .bubble
        bubbleRadius = d.object(forKey: "bubbleRadius") as? Double ?? 20
        textSize = d.string(forKey: "textSize").flatMap(TextSize.init) ?? .medium
        typingSpeed = d.string(forKey: "typingSpeed").flatMap(TypingSpeed.init) ?? .natural
        showActivity = d.object(forKey: "showActivity") as? Bool ?? true
        haptics = d.object(forKey: "haptics") as? Bool ?? true
    }

    var isConfigured: Bool { baseURL != nil && !token.isEmpty }

    var baseURL: URL? {
        var raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        if !raw.contains("://") { raw = "https://" + raw }
        while raw.hasSuffix("/") { raw.removeLast() }
        return URL(string: raw)
    }

    var bubbleAppearance: BubbleAppearance {
        BubbleAppearance(
            userFill: bubbleColor.fill,
            userForeground: bubbleColor.foreground,
            assistantFill: background.assistantFill,
            assistantStyle: assistantStyle,
            radius: bubbleRadius,
            fontSize: textSize.points
        )
    }
}

enum Keychain {
    private static let service = "dev.boopagent.Boop"

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String, for key: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
