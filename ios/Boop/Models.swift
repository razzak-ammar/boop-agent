import Foundation

struct Message: Identifiable, Codable, Equatable, Sendable {
    enum Role: String, Codable, Sendable { case user, assistant }
    enum Status: String, Codable, Sendable { case sent, sending, failed }

    var id: String
    var role: Role
    var content: String
    var createdAt: Date
    var status: Status = .sent
    /// When the agent started on it. Nil while it's only been delivered.
    var readAt: Date? = nil
}

/// What the agent is doing right now. Drives the orb, the typing row and its label.
enum ChatPhase: Equatable {
    case idle
    case thinking
    case working(String)
    case responding

    var isBusy: Bool { self != .idle }

    var label: String {
        switch self {
        case .idle: ""
        case .thinking: "Thinking"
        case .working(let label): label
        case .responding: "Typing"
        }
    }
}

// MARK: - Server payloads

struct ServerMessage: Decodable {
    let id: String
    let role: String
    let content: String
    let createdAt: Double

    var message: Message? {
        guard let role = Message.Role(rawValue: role) else { return nil }
        return Message(id: id, role: role, content: content,
                       createdAt: Date(timeIntervalSince1970: createdAt / 1000))
    }
}

struct MessagesResponse: Decodable {
    let messages: [ServerMessage]
    let hasMore: Bool?
}

struct ModelOption: Decodable, Hashable, Identifiable {
    let value: String
    let label: String
    var id: String { value }

    /// "Fable 5.2 (most capable, priciest)" -> "Fable 5.2"
    var shortLabel: String {
        label.components(separatedBy: " (").first ?? label
    }
}

struct RuntimeConfig: Decodable, Equatable {
    var runtime: String
    var model: String
    var reasoningEffort: String?
    var models: [String: [ModelOption]]
    var reasoningEfforts: [String]
    /// Missing on servers older than the check-in destination setting.
    var checkinDestination: String?
    var telegramAvailable: Bool?

    var currentModels: [ModelOption] { models[runtime] ?? [] }
}

/// Where scheduled check-ins and reminders are delivered (server setting
/// `checkin_destination`).
enum CheckinDestination: String, CaseIterable, Identifiable {
    case origin, telegram, app, both

    var id: String { rawValue }

    var title: String {
        switch self {
        case .origin: "Where They Were Set Up"
        case .telegram: "Telegram"
        case .app: "App"
        case .both: "Both"
        }
    }

    var shortTitle: String {
        self == .origin ? "Original Chat" : title
    }

    var needsTelegram: Bool { self == .telegram || self == .both }
}

/// One event from POST /app/chat.
enum ChatEvent {
    case status(state: String, label: String?)
    case delta(String)
    case reset
    case ack(String)
    case reply(String)
    case failure(String)
}
