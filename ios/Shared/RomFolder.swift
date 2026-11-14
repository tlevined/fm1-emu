import Foundation

/// The firmware packages the app and the plugin share: a folder in their App Group's container.
/// The app's ROM library (the web page) copies every package it keeps here; the plugin lists them.
enum RomFolder {
    static var groupID: String {
        Bundle.main.object(forInfoDictionaryKey: "FM1AppGroup") as? String ?? ""
    }

    static var url: URL? {
        guard !groupID.isEmpty,
              let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupID) else { return nil }
        let dir = base.appendingPathComponent("ROMs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func list() -> [URL] {
        guard let dir = url,
              let items = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        return items
            .filter { $0.pathExtension.lowercased() == "fwsc" }
            .sorted { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }
    }

    static func names() -> [String] { list().map { $0.lastPathComponent } }

    /// A file name safe for the folder (the page makes the same one: web/pwa.js romFile)
    static func safeName(_ name: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|")
        var s = name.components(separatedBy: bad).filter { !$0.isEmpty }.joined(separator: "-")
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { s = "firmware.fwsc" }
        if !s.lowercased().hasSuffix(".fwsc") { s += ".fwsc" }
        return String(s.prefix(124))
    }

    @discardableResult
    static func save(name: String, data: Data) -> URL? {
        guard let dir = url else { return nil }
        let file = dir.appendingPathComponent(safeName(name))
        do { try data.write(to: file, options: .atomic); return file } catch { return nil }
    }

    static func delete(name: String) {
        guard let dir = url else { return }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(safeName(name)))
    }
}
