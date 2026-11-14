# FM-1 Emulator as an installable app (PWA)

This fork adds an installable, offline version of the emulator's page, with a ROM library and
layouts for an Akai MPK and a Novation Launchpad X. The emulator itself is unchanged.

## Put it online (GitHub Pages)

1. Fork `joakimeriksson/fm1-emu` on GitHub, then clone your fork.
2. `git am fm1-pwa.patch` (or copy the files in), commit and push to `master`.
3. In the fork go to **Settings → Pages → Source: GitHub Actions**, then **Actions → enable**.
   The existing "Test and deploy" workflow builds the wasm and publishes the site to
   `https://<you>.github.io/fm1-emu/`.
   (The fork also has the upstream Catalog, Plugin and Release workflows. Disable them under
   Actions if you don't want them to run.)

Or host the prebuilt `site/` folder from `fm1-pwa-site.zip` on any HTTPS static server
(nginx or Caddy in your homelab, Cloudflare Pages…). The iPad needs **HTTPS** to install a PWA.

## Install on the iPad

Open the URL in Safari → **Share → Add to Home Screen**. The app then opens full screen. After
the first visit it starts without a network.

## ROM library (sidebar)

- **Keep every firmware I play** (on by default): each package downloaded is kept in the browser
  (IndexedDB), and catalog cards show *offline ✓*.
- **Download all for offline**: fetches every catalog firmware, 3 at a time (stoppable).
- **Add by URL**: a `.fwsc` link, a GitHub `blob` link (made raw), or an installer page that links
  a `.fwsc`. Sites that block cross-site downloads need the optional CORS proxy prefix.
- **Add files…**: `.fwsc` files from the device. M-VAVE's own `FM-1.fwsc` goes in this way.
- Each entry: **Play**, **Save file** (to flash a real FM-1), **Delete**. Settings and patches
  saved by a firmware live in the emulator's own saves and survive deleting the ROM.
- The app asks the browser for persistent storage, so the library isn't evicted when space runs low.

## Controllers (sidebar → "Connect MIDI controllers")

Needs Web MIDI: Chrome or Edge on macOS, Windows, Linux, ChromeOS or Android. **No iPad browser has
Web MIDI** (WebKit has never shipped it). On iPad, use a Web-MIDI-capable browser app, or wrap the
site in a native shell. The MIDI code uses the standard `navigator.requestMIDIAccess`, so it works
unchanged wherever that exists.

Recognised controllers are taken out of the "MIDI in" picker and mapped:

**Akai MPK (mini MK3 factory program)**
- K1–K4 → KNOB1–4. K5 → SELECT, K6 → PRESETS, K7 → ALGORITHM, K8 → MASTER.
- Pads bank A: PLAY REC SEQ ARP (bottom) / OCT− OCT+ HOME SAVE (top).
- Pads bank B: FX SCL ENV LFO / EDIT GLO SELECT◀ SELECT▶.
- Keys, joystick and sustain go to the MIDI IN jack.

**Launchpad X** (programmer mode, set automatically; allow SysEx when Chrome asks)
- Rows 1–4: two octaves of piano. Pads show the FM-1's key LEDs, such as sequencer steps.
- Row 5: each encoder one step left, plus MASTER down. Row 6: one step right, plus MASTER up.
  Hold a pad to repeat.
- Row 7: HOME SAVE ARP SEQ PLAY REC OCT− OCT+. Row 8: FX SCL ENV LFO EDIT GLO, then a jack / keys toggle.
- Top row ▲ ▼: octave. ◀ ▶: SELECT. Buttons light up like the FM-1's own LEDs.
- The pad returns to Live mode when the page closes.

Per controller, you can set:
- **Notes play**: the MIDI IN jack (velocity, any range), or the FM-1's own keys (F3–G5). Use the
  keys for firmwares that ignore MIDI notes (X0X, Hortator…).
- **Relative knobs**: for encoders set to send relative values.
- **MIDI learn**: bind any CC or note to any encoder, button, MASTER or octave.

## iPad tuning

- The panel redraws at most ~60 fps instead of the screen's 120 Hz.
- The worklet code is loaded from the page's cache, so audio starts offline.
- The audio session is set to "playback", and the screen stays awake while the synth runs.
- There is no zoom, text selection or callout on the synth, and the layout respects safe areas.
- The emulator's own monitor still offers a lower clock or a bigger audio buffer if the sound
  breaks up. If it does, try 80 MHz first.

## Files

`web/pwa.js`, `web/library.js`, `web/controllers.js`, `web/pwa.css`, `web/sw.js`,
`web/manifest.webmanifest`, `web/icons/`, with tests in `web/library.test.mjs` and
`web/controllers.test.mjs`. There are small hooks in `web/main.js` (marked `(PWA)`),
`web/index.html` and `web/build.sh`. `tools/pwa_e2e.mjs` is a headless Chrome check with fake
MIDI devices.
