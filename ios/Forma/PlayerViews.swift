import SwiftUI
import FormaCore

@MainActor
struct MiniPlayer: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var player: PlaybackController
    let expand: () -> Void
    init(model: AppModel, expand: @escaping () -> Void) { self.model = model; self.player = model.player; self.expand = expand }
    var body: some View {
        if let track = player.current {
            HStack(spacing: 4) {
                Button(action: expand) {
                    HStack(spacing: 12) {
                        Artwork(track: track, size: 42)
                        VStack(alignment: .leading, spacing: 3) { Text(track.title).font(.subheadline.bold()).lineLimit(1); Text(track.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Открыть плеер")
                Button { model.toggleLike(track) } label: {
                    Image(systemName: model.isLiked(track) ? "heart.fill" : "heart").foregroundStyle(model.isLiked(track) ? FormaTheme.accent : .secondary).frame(width: 44, height: 44)
                }.buttonStyle(.plain).accessibilityLabel(model.isLiked(track) ? "Убрать из любимого" : "Добавить в любимое").accessibilityIdentifier("mini-player-like")
                Button { player.toggle() } label: {
                    Group { if player.isLoading { ProgressView() } else { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.title3) } }.frame(width: 44, height: 44)
                }.buttonStyle(.plain).accessibilityLabel(player.isPlaying ? "Пауза" : "Воспроизвести")
                Button { player.next() } label: { Image(systemName: "forward.end.fill").frame(width: 44, height: 44) }.buttonStyle(.plain).accessibilityLabel("Следующий трек")
            }.padding(10).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
                .accessibilityIdentifier("mini-player")
                .overlay(alignment: .bottomLeading) {
                    GeometryReader { bounds in Capsule().fill(FormaTheme.accent).frame(width: bounds.size.width * (player.duration > 0 ? min(1, player.position / player.duration) : 0), height: 2) }.frame(height: 2).padding(.horizontal, 20)
                }
        }
    }
}
@MainActor
struct NowPlayingView: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var player: PlaybackController
    @State private var seekValue: Double = 0
    @State private var dragging = false
    init(model: AppModel) { self.model = model; self.player = model.player }
    var body: some View {
        GeometryReader { bounds in
            ScrollView {
                VStack(spacing: 28) {
                    Text("В ТВОЁМ РИТМЕ").font(.caption.weight(.semibold)).tracking(3).foregroundStyle(.secondary)
                    Artwork(track: player.current, size: min(bounds.size.width - 64, 340)).shadow(color: FormaTheme.accent.opacity(0.1), radius: 36)
                    VStack(spacing: 10) { Text(player.current?.title ?? "Музыка ждёт тебя").font(.title2.bold()).multilineTextAlignment(.center); Text(player.current?.artist ?? "YouTube").foregroundStyle(.secondary) }
                    if let error = player.error {
                        GlassPanel { VStack(spacing: 12) { Text(error).font(.subheadline); Button("Повторить") { player.resume() }.buttonStyle(.bordered) } }
                    }
                    VStack(spacing: 8) {
                        Slider(value: Binding(get: { dragging ? seekValue : player.position }, set: { seekValue = $0 }), in: 0...max(1, player.duration), onEditingChanged: { editing in
                            if editing { seekValue = player.position; dragging = true }
                            else { dragging = false; player.seek(to: seekValue) }
                        }).disabled(player.duration <= 0).accessibilityLabel("Позиция воспроизведения")
                        HStack { Text(formatTime(dragging ? seekValue : player.position)); Spacer(); Text(formatTime(player.duration)) }.font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    }
                    HStack(spacing: 42) {
                        Button { player.previous() } label: { Image(systemName: "backward.end.fill").font(.title2) }.accessibilityLabel("В начало трека")
                        Button { player.toggle() } label: {
                            Group { if player.isLoading { ProgressView().tint(.black) } else { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.title) } }
                                .frame(width: 74, height: 74).foregroundStyle(.black).background(FormaTheme.accent, in: Circle())
                        }.accessibilityLabel(player.isPlaying ? "Пауза" : "Воспроизвести")
                        Button { player.next() } label: { Image(systemName: "forward.end.fill").font(.title2) }.accessibilityLabel("Следующий трек")
                    }
                    HStack {
                        Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                        Slider(value: $player.volume, in: 0...1).accessibilityLabel("Громкость")
                        Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
                    }
                    if let track = player.current { Button { model.toggleLike(track) } label: { Label(model.isLiked(track) ? "В любимом" : "Сохранить", systemImage: model.isLiked(track) ? "heart.fill" : "heart") }.buttonStyle(.bordered) }
                }.padding(32)
            }.background(LinearGradient(colors: [FormaTheme.accent.opacity(0.09), FormaTheme.background], startPoint: .topLeading, endPoint: .bottomTrailing)).tint(FormaTheme.accent)
        }
    }
}
