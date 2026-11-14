import AVFoundation
import CoreAudioKit
import UIKit
import WebKit

/// The app: the emulator's web page (web/, bundled as "site") full screen in a WKWebView, whose
/// WebAssembly runs with Safari's JIT, with CoreMIDI behind the page's Web MIDI.
final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var web: WKWebView!
    private let midi = MidiBridge()
    private var server: LocalServer?
    private var downloadURL: URL?

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let content = WKUserContentController()
        // the ROM folder's files, then the Web MIDI shim, before the page's scripts
        let roms = (try? JSONSerialization.data(withJSONObject: RomFolder.names())).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        content.addUserScript(WKUserScript(source: "window.__fm1NativeRoms = \(roms);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let url = Bundle.main.url(forResource: "midi-shim", withExtension: "js"), let shim = try? String(contentsOf: url, encoding: .utf8) {
            content.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        content.add(self, name: "fm1midi")
        content.add(self, name: "fm1native")
        config.userContentController = content
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        if #available(iOS 16.4, *) { web.isInspectable = true }
        view = web
        midi.evaluate = { [weak self] js in self?.web.evaluateJavaScript(js, completionHandler: nil) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        guard let root = Bundle.main.url(forResource: "site", withExtension: nil) else {
            web.loadHTMLString("<body style='background:#000;color:#fff;font:20px system-ui'>The web app is missing from this build.</body>", baseURL: nil)
            return
        }
        let s = LocalServer(root: root)
        guard let port = s.start(ports: [47391, 47392, 47393, 47394]) else {
            web.loadHTMLString("<body style='background:#000;color:#fff;font:20px system-ui'>Could not start the app's local server.</body>", baseURL: nil)
            return
        }
        server = s
        web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true      // the screen stays on while the synth plays
    }

    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var prefersStatusBarHidden: Bool { true }

    // ---------------------------------------------------------------- the page's messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
        switch (message.name, op) {
        case ("fm1midi", "open"):
            midi.open()
        case ("fm1midi", "send"):
            if let id = body["id"] as? String, let data = body["data"] as? [NSNumber] {
                midi.send(to: id, data.map { $0.uint8Value })
            }
        case ("fm1native", "rom"):
            if let name = body["name"] as? String, let b64 = body["data"] as? String, let data = Data(base64Encoded: b64) {
                RomFolder.save(name: name, data: data)
            }
        case ("fm1native", "romDelete"):
            if let name = body["name"] as? String { RomFolder.delete(name: name) }
        case ("fm1native", "bluetooth"):
            let bt = CABTMIDICentralViewController()
            bt.navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
                self?.dismiss(animated: true)
            })
            let nav = UINavigationController(rootViewController: bt)
            nav.modalPresentationStyle = .formSheet
            present(nav, animated: true)
        default:
            break
        }
    }

    // ---------------------------------------------------------------- links, dialogs, downloads

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // links to other sites (the Hub, sources, docs) open in Safari
        if let url = navigationAction.request.url, url.host != "127.0.0.1", navigationAction.navigationType == .linkActivated,
           url.scheme == "https" || url.scheme == "http" {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(suggestedFilename)
        try? FileManager.default.removeItem(at: url)
        downloadURL = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadURL else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        present(share, animated: true)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { [weak a] _ in completionHandler(a?.textFields?.first?.text) })
        present(a, animated: true)
    }

    // the page's process ended (memory pressure while in the background): load it again
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}
