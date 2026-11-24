import SwiftUI

enum BubbleColor: String, CaseIterable, Identifiable {
    case amber, coral, blue, violet, mint, graphite
    var id: String { rawValue }

    var fill: Color {
        switch self {
        case .amber: Color(red: 0.98, green: 0.82, blue: 0.33)
        case .coral: Color(red: 0.85, green: 0.47, blue: 0.34)
        case .blue: Color(red: 0.04, green: 0.52, blue: 1.0)
        case .violet: Color(red: 0.55, green: 0.42, blue: 0.98)
        case .mint: Color(red: 0.39, green: 0.85, blue: 0.68)
        case .graphite: Color(white: 0.32)
        }
    }

    var foreground: Color {
        switch self {
        case .amber, .mint: Color.black.opacity(0.88)
        default: .white
        }
    }
}

enum BackgroundStyle: String, CaseIterable, Identifiable {
    case graphite, black
    var id: String { rawValue }

    var title: String { rawValue.capitalized }

    var color: Color {
        switch self {
        case .graphite: Color(white: 0.071)
        case .black: .black
        }
    }

    var assistantFill: Color {
        switch self {
        case .graphite: Color(white: 0.155)
        case .black: Color(white: 0.115)
        }
    }
}

enum AssistantStyle: String, CaseIterable, Identifiable {
    case bubble, plain
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

enum TextSize: String, CaseIterable, Identifiable {
    case small, medium, large
    var id: String { rawValue }

    var title: String {
        switch self {
        case .small: "S"
        case .medium: "M"
        case .large: "L"
        }
    }

    var points: CGFloat {
        switch self {
        case .small: 15
        case .medium: 17
        case .large: 19
        }
    }
}

enum TypingSpeed: String, CaseIterable, Identifiable {
    case natural, fast, instant
    var id: String { rawValue }
    var title: String { rawValue.capitalized }

    /// Characters revealed per frame when there is little backlog.
    var baseRate: Int {
        switch self {
        case .natural: 1
        case .fast: 3
        case .instant: .max
        }
    }
}

/// Everything a bubble needs to draw itself, so bubbles stay cheap to diff.
struct BubbleAppearance: Equatable {
    var userFill: Color
    var userForeground: Color
    var assistantFill: Color
    var assistantStyle: AssistantStyle
    var radius: CGFloat
    var fontSize: CGFloat
}
