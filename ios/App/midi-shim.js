// Web MIDI for the page inside the FM-1 app (WKWebView has none): navigator.requestMIDIAccess
// backed by CoreMIDI through App/MidiBridge.swift, and window.fm1Native, the app's other services
// for the page (the ROM folder it shares with the AUv3 plugin, Bluetooth MIDI). Injected before the
// page's own scripts run.
(() => {
  const handlers = window.webkit && window.webkit.messageHandlers;
  if (!handlers || !handlers.fm1midi) return;
  const post = (m) => handlers.fm1midi.postMessage(m);
  const native = (m) => handlers.fm1native.postMessage(m);

  class MIDIPortShim extends EventTarget {
    constructor(info, type) {
      super();
      this.id = info.id;
      this.name = info.name;
      this.manufacturer = info.manufacturer || "";
      this.version = "";
      this.type = type;
      this.state = "connected";
      this.connection = "open";
      this.onstatechange = null;
      this._onmessage = null;
    }
    get onmidimessage() { return this._onmessage; }
    set onmidimessage(f) {
      if (this._onmessage) this.removeEventListener("midimessage", this._onmessage);
      this._onmessage = typeof f === "function" ? f : null;
      if (this._onmessage) this.addEventListener("midimessage", this._onmessage);
    }
    open() { return Promise.resolve(this); }
    close() { return Promise.resolve(this); }
    send(data) { if (this.type === "output") post({ op: "send", id: this.id, data: Array.from(data) }); }
    clear() {}
  }

  const access = new EventTarget();
  access.inputs = new Map();
  access.outputs = new Map();
  access.sysexEnabled = true;
  access.onstatechange = null;
  const changed = (port) => {
    const e = new Event("statechange");
    e.port = port;
    port.dispatchEvent(e);
    if (typeof port.onstatechange === "function") port.onstatechange(e);
    access.dispatchEvent(e);
    if (typeof access.onstatechange === "function") access.onstatechange(e);
  };
  const sync = (map, list, type) => {
    const ids = new Set(list.map((p) => p.id));
    for (const [id, port] of map) {
      if (!ids.has(id)) { map.delete(id); port.state = "disconnected"; port.connection = "closed"; changed(port); }
    }
    for (const info of list) {
      if (!map.has(info.id)) { const port = new MIDIPortShim(info, type); map.set(info.id, port); changed(port); }
    }
  };

  let ready = null, resolveReady = null;
  window.__fm1midi = {
    ports(list) {
      sync(access.inputs, list.inputs || [], "input");
      sync(access.outputs, list.outputs || [], "output");
      if (resolveReady) { resolveReady(); resolveReady = null; }
    },
    recv(batch) {
      const now = performance.now();
      for (const [id, bytes] of batch) {
        const port = access.inputs.get(id);
        if (!port) continue;
        const e = new Event("midimessage");
        e.data = new Uint8Array(bytes);
        e.receivedTime = now;
        port.dispatchEvent(e);
      }
    },
  };
  navigator.requestMIDIAccess = () => {
    ready ||= new Promise((resolve) => {
      resolveReady = resolve;
      post({ op: "open" });
      setTimeout(resolve, 1500);            // (no answer: an empty list rather than a hang)
    });
    return ready.then(() => access);
  };

  // the app's services for web/pwa.js
  const b64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(s);
  };
  window.fm1Native = {
    roms: window.__fm1NativeRoms || [],
    keepRom(name, bytes) { native({ op: "rom", name, data: b64(bytes) }); },
    deleteRom(name) { native({ op: "romDelete", name }); },
    bluetooth() { native({ op: "bluetooth" }); },
  };
})();
