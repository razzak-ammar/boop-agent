import SwiftUI

/// The page to the right of the chat. Same background, same atom overhead;
/// for now it's an empty atom waiting for its electrons.
struct TasksPage: View {
    let color: Color

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            EmptyOrbit(color: color)
                .frame(width: 84, height: 84)
            Text("No tasks yet")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.white.opacity(0.55))
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The atom's orbits with nothing in them, turning slowly.
private struct EmptyOrbit: View {
    let color: Color

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            Canvas { canvas, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let a = size.width * 0.48, b = size.width * 0.18
                for i in 0..<3 {
                    let tilt = Double(i) * .pi / 3 + t * 0.12
                    let transform = CGAffineTransform(rotationAngle: tilt)
                        .concatenating(CGAffineTransform(translationX: center.x, y: center.y))
                    let orbit = Path(ellipseIn: CGRect(x: -a, y: -b, width: a * 2, height: b * 2)).applying(transform)
                    canvas.stroke(orbit, with: .color(.white.opacity(0.14)), lineWidth: 1.5)
                }
                let r = size.width * 0.09
                canvas.stroke(
                    Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)),
                    with: .color(color.opacity(0.6)),
                    lineWidth: 2
                )
            }
        }
    }
}
