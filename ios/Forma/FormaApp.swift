import SwiftUI

@main
@MainActor
struct FormaApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .preferredColorScheme(.dark)
#if DEBUG && targetEnvironment(simulator)
                .onAppear { if ProcessInfo.processInfo.arguments.contains("--forma-smoke") { NativeSmoke.startOnce() } }
#endif
        }
    }
}
