import SwiftUI
import FormaCore

@MainActor
struct ContentView: View {
    @ObservedObject var model: AppModel
    @AppStorage("forma.palette") private var palette = "iris"
    @Environment(\.scenePhase) private var scenePhase
    @State private var showPlayer = false
    @State private var showSettings = false
    var body: some View {
        TabView {
            NavigationStack { HomeView(model: model, showSettings: $showSettings) }.modifier(PlayerInset(model: model, expand: { showPlayer = true })).tabItem { Label("Главная", systemImage: "house") }
            NavigationStack { SearchView(model: model) }.modifier(PlayerInset(model: model, expand: { showPlayer = true })).tabItem { Label("Поиск", systemImage: "magnifyingglass") }
            NavigationStack { PlaylistsView(model: model) }.modifier(PlayerInset(model: model, expand: { showPlayer = true })).tabItem { Label("Библиотека", systemImage: "square.stack") }
            NavigationStack { SettingsView(model: model) }.modifier(PlayerInset(model: model, expand: { showPlayer = true })).tabItem { Label("Настройки", systemImage: "gearshape") }
        }
        .tint(FormaTheme.color(palette))
        .sheet(isPresented: $showPlayer) { NowPlayingView(model: model).presentationDetents([.large]).presentationDragIndicator(.visible) }
        .sheet(isPresented: $showSettings) { NavigationStack { PulseSettingsView(model: model) }.presentationDetents([.large]).presentationDragIndicator(.visible) }
        .alert("Forma", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
            Button("Понятно", role: .cancel) { model.message = nil }
        } message: { Text(model.message ?? "") }
        .task {
            guard !ProcessInfo.processInfo.arguments.contains("--forma-smoke") else { return }
            while !model.player.networkPolicy.known, !Task.isCancelled { try? await Task.sleep(nanoseconds: 50_000_000) }
            if model.library.tracks.isEmpty || UserDefaults.standard.integer(forKey: "forma.discoveryRevision") < 4 { await model.refresh(automatic: true) }
            while !Task.isCancelled {
                if scenePhase == .active { await model.synchronize() }
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.synchronize() } }
            else { model.persist(immediately: true) }
        }
    }
}
/// Reserve content space inside each tab, leaving the system tab bar untouched.
@MainActor
private struct PlayerInset: ViewModifier {
    @ObservedObject var model: AppModel
    @ObservedObject private var player: PlaybackController
    let expand: () -> Void
    init(model: AppModel, expand: @escaping () -> Void) { self.model = model; player = model.player; self.expand = expand }
    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            if player.current != nil {
                MiniPlayer(model: model, expand: expand).padding(.horizontal, 12).padding(.vertical, 8)
            }
        }
    }
}
@MainActor
struct HomeView: View {
    @ObservedObject var model: AppModel
    @Binding var showSettings: Bool
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Музыка ближе к тебе.").font(.largeTitle.bold()).padding(.top, 8)
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Label("Твой Пульс", systemImage: "waveform").font(.title.bold())
                        Text("Твой вкус задаёт направление. Оставим место открытиям.").foregroundStyle(.secondary)
                        HStack {
                            Button { model.startPulse() } label: { Label("Слушать", systemImage: "play.fill").fontWeight(.semibold) }.buttonStyle(.borderedProminent)
                            Spacer()
                            Button { showSettings = true } label: { Image(systemName: "slider.horizontal.3") }.accessibilityLabel("Настроить Пульс")
                        }
                    }
                }
                .background(LinearGradient(colors: [FormaTheme.accent.opacity(0.15), .blue.opacity(0.08)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 24))
                HStack { Text("Как ты себя чувствуешь?").font(.title2.bold()); Spacer(); if model.isRefreshing { ProgressView() } }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                    ForEach(Array(MoodMix.all.enumerated()), id: \.element.id) { index, mix in
                        NavigationLink { MoodView(model: model, mix: mix) } label: {
                            VStack(alignment: .leading, spacing: 12) {
                                Image(systemName: ["leaf", "sun.max", "moon", "bolt", "sparkles", "moon.stars"][index]).font(.title)
                                Spacer(minLength: 12)
                                Text(mix.title).font(.headline).multilineTextAlignment(.leading)
                                Text("\(model.moodTracks(mix).count) треков").font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, minHeight: 122, alignment: .leading).padding(16)
                                .background(LinearGradient(colors: [FormaTheme.colors[index].opacity(0.2), .white.opacity(0.03)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 20))
                        }.buttonStyle(ResponsiveButtonStyle())
                    }
                }
                Text("Следующее любимое").font(.title2.bold())
                if model.recommendations.isEmpty { EmptyState(title: "Начни со своей музыки", text: "Найди любимые треки в поиске. Пульс будет учиться на сохранениях и прослушиваниях.") }
                ForEach(model.recommendations.prefix(12)) { item in TrackRow(model: model, track: item.track, reason: item.reason) { model.player.play(item.track, list: model.recommendations.map(\.track)) } }
            }.padding(20)
        }.background(FormaTheme.background).navigationTitle("forma.").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.isRefreshing).accessibilityLabel("Обновить подборки") }
            .refreshable { await model.refresh() }
    }
}
@MainActor
struct TrackRow: View {
    @ObservedObject var model: AppModel
    let track: Track
    var reason: String? = nil
    let play: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            Button(action: play) {
                HStack(spacing: 12) {
                    Artwork(track: track)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(track.title).font(.body.weight(.medium)).lineLimit(2)
                        Text(track.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        if let reason { Text(reason).font(.caption).foregroundStyle(FormaTheme.accent).lineLimit(1) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.contentShape(Rectangle())
            }.buttonStyle(ResponsiveButtonStyle()).accessibilityLabel("Слушать \(track.artist) — \(track.title)")
            Button { model.toggleLike(track) } label: { Image(systemName: model.isLiked(track) ? "heart.fill" : "heart").foregroundStyle(model.isLiked(track) ? FormaTheme.accent : .secondary) }
                .buttonStyle(ResponsiveButtonStyle()).accessibilityLabel(model.isLiked(track) ? "Убрать из любимого" : "Добавить в любимое")
            Menu {
                if model.library.playlists.isEmpty { Text("Создай плейлист в библиотеке") }
                ForEach(model.library.playlists) { playlist in Button(playlist.name) { model.add(track, to: playlist.id) } }
            } label: { Image(systemName: "ellipsis").frame(width: 30, height: 40) }.accessibilityLabel("Добавить в плейлист")
        }.padding(.vertical, 6)
    }
}
@MainActor
struct MoodView: View {
    @ObservedObject var model: AppModel
    let mix: MoodMix
    var body: some View {
        let tracks = model.moodTracks(mix)
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(mix.title).font(.largeTitle.bold())
                Text("Собрано под твой вкус и настроение").foregroundStyle(.secondary)
                Button { model.startPulse(mood: mix.id) } label: { Label("Слушать подборку", systemImage: "play.fill") }.buttonStyle(.borderedProminent).disabled(tracks.isEmpty)
                if tracks.isEmpty { EmptyState(title: "Подборка ещё впереди", text: "Обнови каталог. Мы покажем музыку, когда найдём подходящие треки.") }
                ForEach(tracks) { track in TrackRow(model: model, track: track) { model.player.play(track, list: tracks, context: mix.id) } }
            }.padding(20)
        }.background(FormaTheme.background).navigationBarTitleDisplayMode(.inline)
            .task { await model.prepareTracks(tracks) }
    }
}
@MainActor
struct SearchView: View {
    @ObservedObject var model: AppModel
    @State private var query = ""
    @State private var showLink = false
    @State private var link = ""
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if model.isSearching { ProgressView("Ищем музыку…").padding() }
                if query.isEmpty { EmptyState(title: "Что хочется услышать?", text: "Название трека, исполнитель или ссылка на YouTube.") }
                else if !model.isSearching, model.searchResults.isEmpty { EmptyState(title: "Пока ничего не найдено", text: "Уточни название или попробуй прямую ссылку.") }
                ForEach(model.searchResults) { track in TrackRow(model: model, track: track) { model.player.play(track, list: model.searchResults) } }
            }.padding(20)
        }.background(FormaTheme.background).navigationTitle("Поиск")
            .searchable(text: $query, prompt: "Трек или исполнитель")
            .task(id: query) {
                do { try await Task.sleep(nanoseconds: 350_000_000); try Task.checkCancellation(); await model.search(query) } catch { }
            }
            .toolbar { Button { showLink = true } label: { Image(systemName: "link") }.accessibilityLabel("Открыть ссылку YouTube") }
            .alert("Ссылка на YouTube", isPresented: $showLink) {
                TextField("https://youtu.be/…", text: $link).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Слушать") { Task { await model.openYouTube(link) } }
                Button("Отмена", role: .cancel) {}
            }
    }
}
@MainActor
struct LibraryView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if model.liked.isEmpty { EmptyState(title: "Здесь будет любимое", text: "Сохраняй треки сердечком — они станут основой Пульса.") }
                else { Button { if let first = model.liked.first { model.player.play(first, list: model.liked) } } label: { Label("Слушать любимое", systemImage: "play.fill") }.buttonStyle(.borderedProminent) }
                ForEach(model.liked) { track in TrackRow(model: model, track: track) { model.player.play(track, list: model.liked) } }
            }.padding(20)
        }.background(FormaTheme.background).navigationTitle("Любимое")
    }
}
@MainActor
struct EmptyState: View {
    let title: String
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { Text(title).font(.headline); Text(text).foregroundStyle(.secondary) }.padding(.vertical, 24)
    }
}
