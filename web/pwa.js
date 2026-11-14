// The installable app around the emulator's page: the service worker (offline), the ROM library
// and controller panels in the sidebar, and what an iPad needs (audio session, screen kept on,
// an install hint, no stray zooming). Loaded before main.js, so the library is there when main.js
// first asks it for a package; the panels wait for main.js's "fm1-ready".
import { createLibrary, mountLibrary } from "./library.js";
import { createControllers, mountControllers } from "./controllers.js";

const $ = (id) => document.getElementById(id);
const setting = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const STANDALONE = matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches || navigator.standalone === true;
document.documentElement.toggleAttribute("data-standalone", STANDALONE);
document.documentElement.toggleAttribute("data-ios", IOS);

// ---------------------------------------------------------------- high contrast (on unless turned off)
const contrast = () => document.documentElement.dataset.contrast = setting("fm1pwa.contrast", "high");
contrast();

// ---------------------------------------------------------------- audio on iOS
// "playback": the synth sounds with the ring / silent switch off and is not ducked like a game
try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* older Safari */ }

// ---------------------------------------------------------------- the library and controllers, for main.js
const library = globalThis.fm1Library = createLibrary();
// main.js's controls through a proxy: fm1App exists once main.js has run
const app = new Proxy({}, { get: (_, k) => globalThis.fm1App?.[k] });
const controllers = globalThis.fm1Controllers = createControllers(app);

function ready() {
  const a = globalThis.fm1App;
  // catalog cards of firmwares kept in the library get an "offline" badge
  a.markOffline = (kept) => {
    for (const [id, card] of a.cards) {
      const has = kept.has(id);
      card.classList.toggle("kept", has);
      let badge = card.querySelector(".kept-badge");
      if (has && !badge) {
        badge = Object.assign(document.createElement("span"), { className: "kept-badge", textContent: "offline ✓" });
        card.querySelector(".head")?.insertBefore(badge, card.querySelector(".head button"));
      } else if (!has && badge) badge.remove();
    }
  };
  a.midiActivity = () => {
    const act = $("midiact");
    if (!act) return;
    act.classList.add("on");
    clearTimeout(a._act);
    a._act = setTimeout(() => act.classList.remove("on"), 120);
  };
  mountLibrary(a, library, $("lib-box"));
  mountControllers(a, controllers, $("ctl-box"));
  if (setting("fm1pwa.midi", "") === "1" && controllers.supported) controllers.open();
  // the button sets the flag: the next visit connects at once
  $("ctl-box").addEventListener("click", (e) => { if (e.target.closest("button.primary")) set("fm1pwa.midi", "1"); });

  // a .fwsc opened with the installed app (desktop Chrome's file handling)
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (params) => {
      for (const handle of params.files || []) {
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        try { await library.addBytes(file.name.replace(/\.fwsc$/i, ""), bytes); } catch { /* not a package: main.js says so */ }
        a.openBytes(file.name, bytes);
      }
    });
  }
}
if (globalThis.fm1App) ready(); else addEventListener("fm1-ready", ready, { once: true });

// ---------------------------------------------------------------- the screen stays on while the synth runs
let lock = null;
async function keepAwake() {
  if (!("wakeLock" in navigator) || lock || document.visibilityState !== "visible" || !globalThis.fm1App?.running) return;
  try {
    lock = await navigator.wakeLock.request("screen");
    lock.addEventListener("release", () => { lock = null; });
  } catch { /* not allowed now: the next touch tries again */ }
}
addEventListener("pointerup", keepAwake, { passive: true });
addEventListener("keyup", keepAwake, { passive: true });
document.addEventListener("visibilitychange", keepAwake);
setInterval(keepAwake, 5000);

// ---------------------------------------------------------------- iOS: no double-tap zoom or long-press menus on the synth
document.addEventListener("dblclick", (e) => { if (e.target.closest(".stage")) e.preventDefault(); }, { passive: false });
document.addEventListener("gesturestart", (e) => { if (e.target.closest?.(".stage")) e.preventDefault(); }, { passive: false });
document.addEventListener("contextmenu", (e) => { if (e.target.closest(".stage")) e.preventDefault(); });

// ---------------------------------------------------------------- the toolbar: install, contrast, online
{
  const bar = $("pwa-bar");
  const hint = $("pwa-install");
  let deferred = null;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    hint.hidden = false;
    hint.querySelector("span").textContent = "Install this app for offline play.";
    hint.querySelector("button").hidden = false;
  });
  hint.querySelector("button").addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    hint.hidden = true;
  });
  if (IOS && !STANDALONE && setting("fm1pwa.hint", "") !== "no") {
    hint.hidden = false;
    hint.querySelector("span").textContent = "To install on iPad: tap Share, then “Add to Home Screen”. The app then opens full screen and works offline.";
  }
  hint.querySelector(".close").addEventListener("click", () => { hint.hidden = true; set("fm1pwa.hint", "no"); });

  const hc = $("pwa-contrast");
  hc.checked = setting("fm1pwa.contrast", "high") === "high";
  hc.addEventListener("change", () => { set("fm1pwa.contrast", hc.checked ? "high" : "normal"); contrast(); });

  const net = $("pwa-net");
  const online = () => {
    net.textContent = navigator.onLine ? "online" : "offline: kept firmwares only";
    net.dataset.off = String(!navigator.onLine);
  };
  addEventListener("online", online);
  addEventListener("offline", online);
  online();
  bar.hidden = false;
}

// ---------------------------------------------------------------- the service worker, and its updates
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      const offer = (worker) => {
        const box = $("pwa-update");
        box.hidden = false;
        box.querySelector("button").onclick = () => { wanted = true; worker.postMessage("skip-waiting"); };
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offer(w); });
      });
      // (only after "Reload": the first visit's worker taking over must not reload a playing synth)
      let reloading = false, wanted = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloading || !wanted) return;
        reloading = true;
        location.reload();
      });
      // a long-open app looks for a new version now and then
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    } catch { /* no offline copy: the page still works online */ }
  });
}
