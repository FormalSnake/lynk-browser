#!/usr/bin/env bun
// Reading mode (Ctrl+Shift+R) and floating video (Ctrl+Shift+P) on Linux,
// run as a drive inside the framework's real-app rigs:
//
//   ND_APP_DIR=<this app> ND_ACCEPT_RIGS=x11 \
//     ND_ACCEPT_DRIVE=<path from the framework to this file> \
//     scripts/headless-app-chrome.sh           (in the framework, nix develop)
//
// Chords are real X key events (XTEST) aimed at the page, so they take the road
// a keystroke takes: Chromium's hard reload answers Ctrl+Shift+R unless the
// app's declared accelerator pre-empts it, and a marker set in the page before
// the chord proves no reload happened. Page state is read over CDP, the app's
// answers from the host log, and captures are of the whole screen, so the
// floating window is judged where the compositor put it. The float leg starts
// a second X client (a plain GTK window) and raises it, and the floating video
// has to stay above it. Marker: ND_APP_CHROME_LEGS_OK(<rig>).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rig = process.env.ND_ACCEPT_RIG ?? "x11";
const shots = process.env.ND_ACCEPT_SHOTS ?? "/tmp/nb-reader-shots";
const hostLog = process.env.ND_ACCEPT_HOST_LOG ?? "";
const cdpPort = process.env.ND_CDP_PORT ?? "9555";
mkdirSync(shots, { recursive: true });
let failed = 0;

/// Bounded: `xdotool mousemove --sync` waits for a motion event that a
/// headless Hyprland sometimes never sends.
function sh(...argv: string[]): string {
  const out = Bun.spawnSync(["timeout", "10", ...argv], { env: process.env as Record<string, string> });
  return out.stdout.toString().trim();
}
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${name}: ${ok ? "ok" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}
function capture(name: string): void {
  const path = join(shots, `${name}.png`);
  if (rig === "x11") sh("import", "-window", "root", path);
  else sh("grim", path);
  console.log(`  capture ${path}`);
}

// ---- CDP against the one page target ------------------------------------------

interface Target { type: string; url: string; webSocketDebuggerUrl: string }
let socket: WebSocket | null = null;
let seq = 0;
const waiting = new Map<number, (m: { result?: { result?: { value?: unknown } }; error?: unknown }) => void>();
async function connectPage(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as Target[];
    // The shown tab: the rig's second tab is the fixture with ?two, and the
    // registry and probe views are on chrome:// and extension pages.
    const t = list.find((x) => x.type === "page" && /^https?:/.test(x.url) && !x.url.endsWith("?two"));
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
    await Bun.sleep(200);
  }
  throw new Error("no page target over CDP");
}
async function evalPage(expression: string, retried = false): Promise<string> {
  const id = ++seq;
  const answer = new Promise<{ result?: { result?: { value?: unknown } } }>((r) => waiting.set(id, r));
  socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  // A navigation can swallow the answer to the call that started it.
  const m = await Promise.race([answer, Bun.sleep(15_000).then(() => null)]);
  if (m) return String(m.result?.result?.value ?? "");
  // A session that stops answering (seen on the Hyprland rig, the page still
  // live) is dropped and made again.
  if (retried) return "(timeout)";
  console.log("  (CDP session went quiet, reconnecting)");
  socket?.close();
  await connectPage();
  return evalPage(expression, true);
}
async function load(url: string): Promise<string> {
  await evalPage(`location.href = ${JSON.stringify(url)}`);
  const want = url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    try {
      const at = await evalPage("document.readyState + ' ' + location.href");
      if (at.startsWith("complete") && at.includes(want)) break;
    } catch {}
  }
  await Bun.sleep(2500);
  return evalPage("location.href");
}

// ---- the app's answers, from its log -------------------------------------------

const seen = new Map<string, number>();
async function answer(prefix: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const hits = readFileSync(hostLog, "utf8").split("\n").filter((l) => l.includes(prefix));
    const had = seen.get(prefix) ?? 0;
    if (hits.length > had) {
      seen.set(prefix, had + 1);
      return hits[had]!.trim().split(/\s+/).pop()!;
    }
    await Bun.sleep(100);
  }
  return "(no answer)";
}

// ---- windows and input ---------------------------------------------------------

interface Win { id: string; x: number; y: number; w: number; h: number; name: string; cls: string }
function windowsOf(pid: string): Win[] {
  const out: Win[] = [];
  for (const dec of sh("xdotool", "search", "--onlyvisible", "--pid", pid, "").split("\n").filter(Boolean)) {
    const id = `0x${Number(dec).toString(16)}`;
    const info = sh("xwininfo", "-id", id);
    const n = (k: string) => Number(info.match(new RegExp(`${k}:\\s+(-?\\d+)`))?.[1] ?? 0);
    const cls = sh("xdotool", "getwindowclassname", dec);
    out.push({ id, x: n("Absolute upper-left X"), y: n("Absolute upper-left Y"), w: n("Width"), h: n("Height"), name: sh("xdotool", "getwindowname", dec), cls });
  }
  return out;
}
const hostPid = process.env.ND_ACCEPT_HOST_PID ?? "";
/// The app's toplevel: GTK names it after the binary; Chromium's own windows
/// carry the same pid and are no use here.
const toplevel = (): Win | undefined => {
  const ids = new Set(sh("xdotool", "search", "--onlyvisible", "--classname", "nd-hello").split("\n").filter(Boolean).map((d) => `0x${Number(d).toString(16)}`));
  return windowsOf(hostPid).filter((w) => ids.has(w.id)).sort((a, b) => b.w * b.h - a.w * a.h)[0];
};
const props = (id: string): string =>
  sh("xprop", "-id", id, "WM_CLASS", "WM_NAME", "_NET_WM_PID", "WM_TRANSIENT_FOR", "_NET_WM_STATE", "_NET_WM_WINDOW_TYPE").replace(/\n/g, " | ");
function focusPage(): void {
  const top = toplevel();
  if (!top) return;
  sh("xdotool", "mousemove", "--sync", String(top.x + Math.round(top.w * 0.7)), String(top.y + Math.round(top.h * 0.6)));
  sh("xdotool", "click", "1");
  Bun.sleepSync(300);
}
const key = (chord: string) => sh("xdotool", "key", "--clearmodifiers", chord);

// ---- legs ----------------------------------------------------------------------

const PAGES: { name: string; url: string; pick?: string }[] = [
  { name: "news", url: "https://www.theguardian.com/world", pick: "/\\/\\d{4}\\/[a-z]{3}\\/\\d{2}\\//" },
  { name: "blog", url: "https://www.paulgraham.com/greatwork.html" },
  { name: "docs", url: "https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestPictureInPicture" },
];

await connectPage();

/// NB_READER_LEGS=float runs the floating-video leg alone.
const legs = process.env.NB_READER_LEGS ?? "reader,float";
for (const p of legs.includes("reader") ? PAGES : []) {
  console.log(`  -- ${p.name}`);
  let url = await load(p.url);
  if (p.pick) {
    const href = await evalPage(
      `[...document.querySelectorAll("a[href]")].map((a) => a.href).find((h) => ${p.pick}.test(h) && !/\\/live\\//.test(h)) || ""`,
    );
    if (!href) { check(`${p.name}.article`, false, `no article link on ${p.url}`); continue; }
    url = await load(href);
  }
  await evalPage("window.__nbMarker = 1");
  focusPage();
  // A click on a link would navigate; the page has to still be where it was.
  if ((await evalPage("location.href")) !== url) url = await load(url);
  await evalPage("window.__nbMarker = 1");
  key("ctrl+shift+r");
  const on = await answer("ND_APP READER ");
  check(`${p.name}.readerOn`, on === "on", `${on} on ${url}`);
  check(`${p.name}.noReload`, (await evalPage("String(window.__nbMarker)")) === "1");
  check(`${p.name}.sameAddress`, (await evalPage("location.href")) === url);
  await Bun.sleep(1000);
  capture(`reader-${p.name}-light`);
  await evalPage(`window.__ndReader && (window.__ndReader.host.dataset.scheme = "dark")`);
  await Bun.sleep(300);
  capture(`reader-${p.name}-dark`);
  // Further in, where code blocks, figures and lists are; the reader has the
  // keyboard, so Page Down scrolls it.
  key("Next");
  key("Next");
  await Bun.sleep(400);
  capture(`reader-${p.name}-dark-further`);
  key("ctrl+shift+r");
  const off = await answer("ND_APP READER ");
  check(`${p.name}.readerOff`, off === "off", off);
  check(`${p.name}.pageBack`, (await evalPage("String(!window.__ndReader && window.__nbMarker === 1)")) === "true");
}

// Floating video. A local page, so the leg does not hang on a site's player.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/clip.webm") return new Response(Bun.file(process.env.NB_VIDEO_FIXTURE ?? "/tmp/nb-clip.webm"));
    return new Response(
      '<!doctype html><html><head><meta charset="utf-8"><title>Video fixture</title></head>' +
        '<body style="margin:0;font:16px sans-serif"><h1>A page with a video</h1>' +
        '<video src="/clip.webm" autoplay muted loop controls width="640"></video></body></html>',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
await load(`http://127.0.0.1:${server.port}/video`);
await evalPage("document.querySelector('video').play().then(() => 'playing')");
await Bun.sleep(800);
const before = new Set(windowsOf(hostPid).map((w) => w.id));
focusPage();
key("ctrl+shift+p");
const floated = await answer("ND_APP FLOAT ");
check("float.on", floated === "on", floated);
await Bun.sleep(1500);
check("float.pipElement", (await evalPage("String(!!document.pictureInPictureElement)")) === "true");
const added = windowsOf(hostPid).filter((w) => !before.has(w.id) && w.w > 100);
for (const w of added) console.log(`  ${w.id} ${w.x},${w.y} ${w.w}x${w.h}: ${props(w.id)}`);
for (const w of added.filter((a) => a.name !== "")) console.log(sh("xprop", "-id", w.id).split("\n").filter((l) => !/^\s|ICON|_NET_WM_OPAQUE/.test(l)).join("\n"));
console.log(`  toplevel ${toplevel()?.id}: ${props(toplevel()?.id ?? "0")}`);
console.log(`  new windows: ${JSON.stringify(added)}`);
const pip = added.find((w) => w.name !== "") ?? added[0];
check("float.window", !!pip, pip ? `${pip.w}x${pip.h} "${pip.name}" class ${pip.cls}` : "none");
// Everything on screen names the app: the floating window is the one window
// Chromium put up that a window list offers, and it has to read as ours.
const toplevelClass = sh("xprop", "-id", toplevel()?.id ?? "0", "WM_CLASS");
for (const w of added.filter((a) => a.name !== "")) {
  const cls = sh("xprop", "-id", w.id, "WM_CLASS");
  check(`float.named ${w.id} "${w.name}"`, cls === toplevelClass, `${cls} vs app ${toplevelClass}`);
}
if (rig === "hypr") {
  // Hyprland reads no keep-above hint from XWayland; the host pins the window.
  const clients = JSON.parse(sh("hyprctl", "-j", "clients")) as { pid: number; class: string; title: string; floating: boolean; pinned: boolean; size: number[] }[];
  for (const c of clients) console.log(`  hypr client ${JSON.stringify(c.class)} ${JSON.stringify(c.title)} floating=${c.floating} pinned=${c.pinned} ${c.size}`);
  const floating = clients.find((c) => String(c.pid) === hostPid && c.title === pip?.name);
  check("float.pinnedOnHyprland", !!floating?.pinned, JSON.stringify(floating ?? null));
}
if (pip) {
  // Where Chromium put it (the screen's corner), not centred on the page as a
  // dialog would be.
  const top = toplevel();
  check("float.notOverThePage", !!top && (pip.x + pip.w > top.x + top.w - 40 || pip.y + pip.h > top.y + top.h - 40), `pip ${pip.x},${pip.y} app ${top?.x},${top?.y} ${top?.w}x${top?.h}`);
}
capture("float-alone");

// Another app's window, raised over everything and focused: GTK's own demo, as
// an X client on x11 and a native Wayland one under Hyprland.
const otherApp = Bun.spawn(["gtk4-demo"], {
  stdout: "ignore",
  stderr: "ignore",
  env: { ...process.env, GDK_BACKEND: rig === "x11" ? "x11" : "wayland" } as Record<string, string>,
});
await Bun.sleep(3000);
if (rig === "hypr") {
  sh("hyprctl", "dispatch", "focuswindow", "class:org.gtk.Demo4");
  sh("hyprctl", "dispatch", "togglefloating", "class:org.gtk.Demo4");
  sh("hyprctl", "dispatch", "resizewindowpixel", "exact 1600 1000,class:org.gtk.Demo4");
  sh("hyprctl", "dispatch", "centerwindow");
} else {
  const other = sh("xdotool", "search", "--onlyvisible", "--class", "gtk4-demo").split("\n").filter(Boolean)[0];
  if (other) {
    sh("xdotool", "windowsize", other, "1800", "1150");
    sh("xdotool", "windowactivate", "--sync", other);
  }
}
await Bun.sleep(1200);
capture("float-over-other-app");
if (rig === "x11" && pip) {
  // _NET_CLIENT_LIST_STACKING runs bottom to top.
  const stack = sh("xprop", "-root", "_NET_CLIENT_LIST_STACKING");
  const ids = (stack.match(/0x[0-9a-f]+/g) ?? []).map((h) => Number(h));
  const pipAt = ids.findIndex((id) => added.some((w) => Number(w.id) === id));
  const otherAt = ids.findIndex((id) => !sh("xprop", "-id", String(id), "_NET_WM_PID").endsWith(` ${hostPid}`));
  check("float.aboveOtherApp", otherAt >= 0 && pipAt > otherAt, `stacking ${stack}`);
}
if (rig === "hypr") {
  const clients = JSON.parse(sh("hyprctl", "-j", "clients")) as { class: string; title: string; floating: boolean; pinned: boolean }[];
  for (const c of clients) console.log(`  hypr client ${JSON.stringify(c.class)} ${JSON.stringify(c.title)} floating=${c.floating} pinned=${c.pinned}`);
}
otherApp.kill();

// XTEST reaches X clients but never Hyprland itself, so a click does not
// move the compositor's focus back from the other app; its own dispatcher does.
if (rig === "hypr") sh("hyprctl", "dispatch", "focuswindow", `title:^(${toplevel()?.name ?? "Video fixture"})$`);
if (process.env.NB_READER_LEAVE_FLOAT === "1") {
  // Quit with the video still floating: the rig's quit leg is the check.
  console.log(failed === 0 ? `ND_APP_CHROME_LEGS_OK(${rig})` : `ND_APP_CHROME_LEGS_FAIL(${rig}) ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
focusPage();
key("ctrl+shift+p");
const back = await answer("ND_APP FLOAT ");
check("float.off", back === "off", back);
await Bun.sleep(1200);
// Only what the window manager manages counts: a page's own X window can come
// and go inside the app's toplevel without anything new on screen.
const managed = new Set((sh("xprop", "-root", "_NET_CLIENT_LIST").match(/0x[0-9a-f]+/g) ?? []).map((h) => Number(h)));
const left = windowsOf(hostPid).filter((w) => !before.has(w.id) && w.w > 100 && managed.has(Number(w.id)));
check("float.noneLeft", left.length === 0, JSON.stringify(left));
server.stop(true);

console.log(failed === 0 ? `ND_APP_CHROME_LEGS_OK(${rig})` : `ND_APP_CHROME_LEGS_FAIL(${rig}) ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
