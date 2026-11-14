// End-to-end check of the PWA build in headless Chrome, with a fake Web MIDI (a Launchpad X and an
// MPK mini) and a real firmware package added from a file. Usage: node e2e.mjs SITE_URL FWSC
import { chromium } from "playwright";

const [url, fwsc] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome",
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  class Port extends EventTarget {
    constructor(id, name, type) { super(); Object.assign(this, { id, name, type, state: "connected", connection: "open", _on: null }); }
    set onmidimessage(f) { if (this._on) this.removeEventListener("midimessage", this._on); this._on = f; if (f) this.addEventListener("midimessage", f); }
    get onmidimessage() { return this._on; }
    send(d) { (window.__sent ||= []).push([this.name, Array.from(d)]); }
  }
  const inputs = new Map([["i1", new Port("i1", "Launchpad X LPX MIDI Out", "input")], ["i2", new Port("i2", "Launchpad X LPX DAW Out", "input")],
    ["i3", new Port("i3", "MPK mini 3", "input")]]);
  const outputs = new Map([["o1", new Port("o1", "Launchpad X LPX DAW In", "output")], ["o2", new Port("o2", "Launchpad X LPX MIDI In", "output")]]);
  const access = Object.assign(new EventTarget(), { inputs, outputs, sysexEnabled: true, onstatechange: null });
  navigator.requestMIDIAccess = async () => access;
  window.__midi = (name, bytes) => {
    for (const p of inputs.values()) if (p.name === name) { const e = new Event("midimessage"); e.data = new Uint8Array(bytes); p.dispatchEvent(e); }
  };
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_TUNNEL|net::/.test(m.text())) errors.push(m.text()); });
const ok = (cond, what) => { console.log(`${cond ? "PASS" : "FAIL"}  ${what}`); if (!cond) process.exitCode = 1; };

await page.goto(url);
await page.waitForSelector("#lib-box h2", { timeout: 15000 });
ok(await page.locator("#ctl-box button.primary").isVisible(), "controller panel offers to connect");
ok(await page.evaluate(() => document.documentElement.dataset.contrast) === "high", "high contrast on by default");
ok(await page.evaluate(async () => !!(await navigator.serviceWorker.ready)), "service worker registered");

// a package from a file into the library, then played
await page.locator("#lib-box input[type=file]").setInputFiles(fwsc);
await page.waitForSelector(".lib-list li", { timeout: 10000 });
ok((await page.locator(".lib-list li b").first().textContent()) === "sidplayer", "file added to the library");
await page.locator(".lib-list li button", { hasText: "Play" }).first().click();
await page.click("#start");
await page.waitForFunction(() => /real time/.test(document.getElementById("status").textContent), null, { timeout: 30000 });
ok(true, `booted: ${await page.locator("#status").textContent()}`);
await page.waitForTimeout(3000);
const status = await page.locator("#status").textContent();
ok(/\d+(\.\d)?x real time/.test(status), `running: ${status}`);

// controllers
await page.locator("#ctl-box button.primary").click();
await page.waitForSelector(".ctl-dev", { timeout: 5000 });
ok(await page.locator(".ctl-dev").count() === 2, "Launchpad X and MPK listed");
await page.waitForTimeout(300);
const sent = await page.evaluate(() => window.__sent || []);
ok(sent.some(([n, d]) => n === "Launchpad X LPX MIDI In" && d.join() === "240,0,32,41,2,12,14,1,247"), "Launchpad put in programmer mode on its MIDI port");
ok(sent.some(([n, d]) => n === "Launchpad X LPX MIDI In" && d[6] === 3 && d.length > 100), "Launchpad lit with RGB SysEx");
await page.evaluate(() => {
  window.__calls = [];
  const a = globalThis.fm1App;
  for (const k of ["setKey", "turn", "setPot", "midiIn"]) { const f = a[k]; a[k] = (...args) => { window.__calls.push([k, ...args]); return f(...args); }; }
});
await page.evaluate(() => { __midi("Launchpad X LPX MIDI Out", [0x90, 75, 100]); __midi("Launchpad X LPX MIDI Out", [0x90, 75, 0]); });
await page.evaluate(() => { __midi("Launchpad X LPX MIDI Out", [0x90, 11, 100]); __midi("Launchpad X LPX MIDI Out", [0x90, 11, 0]); });
await page.evaluate(() => { __midi("MPK mini 3", [0xb0, 70, 60]); __midi("MPK mini 3", [0xb0, 70, 66]); __midi("MPK mini 3", [0xb0, 77, 127]); });
await page.evaluate(() => { __midi("MPK mini 3", [0x99, 36, 100]); __midi("MPK mini 3", [0x89, 36, 0]); __midi("MPK mini 3", [0x90, 64, 90]); });
const calls = await page.evaluate(() => window.__calls);
const has = (c) => calls.some((x) => JSON.stringify(x) === JSON.stringify(c));
ok(has(["setKey", 12, true]) && has(["setKey", 12, false]), "Launchpad PLAY pad presses and releases PLAY");
ok(has(["midiIn", [0x90, 60, 100]]), "Launchpad piano pad plays C4 into the jack");
ok(has(["turn", 3, 3]), "MPK K1 turns KNOB1");
ok(has(["setPot", 1023]), "MPK K8 sets MASTER");
ok(has(["setKey", 12, true]), "MPK pad 1 presses PLAY");
ok(has(["midiIn", [0x90, 64, 90]]), "MPK key plays into the jack");
// the Launchpad mirrors the FM-1's PLAY LED (the firmware decides; print what it shows)
await page.screenshot({ path: "/home/claude/shot-desktop.png", fullPage: false });

// offline: the app reopens and plays the kept firmware
await context.setOffline(true);
await page.reload();
await page.waitForSelector(".lib-list li", { timeout: 15000 });
ok(await page.locator("#pwa-net").textContent() !== "online", `offline banner: ${await page.locator("#pwa-net").textContent()}`);
await page.locator(".lib-list li button", { hasText: "Play" }).first().click();
await page.click("#start");
await page.waitForFunction(() => /real time/.test(document.getElementById("status").textContent), null, { timeout: 30000 });
ok(true, `booted offline: ${await page.locator("#status").textContent()}`);

// an iPad-sized window, standalone-ish
const ipad = await browser.newContext({ viewport: { width: 1376, height: 1032 }, deviceScaleFactor: 2, hasTouch: true, isMobile: false,
  userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
await ipad.addInitScript(() => { delete Navigator.prototype.requestMIDIAccess; });
const p2 = await ipad.newPage();
await p2.goto(url);
await p2.waitForSelector("#lib-box h2", { timeout: 15000 });
ok(/no Web MIDI/.test(await p2.locator("#ctl-box").textContent()), "iPad without Web MIDI: explains it");
ok(await p2.locator("#pwa-install").isVisible(), "iPad: Add to Home Screen hint shown");
await p2.screenshot({ path: "/home/claude/shot-ipad.png" });
ok(errors.length === 0, `no page errors${errors.length ? ": " + errors.slice(0, 5).join(" | ") : ""}`);
await browser.close();
