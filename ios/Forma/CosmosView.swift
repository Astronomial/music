import SwiftUI

private struct CosmicVisibilityKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
    var cosmosVisible: Bool {
        get { self[CosmicVisibilityKey.self] }
        set { self[CosmicVisibilityKey.self] = newValue }
    }
}

/// Decorative drawing is isolated from the player and pauses outside the visible scene.
struct CosmicBackground: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.cosmosVisible) private var cosmosVisible
    @AppStorage("forma.starMotion") private var starMotion = true
    @State private var visible = false
    private static let stars: [CGPoint] = (0..<130).map { index in
        CGPoint(x: Double((index * 761 + 137) % 997) / 997,
                y: Double((index * 433 + 89) % 991) / 991)
    }
    private var paused: Bool { !visible || !cosmosVisible || scenePhase != .active || reduceMotion || !starMotion }
    var body: some View {
        ZStack {
            FormaTheme.background
            RadialGradient(colors: [Color(red: 0.19, green: 0.07, blue: 0.31).opacity(0.42), .clear], center: .topTrailing, startRadius: 0, endRadius: 650)
            Canvas { context, size in
                for (index, star) in Self.stars.enumerated() {
                    let radius: CGFloat = index % 7 == 0 ? 1.15 : 0.65
                    let rect = CGRect(x: star.x * size.width, y: star.y * size.height, width: radius * 2, height: radius * 2)
                    context.fill(Path(ellipseIn: rect), with: .color(.white.opacity(index % 3 == 0 ? 0.42 : 0.19)))
                }
            }
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: paused)) { timeline in
                Canvas { context, size in
                    guard !paused else { return }
                    let time = timeline.date.timeIntervalSinceReferenceDate
                    for index in 0..<3 {
                        let phase = (time + Double(index) * 4.1).truncatingRemainder(dividingBy: 14)
                        guard phase < 1.35 else { continue }
                        let progress = phase / 1.35
                        let head = CGPoint(x: size.width * (0.18 + Double(index) * 0.3) + progress * 210,
                                           y: size.height * (0.09 + Double(index) * 0.23) + progress * 145)
                        let tail = CGPoint(x: head.x - 72, y: head.y - 50)
                        var streak = Path(); streak.move(to: tail); streak.addLine(to: head)
                        let opacity = min(1, min(phase * 4, (1.35 - phase) * 4)) * 0.65
                        context.stroke(streak, with: .linearGradient(Gradient(colors: [.clear, Color(red: 0.78, green: 0.68, blue: 1).opacity(opacity)]), startPoint: tail, endPoint: head), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
                    }
                }
            }
        }
        .ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
        .onAppear { visible = true }.onDisappear { visible = false }
    }
}

struct CosmicScreen: ViewModifier {
    func body(content: Content) -> some View {
        content.background { CosmicBackground() }.toolbarBackground(.hidden, for: .navigationBar)
    }
}
extension View {
    func cosmicBackground() -> some View { modifier(CosmicScreen()) }
}

struct PulseGalaxy: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.cosmosVisible) private var cosmosVisible
    @AppStorage("forma.starMotion") private var starMotion = true
    @State private var visible = false
    private var moving: Bool { visible && cosmosVisible && scenePhase == .active && !reduceMotion && starMotion }
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !moving)) { timeline in
            Image("PulseGalaxy").resizable().scaledToFit()
                .rotationEffect(.degrees(moving ? timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 240) * 1.5 : 0))
        }
        .scaleEffect(x: 1.4, y: 0.8).rotationEffect(.degrees(-18))
        .allowsHitTesting(false).accessibilityHidden(true)
        .onAppear { visible = true }.onDisappear { visible = false }
    }
}

@MainActor
struct PulseHero: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var player: PlaybackController
    let settings: () -> Void
    init(model: AppModel, settings: @escaping () -> Void) { self.model = model; player = model.player; self.settings = settings }
    private var active: Bool { model.isPersonalPulse && player.current != nil }
    var body: some View {
        VStack(spacing: 4) {
            PulseGalaxy().frame(maxWidth: 380).frame(height: 240)
            Text("Пульс").font(.system(.largeTitle, design: .rounded, weight: .bold)).accessibilityAddTraits(.isHeader)
            Text("В твоём ритме").font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 16) {
                Button {
                    if active { player.toggle() } else { model.startPulse() }
                } label: {
                    HStack(spacing: 10) {
                        if model.isStartingPulse || (active && player.isLoading) { ProgressView().tint(FormaTheme.background) }
                        else { Image(systemName: active && player.isPlaying ? "pause.fill" : "play.fill") }
                        Text(active && player.isPlaying ? "Пауза" : "Слушать Пульс").fontWeight(.semibold)
                    }.frame(minHeight: 32).padding(.horizontal, 12)
                }.buttonStyle(.borderedProminent).primaryActionForeground().buttonBorderShape(.capsule)
                    .disabled(model.isRestoringLibrary || model.isStartingPulse)
                    .accessibilityIdentifier("personal-pulse-play")
                Button(action: settings) { Image(systemName: "slider.horizontal.3").frame(width: 48, height: 48) }
                    .buttonStyle(ResponsiveButtonStyle()).background { CosmicPanelBackground(radius: 24) }
                    .accessibilityLabel("Настроить Пульс")
            }.padding(.top, 18)
        }.frame(maxWidth: .infinity).padding(.bottom, 22)
    }
}
