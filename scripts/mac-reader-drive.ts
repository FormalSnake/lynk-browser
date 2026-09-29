#!/usr/bin/env bun
// Reading mode (⇧⌘R) and floating video (⇧⌘P) on the real engine, macOS.
//
//   ND_HOST_BINARY=<NDShellDev.app/Contents/MacOS/NDShell> bun scripts/mac-reader-drive.ts
//
// The chords are sent as key events to the window, so they take the same road
// a keystroke does: the page has the keyboard, and Chromium would answer
// ⇧⌘R with a hard reload if the app's declared accelerator did not pre-empt it.
// A marker set in the page before the chord proves no reload happened.
//
// Reader legs run on three real pages (news, blog, docs), each captured in
// light and dark at the window's normal width and at a narrow one. Dark is set
// on the reader directly, the call the app makes on an appearance change: the
// drive does not flip the owner's system appearance. The float leg opens a
// window of its own in Calculator (a fresh instance, killed by pid) and
// captures the floating video over it.
//
// Needs an unlocked session, Screen Recording for tools/ndshot, and the mac
// CEF gate lock (it launches CEF). Captures land in screenshots/reader-*.png.
// Marker: NB_READER_OK.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp } from "@nativedesktop/test";

import { NDSHOT, SHOTS, fail, ndshotWindows, step, walk } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
const bundled = process.env.ND_HOST_BINARY ?? fail("set ND_HOST_BINARY to a bundled CEF host");
const RUN = mkdtempSync(join(tmpdir(), "nb-reader-"));
// Page state is read over CDP: the automation socket's webviewEval does not
// reach a Chromium view on AppKit. launchApp passes no arguments, so the port
// rides a wrapper that execs the host (same pid, same bundle path).
const CDP_PORT = Number(process.env.ND_CEF_DEBUG_PORT ?? 9481);
const hostBinary = join(RUN, "host.sh");
// app.cursor runs the same binary with --nd-input, which must not get the port.
writeFileSync(
  hostBinary,
  `#!/bin/sh\ncase "$1" in --nd-*) exec "${bundled}" "$@" ;; esac\nexec "${bundled}" --remote-debugging-port=${CDP_PORT} "$@"\n`,
);
chmodSync(hostBinary, 0o755);
mkdirSync(SHOTS, { recursive: true });

const VIDEO = resolve(process.env.NB_VIDEO_FIXTURE ?? join(RUN, "clip.webm"));
if (!process.env.NB_VIDEO_FIXTURE) {
  const made = Bun.spawnSync([
    "ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-t", "20", "-c:v", "libvpx-vp9", "-b:v", "1M", "-deadline", "realtime", VIDEO,
  ]);
  if (made.exitCode !== 0) fail(`ffmpeg could not make the video fixture: ${made.stderr.toString()}`);
}
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/clip.webm") return new Response(Bun.file(VIDEO));
    return new Response(
      '<!doctype html><html><head><meta charset="utf-8"><title>Video fixture</title></head>' +
        '<body style="margin:0;font:16px system-ui"><h1>A page with a video</h1>' +
        '<video src="/clip.webm" autoplay muted loop controls width="640"></video></body></html>',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});

const PAGES: { name: string; url: string; pick?: string }[] = [
  // The front is only a way in: the article itself is whatever leads it today.
  { name: "news", url: "https://www.theguardian.com/world", pick: "/\\/\\d{4}\\/[a-z]{3}\\/\\d{2}\\//" },
  { name: "blog", url: "https://www.paulgraham.com/greatwork.html" },
  { name: "docs", url: "https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestPictureInPicture" },
];

// A fresh profile starts on the new-tab page, which has no page to drive: the
// tab starts on the fixture instead.
mkdirSync(join(RUN, "store"), { recursive: true });
writeFileSync(
  join(RUN, "store", "settings.json"),
  JSON.stringify({ version: 1, data: { restoreOnLaunch: false, homepage: `http://127.0.0.1:${server.port}/start` } }),
);

const lines: string[] = [];
const app = await launchApp({
  entry: "src/main.tsx",
  backend: "appkit",
  cwd: ROOT,
  hostBinary,
  env: {
    NB_STORE_DIR: join(RUN, "store"),
    NB_TEST_HOOKS: "1",
    ND_WEBVIEW_ENGINE: "chromium",
    ND_CEF_STYLE: "chrome",
    ND_CEF_CACHE: join(RUN, "cef"),
    ND_APP_ID: "dev.nativebrowser.readerdrive",
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => {
    lines.push(line);
  },
});

// ---- CDP against the tab's page ------------------------------------------------

interface Target { type: string; url: string; webSocketDebuggerUrl: string }
let socket: WebSocket | null = null;
let seq = 0;
const waiting = new Map<number, (m: { result?: { result?: { value?: unknown } } }) => void>();
async function connectPage(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Target[];
      // The tab, not the registry view on chrome://extensions.
      const t = list.find((x) => x.type === "page" && !x.url.startsWith("chrome"));
      if (t) {
        socket = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => (socket!.onopen = r));
        socket.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          waiting.get(m.id)?.(m);
          waiting.delete(m.id);
        };
        return;
      }
    } catch {}
    await Bun.sleep(200);
  }
  fail("no page target over CDP");
}
async function evalPage(expression: string): Promise<string> {
  const id = ++seq;
  const answer = new Promise<{ result?: { result?: { value?: unknown } } }>((r) => waiting.set(id, r));
  socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  // A navigation can swallow the answer to the call that started it.
  const m = await Promise.race([answer, Bun.sleep(15_000).then(() => ({ result: { result: { value: "(timeout)" } } }))]);
  return String(m.result?.result?.value ?? "");
}
async function load(url: string): Promise<string> {
  await evalPage(`location.href = ${JSON.stringify(url)}`);
  const want = url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
  for (let i = 0; i < 150; i++) {
    await Bun.sleep(200);
    const at = await evalPage("document.readyState + ' ' + location.href");
    if (at.startsWith("complete") && at.includes(want)) break;
  }
  await Bun.sleep(2500);
  return evalPage("location.href");
}

/// Set before the toggle: the reader's shadow root is closed, so the drive
/// keeps the roots the page makes to measure the reader's type.
const CATCH_ROOTS = `(() => {
  if (window.__nbRoots) return "ok";
  window.__nbRoots = [];
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { const r = attach.call(this, init); window.__nbRoots.push(r); return r; };
  return "ok";
})()`;
const METRICS = `(() => {
  const r = window.__ndReader && window.__nbRoots.find((x) => x.host === window.__ndReader.host);
  if (!r) return "{}";
  const scroll = r.querySelector(".scroll");
  const main = r.querySelector("main");
  const p = [...r.querySelectorAll("article p")].find((x) => x.innerText.trim().length > 80);
  const cs = p ? getComputedStyle(p) : null;
  const ms = getComputedStyle(main);
  const inner = main.clientWidth - parseFloat(ms.paddingLeft) - parseFloat(ms.paddingRight);
  return JSON.stringify({
    chars: r.querySelector("article").innerText.length,
    title: r.querySelector("h1.title").innerText,
    fontSize: cs ? parseFloat(cs.fontSize) : 0,
    lineHeight: cs ? parseFloat(cs.lineHeight) : 0,
    measure: cs ? inner / parseFloat(cs.fontSize) : 0,
    ink: cs ? cs.color : "",
    ground: getComputedStyle(scroll).backgroundColor,
    overflowX: scroll.scrollWidth - scroll.clientWidth,
    indent: p ? Math.round(p.getBoundingClientRect().left - r.querySelector("h1.title").getBoundingClientRect().left) : 0,
    chain: p ? (() => { const out = []; for (let e = p; e && e.localName !== "article"; e = e.parentElement) out.push(e.localName); return out.join("<"); })() : "",
  });
})()`;
/// Content extracted and set to read: a real article's worth of words, body
/// text at 17 px or more with 1.5 line spacing or more, lines no longer than
/// about 75 characters, and nothing wider than the window.
function readable(what: string, raw: string): void {
  const m = JSON.parse(raw) as { chars?: number; title?: string; fontSize?: number; lineHeight?: number; measure?: number; overflowX?: number; indent?: number; ink?: string; ground?: string };
  console.log(`  ${what}: ${raw}`);
  if (!m.chars || m.chars < 1500) fail(`${what}: only ${m.chars ?? 0} characters extracted`);
  if (!m.title) fail(`${what}: no title`);
  if ((m.fontSize ?? 0) < 17) fail(`${what}: body text is ${m.fontSize} px`);
  if ((m.lineHeight ?? 0) / (m.fontSize ?? 1) < 1.5) fail(`${what}: line height ${m.lineHeight} on ${m.fontSize} px`);
  if ((m.measure ?? 99) > 40) fail(`${what}: lines are ${m.measure?.toFixed(1)} em wide`);
  if ((m.overflowX ?? 1) > 0) fail(`${what}: ${m.overflowX} px wider than the window`);
  if (Math.abs(m.indent ?? 0) > 1) fail(`${what}: body text sits ${m.indent} px off the title's edge`);
}

let calculator = 0;
try {
  const page = await step("find the tab's page", async () => {
    const deadline = Date.now() + PATIENCE;
    for (;;) {
      let id = "";
      walk((await app.tree()).root, (n) => {
        if (!id && typeof n.testID === "string" && /^page-t\d+$/.test(n.testID)) id = n.testID;
      });
      if (id) return id;
      if (Date.now() > deadline) fail("no page view in the tree");
      await Bun.sleep(250);
    }
  });
  const tab = page.slice("page-".length);
  await connectPage();
  const mainWindow = (): number => ndshotWindows(app.pid)[0]?.windowID ?? fail("no window on screen");
  const capture = (name: string, windowID = mainWindow()): void => {
    const out = `${SHOTS}/${name}.png`;
    const shot = Bun.spawnSync(["timeout", "30", NDSHOT, "capture", "--out", out, "--window-id", String(windowID), "--region"]);
    if (shot.exitCode !== 0) fail(`capture ${name}: ${shot.stderr.toString().trim()}`);
    console.log(`  capture ${name}.png`);
  };
  /// The next answer the app logged under `prefix`, one per chord.
  const seen = new Map<string, number>();
  const marker = async (prefix: string): Promise<string> => {
    const deadline = Date.now() + PATIENCE;
    for (;;) {
      const hits = lines.filter((l) => l.includes(prefix));
      const had = seen.get(prefix) ?? 0;
      if (hits.length > had) {
        seen.set(prefix, had + 1);
        return hits[had]!.trim().split(/\s+/).pop()!;
      }
      if (Date.now() > deadline) fail(`no ${prefix.trim()} answer`);
      await Bun.sleep(100);
    }
  };
  await app.setWindowSize(1280, 860);
  /// A real keystroke: System Events posts it to the frontmost app, which is
  /// the road a person's key takes (the page has the keyboard, and Chromium
  /// answers ⇧⌘R itself unless the app's menu gets it first).
  const chord = (letter: string): void => {
    const script =
      `tell application "System Events"\n` +
      `  set frontmost of (first process whose unix id is ${app.pid}) to true\n` +
      `  delay 0.3\n` +
      `  keystroke "${letter}" using {command down, shift down}\n` +
      `end tell`;
    const out = Bun.spawnSync(["osascript", "-e", script]);
    if (out.exitCode !== 0) fail(`osascript: ${out.stderr.toString().trim()}`);
  };

  const key = (code: number): void => {
    const script =
      `tell application "System Events"\n` +
      `  set frontmost of (first process whose unix id is ${app.pid}) to true\n` +
      `  delay 0.3\n` +
      `  key code ${code}\n` +
      `end tell`;
    const out = Bun.spawnSync(["osascript", "-e", script]);
    if (out.exitCode !== 0) fail(`osascript: ${out.stderr.toString().trim()}`);
  };
  /// ⌘K, the words, Return: the command bar runs its top row.
  const viaBar = (words: string): void => {
    const script =
      `tell application "System Events"\n` +
      `  set frontmost of (first process whose unix id is ${app.pid}) to true\n` +
      `  delay 0.3\n` +
      `  keystroke "k" using {command down}\n` +
      `  delay 0.6\n` +
      `  keystroke "${words}"\n` +
      `  delay 0.6\n` +
      `  key code 36\n` +
      `end tell`;
    const out = Bun.spawnSync(["osascript", "-e", script]);
    if (out.exitCode !== 0) fail(`osascript: ${out.stderr.toString().trim()}`);
  };

  /// NB_READER_LEGS=float runs the floating-video leg alone.
  const legs = process.env.NB_READER_LEGS ?? "reader,float";
  const only = process.env.NB_READER_PAGES;
  for (const p of legs.includes("reader") ? PAGES.filter((x) => !only || only.includes(x.name) || x === PAGES[0]) : []) {
    let url = await load(p.url);
    if (p.pick) {
      const href = await evalPage(
        `[...document.querySelectorAll("a[href]")].map((a) => a.href).find((h) => ${p.pick}.test(h) && !/\\/live\\//.test(h)) || ""`,
      );
      if (!href) fail(`${p.name}: no article link on ${p.url}`);
      url = await load(href);
    }
    await evalPage("window.__nbMarker = 1");
    await evalPage(CATCH_ROOTS);
    await evalPage("window.__nbKeys = []; window.addEventListener('keydown', (e) => window.__nbKeys.push(e.key), true); 'ok'");
    // The command bar reaches the same toggle as the chord: the first page
    // goes in through it.
    if (p === PAGES[0]) viaBar("reading mode");
    else chord("r");
    const on = await marker(`ND_APP READER ${tab}`);
    if (on !== "on") fail(`${p.name}: reader answered ${on} on ${url}`);
    if ((await evalPage("String(window.__nbMarker)")) !== "1") fail(`${p.name}: the chord reloaded the page`);
    if ((await evalPage("location.href")) !== url) fail(`${p.name}: the address changed under the reader`);
    await Bun.sleep(1200);
    readable(p.name, await evalPage(METRICS));
    await evalPage(`window.__ndReader && (window.__ndReader.host.dataset.scheme = "light")`);
    await Bun.sleep(300);
    capture(`reader-${p.name}-light`);
    await evalPage(`window.__ndReader.host.dataset.scheme = "dark"`);
    await Bun.sleep(300);
    capture(`reader-${p.name}-dark`);
    // Further in, where code blocks, figures and lists are; the reader has the
    // keyboard, so Page Down scrolls it.
    Bun.spawnSync(["osascript", "-e", 'tell application "System Events" to key code 121', "-e", 'tell application "System Events" to key code 121']);
    await Bun.sleep(400);
    capture(`reader-${p.name}-dark-further`);
    await app.setWindowSize(720, 860);
    await Bun.sleep(800);
    readable(`${p.name} at 720`, await evalPage(METRICS));
    capture(`reader-${p.name}-dark-narrow`);
    await evalPage(`window.__ndReader.host.dataset.scheme = "light"`);
    await Bun.sleep(300);
    capture(`reader-${p.name}-light-narrow`);
    await app.setWindowSize(1280, 860);
    // The chord leaves on the first page, Escape on the others; the app hears
    // of an Escape through the reader's channel.
    if (p === PAGES[0]) chord("r");
    else {
      // The toggle hands the keyboard to the reader, without a click.
      const focus = await evalPage("String(document.hasFocus())");
      if (focus !== "true") fail(`${p.name}: the page does not have the keyboard under the reader`);
      key(121);
      key(53);
      await Bun.sleep(800);
      console.log(`  keys the page saw: ${await evalPage("JSON.stringify(window.__nbKeys)")}`);
      console.log(`  after Escape the reader is ${(await evalPage("String(!!window.__ndReader)")) === "true" ? "still up" : "gone"}`);
    }
    const off = await marker(`ND_APP READER ${tab}`);
    if (off !== "off") fail(`${p.name}: leaving answered ${off}`);
    if ((await evalPage("String(!window.__ndReader && window.__nbMarker === 1)")) !== "true") {
      fail(`${p.name}: leaving the reader did not put the page back as it was`);
    }
    console.log(`NB_READER_PAGE_OK ${p.name} ${url}`);
  }

  // ---- floating video ------------------------------------------------------
  await load(`http://127.0.0.1:${server.port}/video`);
  await evalPage("document.querySelector('video').play()");
  await Bun.sleep(1000);
  const before = new Set(ndshotWindows(app.pid).map((w) => w.windowID));
  viaBar("float video");
  const floated = await marker(`ND_APP FLOAT ${tab}`);
  if (floated !== "on") fail(`float answered ${floated}`);
  await Bun.sleep(1500);
  const pip = ndshotWindows(app.pid).find((w) => !before.has(w.windowID) && w.width > 100);
  if (!pip) fail("no floating window appeared");
  console.log(`  floating window ${JSON.stringify({ app: pip.app, title: pip.title, w: pip.width, h: pip.height })}`);
  capture("float-window", pip.windowID);
  if ((await evalPage("String(!!document.pictureInPictureElement)")) !== "true") fail("the page has no floating video");

  // Moved by hand, it stays where it was put: nothing puts it back in a
  // corner, and the app window moving or the app coming forward leaves it be.
  const [win] = (await app.windows()).windows;
  const geo = win?.geometry ?? fail("the window reports no geometry");
  // Clear of the play button in the middle and the buttons in the corners.
  const grab = { x: pip.x + pip.width * 0.3 - geo.x, y: pip.y + pip.height * 0.7 - geo.y };
  const drop = { x: grab.x - 360, y: grab.y - 220 };
  console.log(`  window at ${geo.x},${geo.y}; floating window at ${pip.x},${pip.y}; grabbing ${grab.x},${grab.y} in the window`);
  await app.cursor.move(grab, { steps: 12 });
  await Bun.sleep(300);
  await app.cursor.down();
  await Bun.sleep(200);
  await app.cursor.move(drop, { steps: 30 });
  await Bun.sleep(200);
  await app.cursor.up();
  await Bun.sleep(1500);
  const moved = ndshotWindows(app.pid).find((w) => w.windowID === pip.windowID) ?? fail("the floating window went away when moved");
  const dx = moved.x - pip.x;
  const dy = moved.y - pip.y;
  if (Math.abs(dx + 360) > 40 || Math.abs(dy + 220) > 40) fail(`the drag moved it by ${dx},${dy}, not -360,-220`);
  await app.setWindowSize(1100, 800);
  await Bun.sleep(1500);
  const kept = ndshotWindows(app.pid).find((w) => w.windowID === pip.windowID);
  console.log(`  moved ${pip.x},${pip.y} -> ${moved.x},${moved.y}; after the app window resized ${kept?.x},${kept?.y}`);
  if (!kept || Math.abs(kept.x - moved.x) > 2 || Math.abs(kept.y - moved.y) > 2) fail(`it did not stay where it was put: ${JSON.stringify(kept)}`);
  await app.setWindowSize(1280, 860);
  capture("float-moved", pip.windowID);

  const calc = Bun.spawn(["/System/Applications/Calculator.app/Contents/MacOS/Calculator"], { stdout: "ignore", stderr: "ignore" });
  calculator = calc.pid;
  await Bun.sleep(2500);
  Bun.spawnSync(["osascript", "-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${calculator}) to true`]);
  await Bun.sleep(1000);
  const still = ndshotWindows(app.pid).find((w) => w.windowID === pip.windowID);
  if (!still?.onScreen) fail("the floating window left the screen when another app came forward");
  const shot = Bun.spawnSync([
    "timeout", "30", NDSHOT, "capture", "--out", `${SHOTS}/float-over-other-app.png`, "--window-id", String(pip.windowID), "--region", "--no-focus",
  ]);
  if (shot.exitCode !== 0) fail(`capture over another app: ${shot.stderr.toString().trim()}`);
  console.log("  capture float-over-other-app.png");

  // Back to the app the way a person gets there, a click on its window
  // (the page's empty top right, clear of the floating video).
  const [again] = (await app.windows()).windows;
  const at = again?.geometry ?? fail("the window reports no geometry");
  await app.cursor.click({ x: at.w - 40, y: 120 });
  await Bun.sleep(500);
  // Through the bar, not the chord: a global shortcut on the test Mac takes
  // ⇧⌘P before any keyDown reaches the app.
  viaBar("float video");
  const back = await marker(`ND_APP FLOAT ${tab}`);
  if (back !== "off") fail(`second float chord answered ${back}`);
  await Bun.sleep(1200);
  const left = ndshotWindows(app.pid).filter((w) => !before.has(w.windowID) && w.width > 100);
  if (left.length > 0) fail(`windows left behind after the video came back: ${JSON.stringify(left)}`);
  const inPage = await evalPage(
    "(() => { const v = document.querySelector('video'); const r = v.getBoundingClientRect(); return String(!document.pictureInPictureElement && v.isConnected && r.width > 100 && r.height > 50); })()",
  );
  if (inPage !== "true") fail("the video is not back in the page");
  capture("float-back-in-page");
  console.log("NB_FLOAT_OK");
  console.log("NB_READER_OK");
} finally {
  if (calculator) process.kill(calculator, "SIGKILL");
  await app.close().catch(() => {});
  server.stop(true);
}
