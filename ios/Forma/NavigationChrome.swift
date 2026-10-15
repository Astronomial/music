import SwiftUI
import UIKit

/// Native tabs retain their accessible names when their visible captions are hidden.
struct TabBarLabels: UIViewRepresentable {
    var compact: Bool
    func makeUIView(context: Context) -> LabelView { LabelView() }
    func updateUIView(_ view: LabelView, context: Context) {
        view.compact = compact
        DispatchQueue.main.async { view.updateLabels() }
    }
    final class LabelView: UIView {
        var compact = false
        override func didMoveToWindow() { super.didMoveToWindow(); updateLabels() }
        func updateLabels() {
            guard let window else { return }
            func find(_ view: UIView) -> UITabBar? {
                if let bar = view as? UITabBar { return bar }
                return view.subviews.lazy.compactMap { find($0) }.first
            }
            guard let bar = find(window) else { return }
            let names = ["Главная", "Поиск", "Библиотека", "Настройки"]
            for (index, item) in (bar.items ?? []).enumerated() where index < names.count {
                let title = compact ? "" : names[index]
                let insets = compact ? UIEdgeInsets(top: 5, left: 0, bottom: -5, right: 0) : .zero
                if item.accessibilityLabel != names[index] { item.accessibilityLabel = names[index] }
                if item.accessibilityIdentifier != "tab-\(index)" { item.accessibilityIdentifier = "tab-\(index)" }
                if item.title != title { item.title = title }
                if item.imageInsets != insets { item.imageInsets = insets }
            }
        }
    }
}

@MainActor
struct LibraryRecoveryNotice: View {
    @ObservedObject var model: AppModel
    var body: some View {
        if let message = model.libraryRecoveryMessage {
            GlassPanel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Библиотека недоступна").font(.headline).accessibilityAddTraits(.isHeader)
                    Text(message).font(.subheadline).foregroundStyle(.secondary)
                    Text("Изменения пока не сохраняются. Исходный файл сохранён.").font(.subheadline)
                    Button("Повторить открытие") { Task { await model.retryLibrary() } }.buttonStyle(.bordered)
                        .disabled(model.isRestoringLibrary)
                }
            }
        }
    }
}
