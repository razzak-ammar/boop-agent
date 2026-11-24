import SwiftUI

/// The atom, which on tap fires two buttons out sideways like electrons
/// leaving their orbits: settings on the left, and on the right whichever
/// page you're not on (tasks from the chat, chat from tasks).
struct AtomMenu: View {
    let size: CGFloat
    let color: Color
    let phase: ChatPhase
    @Binding var isOpen: Bool
    var showsError = false
    let onSettings: () -> Void
    let secondarySymbol: String
    let secondaryLabel: String
    let onSecondary: () -> Void

    private var spread: CGFloat { size * 0.75 + 40 }

    var body: some View {
        ZStack {
            satellite("gearshape", label: "Settings", side: -1, delay: 0, action: onSettings)
            satellite(secondarySymbol, label: secondaryLabel, side: 1, delay: 0.04, action: onSecondary)

            Button {
                withAnimation(.spring(duration: 0.42, bounce: 0.38)) { isOpen.toggle() }
            } label: {
                Atom(size: size, color: color, phase: phase)
                    .overlay(alignment: .bottom) {
                        if showsError {
                            Circle().fill(.red).frame(width: 6, height: 6).offset(y: 4)
                        }
                    }
                    .scaleEffect(isOpen ? 1.12 : 1)
                    .contentShape(.circle)
            }
            .buttonStyle(AtomPress())
            .accessibilityLabel(isOpen ? "Close menu" : "Menu")
        }
        .sensoryFeedback(.impact(weight: .light), trigger: isOpen)
    }

    private func satellite(_ symbol: String, label: String, side: CGFloat, delay: Double,
                           action: @escaping () -> Void) -> some View {
        Button {
            withAnimation(.spring(duration: 0.3)) { isOpen = false }
            action()
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .medium))
                .contentTransition(.symbolEffect(.replace))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: 44, height: 44)
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        // Shoot out from behind the nucleus, along a slight arc.
        .scaleEffect(isOpen ? 1 : 0.2)
        .opacity(isOpen ? 1 : 0)
        .blur(radius: isOpen ? 0 : 6)
        .rotationEffect(.degrees(isOpen ? 0 : Double(-side) * 90))
        .offset(x: isOpen ? side * spread : 0, y: isOpen ? 0 : -6)
        .animation(.spring(duration: 0.45, bounce: 0.35).delay(isOpen ? delay : 0), value: isOpen)
        .allowsHitTesting(isOpen)
    }
}

/// A soft squeeze when the atom is pressed.
struct AtomPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.86 : 1)
            .animation(.spring(duration: 0.25, bounce: 0.5), value: configuration.isPressed)
    }
}
