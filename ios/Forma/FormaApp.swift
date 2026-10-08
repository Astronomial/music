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
                .task { if ProcessInfo.processInfo.arguments.contains("--forma-smoke") { await NativeSmoke.run() } }
#endif
        }
    }
}
