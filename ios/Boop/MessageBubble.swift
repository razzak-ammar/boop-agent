import SwiftUI
import UIKit

struct MessageBubble: View, Equatable {
    let message: Message
    let groupStart: Bool
    let appearance: BubbleAppearance
    var onRetry: (() -> Void)? = nil

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.message == rhs.message && lhs.groupStart == rhs.groupStart && lhs.appearance == rhs.appearance
    }

    private var isUser: Bool { message.role == .user }
    private var plain: Bool { !isUser && appearance.assistantStyle == .plain }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 52) }

            if message.status == .failed, let onRetry {
                Button(action: onRetry) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
                .transition(.scale.combined(with: .opacity))
                .accessibilityLabel("Retry")
            }

            Text(Self.render(message.content))
                .font(.system(size: appearance.fontSize))
                .foregroundStyle(isUser ? appearance.userForeground : Color.white.opacity(0.94))
                .tint(isUser ? appearance.userForeground : appearance.userFill)
                .lineSpacing(2)
                .textSelection(.enabled)
                .padding(.horizontal, plain ? 2 : 14)
                .padding(.vertical, plain ? 2 : 9)
                .background {
                    if !plain {
                        RoundedRectangle(cornerRadius: appearance.radius, style: .continuous)
                            .fill(isUser ? appearance.userFill : appearance.assistantFill)
                    }
                }
                .opacity(message.status == .sending ? 0.75 : 1)
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = message.content
                    }
                }

            if !isUser { Spacer(minLength: plain ? 0 : 40) }
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .overlay(alignment: .trailing) {
            // Parked just past the right edge; dragging the chat left pulls it into view.
            Text(message.createdAt, format: .dateTime.hour().minute())
                .font(.caption)
                .foregroundStyle(.white.opacity(0.45))
                .fixedSize()
                .frame(width: Self.peekWidth, alignment: .leading)
                .offset(x: Self.peekWidth)
                .accessibilityHidden(true)
        }
        .padding(.top, groupStart ? (plain ? 16 : 12) : 3)
    }

    static let peekWidth: CGFloat = 72

    /// Inline markdown (bold, italics, code, links), keeping line breaks.
    static func render(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

/// User bubbles rise out of the composer; replies fade up from the left.
struct RiseModifier: ViewModifier {
    let progress: Double // 0 = hidden, 1 = settled
    let anchor: UnitPoint

    func body(content: Content) -> some View {
        content
            .scaleEffect(0.6 + 0.4 * progress, anchor: anchor)
            .offset(y: 46 * (1 - progress))
            .opacity(progress)
            .blur(radius: 6 * (1 - progress))
    }
}

extension AnyTransition {
    static func rise(from anchor: UnitPoint) -> AnyTransition {
        .asymmetric(
            insertion: .modifier(
                active: RiseModifier(progress: 0, anchor: anchor),
                identity: RiseModifier(progress: 1, anchor: anchor)
            ),
            removal: .opacity
        )
    }
}
