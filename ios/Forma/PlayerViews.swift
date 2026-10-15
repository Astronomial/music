import SwiftUI
import FormaCore

@MainActor
struct MiniPlayer: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var player: PlaybackController
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let expand: () -> Void
    init(model: AppModel, expand: @escaping () -> Void) { self.model = model; self.player = model.player; self.expand = expand }
    var body: some View {
        if let track = player.current {
            Group {
                if typeSize.isAccessibilitySize {
                    VStack(spacing: 8) { details(track); controls(track).frame(maxWidth: .infinity) }
                } else { HStack(spacing: 4) { details(track); controls(track) } }
            }.padding(10).background {
                if reduceTransparency { RoundedRectangle(cornerRadius: 20).fill(FormaTheme.background) }
                else {
                    RoundedRectangle(cornerRadius: 20).fill(.regularMaterial)
                        .overlay(RoundedRectangle(cornerRadius: 20).fill(FormaTheme.panel.opacity(0.55)))
                }
            }
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(.white.opacity(0.1), lineWidth: 1))
                .accessibilityIdentifier("mini-player")
#if DEBUG && targetEnvironment(simulator)
                .background(GeometryReader { bounds in
                    Color.clear.onAppear { NativeSmoke.miniFrame = bounds.frame(in: .global) }
                        .onChange(of: bounds.frame(in: .global)) { _, rect in NativeSmoke.miniFrame = rect }
                })
#endif
                .overlay(alignment: .bottomLeading) {
                    GeometryReader { bounds in Capsule().fill(FormaTheme.accent).frame(width: bounds.size.width * (player.duration > 0 ? max(0, min(1, player.position / player.duration)) : 0), height: 2) }.frame(height: 2).padding(.horizontal, 20).accessibilityHidden(true)
                }
        }
    }
    private func details(_ track: Track) -> some View {
        Button(action: expand) {
            HStack(spacing: 10) {
                Artwork(track: track, size: 44).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) { Text(track.title).font(.subheadline.bold()).lineLimit(1); Text(track.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.foregroundStyle(.primary).buttonStyle(ResponsiveButtonStyle()).accessibilityLabel("\(track.title), \(track.artist)").accessibilityHint("Открыть плеер")
    }
    private func controls(_ track: Track) -> some View {
        let size: CGFloat = typeSize.isAccessibilitySize ? 56 : 44
        return HStack(spacing: 0) {
            Button { model.toggleLike(track) } label: {
                Image(systemName: model.isLiked(track) ? "heart.fill" : "heart").foregroundStyle(model.isLiked(track) ? FormaTheme.accent : .secondary).frame(width: size, height: size).contentShape(Rectangle())
            }.accessibilityLabel(model.isLiked(track) ? "Убрать из любимого" : "Добавить в любимое").accessibilityIdentifier("mini-player-like")
            Button { model.toggleDislike(track) } label: { Image(systemName: model.isDisliked(track) ? "hand.thumbsdown.fill" : "hand.thumbsdown").foregroundStyle(model.isDisliked(track) ? FormaTheme.accent : .secondary).frame(width: size, height: size).contentShape(Rectangle()) }
                .accessibilityLabel(model.isDisliked(track) ? "Снять дизлайк" : "Не нравится").accessibilityHint("Переключает текущий трек").accessibilityIdentifier("mini-player-dislike")
            Button { player.toggle() } label: {
                Group { if player.isLoading { ProgressView() } else { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.title3) } }.frame(width: size, height: size).contentShape(Rectangle())
            }.accessibilityLabel(player.isPlaying || player.isLoading ? "Пауза" : "Воспроизвести").accessibilityIdentifier("mini-player-play")
            Button { player.next() } label: { Image(systemName: "forward.end.fill").frame(width: size, height: size).contentShape(Rectangle()) }.accessibilityLabel("Следующий трек").accessibilityIdentifier("mini-player-next")
        }.buttonStyle(ResponsiveButtonStyle()).fixedSize(horizontal: true, vertical: false)
    }
}
@MainActor
struct NowPlayingView: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var player: PlaybackController
    @State private var seekValue: Double = 0
    @State private var dragging = false
    @State private var seekTrackID: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    private var contextTitle: String {
        if let mood = player.selectionMood { return MoodMix.all.first { $0.id == mood }?.title ?? "Подборка" }
        if let playlistID = model.pulsePlaylistID { return model.library.playlists.first { $0.id == playlistID }?.name ?? "Пульс" }
        return player.selectionSurface == "pulse" ? "Пульс" : "Сейчас играет"
    }
    init(model: AppModel) { self.model = model; self.player = model.player }
    var body: some View {
        GeometryReader { bounds in
            ScrollView {
                VStack(spacing: 20) {
                    Artwork(track: player.current, size: max(100, min(bounds.size.width - 48, min(bounds.size.height * 0.36, 300)))).accessibilityHidden(true)
                    VStack(spacing: 10) { Text(player.current?.title ?? "Музыка ждёт тебя").font(.title2.bold()).multilineTextAlignment(.center); Text(player.current?.artist ?? "YouTube").foregroundStyle(.secondary) }
                    if let error = player.error {
                        GlassPanel { VStack(spacing: 12) { Text(error).font(.subheadline); Button("Повторить") { player.resume() }.buttonStyle(.bordered) } }
                    }
                    VStack(spacing: 8) {
                        Slider(value: Binding(get: { min(max(1, player.duration), max(0, dragging ? seekValue : player.position)) }, set: { seekValue = $0 }), in: 0...max(1, player.duration), onEditingChanged: { editing in
                            if editing { seekValue = player.position; seekTrackID = player.current?.id; dragging = true }
                            else {
                                dragging = false
                                if seekTrackID == player.current?.id { player.seek(to: seekValue) }
                                seekTrackID = nil
                            }
                        }).disabled(player.duration <= 0).accessibilityLabel("Позиция воспроизведения")
                        HStack { Text(formatTime(dragging ? seekValue : player.position)); Spacer(); Text(formatTime(player.duration)) }.font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    }
                    HStack(spacing: 42) {
                        Button { player.previous() } label: { Image(systemName: "backward.end.fill").font(.title2).frame(width: 44, height: 44) }.accessibilityLabel("В начало трека")
                        Button { player.toggle() } label: {
                            Group { if player.isLoading { ProgressView().tint(.black) } else { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.title) } }
                                .frame(width: 74, height: 74).foregroundStyle(.black).background(FormaTheme.accent, in: Circle())
                        }.accessibilityLabel(player.isPlaying || player.isLoading ? "Пауза" : "Воспроизвести")
                        Button { player.next() } label: { Image(systemName: "forward.end.fill").font(.title2).frame(width: 44, height: 44) }.accessibilityLabel("Следующий трек")
                    }.buttonStyle(ResponsiveButtonStyle())
                    HStack {
                        Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                        Slider(value: $player.volume, in: 0...1).accessibilityLabel("Громкость")
                        Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
                    }
                    if let track = player.current {
                        if typeSize.isAccessibilitySize { VStack(spacing: 12) { ratings(track) } }
                        else { HStack(spacing: 12) { ratings(track) } }
                    }
                }.padding(24)
            }.cosmicBackground().tint(FormaTheme.accent)
                .onChange(of: player.current?.id) { _, _ in dragging = false; seekTrackID = nil; seekValue = player.position }
        }.navigationTitle(contextTitle).navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Готово") { dismiss() }.accessibilityLabel("Закрыть плеер") }
#if DEBUG && targetEnvironment(simulator)
            .onAppear { NativeDesignAudit.playerTextSize = typeSize }
            .onChange(of: typeSize) { _, size in NativeDesignAudit.playerTextSize = size }
#endif
    }
    @ViewBuilder private func ratings(_ track: Track) -> some View {
        Button { model.toggleDislike(track) } label: {
            Label(model.isDisliked(track) ? "Снять дизлайк" : "Не нравится", systemImage: model.isDisliked(track) ? "hand.thumbsdown.fill" : "hand.thumbsdown").frame(minHeight: 32)
        }.buttonStyle(.bordered).accessibilityHint("Переключает текущий трек")
        Button { model.toggleLike(track) } label: {
            Label(model.isLiked(track) ? "В любимом" : "Сохранить", systemImage: model.isLiked(track) ? "heart.fill" : "heart").frame(minHeight: 32)
        }.buttonStyle(.bordered).accessibilityLabel(model.isLiked(track) ? "Убрать из любимого" : "Добавить в любимое")
    }
}
