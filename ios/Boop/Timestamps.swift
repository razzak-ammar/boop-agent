import SwiftUI

/// iMessage-style time labels.
enum Stamp {
    /// A gap this long between messages earns a centered time header.
    static let gap: TimeInterval = 60 * 60

    /// "Today 2:57 PM", "Yesterday 9:14 AM", "Monday 3:02 PM", "Wed, Nov 12 at 3:02 PM".
    static func header(_ date: Date, now: Date = .now) -> Text {
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        let day: String
        if calendar.isDateInToday(date) {
            day = "Today"
        } else if calendar.isDateInYesterday(date) {
            day = "Yesterday"
        } else if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date),
                                                     to: calendar.startOfDay(for: now)).day, days < 7 {
            day = date.formatted(.dateTime.weekday(.wide))
        } else if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return Text("\(Text(date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())).fontWeight(.semibold)) at \(time)")
        } else {
            return Text("\(Text(date.formatted(.dateTime.month(.abbreviated).day().year())).fontWeight(.semibold)) at \(time)")
        }
        return Text("\(Text(day).fontWeight(.semibold)) \(time)")
    }
}

/// Centered time between messages that are far apart.
struct StampHeader: View {
    let date: Date

    var body: some View {
        Stamp.header(date)
            .font(.caption)
            .foregroundStyle(.white.opacity(0.45))
            .frame(maxWidth: .infinity)
            .padding(.top, 18)
            .padding(.bottom, 2)
    }
}

/// Under your last message: delivered, then read once the agent starts on it.
enum Receipt: Equatable {
    case delivered
    case read(Date)
}

struct ReceiptLabel: View {
    let receipt: Receipt

    var body: some View {
        Group {
            switch receipt {
            case .delivered:
                Text("Delivered")
            case .read(let date):
                Text("\(Text("Read").fontWeight(.semibold)) \(date.formatted(date: .omitted, time: .shortened))")
            }
        }
        .font(.caption2)
        .foregroundStyle(.white.opacity(0.45))
        .id(receipt == .delivered)
        .transition(.blurReplace)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.trailing, 20)
        .padding(.top, 4)
    }
}
