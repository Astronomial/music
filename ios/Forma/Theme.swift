import SwiftUI
import FormaCore

enum FormaTheme {
    static let background = Color(red: 0.025, green: 0.03, blue: 0.05)
    static var accent: Color { color(UserDefaults.standard.string(forKey: "forma.palette") ?? "iris") }
    static func color(_ palette: String) -> Color {
        switch palette { case "mint": return Color(red: 0.4, green: 0.92, blue: 0.7); case "sunset": return Color(red: 1, green: 0.65, blue: 0.5); case "ice": return Color(red: 0.5, green: 0.8, blue: 1); default: return Color(red: 0.73, green: 0.65, blue: 1) }
    }
    static let colors: [Color] = [.mint, .orange, .purple, .blue, .teal, .indigo]
}
@MainActor
struct GlassPanel<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        content.padding(20).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(.white.opacity(0.08), lineWidth: 1))
    }
}
@MainActor
struct Artwork: View {
    let track: Track?
    var size: CGFloat = 48
    var body: some View {
        ZStack {
            LinearGradient(colors: [FormaTheme.accent.opacity(0.3), .indigo.opacity(0.2)], startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: "music.note").foregroundStyle(FormaTheme.accent)
            if let url = track?.artworkURL {
                AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Color.clear }
            }
        }.frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: size * 0.18))
    }
}
func formatTime(_ value: Double) -> String {
    let time = max(0, Int(value.isFinite ? value : 0)); return "\(time / 60):\(String(format: "%02d", time % 60))"
}
