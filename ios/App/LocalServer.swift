import Foundation
import Network

/// The web app, served from the app's bundle on 127.0.0.1. A loopback page is a secure context
/// (WebAssembly, the AudioWorklet and crypto.subtle all need one), keeps one origin for its saves
/// and ROM library, and needs no network: the bundle has every file.
final class LocalServer {
    let root: URL
    private(set) var port: UInt16 = 0
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "fm1.server")

    init(root: URL) { self.root = root.standardizedFileURL }

    /// Listen on the first of these ports that is free (the first keeps the page's origin, and
    /// with it the browser storage, from one launch to the next).
    func start(ports: [UInt16]) -> UInt16? {
        for p in ports {
            guard let nwPort = NWEndpoint.Port(rawValue: p) else { continue }
            let params = NWParameters.tcp
            params.requiredInterfaceType = .loopback
            params.allowLocalEndpointReuse = true
            guard let l = try? NWListener(using: params, on: nwPort) else { continue }
            let ready = DispatchSemaphore(value: 0)
            var ok = false
            l.stateUpdateHandler = { state in
                switch state {
                case .ready: ok = true; ready.signal()
                case .failed, .cancelled: ready.signal()
                default: break
                }
            }
            l.newConnectionHandler = { [weak self] c in self?.handle(c) }
            l.start(queue: queue)
            _ = ready.wait(timeout: .now() + 2)
            if ok {
                l.stateUpdateHandler = nil
                listener = l
                port = p
                return p
            }
            l.cancel()
        }
        return nil
    }

    private func handle(_ c: NWConnection) {
        c.start(queue: queue)
        receive(c, buffer: Data())
    }

    private func receive(_ c: NWConnection, buffer: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(c, head: buf.subdata(in: buf.startIndex..<end.lowerBound))
            } else if done || error != nil || buf.count > 65_536 {
                c.cancel()
            } else {
                self.receive(c, buffer: buf)
            }
        }
    }

    private func respond(_ c: NWConnection, head: Data) {
        let line = String(decoding: head, as: UTF8.self).split(separator: "\r\n").first.map(String.init) ?? ""
        let parts = line.split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else { return send(c, 405, "text/plain", Data("method".utf8), head: false) }
        let headOnly = parts[0] == "HEAD"
        var path = String(parts[1].split(separator: "?", maxSplits: 1).first ?? "/")
        path = path.removingPercentEncoding ?? path
        if path.hasSuffix("/") { path += "index.html" }
        let file = root.appendingPathComponent(String(path.drop { $0 == "/" })).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let body = try? Data(contentsOf: file) else {
            return send(c, 404, "text/plain", Data("not found".utf8), head: headOnly)
        }
        send(c, 200, Self.type(of: file.pathExtension), body, head: headOnly)
    }

    private func send(_ c: NWConnection, _ status: Int, _ type: String, _ body: Data, head: Bool) {
        let reason = [200: "OK", 404: "Not Found", 405: "Method Not Allowed"][status] ?? "OK"
        let header = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n" +
            "Cache-Control: no-cache\r\nCross-Origin-Resource-Policy: same-origin\r\nConnection: close\r\n\r\n"
        var out = Data(header.utf8)
        if !head { out.append(body) }
        c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
    }

    static func type(of ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json"
        case "wasm": return "application/wasm"
        case "png": return "image/png"
        case "svg": return "image/svg+xml"
        case "pdf": return "application/pdf"
        default: return "application/octet-stream"
        }
    }
}
