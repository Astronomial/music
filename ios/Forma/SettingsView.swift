import SwiftUI
import FormaCore

@MainActor
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @AppStorage("forma.palette") private var palette = "iris"
    @AppStorage("forma.showArtwork") private var showArtwork = true
    @AppStorage("forma.soundAnalysis") private var soundAnalysis = true
    @AppStorage("forma.soundCellular") private var soundCellular = true
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                WiFiSettingsView(model: model)
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Твой цвет").font(.headline)
                        Picker("Палитра", selection: $palette) {
                            Text("Ирис").tag("iris"); Text("Мята").tag("mint"); Text("Закат").tag("sunset"); Text("Лёд").tag("ice")
                        }.pickerStyle(.segmented)
                    }
                }
                GlassPanel {
                    Toggle("Показывать обложки", isOn: $showArtwork)
                        .onChange(of: showArtwork) { _, _ in model.player.refreshArtworkPreference() }
                }
                GlassPanel {
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle("Анализировать звучание", isOn: $soundAnalysis).onChange(of: soundAnalysis) { _, _ in model.soundPolicyChanged() }
                        Toggle("Анализ по мобильной сети", isOn: $soundCellular).disabled(!soundAnalysis).onChange(of: soundCellular) { _, _ in model.soundPolicyChanged() }
                        Text("Пульс сравнивает спектр, темп, динамику и ритм. До 6 МБ на трек, 12 треков в час; временное аудио удаляется после обработки. Проанализировано: \(model.library.tracks.values.filter { $0.soundProfile != nil }.count)").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                GlassPanel { DisclosureGroup("Скорость воспроизведения") { PlaybackPerformanceView(player: model.player) } }
                NavigationLink { PulseSettingsView(model: model) } label: { Label("Настроить Пульс", systemImage: "slider.horizontal.3").font(.headline) }
                Text("Forma 1.3.0 · iOS 17+\nВоспроизведение работает через нативный плеер. YouTube должен быть доступен в твоей сети.").font(.footnote).foregroundStyle(.secondary)
            }.padding(20)
        }.background(FormaTheme.background).navigationTitle("Настройки")
    }
}

@MainActor
private struct PlaybackPerformanceView: View {
    @ObservedObject var player: PlaybackController
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let last = player.measurements.last {
                Text(last.title).font(.subheadline).lineLimit(2)
                Text("Последний старт: \(last.totalMilliseconds / 1000, specifier: "%.2f") с").font(.headline).monospacedDigit()
                Text("Получение потока: \(last.resolutionMilliseconds / 1000, specifier: "%.2f") с · буфер: \(last.bufferMilliseconds / 1000, specifier: "%.2f") с").font(.footnote).foregroundStyle(.secondary)
                ShareLink(item: player.performanceReport) { Label("Поделиться замерами", systemImage: "square.and.arrow.up") }
            } else { Text("Выбери несколько треков, чтобы увидеть время запуска.").font(.subheadline) }
            Text("Для сравнения с ПК выбирай одинаковые треки в одной Wi-Fi сети. Загрузка нового и заранее подготовленного трека измеряется отдельно.").font(.footnote).foregroundStyle(.secondary)
        }.padding(.top, 12)
    }
}

@MainActor
private struct WiFiSettingsView: View {
    @ObservedObject var model: AppModel
    @State private var code = ""
    var body: some View {
        GlassPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("Синхронизация с ПК · Wi-Fi").font(.title2.bold())
                Text("Подключи iPhone и ПК к одной домашней сети. На ПК: Настройки → Подключить iPhone. Каждый обмен требует подтверждения на одном из устройств.").foregroundStyle(.secondary)
                TextField("Вставь код подключения", text: $code, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                Button("Подключить ПК") { Task { await model.pairPC(code) } }.buttonStyle(.borderedProminent).disabled(model.isSyncing || code.isEmpty || !model.canSynchronizePC)
                if let host = model.pcHost {
                    Text("ПК: \(host)").font(.subheadline)
                    if let proposal = model.syncProposal {
                        Text("Изменения перед обменом").font(.headline)
                        WiFiChangesView(title: "На ПК", summary: proposal.summary.toPC)
                        WiFiChangesView(title: "На iPhone", summary: proposal.summary.toPhone)
                        if proposal.status == .pending {
                            Button("Применить на обоих устройствах") { Task { await model.approveExchange() } }.buttonStyle(.borderedProminent).disabled(model.isSyncing || !model.canSynchronizePC)
                        }
                        Button("Отклонить обмен", role: .destructive) { Task { await model.rejectExchange() } }.disabled(model.isSyncing || !model.canSynchronizePC || proposal.status == .approved)
                        Button("Проверить решение на ПК") { Task { await model.synchronize(showErrors: true) } }.disabled(model.isSyncing || !model.canSynchronizePC)
                    } else {
                        Button("Подготовить обмен") { Task { await model.synchronize(showErrors: true) } }.buttonStyle(.bordered).disabled(model.isSyncing || !model.canSynchronizePC)
                    }
                    Button("Отключить ПК", role: .destructive) { Task { await model.disconnectPC() } }.disabled(model.isSyncing)
                }
                if model.isSyncing { ProgressView("Проверяем обмен…") }
                Text(model.syncStatus).font(.footnote).foregroundStyle(.secondary)
                Text("Локальные изменения сохраняются сразу. На другое устройство они переносятся только после подтверждения. Передаются лайки, дизлайки, плейлисты, история, настройки Пульса и признаки звучания; музыкальные файлы остаются на устройстве.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}
private struct WiFiChangesView: View {
    let title: String
    let summary: SyncChangeSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            if summary.rows.isEmpty { Text("Без изменений").foregroundStyle(.secondary) }
            ForEach(0..<summary.rows.count, id: \.self) { index in Text("\(summary.rows[index].0): \(summary.rows[index].1)").font(.subheadline) }
            if !summary.details.isEmpty {
                DisclosureGroup("Какие треки и плейлисты") { ForEach(Array(summary.details.enumerated()), id: \.offset) { row in Text(row.element).font(.footnote) } }
            }
        }
    }
}
