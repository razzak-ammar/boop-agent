import SwiftUI

struct ChatView: View {
    @Environment(ChatStore.self) private var store
    @Environment(AppSettings.self) private var settings

    @State private var draft = ""
    @State private var showSettings = false
    @State private var page: Page? = .chat
    @State private var menuOpen = false
    @State private var nearBottom = true
    @State private var sendCount = 0
    @State private var position = ScrollPosition(edge: .bottom)
    /// How far the chat has been dragged left past its edge.
    @State private var peek: CGFloat = 0
    /// 0 on tasks, 1 on chat, in between mid-swipe. Drives the header swap.
    @State private var chatProgress: CGFloat = 1
    @FocusState private var composerFocused: Bool

    private struct Row: Identifiable {
        let message: Message
        let groupStart: Bool
        let stamp: Date?
        let receipt: Receipt?
        var id: String { message.id }
    }

    private var rows: [Row] {
        let messages = store.messages
        // Only your latest delivered message carries a receipt.
        let receiptIndex = messages.lastIndex { $0.role == .user && $0.status == .sent }
        var previous: Message?
        return messages.indices.map { index in
            let message = messages[index]
            defer { previous = message }
            let farApart = previous.map { message.createdAt.timeIntervalSince($0.createdAt) > Stamp.gap } ?? true
            return Row(
                message: message,
                groupStart: message.role != previous?.role || farApart,
                stamp: farApart ? message.createdAt : nil,
                receipt: index == receiptIndex ? message.readAt.map(Receipt.read) ?? .delivered : nil
            )
        }
    }

    enum Page: Hashable { case chat, tasks }

    private static let peekLimit: CGFloat = 76

    /// Room under the shared atom header.
    private static let headerHeight: CGFloat = 58

    private var showsTyping: Bool {
        store.phase.isBusy && !store.isStreaming
    }

    var body: some View {
        // Tasks and chat sit side by side; the atom stays put above both.
        // Chat is the last page, so dragging it left rubber-bands past the
        // edge and pulls each message's time into view, like Messages.
        ScrollView(.horizontal) {
            HStack(spacing: 0) {
                TasksPage(color: settings.bubbleColor.fill)
                    .safeAreaPadding(.top, Self.headerHeight)
                    .containerRelativeFrame(.horizontal)
                    .id(Page.tasks)
                chat
                    // The rubber band would keep going; stop once the times are out.
                    .offset(x: max(0, peek - Self.peekLimit))
                    .containerRelativeFrame(.horizontal)
                    .id(Page.chat)
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $page)
        .defaultScrollAnchor(.trailing, for: .initialOffset)
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { closeMenu() }
        }
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            max(0, geometry.visibleRect.maxX - geometry.contentSize.width)
        } action: { _, overscroll in
            peek = overscroll
        }
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            min(1, max(0, geometry.contentOffset.x / max(1, geometry.containerSize.width)))
        } action: { _, progress in
            chatProgress = progress
        }
        .onChange(of: page) {
            dismissKeyboard()
            closeMenu()
        }
        .overlay(alignment: .top) { header }
        .background(settings.background.color.ignoresSafeArea())
        // Settings slides up over everything and takes the whole screen.
        .fullScreenCover(isPresented: $showSettings, onDismiss: store.settingsChanged) {
            SettingsView()
        }
        .task {
            if !settings.isConfigured { showSettings = true }
        }
    }

    private var chat: some View {
        let appearance = settings.bubbleAppearance

        return ScrollView {
            LazyVStack(spacing: 0) {
                if store.hasOlder {
                    // Scrolling up to here pulls in the previous 30.
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .onAppear { Task { await store.loadOlder() } }
                }

                ForEach(rows) { row in
                    VStack(spacing: 0) {
                        if let stamp = row.stamp {
                            StampHeader(date: stamp)
                        }
                        MessageBubble(
                            message: row.message,
                            groupStart: row.groupStart,
                            appearance: appearance,
                            onRetry: { store.retry(row.message.id) }
                        )
                        .equatable()
                        if let receipt = row.receipt {
                            ReceiptLabel(receipt: receipt)
                        }
                    }
                    .transition(.rise(from: row.message.role == .user ? .bottomTrailing : .bottomLeading))
                }

                if showsTyping {
                    TypingIndicator(
                        appearance: appearance,
                        label: settings.showActivity ? store.phase.label : nil
                    )
                    .transition(.rise(from: .bottomLeading))
                }
            }
            .padding(.bottom, 10)
        }
        .scrollPosition($position)
        // Times parked past the right edge must survive the clip, but only sideways.
        .scrollClipDisabled()
        .clipShape(TrailingBleed())
        .defaultScrollAnchor(.bottom)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { closeMenu() }
        }
        .onAppear {
            // Land on the newest message, whatever the pager did on the way in.
            position.scrollTo(edge: .bottom)
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentSize.height - geometry.visibleRect.maxY < 120
        } action: { _, isNear in
            nearBottom = isNear
        }
        .onChange(of: store.messages.last?.id) {
            // Follow new messages, unless you've scrolled up to read.
            if nearBottom {
                withAnimation(ChatStore.sendAnimation) { position.scrollTo(edge: .bottom) }
            }
        }
        .overlay {
            // Tap anywhere else to put the buttons away.
            if menuOpen {
                Color.clear
                    .contentShape(.rect)
                    .onTapGesture { closeMenu() }
            }
        }
        .overlay {
            if isEmpty {
                VStack {
                    Spacer()
                    menu(size: 64)
                    Spacer()
                    SuggestionChips { prompt in send(prompt) }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }
        }
        .safeAreaBar(edge: .top) { Color.clear.frame(height: Self.headerHeight) }
        .scrollEdgeEffectHidden(true, for: .top)
        .safeAreaBar(edge: .bottom) {
            Composer(
                text: $draft,
                focused: $composerFocused,
                accent: settings.bubbleColor,
                sendCount: sendCount,
                onSend: { send(draft) }
            )
            // The composer stays put while the messages slide to show their times.
            .offset(x: min(peek, Self.peekLimit))
        }
        .onChange(of: composerFocused) { _, focused in
            if focused { closeMenu() }
        }
        .animation(Self.listAnimation, value: showsTyping)
        .animation(.smooth, value: store.messages.isEmpty)
    }

    private static let listAnimation = ChatStore.sendAnimation

    private var isEmpty: Bool { store.messages.isEmpty && !store.phase.isBusy }

    private func menu(size: CGFloat) -> some View {
        AtomMenu(
            size: size,
            color: settings.bubbleColor.fill,
            phase: store.phase,
            isOpen: $menuOpen,
            showsError: store.connectionError != nil && !store.phase.isBusy,
            onSettings: { showSettings = true },
            secondarySymbol: "checklist",
            secondaryLabel: "Tasks",
            onSecondary: {
                withAnimation(.smooth(duration: 0.45)) { page = .tasks }
            }
        )
    }

    private func dismissKeyboard() {
        composerFocused = false
        // FocusState alone doesn't always let go once the field is off screen.
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func closeMenu() {
        guard menuOpen else { return }
        withAnimation(.spring(duration: 0.3)) { menuOpen = false }
    }

    /// Just the atom, centered, shared by both pages. On an empty chat the
    /// big one in the middle takes over.
    private var header: some View {
        // The atom belongs to the chat; on tasks it turns into a tasks mark,
        // and a profile button for settings slides in on the left. Both
        // track the swipe itself.
        let toTasks = 1 - chatProgress
        return ZStack {
            menu(size: 36)
                .opacity(isEmpty ? 0 : 1)
                .animation(.smooth, value: isEmpty)
                .opacity(chatProgress)
                .scaleEffect(0.6 + 0.4 * chatProgress)
                .blur(radius: 6 * toTasks)
                .rotationEffect(.degrees(-50 * toTasks))
                .allowsHitTesting(!isEmpty && chatProgress > 0.5)

            TasksMark(color: settings.bubbleColor.fill)
                .opacity(toTasks)
                .scaleEffect(0.6 + 0.4 * toTasks)
                .blur(radius: 6 * chatProgress)
                .rotationEffect(.degrees(50 * chatProgress))
                .allowsHitTesting(false)
        }
        .frame(maxWidth: .infinity)
        .overlay(alignment: .leading) {
            ProfileButton { showSettings = true }
                .padding(.leading, 12)
                .opacity(toTasks)
                .offset(x: -40 * chatProgress)
                .blur(radius: 4 * chatProgress)
                .allowsHitTesting(toTasks > 0.5)
        }
            .padding(.top, 2)
            .background {
                // Messages fade out as they scroll up under the status bar and atom.
                let bg = settings.background.color
                LinearGradient(
                    stops: [
                        .init(color: bg, location: 0),
                        .init(color: bg, location: 0.45),
                        .init(color: bg.opacity(0.85), location: 0.65),
                        .init(color: bg.opacity(0), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .padding(.bottom, -44)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
            }
    }

    private func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        draft = ""
        sendCount += 1
        closeMenu()
        store.send(trimmed)
        withAnimation(ChatStore.sendAnimation) { position.scrollTo(edge: .bottom) }
    }
}

/// What sits where the atom was while you're on tasks.
private struct TasksMark: View {
    let color: Color

    var body: some View {
        Image(systemName: "checklist")
            .font(.system(size: 24, weight: .medium))
            .foregroundStyle(color)
            .shadow(color: color.opacity(0.45), radius: 10)
            .frame(width: 54, height: 54)
            .accessibilityLabel("Tasks")
    }
}

/// Top left on tasks: straight to settings.
private struct ProfileButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "person.fill")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: 44, height: 44)
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .buttonStyle(AtomPress())
        .frame(width: 54, height: 54)
        .accessibilityLabel("Settings")
    }
}

/// The view's own bounds, opened up on the right for the peek times.
private nonisolated struct TrailingBleed: Shape {
    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX, y: rect.minY, width: rect.width + 80, height: rect.height))
    }
}

private struct SuggestionChips: View {
    let onPick: (String) -> Void
    private let prompts = ["Plan my day", "Anything urgent?"]

    var body: some View {
        HStack(spacing: 10) {
            ForEach(prompts, id: \.self) { prompt in
                Button(prompt) { onPick(prompt) }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .glassEffect(.regular.interactive(), in: .capsule)
            }
        }
        .padding(.bottom, 12)
    }
}
