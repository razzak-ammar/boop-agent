import Foundation

enum BoopError: LocalizedError {
    case notConfigured
    case http(Int)
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Add a server and token."
        case .http(401): "Token rejected."
        case .http(404): "Server has no app API. Set BOOP_APP_TOKEN."
        case .http(let code): "Server error \(code)."
        case .server(let message): message
        }
    }
}

/// Talks to the Boop server's /app API.
struct BoopClient {
    let baseURL: URL
    let token: String

    init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
    }

    init(settings: AppSettings) throws {
        guard let url = settings.baseURL, !settings.token.isEmpty else { throw BoopError.notConfigured }
        self.init(baseURL: url, token: settings.token)
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 90 // idle gap; the server pings every 15s
        config.timeoutIntervalForResource = 60 * 30
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: "app").appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await Self.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let error = body["error"] as? String, status == 400 {
                throw BoopError.server(error)
            }
            throw BoopError.http(status)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// The newest `limit` messages, and whether older ones exist.
    func messages(limit: Int) async throws -> (messages: [Message], hasMore: Bool) {
        var req = request("messages")
        req.url?.append(queryItems: [URLQueryItem(name: "limit", value: String(limit))])
        let response = try await send(req, as: MessagesResponse.self)
        return (response.messages.compactMap(\.message), response.hasMore ?? false)
    }

    func config() async throws -> RuntimeConfig {
        try await send(request("config"), as: RuntimeConfig.self)
    }

    func updateConfig(_ changes: [String: Any]) async throws -> RuntimeConfig {
        try await send(request("config", method: "POST", body: changes), as: RuntimeConfig.self)
    }

    /// One chat turn as a stream of events.
    func chat(_ content: String) -> AsyncThrowingStream<ChatEvent, Error> {
        let req = request("chat", method: "POST", body: ["content": content])
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await (name, data) in Self.serverSentEvents(req) {
                        if let event = Self.decode(name: name, data: data) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Fires whenever the conversation changes server-side (reminders, automations).
    func changes() -> AsyncThrowingStream<Void, Error> {
        let req = request("events")
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await (name, _) in Self.serverSentEvents(req) where name == "changed" {
                        continuation.yield(())
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Server-sent events

    /// The server writes `event:` then a single-line `data:`, so each data line
    /// completes an event. (`AsyncBytes.lines` drops blank lines, so the usual
    /// blank-line dispatch can't be relied on.)
    private static func serverSentEvents(_ request: URLRequest) -> AsyncThrowingStream<(String, String), Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = request
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await session.bytes(for: req)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard (200..<300).contains(status) else { throw BoopError.http(status) }
                    var name = "message"
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") {
                            name = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            continuation.yield((name, String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)))
                            name = "message"
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func decode(name: String, data: String) -> ChatEvent? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else { return nil }
        switch name {
        case "status":
            return .status(state: object["state"] as? String ?? "thinking", label: object["label"] as? String)
        case "delta":
            if object["reset"] as? Bool == true { return .reset }
            return (object["text"] as? String).map(ChatEvent.delta)
        case "ack":
            return (object["content"] as? String).map(ChatEvent.ack)
        case "reply":
            return (object["content"] as? String).map(ChatEvent.reply)
        case "error":
            return .failure(object["message"] as? String ?? "Something went wrong.")
        default:
            return nil
        }
    }
}
