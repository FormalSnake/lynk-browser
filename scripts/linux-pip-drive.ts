#!/usr/bin/env bun
// Picture in picture on Linux, run as a drive inside the framework's real-app
// rigs (x11 under openbox, Hyprland over XWayland):
//
//   ND_APP_DIR=<this app> ND_ACCEPT_RIGS=x11 \
//     ND_ACCEPT_DRIVE=<path from the framework to this file> \
//     scripts/headless-app-chrome.sh           (in the framework, nix develop)
//
// A page's own document window (documentPictureInPicture.requestWindow, the
// way Google Meet pops its call out) and the floating video: each opens as a
// window of the app that a window manager can be given rules for (the app's
// class, a fixed title, a utility type), stays above other apps, and goes
// away with its tab. Input is XTEST, page state is read over CDP, captures are
// of the whole screen. Marker: ND_APP_CHROME_LEGS_OK(<rig>).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rig = process.env.ND_ACCEPT_RIG ?? "x11";
const shots = process.env.ND_ACCEPT_SHOTS ?? "/tmp/nb-pip-shots";
const hostLog = process.env.ND_ACCEPT_HOST_LOG ?? "";
const cdpPort = process.env.ND_CDP_PORT ?? "9555";
const hostPid = process.env.ND_ACCEPT_HOST_PID ?? "";
const legs = (process.env.NB_PIP_LEGS ?? "document,video").split(",");
mkdirSync(shots, { recursive: true });
let failed = 0;

function sh(...argv: string[]): string {
  const out = Bun.spawnSync(["timeout", "10", ...argv], { env: process.env as Record<string, string> });
  return out.stdout.toString().trim();
}
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${name}: ${ok ? "ok" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}
function capture(name: string): void {
  const path = join(shots, `pip-${name}.png`);
  if (rig === "x11") sh("import", "-window", "root", path);
  else sh("grim", path);
  console.log(`  capture ${path}`);
}

// ---- CDP against the shown tab ---------------------------------------------------

interface Target { type: string; url: string; webSocketDebuggerUrl: string }
let socket: WebSocket | null = null;
let seq = 0;
const waiting = new Map<number, (m: { result?: { result?: { value?: unknown } } }) => void>();
async function connectPage(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as Target[];
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
async function cdp(method: string, params: Record<string, unknown>): Promise<{ result?: { result?: { value?: unknown } } } | null> {
  const id = ++seq;
  const answer = new Promise<{ result?: { result?: { value?: unknown } } }>((r) => waiting.set(id, r));
  socket!.send(JSON.stringify({ id, method, params }));
  return Promise.race([answer, Bun.sleep(15_000).then(() => null)]);
}
async function evalPage(expression: string, userGesture = false): Promise<string> {
  const m = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
  return m ? String(m.result?.result?.value ?? "") : "(timeout)";
}
async function load(url: string): Promise<void> {
  await evalPage(`location.href = ${JSON.stringify(url)}`);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    const at = await evalPage("document.readyState + ' ' + location.href");
    if (at.startsWith("complete") && at.includes(url.replace(/^http:\/\//, ""))) break;
  }
  await Bun.sleep(1200);
}
async function clickInPage(selector: string): Promise<void> {
  const box = JSON.parse(await evalPage(`JSON.stringify((r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()))`)) as [number, number];
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", clickCount: 1 });
}

// ---- the app's log ------------------------------------------------------------------

function logLines(): string[] {
  return hostLog ? readFileSync(hostLog, "utf8").split("\n") : [];
}
async function logged(pattern: RegExp, from: number, ms = 6000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = logLines().slice(from).find((l) => pattern.test(l));
    if (hit) return hit;
    await Bun.sleep(100);
  }
  return "";
}

// ---- windows --------------------------------------------------------------------------

interface Win { id: string; x: number; y: number; w: number; h: number; name: string }
function windowsOf(pid: string): Win[] {
  const out: Win[] = [];
  for (const dec of sh("xdotool", "search", "--onlyvisible", "--pid", pid, "").split("\n").filter(Boolean)) {
    const id = `0x${Number(dec).toString(16)}`;
    const info = sh("xwininfo", "-id", id);
    const n = (k: string) => Number(info.match(new RegExp(`${k}:\\s+(-?\\d+)`))?.[1] ?? 0);
    out.push({ id, x: n("Absolute upper-left X"), y: n("Absolute upper-left Y"), w: n("Width"), h: n("Height"), name: sh("xdotool", "getwindowname", dec) });
  }
  return out;
}
const managed = () => new Set((sh("xprop", "-root", "_NET_CLIENT_LIST").match(/0x[0-9a-f]+/g) ?? []).map((h) => Number(h)));
const prop = (id: string, name: string) => sh("xprop", "-id", id, name);
/// The class the app's own windows carry: any managed window of the host that
/// is not a picture-in-picture window.
function appClassName(): string {
  const ids = [...managed()].map((id) => `0x${id.toString(16)}`);
  // Hyprland keeps no _NET_CLIENT_LIST: every X window of the host will do.
  if (ids.length === 0) ids.push(...windowsOf(hostPid).map((w) => w.id));
  for (const hex of ids) {
    if (!prop(hex, "_NET_WM_PID").endsWith(` ${hostPid}`)) continue;
    const cls = prop(hex, "WM_CLASS");
    if (!cls.includes("=") || cls.includes('"picture-in-picture"')) continue;
    return cls.split("=")[1]?.split(",").at(-1)?.trim() ?? "";
  }
  return "";
}
interface HyprClient { pid: number; class: string; initialClass: string; title: string; initialTitle: string; floating: boolean; pinned: boolean; size: number[]; at: number[] }
const hyprClients = (): HyprClient[] => (rig === "hypr" ? (JSON.parse(sh("hyprctl", "-j", "clients") || "[]") as HyprClient[]) : []);

/// The picture-in-picture window that appeared since `before`: the one the
/// window manager manages (Chromium's own scaffolding is unmanaged).
async function newPip(before: Set<string>): Promise<Win | undefined> {
  for (let i = 0; i < 40; i++) {
    const list = managed();
    const found = windowsOf(hostPid).find((w) => !before.has(w.id) && w.w > 100 && list.has(Number(w.id)));
    if (found) return found;
    await Bun.sleep(200);
  }
  return undefined;
}

/// What a window rule can match on, and what keeps the window above.
function rulesFor(what: string, pip: Win): void {
  const appClass = appClassName();
  const cls = prop(pip.id, "WM_CLASS");
  const name = prop(pip.id, "_NET_WM_NAME");
  const type = prop(pip.id, "_NET_WM_WINDOW_TYPE");
  const state = prop(pip.id, "_NET_WM_STATE");
  console.log(`  ${what} ${pip.id} ${pip.x},${pip.y} ${pip.w}x${pip.h} | ${cls} | ${name} | ${type} | ${state}`);
  // Under Hyprland the app's own window is not an X client the drive can
  // read; the x11 rig holds the class to the app's, here it is only Chromium's
  // default that must be gone.
  if (rig === "hypr") check(`${what}.appClass`, /"picture-in-picture", "[^"]+"$/.test(cls) && !cls.includes("Chromium"), cls);
  else check(`${what}.appClass`, appClass !== "" && cls.endsWith(appClass), `${cls} vs ${appClass}`);
  check(`${what}.instance`, cls.includes('"picture-in-picture"'), cls);
  check(`${what}.title`, name.includes('"Picture in Picture"'), name);
  check(`${what}.utilityType`, type.includes("_NET_WM_WINDOW_TYPE_UTILITY"), type);
  if (rig === "x11") check(`${what}.above`, state.includes("_NET_WM_STATE_ABOVE"), state);
  if (rig === "hypr") {
    const c = hyprClients().find((x) => String(x.pid) === hostPid && x.title === "Picture in Picture");
    console.log(`  ${what} hypr ${JSON.stringify(c)}`);
    check(`${what}.pinnedOnHyprland`, !!c?.pinned && !!c?.floating, JSON.stringify(c ?? null));
  }
}

/// The window manager's work area, from _NET_WORKAREA.
function workArea(): { x: number; y: number; w: number; h: number } {
  const v = (sh("xprop", "-root", "_NET_WORKAREA").split("=")[1] ?? "").split(",").map((n) => Number(n.trim()));
  if (v.length >= 4 && v.every((n) => !Number.isNaN(n))) return { x: v[0]!, y: v[1]!, w: v[2]!, h: v[3]! };
  const [w, h] = sh("xdotool", "getdisplaygeometry").split(" ").map(Number);
  return { x: 0, y: 0, w: w ?? 1920, h: h ?? 1080 };
}
const MARGIN = 16;
const TAB = 28;
const near = (a: number, b: number, tol = 3) => Math.abs(a - b) <= tol;
const hostLines = (from: number) => logLines().slice(from).filter((l) => l.includes("ND_PIP"));

/// Grabs the window at (fx, fy) of its frame, carries it to the middle of the
/// screen at ~120 Hz, flicks it by `toward` over 48 ms and lets go; then waits
/// for the landing. One xdotool process, so the timing is the script's.
async function throwWindow(pip: Win, fx: number, fy: number, toward: { x: number; y: number }): Promise<Win> {
  const area = workArea();
  const from = { x: Math.round(pip.x + pip.w * fx), y: Math.round(pip.y + pip.h * fy) };
  const mid = { x: Math.round(area.x + area.w / 2), y: Math.round(area.y + area.h / 2) };
  const args = ["xdotool", "mousemove", "--sync", String(from.x), String(from.y), "mousedown", "1"];
  for (let i = 1; i <= 30; i++) {
    args.push("sleep", "0.008", "mousemove", String(Math.round(from.x + ((mid.x - from.x) * i) / 30)), String(Math.round(from.y + ((mid.y - from.y) * i) / 30)));
  }
  for (let i = 1; i <= 6; i++) {
    args.push("sleep", "0.008", "mousemove", String(Math.round(mid.x + (toward.x * i) / 6)), String(Math.round(mid.y + (toward.y * i) / 6)));
  }
  args.push("mouseup", "1");
  Bun.spawnSync(["timeout", "20", ...args], { env: process.env as Record<string, string> });
  await Bun.sleep(1500);
  return windowsOf(hostPid).find((w) => w.id === pip.id) ?? pip;
}

/// On a floating X11 manager the window lands in the corner the flick points
/// at and tucks past an edge on a push there. Under Hyprland the compositor
/// places it and the host leaves its geometry alone.
async function landings(what: string, pip: Win, grab: { fx: number; fy: number }, stashable: boolean): Promise<Win> {
  const area = workArea();
  if (rig === "hypr") {
    const before = windowsOf(hostPid).find((w) => w.id === pip.id) ?? pip;
    const mark = logLines().length;
    await throwWindow(before, grab.fx, grab.fy, { x: -160, y: -110 });
    check(`${what}.noLandingOnHyprland`, !hostLines(mark).some((l) => /settle/.test(l)), hostLines(mark).join(" | "));
    capture(`${what}-hypr-moved`);
    // Unpinned and tiled by the user: the host does not pin it again or
    // move it, whatever the compositor then does with it.
    const address = hyprClients().find((x) => String(x.pid) === hostPid && x.title === "Picture in Picture") as (HyprClient & { address?: string }) | undefined;
    if (address?.address) {
      sh("hyprctl", "dispatch", "pin", `address:${address.address}`);
      sh("hyprctl", "dispatch", "settiled", `address:${address.address}`);
      await Bun.sleep(400);
      const placed = hyprClients().find((x) => String(x.pid) === hostPid && x.title === "Picture in Picture");
      await Bun.sleep(2500);
      const later = hyprClients().find((x) => String(x.pid) === hostPid && x.title === "Picture in Picture");
      console.log(`    after unpin and settiled: ${JSON.stringify(placed?.at)} floating=${placed?.floating}; later ${JSON.stringify(later?.at)} floating=${later?.floating} pinned=${later?.pinned}`);
      check(`${what}.notPinnedAgain`, !!later && !later.pinned && JSON.stringify(later.at) === JSON.stringify(placed?.at), JSON.stringify(later ?? null));
      capture(`${what}-hypr-unpinned`);
      sh("hyprctl", "dispatch", "setfloating", `address:${address.address}`);
    }
    return windowsOf(hostPid).find((w) => w.id === pip.id) ?? pip;
  }
  for (const [name, top, right, toward] of [
    ["tl", true, false, { x: -160, y: -110 }],
    ["br", false, true, { x: 160, y: 110 }],
  ] as const) {
    const mark = logLines().length;
    pip = await throwWindow(pip, grab.fx, grab.fy, toward);
    const want = { x: right ? area.x + area.w - pip.w - MARGIN : area.x + MARGIN, y: top ? area.y + MARGIN : area.y + area.h - pip.h - MARGIN };
    console.log(`    ${hostLines(mark).join("\n    ")}`);
    check(`${what}.landed.${name}`, near(pip.x, want.x) && near(pip.y, want.y), `at ${pip.x},${pip.y} want ${want.x},${want.y}`);
    capture(`${what}-landed-${name}`);
  }
  // A hard push past the left edge from the bottom-right corner tucks it there;
  // a document window lands in the corner instead.
  if (!stashable) {
    const mark = logLines().length;
    const from = { x: Math.round(pip.x + pip.w * grab.fx), y: Math.round(pip.y + pip.h * grab.fy) };
    const args = ["xdotool", "mousemove", "--sync", String(from.x), String(from.y), "mousedown", "1"];
    for (let i = 1; i <= 12; i++) args.push("sleep", "0.008", "mousemove", String(Math.round(from.x + ((area.x + 120 - from.x) * i) / 12)), String(from.y));
    args.push("mouseup", "1");
    Bun.spawnSync(["timeout", "20", ...args], { env: process.env as Record<string, string> });
    await Bun.sleep(1500);
    pip = windowsOf(hostPid).find((w) => w.id === pip.id) ?? pip;
    console.log(`    ${hostLines(mark).join("\n    ")}`);
    check(`${what}.pushLandsInCorner`, near(pip.x, area.x + MARGIN), `x ${pip.x}`);
  } else {
    const mark = logLines().length;
    const from = { x: Math.round(pip.x + pip.w * grab.fx), y: Math.round(pip.y + pip.h * grab.fy) };
    const args = ["xdotool", "mousemove", "--sync", String(from.x), String(from.y), "mousedown", "1"];
    const to = { x: area.x + 120, y: from.y };
    for (let i = 1; i <= 12; i++) args.push("sleep", "0.008", "mousemove", String(Math.round(from.x + ((to.x - from.x) * i) / 12)), String(to.y));
    args.push("mouseup", "1");
    Bun.spawnSync(["timeout", "20", ...args], { env: process.env as Record<string, string> });
    await Bun.sleep(1500);
    pip = windowsOf(hostPid).find((w) => w.id === pip.id) ?? pip;
    console.log(`    ${hostLines(mark).join("\n    ")}`);
    // Tucked so the tab shows; a manager may keep a little more on screen.
    const showing = pip.x + pip.w - area.x;
    check(`${what}.stashedLeft`, showing >= TAB - 2 && showing <= TAB + 24, `x ${pip.x}, ${showing} px showing`);
    capture(`${what}-stashed`);
    // Dragged back out by its visible strip, it lands in a corner on that side.
    const back = await throwWindow(pip, (pip.w - TAB / 2) / pip.w, grab.fy, { x: -40, y: 100 });
    check(`${what}.revealed`, back.x >= area.x, `x ${back.x}`);
    pip = back;
  }
  return pip;
}

const DOC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Call fixture</title>
<style>body{margin:0;font:15px system-ui;background:#f4f4f6}
#card{display:flex;gap:10px;align-items:center;justify-content:center;height:100%;min-height:200px;background:#1f2a37;color:#fff}
#card button{font:inherit;padding:8px 14px;border-radius:999px;border:0;background:#334155;color:#fff}
#card .hang{background:#dc2626}#pop{margin:24px;font:inherit;padding:8px 14px}
#home{margin:24px;height:220px;width:400px}</style></head><body>
<button id="pop">Pop out the call</button><div id="home"><div id="card"><button>Mute</button><button>Camera</button><button class="hang">Leave</button></div></div>
<script>
document.getElementById("pop").onclick = async () => {
  const w = await documentPictureInPicture.requestWindow({ width: 420, height: 240 });
  for (const s of document.querySelectorAll("style")) w.document.head.append(s.cloneNode(true));
  w.document.body.style.cssText = "margin:0;height:100vh";
  w.document.body.append(document.getElementById("card"));
  w.addEventListener("pagehide", () => document.getElementById("home").append(w.document.getElementById("card")));
};
</script></body></html>`;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/clip.webm" && process.env.NB_VIDEO_FIXTURE) return new Response(Bun.file(process.env.NB_VIDEO_FIXTURE));
    if (path === "/video")
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><title>Video fixture</title></head>' +
          '<body style="margin:0;font:16px system-ui"><h1>A page with a video</h1>' +
          '<video src="/clip.webm" autoplay muted loop controls width="640"></video></body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    return new Response(DOC_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

await connectPage();

if (legs.includes("document")) {
  await load(`http://127.0.0.1:${server.port}/doc`);
  check("doc.apiPresent", (await evalPage("typeof documentPictureInPicture + ' ' + typeof documentPictureInPicture.requestWindow")) === "object function");
  const before = new Set(windowsOf(hostPid).map((w) => w.id));
  const mark = logLines().length;
  await clickInPage("#pop");
  const pip = await newPip(before);
  check("doc.window", !!pip, pip ? `${pip.w}x${pip.h} "${pip.name}"` : "none");
  check("doc.openedEvent", (await logged(/ND_APP PIP t\d+ document opened/, mark)) !== "");
  if (pip) {
    await Bun.sleep(1500);
    const now = windowsOf(hostPid).find((w) => w.id === pip.id) ?? pip;
    for (const line of sh("xprop", "-id", pip.id).split("\n").filter((l) => !/^\s|ICON|_NET_WM_OPAQUE/.test(l))) console.log(`    ${line}`);
    // The page asked for its content to be 420x240; Chromium's frame goes around that.
    const inner = await evalPage("documentPictureInPicture.window ? documentPictureInPicture.window.innerWidth + 'x' + documentPictureInPicture.window.innerHeight : ''");
    check("doc.sizeAsRequested", inner === "420x240", `content ${inner}, window ${now.w}x${now.h}`);
    check("doc.contentMoved", (await evalPage("String(!document.getElementById('card'))")) === "true");
    rulesFor("doc", now);
    capture("doc-open");
    // The app window at a narrow width with the call popped out: the window
    // stays where it is and the page keeps its layout.
    const appIds = [...managed()].map((id) => `0x${id.toString(16)}`)
      .filter((id) => prop(id, "_NET_WM_PID").endsWith(` ${hostPid}`) && !prop(id, "WM_CLASS").includes('"picture-in-picture"'));
    const geomOf = (id: string): Win => {
      const info = sh("xwininfo", "-id", id);
      const n = (k: string) => Number(info.match(new RegExp(`${k}:\\s+(-?\\d+)`))?.[1] ?? 0);
      return { id, x: n("Absolute upper-left X"), y: n("Absolute upper-left Y"), w: n("Width"), h: n("Height"), name: "" };
    };
    const app = appIds.map(geomOf).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    console.log(`    app window ${app?.id} ${app?.w}x${app?.h}`);
    if (app && rig === "x11") {
      sh("xdotool", "windowsize", app.id, "720", String(app.h));
      await Bun.sleep(1500);
      const narrow = geomOf(app.id);
      const still = windowsOf(hostPid).find((w) => w.id === pip.id);
      check("doc.appNarrow", !!narrow && narrow.w <= 740 && !!still && still.x === now.x && still.y === now.y, `app ${narrow?.w}x${narrow?.h}, pip ${still?.x},${still?.y}`);
      capture("doc-app-narrow");
      sh("xdotool", "windowsize", app.id, String(app.w), String(app.h));
      await Bun.sleep(800);
    } else if (rig === "hypr") {
      const main = hyprClients().find((x) => String(x.pid) === hostPid && x.title !== "Picture in Picture") as (HyprClient & { address?: string }) | undefined;
      if (main?.address) sh("hyprctl", "dispatch", "resizewindowpixel", `exact 720 ${main.size[1]},address:${main.address}`);
      await Bun.sleep(1500);
      capture("doc-app-narrow");
    }
    // Chromium's frame is the handle: its title strip.
    await landings("doc", now, { fx: 0.3, fy: 10 / now.h }, false);
    // Closed from the page, as Meet's own button does: the controls come home.
    await evalPage("documentPictureInPicture.window?.close(), 'ok'");
    await Bun.sleep(1500);
    check("doc.closedGone", !windowsOf(hostPid).some((w) => w.id === pip.id && managed().has(Number(w.id))));
    check("doc.contentReturned", (await evalPage("String(!!document.querySelector('#home #card'))")) === "true");
  }
}

if (legs.includes("video")) {
  await load(`http://127.0.0.1:${server.port}/video`);
  await evalPage("document.querySelector('video').play().then(() => 'playing')");
  await Bun.sleep(800);
  const before = new Set(windowsOf(hostPid).map((w) => w.id));
  check("video.request", (await evalPage("document.querySelector('video').requestPictureInPicture().then(() => 'ok', (e) => String(e))", true)) === "ok");
  const pip = await newPip(before);
  check("video.window", !!pip, pip ? `${pip.w}x${pip.h} "${pip.name}"` : "none");
  if (pip) {
    await Bun.sleep(1500);
    const now = windowsOf(hostPid).find((w) => w.id === pip.id) ?? pip;
    for (const line of sh("xprop", "-id", pip.id).split("\n").filter((l) => !/^\s|ICON|_NET_WM_OPAQUE/.test(l))) console.log(`    ${line}`);
    rulesFor("video", now);
    capture("video-open");
    await landings("video", now, { fx: 0.3, fy: 0.6 }, true);
    await evalPage("document.exitPictureInPicture().then(() => 'ok')");
    await Bun.sleep(1200);
    check("video.backInPage", (await evalPage("String(!document.pictureInPictureElement)")) === "true");
  }
}

server.stop(true);
console.log(failed === 0 ? `ND_APP_CHROME_LEGS_OK(${rig})` : `ND_APP_CHROME_LEGS_FAIL(${rig}) ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
