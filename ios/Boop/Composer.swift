import SwiftUI

struct Composer: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let accent: BubbleColor
    let sendCount: Int
    let onSend: () -> Void

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField("Message", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .font(.system(size: 17))
                .focused(focused)
                .padding(.leading, 18)
                .padding(.vertical, 12)
                .tint(accent.fill)

            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(canSend ? accent.foreground : .white.opacity(0.35))
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(canSend ? accent.fill : .white.opacity(0.08)))
                    .scaleEffect(canSend ? 1 : 0.88)
                    .symbolEffect(.bounce.up, value: sendCount)
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .padding(.trailing, 6)
            .padding(.bottom, 6)
            .animation(.spring(duration: 0.3, bounce: 0.4), value: canSend)
            .accessibilityLabel("Send")
        }
        .glassEffect(.regular, in: .rect(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }
}
