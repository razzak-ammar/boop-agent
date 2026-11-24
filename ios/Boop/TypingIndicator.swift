import SwiftUI

/// Three bouncing dots, plus an optional shimmering label ("Thinking", "Checking calendar").
struct TypingIndicator: View {
    let appearance: BubbleAppearance
    let label: String?

    var body: some View {
        HStack(spacing: 10) {
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { i in
                        let wave = max(0, sin(t * 2 * .pi / 1.15 - Double(i) * 0.6))
                        Circle()
                            .fill(Color.white)
                            .frame(width: 7, height: 7)
                            .opacity(0.3 + 0.6 * wave)
                            .offset(y: -3 * wave)
                    }
                }
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 14)
            .background {
                RoundedRectangle(cornerRadius: appearance.radius, style: .continuous)
                    .fill(appearance.assistantFill)
            }

            ZStack(alignment: .leading) {
                if let label, !label.isEmpty {
                    ShimmerText(text: label)
                        .id(label)
                        .transition(.blurReplace)
                }
            }
        }
        .padding(.top, 12)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.smooth(duration: 0.3), value: label)
    }
}

struct ShimmerText: View {
    let text: String

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let x = (t.truncatingRemainder(dividingBy: 1.8) / 1.8) * 1.6 - 0.3
            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(
                    LinearGradient(
                        stops: [
                            .init(color: .white.opacity(0.35), location: x - 0.25),
                            .init(color: .white.opacity(0.85), location: x),
                            .init(color: .white.opacity(0.35), location: x + 0.25),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
        }
    }
}
