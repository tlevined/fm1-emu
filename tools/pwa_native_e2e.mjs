// The page as the iOS app runs it: a fake WKWebView bridge (messageHandlers) and the real midi-shim.js
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const [url, fwsc, shimPath] = process.argv.slice(2);
const shim = readFileSync(shimPath, "utf8");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1376, height: 1032 } });
await ctx.addInitScript(() => {
  window.__posts = [];
  const h = (name) => ({ postMessage: (m) => window.__posts.push([name, JSON.parse(JSON.stringify(m))]) });
  window.webkit = { messageHandlers: { fm1midi: h("fm1midi"), fm1native: h("fm1native") } };
  window.__fm1NativeRoms = ["Already there.fwsc"];
  delete Navigator.prototype.requestMIDIAccess;
});
await ctx.addInitScript({ content: shim });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const ok = (c, w) => { console.log(`${c ? "PASS" : "FAIL"}  ${w}`); if (!c) process.exitCode = 1; };
await page.goto(url);
await page.waitForSelector("#lib-box h2");
ok(await page.evaluate(() => typeof navigator.requestMIDIAccess === "function" && !!window.fm1Native), "shim gives the page Web MIDI and fm1Native");
ok(await page.locator("#pwa-bar button", { hasText: "Bluetooth MIDI" }).isVisible(), "Bluetooth MIDI button");
ok(!(await page.locator("#pwa-install").isVisible()), "no Add to Home Screen hint in the app");
await page.locator("#pwa-bar button", { hasText: "Bluetooth MIDI" }).click();
await page.locator("#lib-box input[type=file]").setInputFiles(fwsc);
await page.waitForFunction(() => window.__posts.some(([n, m]) => n === "fm1native" && m.op === "rom"), null, { timeout: 10000 });
const posts = await page.evaluate(() => window.__posts);
const rom = posts.find(([n, m]) => m.op === "rom")[1];
ok(rom.name === "sidplayer.fwsc" && rom.data.length > 800000, `ROM shared with the plugin: ${rom.name}, ${rom.data.length} base64 chars`);
ok(posts.some(([n, m]) => n === "fm1native" && m.op === "bluetooth"), "Bluetooth request reaches the app");
// controllers through the shim
await page.locator("#ctl-box button.primary").click();
await page.waitForFunction(() => window.__posts.some(([n, m]) => n === "fm1midi" && m.op === "open"));
await page.evaluate(() => __fm1midi.ports({ inputs: [{ id: "11", name: "Launchpad X LPX MIDI Out" }, { id: "12", name: "MPK mini 3" }],
  outputs: [{ id: "21", name: "Launchpad X LPX DAW In" }, { id: "22", name: "Launchpad X LPX MIDI In" }] }));
await page.waitForSelector(".ctl-dev", { timeout: 5000 });
await page.waitForTimeout(300);
const sends = (await page.evaluate(() => window.__posts)).filter(([n, m]) => m.op === "send");
ok(sends.some(([, m]) => m.id === "22" && m.data.join() === "240,0,32,41,2,12,14,1,247"), "programmer mode sent to the Launchpad's MIDI port via CoreMIDI");
ok(sends.some(([, m]) => m.id === "22" && m.data[6] === 3), "Launchpad lights sent");
await page.locator(".lib-list li button", { hasText: "Play" }).first().click();
await page.click("#start");
await page.waitForFunction(() => /real time/.test(document.getElementById("status").textContent), null, { timeout: 30000 });
await page.evaluate(() => { window.__calls = []; const a = globalThis.fm1App; for (const k of ["setKey", "midiIn", "turn"]) { const f = a[k]; a[k] = (...x) => { window.__calls.push([k, ...x]); return f(...x); }; } });
await page.evaluate(() => __fm1midi.recv([["11", [0x90, 75, 100]], ["11", [0x90, 75, 0]], ["12", [0x90, 64, 80]], ["12", [0xb0, 70, 10]], ["12", [0xb0, 70, 14]]]));
const calls = await page.evaluate(() => window.__calls);
const has = (c) => calls.some((x) => JSON.stringify(x) === JSON.stringify(c));
ok(has(["setKey", 12, true]) && has(["setKey", 12, false]), "Launchpad PLAY via CoreMIDI bridge");
ok(has(["midiIn", [0x90, 64, 80]]), "MPK key via CoreMIDI bridge");
ok(has(["turn", 3, 2]), "MPK knob via CoreMIDI bridge");
// a device unplugged
await page.evaluate(() => __fm1midi.ports({ inputs: [{ id: "12", name: "MPK mini 3" }], outputs: [] }));
await page.waitForTimeout(200);
ok(/unplugged/.test(await page.locator("#ctl-box").textContent()), "unplugging shows in the panel");
// deleting from the library removes the shared copy
page.on("dialog", (d) => d.accept());
await page.locator(".lib-list li button", { hasText: "Delete" }).first().click();
await page.waitForFunction(() => window.__posts.some(([n, m]) => m.op === "romDelete"), null, { timeout: 5000 });
const del = (await page.evaluate(() => window.__posts)).find(([n, m]) => m.op === "romDelete")[1];
ok(del.name === "sidplayer.fwsc", "deleted from the shared folder too");
ok(!(await page.evaluate(() => window.__posts)).some(([n, m]) => m.op === "romDelete" && m.name === "Already there.fwsc"), "files the page didn't put there are left alone");
ok(errors.length === 0, "no page errors " + errors.join(" | "));
await browser.close();
