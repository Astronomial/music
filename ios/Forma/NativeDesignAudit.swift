#if DEBUG && targetEnvironment(simulator)
import SwiftUI
import UIKit
import FormaCore

/// Captures the actual native screens, not a web approximation of the iPhone UI.
@MainActor
enum NativeDesignAudit {
    static var selectTab: ((Int) -> Void)?
    static var present: ((String?) -> Void)?
    static var largeText: ((Bool) -> Void)?
    static var playerTextSize: DynamicTypeSize?
    static func run(model: AppModel) async throws -> [String: Any] {
        guard let selectTab, let present, let largeText,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow) else {
            throw SyncError.rejected("Native design navigation was not attached")
        }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("design-audit")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let defaults = UserDefaults.standard
        let savedCompact = defaults.object(forKey: "forma.compactNavigation")
        let savedMotion = defaults.object(forKey: "forma.starMotion")
        let wasPlaying = model.player.isPlaying
        model.player.pause()
        defer {
            present(nil); selectTab(0); largeText(false)
            if let savedCompact { defaults.set(savedCompact, forKey: "forma.compactNavigation") } else { defaults.removeObject(forKey: "forma.compactNavigation") }
            if let savedMotion { defaults.set(savedMotion, forKey: "forma.starMotion") } else { defaults.removeObject(forKey: "forma.starMotion") }
            if wasPlaying { model.player.resume() }
        }
        func settle() async throws { try await Task.sleep(nanoseconds: 750_000_000) }
        func tabBar(_ view: UIView) -> UITabBar? {
            if let bar = view as? UITabBar { return bar }
            return view.subviews.lazy.compactMap { tabBar($0) }.first
        }
        func verifyTabs(_ selected: Int, compact: Bool) throws {
            guard let bar = tabBar(window), let items = bar.items, items.count == 4,
                  bar.selectedItem === items[selected] else { throw SyncError.rejected("Native tab selection did not follow navigation") }
            let names = ["Главная", "Поиск", "Библиотека", "Настройки"]
            for (index, item) in items.enumerated() {
                guard item.accessibilityLabel == names[index], compact ? (item.title ?? "").isEmpty : item.title == names[index] else {
                    throw SyncError.rejected("Tab caption or VoiceOver name lost in compact navigation")
                }
            }
            let frame = bar.convert(bar.bounds, to: nil)
            guard NativeSmoke.miniFrame.maxY <= frame.minY + 1,
                  NativeSmoke.miniFrame.minX >= -1, NativeSmoke.miniFrame.maxX <= window.bounds.width + 1 else {
                throw SyncError.rejected("Mini-player overlaps tabs or extends beyond the screen")
            }
        }
        var captures = 0
        func snapshot(_ name: String) throws {
            window.layoutIfNeeded()
            let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
            let image = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            guard let data = image.pngData() else { throw SyncError.rejected("Native screen capture failed") }
            try data.write(to: directory.appendingPathComponent(name + ".png")); captures += 1
        }
        guard let image = UIImage(named: "PulseGalaxy"), image.size.width >= 1024 else { throw SyncError.rejected("Galaxy texture missing or undersized") }
        defaults.set(false, forKey: "forma.compactNavigation")
        defaults.set(false, forKey: "forma.starMotion")
        for tab in 0..<4 {
            selectTab(tab); try await settle(); try snapshot("\(tab)-standard"); try verifyTabs(tab, compact: false)
        }
        defaults.set(true, forKey: "forma.compactNavigation")
        for tab in 0..<4 {
            selectTab(tab); try await settle(); try snapshot("\(tab)-compact"); try verifyTabs(tab, compact: true)
        }
        selectTab(0); largeText(true); try await settle(); try verifyTabs(0, compact: true); try snapshot("home-large-text")
        selectTab(3); try await settle(); try snapshot("settings-large-text"); try verifyTabs(3, compact: true)
        selectTab(0); largeText(false); try await settle()
        present("player"); try await settle(); try snapshot("player")
        largeText(true); try await settle(); try snapshot("player-large-text")
        guard playerTextSize == .accessibility3 else { throw SyncError.rejected("Large-text audit did not reach the presented player") }
        largeText(false)
        present(nil); try await settle()
        present("pulse"); try await settle(); try snapshot("pulse-settings")
        present(nil); try await settle()
        return ["nativeDesignScreens": captures, "compactTabsKeepVoiceOverNames": true, "nativeTabSelectionVerified": true,
                "largeTextMiniPlayerAboveTabs": true, "largeTextPlayerVerified": true, "galaxyTexture1024": true]
    }
}
#endif
