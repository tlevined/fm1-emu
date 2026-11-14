// The ROM library: firmware packages (.fwsc) kept in this browser, so every firmware plays with no
// network once it has been fetched (an installed PWA on a plane). Three kinds of entry:
//   cat:<id>  a catalog firmware (web/firmwares.json), fetched from its author's site
//   url:<h>   a package added by URL (any https URL that allows other pages to read it)
//   file:<h>  a package opened from this device
// Metadata and bytes live in two object stores, so listing the library never reads 200 MB.
// main.js asks `packageFor(entry)` before it downloads a catalog firmware and hands every
// download to `keep(entry, got)`; the panel in the sidebar is `mountLibrary(app)`.
import { fetchPackage, flashFromPackage } from "./fwsc.js";

const DB = "fm1-pwa-library", VERSION = 1;
const MAX_PACKAGE = 16 << 20;

// ---------------------------------------------------------------- pure helpers (tested in node)
// A URL as written by a person, made into one this page can download: GitHub's "blob" pages become
// their raw file, Dropbox share links their download.
export function normalizeUrl(text) {
  let url;
  try { url = new URL(String(text).trim()); } catch { throw new Error("not a URL"); }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") throw new Error("only https URLs can be added");
  if (url.host === "github.com") {
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  if (/(^|\.)dropbox\.com$/.test(url.host) && url.searchParams.has("dl")) {
    url.searchParams.set("dl", "1");
    return url.href;
  }
  return url.href;
}

// The name a package goes by: ?name= or its file name, without .fwsc
export function nameFromUrl(href) {
  const url = new URL(href);
  const raw = url.searchParams.get("name") || url.pathname.split("/").pop() || url.host;
  let name = raw;
  try { name = decodeURIComponent(raw); } catch { /* as written */ }
  return name.replace(/\.fwsc$/i, "") || url.host;
}

// Is this an FM-1 / SMK-37 update package? (fwsc.js finds its flash image or throws)
export function checkPackage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 0x400) throw new Error("too small to be a .fwsc package");
  if (bytes.length > MAX_PACKAGE) throw new Error("too large to be a .fwsc package");
  flashFromPackage(bytes);
  return bytes;
}

// .fwsc files a web page names (an installer's "download" link), absolute
export function packagesInPage(html, base) {
  const out = [];
  for (const m of String(html).matchAll(/["'(=\s]([^"'()\s<>]+?\.fwsc)(?:[?#][^"'\s<>]*)?["')\s>]/gi)) {
    try {
      const href = new URL(m[1], base).href;
      if (!out.includes(href)) out.push(href);
    } catch { /* not a URL */ }
  }
  return out;
}

export const sizeText = (n) => n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export async function shortHash(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- the store
export class RomStore {
  constructor(indexedDB = globalThis.indexedDB) {
    this.idb = indexedDB;
    this.db = null;
  }
  open() {
    if (!this.idb) return Promise.reject(new Error("this browser has no IndexedDB"));
    this.db ||= new Promise((resolve, reject) => {
      const r = this.idb.open(DB, VERSION);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("meta", { keyPath: "key" });
        r.result.createObjectStore("bytes");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch((e) => { this.db = null; throw e; });
    return this.db;
  }
  async tx(stores, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("storage transaction aborted"));
      const req = fn(...stores.map((s) => t.objectStore(s)));
      if (req) req.onsuccess = () => { out = req.result; };
    });
  }
  list() { return this.tx(["meta"], "readonly", (m) => m.getAll()).then((l) => l.sort((a, b) => a.name.localeCompare(b.name))); }
  meta(key) { return this.tx(["meta"], "readonly", (m) => m.get(key)); }
  bytes(key) { return this.tx(["bytes"], "readonly", (b) => b.get(key)); }
  async put(meta, bytes) {
    const record = { ...meta, size: bytes.length, added: meta.added || Date.now() };
    await this.tx(["meta", "bytes"], "readwrite", (m, b) => { b.put(bytes, record.key); m.put(record); });
    return record;
  }
  delete(key) { return this.tx(["meta", "bytes"], "readwrite", (m, b) => { b.delete(key); m.delete(key); }); }
}

// ---------------------------------------------------------------- what main.js asks
// The keep-everything switch: on by default, so a firmware played once is there offline
const KEEP = "fm1pwa.keep";
const setting = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export function createLibrary(store = new RomStore()) {
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) try { fn(); } catch { /* a view gone */ } };
  const lib = {
    store,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    keepsEverything: () => setting(KEEP, "1") === "1",
    setKeepsEverything(on) { set(KEEP, on ? "1" : "0"); },
    // a catalog entry's kept package, as main.js's packageOf returns them; null when not kept
    async packageFor(entry) {
      if (!entry || entry.byo || entry.link || entry.id === "local") return null;
      const meta = await store.meta(`cat:${entry.id}`);
      if (!meta) return null;
      const bytes = await store.bytes(meta.key);
      return bytes ? { bytes, url: meta.url, ...(meta.version && meta.version !== entry.version && { version: meta.version }) } : null;
    },
    // a package main.js downloaded for a catalog entry
    async keep(entry, got, force = false) {
      if (!entry || entry.byo || entry.link || entry.id === "local" || !got?.bytes) return null;
      if (!force && !lib.keepsEverything()) return null;
      const record = await store.put({ key: `cat:${entry.id}`, kind: "catalog", catalogId: entry.id, name: entry.name,
        version: got.version || entry.version || "", author: entry.author || "", url: got.url || entry.package || "" }, got.bytes);
      changed();
      return record;
    },
    async addBytes(name, bytes, { url = "", kind = url ? "url" : "file" } = {}) {
      checkPackage(bytes);
      const key = `${kind}:${await shortHash(bytes)}`;
      const record = await store.put({ key, kind, name, version: "", author: "", url }, bytes);
      changed();
      return record;
    },
    // a package from the web: a .fwsc URL, or a page that links one (an installer or "Try" page).
    // `proxy`, when set, is put before the URL for sites that do not let other pages read them.
    async addUrl(text, { name = "", proxy = "", fetchFn = fetch } = {}) {
      const href = normalizeUrl(text);
      const via = (u) => proxy ? proxy + (proxy.includes("?") || proxy.endsWith("=") ? encodeURIComponent(u) : u) : u;
      let r;
      try { r = await fetchFn(via(href)); } catch {
        throw new Error("the site does not let other pages download from it (no CORS). Download the file and add it with “Add files”, or set a CORS proxy");
      }
      if (!r.ok) throw new Error(`${href}: HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      try {
        return await lib.addBytes(name || nameFromUrl(href), checkPackage(bytes), { url: href });
      } catch (notPackage) {
        // maybe a page that links the package
        const text = new TextDecoder().decode(bytes.subarray(0, 4 << 20));
        if (!/<html|<script|<a\s/i.test(text)) throw notPackage;
        for (const link of packagesInPage(text, href)) {
          try {
            const p = await fetchFn(via(link));
            if (!p.ok) continue;
            const b = new Uint8Array(await p.arrayBuffer());
            return await lib.addBytes(name || nameFromUrl(link), checkPackage(b), { url: link });
          } catch { /* the next link */ }
        }
        throw new Error("that page is not a .fwsc package and links none that downloads");
      }
    },
    // every catalog firmware not kept yet, `parallel` at a time; onProgress(done, total, failed)
    async downloadAll(entries, { parallel = 3, onProgress = () => {}, signal, fetchFn = fetch } = {}) {
      const kept = new Set((await store.list()).map((m) => m.key));
      const todo = entries.filter((e) => !e.byo && !e.link && e.package && !kept.has(`cat:${e.id}`));
      let done = 0;
      const failed = [];
      const queue = todo.slice();
      onProgress(0, todo.length, failed);
      const worker = async () => {
        while (queue.length && !signal?.aborted) {
          const e = queue.shift();
          try { await lib.keep(e, await fetchPackage(e, fetchFn), true); }
          catch (error) { failed.push({ entry: e, error }); }
          onProgress(++done, todo.length, failed);
        }
      };
      await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, worker));
      return { total: todo.length, done, failed };
    },
    async remove(key) { await store.delete(key); changed(); },
  };
  return lib;
}

// ---------------------------------------------------------------- the panel
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};

export function mountLibrary(app, lib, box) {
  const PROXY = "fm1pwa.proxy";
  const count = el("span", { className: "lib-count dim" });
  const usage = el("p", { className: "lib-usage" });
  const progress = el("p", { className: "lib-progress", hidden: true, role: "status" });
  const list = el("ul", { className: "lib-list" });
  const message = el("p", { className: "lib-msg", role: "status" });
  const say = (text, bad = false) => { message.textContent = text; message.dataset.error = String(bad); };

  // download everything in the catalog
  let controller = null;
  const all = el("button", { type: "button", className: "primary", textContent: "Download all for offline" });
  const untested = el("input", { type: "checkbox" });
  all.addEventListener("click", async () => {
    if (controller) { controller.abort(); return; }
    controller = new AbortController();
    all.textContent = "Stop downloading";
    progress.hidden = false;
    const entries = app.catalog.firmwares.filter((f) => untested.checked || !f.untested);
    try {
      const r = await lib.downloadAll(entries, { signal: controller.signal, onProgress: (d, t, failed) => {
        progress.textContent = t ? `Downloaded ${d} of ${t}${failed.length ? ` · ${failed.length} failed` : ""}` : "Every firmware is already here";
      } });
      say(r.total ? `${r.done - r.failed.length} firmwares kept for offline${r.failed.length ?
        `; ${r.failed.length} could not be downloaded (${r.failed.slice(0, 3).map((f) => f.entry.name).join(", ")}${r.failed.length > 3 ? "…" : ""})` : ""}` :
        "Every firmware is already kept", r.failed.length > 0);
    } catch (error) { say(error.message, true); }
    controller = null;
    all.textContent = "Download all for offline";
    persist();
  });

  // add by URL
  const url = el("input", { type: "url", placeholder: "https://…/firmware.fwsc", className: "lib-url", inputMode: "url",
    autocapitalize: "off", autocomplete: "off", spellcheck: false });
  url.setAttribute("aria-label", "Package URL");
  const nameIn = el("input", { type: "text", placeholder: "Name (optional)", className: "lib-name" });
  nameIn.setAttribute("aria-label", "Name for the package");
  const proxy = el("input", { type: "url", placeholder: "e.g. https://corsproxy.io/?url=", value: setting(PROXY, ""), className: "lib-proxy" });
  proxy.setAttribute("aria-label", "CORS proxy prefix");
  proxy.addEventListener("change", () => set(PROXY, proxy.value.trim()));
  const add = el("button", { type: "button", textContent: "Add" });
  const addUrl = async () => {
    if (!url.value.trim()) { url.focus(); return; }
    add.disabled = true;
    say("Downloading…");
    try {
      const r = await lib.addUrl(url.value, { name: nameIn.value.trim(), proxy: proxy.value.trim() });
      say(`Added ${r.name} (${sizeText(r.size)})`);
      url.value = nameIn.value = "";
      persist();
    } catch (error) { say(error.message, true); }
    add.disabled = false;
  };
  add.addEventListener("click", addUrl);
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") addUrl(); });

  // add files
  const files = el("input", { type: "file", multiple: true });
  files.addEventListener("change", async () => {
    const picked = [...files.files];
    files.value = "";
    let ok = 0;
    for (const f of picked) {
      try { await lib.addBytes(f.name.replace(/\.fwsc$/i, ""), new Uint8Array(await f.arrayBuffer())); ok++; }
      catch (error) { say(`${f.name}: ${error.message}`, true); }
    }
    if (ok) say(`Added ${ok} package${ok > 1 ? "s" : ""}`);
    persist();
  });

  const keep = el("input", { type: "checkbox", checked: lib.keepsEverything() });
  keep.addEventListener("change", () => lib.setKeepsEverything(keep.checked));

  box.append(
    el("h2", { className: "eyebrow", id: "h-lib" }, "ROM library ", count),
    usage,
    el("div", { className: "row" }, all),
    el("label", { className: "check" }, untested, " include firmwares not yet run in the emulator"),
    progress,
    el("label", { className: "check" }, keep, " keep every firmware I play"),
    el("div", { className: "lib-add" }, url, nameIn, add),
    el("div", { className: "row" }, el("label", { className: "file" }, "Add files… ", files)),
    el("details", { className: "lib-more" }, el("summary", {}, "CORS proxy (for sites that block downloads)"),
      el("p", { className: "dim" }, "Most firmware sites let this page download from them. For one that does not, put a proxy's address here; it is put in front of the URL you add."),
      proxy),
    message,
    el("details", { className: "lib-browse", open: true }, el("summary", {}, "Kept packages"), list),
  );

  async function persist() {
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch { /* not offered */ }
    showUsage();
  }
  async function showUsage() {
    try {
      const est = await navigator.storage?.estimate?.();
      const kept = await navigator.storage?.persisted?.();
      usage.textContent = est ? `${sizeText(est.usage || 0)} used of ${sizeText(est.quota || 0)} this browser allows` +
        (kept ? " · protected from automatic cleanup" : " · the browser may clear it when space runs low") : "";
    } catch { usage.textContent = ""; }
  }

  async function render() {
    let items;
    try { items = await lib.store.list(); } catch (error) { say(`Library unavailable: ${error.message}`, true); return; }
    const total = items.reduce((s, m) => s + (m.size || 0), 0);
    count.textContent = items.length ? `· ${items.length} · ${sizeText(total)}` : "· empty";
    const kept = new Set(items.filter((m) => m.kind === "catalog").map((m) => m.catalogId));
    app.markOffline?.(kept);
    list.replaceChildren(...items.map((m) => {
      const play = el("button", { type: "button", textContent: "Play" });
      play.setAttribute("aria-label", `Play ${m.name}`);
      play.addEventListener("click", async () => {
        if (m.kind === "catalog") app.selectFirmware(m.catalogId);
        else app.openBytes(`${m.name}.fwsc`, await lib.store.bytes(m.key));
      });
      const save = el("button", { type: "button", textContent: "Save file" });
      save.setAttribute("aria-label", `Save ${m.name} as a .fwsc file`);
      save.addEventListener("click", async () => {
        const blob = new Blob([await lib.store.bytes(m.key)], { type: "application/octet-stream" });
        const a = el("a", { href: URL.createObjectURL(blob), download: `${m.name.replace(/[^\w.-]+/g, "_")}.fwsc` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      });
      const del = el("button", { type: "button", textContent: "Delete", className: "danger" });
      del.setAttribute("aria-label", `Delete ${m.name} from the library`);
      del.addEventListener("click", async () => {
        if (!confirm(`Delete ${m.name} from the library? Its saved settings and patches are kept.`)) return;
        await lib.remove(m.key);
      });
      const what = [m.version, m.kind === "catalog" ? "catalog" : m.kind === "url" ? "from a URL" : "your file", sizeText(m.size)].filter(Boolean).join(" · ");
      return el("li", {}, el("div", { className: "lib-item" }, el("b", {}, m.name), el("span", { className: "dim" }, what)),
        el("div", { className: "lib-acts" }, play, save, del));
    }));
    showUsage();
  }
  lib.onChange(render);
  render();
  return { render };
}
