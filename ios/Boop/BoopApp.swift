import SwiftUI

@main
struct BoopApp: App {
    @State private var settings: AppSettings
    @State private var store: ChatStore
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let settings = AppSettings()
        _settings = State(initialValue: settings)
        _store = State(initialValue: ChatStore(settings: settings))
    }

    var body: some Scene {
        WindowGroup {
            ChatView()
                .environment(settings)
                .environment(store)
                .preferredColorScheme(.dark)
                .tint(settings.bubbleColor.fill)
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .active: store.becameActive()
            case .background: store.resignedActive()
            default: break
            }
        }
    }
}
