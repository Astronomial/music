import SwiftUI
import FormaCore

@MainActor
struct ContentView: View {
    @ObservedObject var model: AppModel
    @AppStorage("forma.palette") private var palette = "iris"
    @AppStorage("forma.compactNavigation") private var compactNavigation = false
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab = 0
    @State private var sheet: AppSheet?
#if DEBUG && targetEnvironment(simulator)
    @Environment(\.dynamicTypeSize) private var systemTypeSize
    @State private var auditingLargeText = false
#endif
    private var showSettings: Binding<Bool> { Binding(get: { sheet == .pulse }, set: { sheet = $0 ? .pulse : nil }) }
    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack { HomeView(model: model, showSettings: showSettings) }.modifier(PlayerInset(model: model, expand: { sheet = .player }))
                .tabItem { Image(systemName: "house"); Text(compactNavigation ? "" : "Главная") }.tag(0)
            NavigationStack { SearchView(model: model) }.modifier(PlayerInset(model: model, expand: { sheet = .player }))
                .tabItem { Image(systemName: "magnifyingglass"); Text(compactNavigation ? "" : "Поиск") }.tag(1)
            NavigationStack { PlaylistsView(model: model) }.modifier(PlayerInset(model: model, expand: { sheet = .player }))
                .tabItem { Image(systemName: "square.stack"); Text(compactNavigation ? "" : "Библиотека") }.tag(2)
            NavigationStack { SettingsView(model: model) }.modifier(PlayerInset(model: model, expand: { sheet = .player }))
                .tabItem { Image(systemName: "gearshape"); Text(compactNavigation ? "" : "Настройки") }.tag(3)
        }
        .background(TabBarLabels(compact: compactNavigation).frame(width: 0, height: 0))
        .tint(FormaTheme.color(palette))
        .environment(\.cosmosVisible, sheet == nil)
        .sheet(item: $sheet) { destination in
            NavigationStack {
                if destination == .player { NowPlayingView(model: model) }
                else { PulseSettingsView(model: model) }
            }.environment(\.cosmosVisible, true).modifier(AppMessageAlert(model: model)).presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .modifier(AppMessageAlert(model: model, enabled: sheet == nil))
        .task {
            guard !ProcessInfo.processInfo.arguments.contains("--forma-smoke") else { return }
            while (!model.player.networkPolicy.known || model.isRestoringLibrary), !Task.isCancelled { try? await Task.sleep(nanoseconds: 50_000_000) }
            guard !Task.isCancelled else { return }
            if model.library.tracks.isEmpty || UserDefaults.standard.integer(forKey: "forma.discoveryRevision") < 6 { await model.refresh(automatic: true) }
            while !Task.isCancelled {
                if scenePhase == .active { await model.synchronize() }
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.becameActive() } }
            else { model.persist(immediately: true, background: phase == .background) }
        }
#if DEBUG && targetEnvironment(simulator)
        .environment(\.dynamicTypeSize, auditingLargeText ? .accessibility3 : systemTypeSize)
        .onAppear {
            NativeDesignAudit.selectTab = { selectedTab = $0 }
            NativeDesignAudit.present = { sheet = $0 == "player" ? .player : $0 == "pulse" ? .pulse : nil }
            NativeDesignAudit.largeText = { auditingLargeText = $0 }
        }
#endif
    }
}
private enum AppSheet: String, Identifiable { case player, pulse; var id: String { rawValue } }
@MainActor
private struct AppMessageAlert: ViewModifier {
    @ObservedObject var model: AppModel
    var enabled = true
    func body(content: Content) -> some View {
        content.alert("Forma", isPresented: Binding(get: { enabled && model.message != nil }, set: { if !$0, enabled { model.message = nil } })) {
            Button("Понятно", role: .cancel) { model.message = nil }
        } message: { Text(model.message ?? "") }
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
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if model.isRestoringLibrary { ProgressView("Открываем библиотеку…") }
                LibraryRecoveryNotice(model: model)
                PulseHero(model: model) { showSettings = true }
                HStack { Text("По настроению").font(.title2.bold()).accessibilityAddTraits(.isHeader); Spacer(); if model.isRefreshing { ProgressView().accessibilityLabel("Обновление подборок") } }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .top), count: typeSize.isAccessibilitySize ? 1 : 2), spacing: 14) {
                    ForEach(Array(MoodMix.all.enumerated()), id: \.element.id) { index, mix in
                        NavigationLink { MoodView(model: model, mix: mix) } label: {
                            VStack(alignment: .leading, spacing: 12) {
                                Image(systemName: ["leaf", "sun.max", "moon", "bolt", "sparkles", "moon.stars"][index]).font(.title2).foregroundStyle(FormaTheme.colors[index]).accessibilityHidden(true)
                                Spacer(minLength: 16)
                                Text(mix.title).font(.headline).multilineTextAlignment(.leading)
                                Text("\(model.moodTracks(mix).count) треков").font(.subheadline).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, minHeight: 124, alignment: .leading).padding(16)
                                .background { CosmicPanelBackground(radius: 20) }
                        }.foregroundStyle(.primary).buttonStyle(ResponsiveButtonStyle()).accessibilityHint(mix.subtitle)
                    }
                }
                Text("Для тебя").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                if model.recommendations.isEmpty, !model.isRestoringLibrary { EmptyState(title: "Добавь любимую музыку", text: "Найди треки в поиске или перенеси библиотеку с ПК.") }
                ForEach(model.recommendations.prefix(12)) { item in TrackRow(model: model, track: item.track, reason: item.reason) { model.playRecommendation(item.track) } }
            }.padding(20)
        }.cosmicBackground().navigationTitle("forma.").navigationBarTitleDisplayMode(.inline)
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
            }.foregroundStyle(.primary).buttonStyle(ResponsiveButtonStyle()).accessibilityLabel("Слушать \(track.artist) — \(track.title)").accessibilityHint(reason ?? "")
            Button { model.toggleLike(track) } label: { Image(systemName: model.isLiked(track) ? "heart.fill" : "heart").foregroundStyle(model.isLiked(track) ? FormaTheme.accent : .secondary).frame(width: 44, height: 44).contentShape(Rectangle()) }
                .buttonStyle(ResponsiveButtonStyle()).accessibilityLabel(model.isLiked(track) ? "Убрать из любимого" : "Добавить в любимое")
            Menu {
                Button(model.isDisliked(track) ? "Снять дизлайк" : "Не нравится", systemImage: "hand.thumbsdown") { model.toggleDislike(track) }
                if model.library.playlists.isEmpty { Text("Создай плейлист в библиотеке") }
                ForEach(model.library.playlists) { playlist in Button(playlist.name) { model.add(track, to: playlist.id) } }
            } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Действия с треком \(track.title)")
        }.padding(.vertical, 6).padding(.horizontal, 8)
            .background { CosmicPanelBackground(radius: 16, opacity: 0.45) }
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
                Text(mix.subtitle).foregroundStyle(.secondary)
                Button { model.startPulse(mood: mix.id) } label: { Label("Слушать подборку", systemImage: "play.fill") }.buttonStyle(.borderedProminent).foregroundStyle(FormaTheme.background).disabled(tracks.isEmpty)
                if tracks.isEmpty { EmptyState(title: model.isRefreshing ? "Подбираем треки…" : "Пока нет подходящих треков", text: "Обнови подборки на главной или добавь любимую музыку.") }
                ForEach(tracks) { track in TrackRow(model: model, track: track) { model.playRecommendation(track, mood: mix.id) } }
            }.padding(20)
        }.cosmicBackground().navigationBarTitleDisplayMode(.inline)
            .task { await model.prepareTracks(tracks) }
    }
}
@MainActor
struct SearchView: View {
    @ObservedObject var model: AppModel
    @State private var query = ""
    @State private var showLink = false
    @State private var link = ""
    private var normalizedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if normalizedQuery.count < 2 { EmptyState(title: "Найди свою музыку", text: "Введи хотя бы два символа: название или исполнителя.") }
                else if model.isSearching || model.completedSearchQuery != normalizedQuery { ProgressView("Ищем музыку…").padding() }
                if normalizedQuery.count >= 2, model.completedSearchQuery == normalizedQuery {
                    if !model.isSearching, model.searchResults.isEmpty { EmptyState(title: "Ничего не найдено", text: "Уточни запрос или открой ссылку YouTube.") }
                    ForEach(model.searchResults) { track in TrackRow(model: model, track: track) { model.play(track, list: model.searchResults) } }
                }
            }.padding(20)
        }.cosmicBackground().navigationTitle("Поиск")
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
                else { Button { if let first = model.liked.first { model.play(first, list: model.liked) } } label: { Label("Слушать любимое", systemImage: "play.fill") }.buttonStyle(.borderedProminent).foregroundStyle(FormaTheme.background) }
                ForEach(model.liked) { track in TrackRow(model: model, track: track) { model.play(track, list: model.liked) } }
            }.padding(20)
        }.cosmicBackground().navigationTitle("Любимое")
    }
}
@MainActor
struct EmptyState: View {
    let title: String
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { Text(title).font(.headline).accessibilityAddTraits(.isHeader); Text(text).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 24)
    }
}
