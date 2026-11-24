import SwiftUI

/// The agent's mark: a nucleus with three tilted orbits.
///
/// Every few seconds one electron makes a quantum jump: it blinks out and
/// reappears on the far side of its orbit with a small ripple. The motion
/// tracks what the agent is doing:
/// - idle: slow orbits, the nucleus breathes
/// - thinking: the orbits start to precess
/// - working: everything spins up
/// - responding: the nucleus pulses as the text arrives
struct Atom: View {
    let size: CGFloat
    let color: Color
    let phase: ChatPhase

    var body: some View {
        TimelineView(.animation(minimumInterval: phase.isBusy ? nil : 1 / 30)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            Canvas { canvas, area in
                draw(in: &canvas, area: area, t: t)
            }
        }
        .frame(width: size * 1.5, height: size * 1.5)
        .accessibilityElement()
        .accessibilityLabel(phase.isBusy ? phase.label : "Boop")
    }

    private struct Motion {
        var precession: Double   // orbit rotation, rad/s
        var orbit: Double        // electron speed, rad/s
        var pulse: (Double) -> Double
    }

    private var motion: Motion {
        switch phase {
        case .idle:
            Motion(precession: 0.06, orbit: 0.9) { t in 1 + 0.035 * sin(t * 1.5) }
        case .thinking:
            Motion(precession: 0.55, orbit: 1.7) { t in 1 + 0.06 * sin(t * 3.8) }
        case .working:
            Motion(precession: 1.1, orbit: 3.4) { t in 1 + 0.05 * sin(t * 6) }
        case .responding:
            Motion(precession: 0.2, orbit: 1.3) { t in 1 + 0.13 * abs(sin(t * 5.5)) }
        }
    }

    private static let jumpEvery = 4.6     // seconds between quantum jumps
    private static let jumpLength = 0.22   // how long the electron is gone

    private func draw(in canvas: inout GraphicsContext, area: CGSize, t: Double) {
        let center = CGPoint(x: area.width / 2, y: area.height / 2)
        let a = size * 0.5            // orbit semi-major axis
        let b = size * 0.19           // orbit semi-minor axis
        let m = motion
        let electronColor = color.mix(with: .white, by: 0.55)
        let busy = phase.isBusy

        // Glow
        let glowRadius = size * (busy ? 0.62 : 0.5)
        canvas.fill(
            Path(ellipseIn: CGRect(x: center.x - glowRadius, y: center.y - glowRadius,
                                   width: glowRadius * 2, height: glowRadius * 2)),
            with: .radialGradient(
                Gradient(colors: [color.opacity(busy ? 0.42 : 0.28), color.opacity(0)]),
                center: center, startRadius: 0, endRadius: glowRadius
            )
        )

        // Quantum jumps: which electron is mid-jump, and how many jumps each has made.
        let cycle = t / Self.jumpEvery
        let jumpIndex = Int(cycle.rounded(.down))
        let jumper = ((jumpIndex % 3) + 3) % 3
        let sinceJump = (cycle - Double(jumpIndex)) * Self.jumpEvery

        struct Electron { var point: CGPoint; var depth: Double; var opacity: Double; var ripple: Double? }
        var electrons: [Electron] = []

        for i in 0..<3 {
            let tilt = Double(i) * .pi / 3 + t * m.precession
            let transform = CGAffineTransform(rotationAngle: tilt)
                .concatenating(CGAffineTransform(translationX: center.x, y: center.y))

            // Orbit
            let orbit = Path(ellipseIn: CGRect(x: -a, y: -b, width: a * 2, height: b * 2)).applying(transform)
            canvas.stroke(orbit, with: .color(.white.opacity(0.28)), lineWidth: max(1, size * 0.03))

            // Electron: each completed jump moves it half an orbit.
            let jumps = (jumpIndex - i) >= 0 ? (jumpIndex - i) / 3 + 1 : 0
            var theta = t * m.orbit + Double(i) * 2.1 + Double(jumps) * .pi
            var opacity = 1.0
            var ripple: Double?
            if i == jumper {
                if sinceJump < Self.jumpLength {
                    // Gone: fade out on the old side, then in on the new side.
                    let half = Self.jumpLength / 2
                    if sinceJump < half {
                        theta -= .pi
                        opacity = 1 - sinceJump / half
                    } else {
                        opacity = (sinceJump - half) / half
                    }
                }
                if sinceJump > Self.jumpLength / 2, sinceJump < Self.jumpLength / 2 + 0.45 {
                    ripple = (sinceJump - Self.jumpLength / 2) / 0.45
                }
            }
            let local = CGPoint(x: a * cos(theta), y: b * sin(theta))
            electrons.append(Electron(point: local.applying(transform), depth: sin(theta),
                                      opacity: opacity, ripple: ripple))
        }

        func drawElectron(_ e: Electron) {
            let behind = e.depth < 0
            let r = size * (behind ? 0.06 : 0.075)
            canvas.fill(
                Path(ellipseIn: CGRect(x: e.point.x - r, y: e.point.y - r, width: r * 2, height: r * 2)),
                with: .color(electronColor.opacity(e.opacity * (behind ? 0.45 : 1)))
            )
            if let p = e.ripple {
                let rr = r * (1 + 2.6 * p)
                canvas.stroke(
                    Path(ellipseIn: CGRect(x: e.point.x - rr, y: e.point.y - rr, width: rr * 2, height: rr * 2)),
                    with: .color(electronColor.opacity(0.7 * (1 - p))),
                    lineWidth: max(0.6, size * 0.02)
                )
            }
        }

        // Electrons behind the nucleus, then the nucleus, then the ones in front.
        electrons.filter { $0.depth < 0 }.forEach(drawElectron)

        let nr = size * 0.15 * m.pulse(t)
        let nucleus = CGRect(x: center.x - nr, y: center.y - nr, width: nr * 2, height: nr * 2)
        canvas.fill(
            Path(ellipseIn: nucleus),
            with: .radialGradient(
                Gradient(colors: [color.mix(with: .white, by: 0.45), color, color.mix(with: .black, by: 0.15)]),
                center: CGPoint(x: center.x - nr * 0.35, y: center.y - nr * 0.4),
                startRadius: 0, endRadius: nr * 1.5
            )
        )

        electrons.filter { $0.depth >= 0 }.forEach(drawElectron)
    }
}

#Preview {
    VStack(spacing: 40) {
        Atom(size: 64, color: BubbleColor.amber.fill, phase: .idle)
        Atom(size: 64, color: BubbleColor.coral.fill, phase: .thinking)
        Atom(size: 64, color: BubbleColor.violet.fill, phase: .working("Checking calendar"))
        Atom(size: 64, color: BubbleColor.mint.fill, phase: .responding)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.black)
}
