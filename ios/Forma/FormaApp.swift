import SwiftUI

@main
@MainActor
struct FormaApp: App {
    @StateObject private var model = AppModel()
    init() {
#if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--forma-smoke") { _model = StateObject(wrappedValue: NativeSmoke.makeModel()) }
#endif
    }
    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .preferredColorScheme(.dark)
#if DEBUG && targetEnvironment(simulator)
                .onAppear { if ProcessInfo.processInfo.arguments.contains("--forma-smoke") { NativeSmoke.startOnce(model: model) } }
#endif
        }
    }
}
