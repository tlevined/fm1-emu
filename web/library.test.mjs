// The ROM library: URL handling, package checks and the IndexedDB store (fake-indexeddb in node:
// FAKE_IDB=path/to/fake-indexeddb, skipped without it). FM1_TEST_FWSC: a real package to keep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { normalizeUrl, nameFromUrl, packagesInPage, checkPackage, createLibrary, RomStore } from "./library.js";

const PKG = process.env.FM1_TEST_FWSC;
const pkg = PKG && existsSync(PKG) ? new Uint8Array(readFileSync(PKG)) : null;
const idb = process.env.FAKE_IDB ? (await import(process.env.FAKE_IDB)).indexedDB : null;

test("URLs people paste become downloadable ones", () => {
  assert.equal(normalizeUrl(" https://github.com/a/b/blob/main/dist/x.fwsc "), "https://raw.githubusercontent.com/a/b/main/dist/x.fwsc");
  assert.equal(normalizeUrl("https://github.com/a/b/raw/v1/x.fwsc"), "https://raw.githubusercontent.com/a/b/v1/x.fwsc");
  assert.equal(normalizeUrl("http://example.com/a.fwsc"), "https://example.com/a.fwsc");
  assert.equal(normalizeUrl("https://www.dropbox.com/s/k/a.fwsc?dl=0"), "https://www.dropbox.com/s/k/a.fwsc?dl=1");
  assert.throws(() => normalizeUrl("ftp://x/a.fwsc"), /https/);
  assert.throws(() => normalizeUrl("not a url"), /not a URL/);
});

test("names come from ?name= or the file", () => {
  assert.equal(nameFromUrl("https://h/x/Felucca%201.2.fwsc"), "Felucca 1.2");
  assert.equal(nameFromUrl("https://h/x/a.fwsc?name=Mine"), "Mine");
});

test("an installer page's package links are found", () => {
  const html = `<a href="dist/fw-1.0.fwsc">get</a> <script>const u = 'https://cdn.example/b.fwsc?v=2';</script> <a href="dist/fw-1.0.fwsc">again</a>`;
  assert.deepEqual(packagesInPage(html, "https://site.example/install/"),
    ["https://site.example/install/dist/fw-1.0.fwsc", "https://cdn.example/b.fwsc"]);
});

test("only real packages are accepted", { skip: !pkg && "FM1_TEST_FWSC not set" }, () => {
  assert.equal(checkPackage(pkg), pkg);
  assert.throws(() => checkPackage(new Uint8Array(4096)), /not an FM-1 update package/);
  assert.throws(() => checkPackage(new Uint8Array(10)), /too small/);
});

test("the store keeps, lists, serves and forgets packages", { skip: (!idb || !pkg) && "FAKE_IDB / FM1_TEST_FWSC not set" }, async () => {
  globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, String(v)); } };
  const lib = createLibrary(new RomStore(idb));
  const entry = { id: "sid", name: "FM-1 SID", version: "1.0", author: "J", package: "https://x/sid.fwsc" };
  assert.equal(await lib.packageFor(entry), null);
  let changes = 0;
  lib.onChange(() => changes++);
  await lib.keep(entry, { bytes: pkg, url: entry.package });
  const got = await lib.packageFor(entry);
  assert.deepEqual(got.bytes, pkg);
  assert.equal(got.url, entry.package);
  assert.equal(got.version, undefined);                      // same version: nothing to note
  assert.equal((await lib.packageFor({ ...entry, version: "0.9" })).version, "1.0");
  // not kept when switched off, unless forced (download all)
  lib.setKeepsEverything(false);
  assert.equal(await lib.keep({ ...entry, id: "other" }, { bytes: pkg }), null);
  lib.setKeepsEverything(true);
  // added by URL: a page that links the package
  const fetchFn = async (u) => u.endsWith("/page/")
    ? new Response(`<html><a href="files/sid-2.fwsc">dl</a></html>`)
    : u.endsWith("/files/sid-2.fwsc") ? new Response(pkg) : new Response("", { status: 404 });
  const added = await lib.addUrl("https://site.example/page/", { fetchFn });
  assert.equal(added.name, "sid-2");
  assert.equal(added.kind, "url");
  // through a proxy
  const seen = [];
  await lib.addUrl("https://blocked.example/a.fwsc", { proxy: "https://proxy.example/?url=", name: "P",
    fetchFn: async (u) => { seen.push(u); return new Response(pkg); } });
  assert.deepEqual(seen, ["https://proxy.example/?url=https%3A%2F%2Fblocked.example%2Fa.fwsc"]);
  await assert.rejects(lib.addUrl("https://x.example/notes.txt", { fetchFn: async () => new Response("hello there, not a package at all".repeat(40)) }),
    /not an FM-1 update package/);
  const list = await lib.store.list();
  assert.deepEqual(list.map((m) => m.kind).sort(), ["catalog", "url"]);   // the same bytes twice: one url entry
  assert.ok(changes >= 3);
  // download all: skips what is kept, reports failures
  const cat = [entry, { id: "b", name: "B", package: "https://x/b.fwsc" }, { id: "c", name: "C", package: "https://x/c.fwsc" }, { id: "m", byo: true }];
  const r = await lib.downloadAll(cat, { fetchFn: async (u) => u.endsWith("b.fwsc") ? new Response(pkg) : new Response("", { status: 404 }) });
  assert.equal(r.total, 2);
  assert.equal(r.failed.length, 1);
  assert.ok(await lib.packageFor({ id: "b" }));
  await lib.remove("cat:b");
  assert.equal(await lib.packageFor({ id: "b" }), null);
});
