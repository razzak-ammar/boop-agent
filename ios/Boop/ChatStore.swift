import Foundation
import Observation
import SwiftUI
import UIKit

/// The one conversation: local cache, the in-flight turn, and the typewriter.
@Observable
final class ChatStore {
    private(set) var messages: [Message]
    private(set) var phase: ChatPhase = .idle
    private(set) var connectionError: String?
    /// Older messages exist on the server beyond what's loaded.
    private(set) var hasOlder = false

    static let pageSize = 30
    /// How many of the newest messages to keep in sync. Grows as you scroll up.
    @ObservationIgnored private var window = ChatStore.pageSize
    @ObservationIgnored private var loadingOlder = false

    @ObservationIgnored private let settings: AppSettings
    @ObservationIgnored private var queue: [String] = []           // user message ids waiting for a turn
    @ObservationIgnored private var turnTask: Task<Void, Never>?
    @ObservationIgnored private var turnMessageID: String?
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var saveTask: Task<Void, Never>?

    // Typewriter state for the assistant message being written.
    @ObservationIgnored private var streamingID: String?
    @ObservationIgnored private var target: [Character] = []
    @ObservationIgnored private var revealed = 0
    @ObservationIgnored private var revealTask: Task<Void, Never>?
    @ObservationIgnored private var replyDone = false

    static let sendAnimation = Animation.spring(duration: 0.42, bounce: 0.22)

    init(settings: AppSettings) {
        self.settings = settings
        // Read synchronously so the first frame already shows the conversation.
        messages = Self.markRead(MessageCache.load())
    }

    var isStreaming: Bool { streamingID != nil }
    var isTurnInFlight: Bool { turnTask != nil }

    // MARK: - Sending

    func send(_ text: String) {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        let message = Message(id: UUID().uuidString, role: .user, content: content, createdAt: .now, status: .sending)
        withAnimation(Self.sendAnimation) { messages.append(message) }
        haptic(.light)
        queue.append(message.id)
        runNextTurn()
    }

    func retry(_ id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].status = .sending
        queue.append(id)
        runNextTurn()
    }

    private func runNextTurn() {
        guard turnTask == nil, !queue.isEmpty else { return }
        let id = queue.removeFirst()
        guard let message = messages.first(where: { $0.id == id }) else { runNextTurn(); return }

        turnTask = Task { [weak self] in
            await self?.runTurn(for: message)
            guard let self else { return }
            self.turnTask = nil
            if self.queue.isEmpty {
                self.scheduleSave()
                self.scheduleRefresh(after: .milliseconds(400))
            } else {
                self.runNextTurn()
            }
        }
    }

    private func runTurn(for message: Message) async {
        let client: BoopClient
        do { client = try BoopClient(settings: settings) } catch {
            fail(message.id, error)
            return
        }
        setPhase(.thinking)
        turnMessageID = message.id
        defer { turnMessageID = nil }
        var delivered = false
        do {
            for try await event in client.chat(message.content) {
                if !delivered {
                    delivered = true
                    setStatus(message.id, .sent)
                    connectionError = nil
                }
                handle(event)
            }
            if !replyDone, streamingID != nil { replyDone = true }
            await waitForReveal()
        } catch is CancellationError {
        } catch {
            if delivered {
                // The server keeps going without us; pick the reply up from history.
                dropStreaming()
            } else {
                fail(message.id, error)
            }
        }
        finishStreaming()
        setPhase(.idle)
    }

    private func handle(_ event: ChatEvent) {
        // "thinking" only means the server has it; anything after that is the agent at work.
        switch event {
        case .status("thinking", _), .failure: break
        default: markTurnRead()
        }
        switch event {
        case .status(let state, let label):
            switch state {
            case "working": setPhase(.working(label ?? "Working"))
            case "responding": setPhase(.responding)
            default: setPhase(.thinking)
            }
        case .delta(let text):
            appendStreaming(text)
        case .reset:
            dropStreaming()
        case .ack(let content):
            dropStreaming()
            let ack = Message(id: UUID().uuidString, role: .assistant, content: content, createdAt: .now)
            withAnimation(Self.sendAnimation) { messages.append(ack) }
        case .reply(let content):
            completeStreaming(with: content)
        case .failure(let text):
            dropStreaming()
            let note = Message(id: UUID().uuidString, role: .assistant, content: text, createdAt: .now)
            withAnimation(Self.sendAnimation) { messages.append(note) }
        }
    }

    private func markTurnRead() {
        guard let id = turnMessageID,
              let index = messages.firstIndex(where: { $0.id == id }),
              messages[index].readAt == nil else { return }
        withAnimation(.smooth(duration: 0.3)) { messages[index].readAt = .now }
    }

    // MARK: - Typewriter

    private func appendStreaming(_ text: String) {
        if streamingID == nil {
            let id = UUID().uuidString
            streamingID = id
            target = []
            revealed = 0
            replyDone = false
            withAnimation(Self.sendAnimation) {
                messages.append(Message(id: id, role: .assistant, content: "", createdAt: .now))
            }
            haptic(.soft)
        }
        target.append(contentsOf: text)
        startRevealing()
    }

    private func completeStreaming(with final: String) {
        if streamingID == nil {
            appendStreaming(final)
        } else {
            let finalChars = Array(final)
            let shown = target.prefix(revealed)
            if !finalChars.starts(with: shown) {
                // The server rewrote the reply (e.g. a schedule receipt); retype from the common prefix.
                revealed = zip(finalChars, shown).prefix { $0 == $1 }.count
            }
            target = finalChars
        }
        replyDone = true
        startRevealing()
    }

    private func startRevealing() {
        guard revealTask == nil else { return }
        revealTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                guard self.revealed < self.target.count else {
                    if self.replyDone { break }
                    try? await Task.sleep(for: .milliseconds(16))
                    continue
                }
                let backlog = self.target.count - self.revealed
                let base = self.settings.typingSpeed.baseRate
                // Catch up smoothly when the network outpaces the animation.
                let step = base == .max ? backlog : max(base, backlog / 12)
                self.revealed = min(self.target.count, self.revealed + step)
                self.updateStreamingText()
                try? await Task.sleep(for: .milliseconds(16))
            }
            self?.revealTask = nil
        }
    }

    private func updateStreamingText() {
        guard let id = streamingID, let index = messages.lastIndex(where: { $0.id == id }) else { return }
        messages[index].content = String(target.prefix(revealed))
    }

    private func waitForReveal() async {
        while let task = revealTask {
            await task.value
        }
    }

    private func finishStreaming() {
        revealTask?.cancel()
        revealTask = nil
        if let id = streamingID, let index = messages.lastIndex(where: { $0.id == id }) {
            messages[index].content = String(target)
            if messages[index].content.isEmpty { messages.remove(at: index) }
        }
        streamingID = nil
        target = []
        revealed = 0
        replyDone = false
    }

    private func dropStreaming() {
        revealTask?.cancel()
        revealTask = nil
        if let id = streamingID {
            withAnimation(.easeOut(duration: 0.2)) { messages.removeAll { $0.id == id } }
        }
        streamingID = nil
        target = []
        revealed = 0
        replyDone = false
    }

    // MARK: - Sync

    /// Pulls the conversation from the server. Skipped mid-turn so the
    /// streaming bubble is never yanked away.
    func refresh() async {
        guard turnTask == nil, let client = try? BoopClient(settings: settings) else { return }
        do {
            let (remote, more) = try await client.messages(limit: window)
            guard turnTask == nil else { return }
            connectionError = nil
            hasOlder = more
            let merged = Self.reconcile(local: messages, remote: remote)
            if merged != messages {
                let isAppend = merged.count > messages.count && merged.starts(with: messages)
                withAnimation(isAppend ? Self.sendAnimation : nil) { messages = merged }
                scheduleSave()
            }
        } catch {
            connectionError = error.localizedDescription
        }
    }

    /// Pulls the next 30 older messages. Bubbles already on screen keep their
    /// place: the list is anchored to the bottom, so growth at the top doesn't move them.
    func loadOlder() async {
        guard hasOlder, !loadingOlder, turnTask == nil,
              let client = try? BoopClient(settings: settings) else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let (remote, more) = try await client.messages(limit: window + Self.pageSize)
            guard turnTask == nil else { return }
            window += Self.pageSize
            hasOlder = more
            let merged = Self.reconcile(local: messages, remote: remote)
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { messages = merged }
        } catch {
            connectionError = error.localizedDescription
        }
    }

    /// Server history wins, but local ids are kept for matching messages so
    /// SwiftUI doesn't re-insert (and re-animate) bubbles already on screen.
    static func reconcile(local: [Message], remote: [Message]) -> [Message] {
        var pool: [String: [Message]] = [:]
        for message in local where message.status == .sent {
            pool["\(message.role.rawValue)|\(message.content)", default: []].append(message)
        }
        var merged = remote.map { remoteMessage -> Message in
            var message = remoteMessage
            let key = "\(message.role.rawValue)|\(message.content)"
            if var matches = pool[key], !matches.isEmpty {
                let known = matches.removeFirst()
                message.id = known.id
                message.readAt = known.readAt
                pool[key] = matches
            }
            return message
        }
        merged = markRead(merged)
        // Keep messages that haven't reached the server yet.
        merged.append(contentsOf: local.filter { $0.status != .sent })
        return merged
    }

    /// A user message counts as read once anything from the agent follows it.
    static func markRead(_ messages: [Message]) -> [Message] {
        var messages = messages
        var nextReply: Date?
        for index in messages.indices.reversed() {
            if messages[index].role == .assistant {
                nextReply = messages[index].createdAt
            } else if messages[index].readAt == nil, messages[index].status == .sent, let nextReply {
                messages[index].readAt = nextReply
            }
        }
        return messages
    }

    private func scheduleRefresh(after delay: Duration) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    /// Foreground: refresh, then listen for server-side changes until backgrounded.
    func becameActive() {
        scheduleRefresh(after: .zero)
        guard eventsTask == nil else { return }
        eventsTask = Task { [weak self] in
            var backoff: Duration = .seconds(1)
            while !Task.isCancelled {
                guard let self, let client = try? BoopClient(settings: self.settings) else {
                    try? await Task.sleep(for: .seconds(3))
                    continue
                }
                do {
                    for try await _ in client.changes() {
                        backoff = .seconds(1)
                        self.scheduleRefresh(after: .milliseconds(300))
                    }
                } catch {}
                try? await Task.sleep(for: backoff)
                backoff = min(backoff * 2, .seconds(30))
            }
        }
    }

    func resignedActive() {
        eventsTask?.cancel()
        eventsTask = nil
        MessageCache.save(messages)
    }

    func settingsChanged() {
        eventsTask?.cancel()
        eventsTask = nil
        becameActive()
    }

    // MARK: - Helpers

    private func setPhase(_ next: ChatPhase) {
        guard phase != next else { return }
        withAnimation(.smooth(duration: 0.3)) { phase = next }
    }

    private func setStatus(_ id: String, _ status: Message.Status) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].status = status
    }

    private func fail(_ id: String, _ error: Error) {
        withAnimation(.smooth) { setStatus(id, .failed) }
        connectionError = error.localizedDescription
        haptic(.rigid)
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, !Task.isCancelled else { return }
            MessageCache.save(self.messages)
        }
    }

    private func haptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        guard settings.haptics else { return }
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }
}

/// The newest page of messages on disk, so launch never waits on the network.
enum MessageCache {
    private static var url: URL {
        URL.cachesDirectory.appending(path: "conversation.json")
    }

    static func load() -> [Message] {
        guard let data = try? Data(contentsOf: url),
              let messages = try? JSONDecoder().decode([Message].self, from: data) else { return [] }
        // Anything mid-flight when the app died is shown as failed, ready to retry.
        return messages.map { message in
            var message = message
            if message.status == .sending { message.status = .failed }
            return message
        }
    }

    static func save(_ messages: [Message]) {
        guard let data = try? JSONEncoder().encode(Array(messages.suffix(ChatStore.pageSize))) else { return }
        let url = url
        Task.detached(priority: .utility) {
            try? data.write(to: url, options: .atomic)
        }
    }
}
