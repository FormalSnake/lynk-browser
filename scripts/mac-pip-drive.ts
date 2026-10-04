#!/usr/bin/env bun
// Picture in picture on the real engine, macOS: a page's own document window
// (documentPictureInPicture.requestWindow, as Google Meet uses) and the
// floating video, both drawn and driven by the host instead of Chromium.
//
//   ND_HOST_BINARY=<NDShellDev.app/Contents/MacOS/NDShell> bun scripts/mac-pip-drive.ts
//
// Every gesture is a real one: app.cursor posts HID mouse, scroll and pinch
// events, so AppKit routes them the way it routes a person's. Frame pacing of
// each drag and each flight comes from the host's trace (ND_PIP_TRACE=1) and is
// held to the display's refresh rate. Captures land in screenshots/pip-*.png.
//
// Needs an unlocked, idle session (the cursor is the owner's), Screen
// Recording for tools/ndshot and the mac CEF gate lock. Marker: NB_PIP_OK.
// NB_PIP_LEGS=video,document picks legs.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp } from "@nativedesktop/test";

import { NDSHOT, SHOTS, fail, ndshotWindows, step, walk } from "./drive-lib.ts";
import type { NdshotWindow } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
const bundled = process.env.ND_HOST_BINARY ?? fail("set ND_HOST_BINARY to a bundled CEF host");
const legs = (process.env.NB_PIP_LEGS ?? "video,document,meet").split(",");
const RUN = mkdtempSync(join(tmpdir(), "nb-pip-"));
const CDP_PORT = Number(process.env.ND_CEF_DEBUG_PORT ?? 9483);
const hostBinary = join(RUN, "host.sh");
writeFileSync(
  hostBinary,
  `#!/bin/sh\ncase "$1" in --nd-*) exec "${bundled}" "$@" ;; esac\nexec "${bundled}" --remote-debugging-port=${CDP_PORT} ${process.env.NB_PIP_HOST_ARGS ?? ""} "$@"\n`,
);
chmodSync(hostBinary, 0o755);
mkdirSync(SHOTS, { recursive: true });

const idle = Number(
  Bun.spawnSync(["sh", "-c", "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'"]).stdout.toString().trim(),
);
if (!process.env.NB_PIP_IGNORE_IDLE && idle < 60) fail(`the mac has been idle ${idle}s; the drive moves the real cursor`);

const VIDEO = join(RUN, "clip.webm");
{
  const made = Bun.spawnSync([
    "ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-t", "60", "-c:v", "libvpx-vp9", "-b:v", "1M", "-deadline", "realtime", VIDEO,
  ]);
  if (made.exitCode !== 0) fail(`ffmpeg could not make the video fixture: ${made.stderr.toString()}`);
}

/// A page that does what Meet does: a button opens a document window of a
/// given size and moves its call controls into it; when that window goes
/// away the controls come home.
const DOC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Call fixture</title>
<style>body{margin:0;font:15px -apple-system,system-ui;background:#f4f4f6}
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
    if (path === "/clip.webm") return new Response(Bun.file(VIDEO));
    if (path === "/video")
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><title>Video fixture</title></head>' +
          '<body style="margin:0;font:16px system-ui"><h1 style="margin:24px">A page with a video</h1>' +
          '<video src="/clip.webm" autoplay muted loop controls width="640" style="margin:24px"></video></body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    return new Response(DOC_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

mkdirSync(join(RUN, "store"), { recursive: true });
writeFileSync(
  join(RUN, "store", "settings.json"),
  JSON.stringify({ version: 1, data: { restoreOnLaunch: false, homepage: `http://127.0.0.1:${server.port}/doc` } }),
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
    ND_APP_ID: "dev.nativebrowser.pipdrive",
    ND_PIP_TRACE: "1",
    ...(process.env.NB_PIP_REDUCED ? { ND_PIP_REDUCE_MOTION: "1" } : {}),
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => {
    lines.push(line);
    if (line.includes("ND_PIP") || line.includes("ND_APP PIP")) console.log(`    ${line.trim()}`);
  },
});

// ---- CDP against the tab's page ---------------------------------------------------

interface Target { type: string; url: string; webSocketDebuggerUrl: string }
let socket: WebSocket | null = null;
let seq = 0;
const waiting = new Map<number, (m: { result?: { result?: { value?: unknown } } }) => void>();
async function connectPage(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Target[];
      const t = list.find((x) => x.type === "page" && x.url.startsWith("http://127.0.0.1"));
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
async function cdp(method: string, params: Record<string, unknown>): Promise<{ result?: { result?: { value?: unknown } } }> {
  const id = ++seq;
  const answer = new Promise<{ result?: { result?: { value?: unknown } } }>((r) => waiting.set(id, r));
  socket!.send(JSON.stringify({ id, method, params }));
  return Promise.race([answer, Bun.sleep(15_000).then(() => ({ result: { result: { value: "(timeout)" } } }))]);
}
async function evalPage(expression: string, userGesture = false): Promise<string> {
  const m = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
  return String(m.result?.result?.value ?? "");
}
async function load(url: string): Promise<void> {
  await evalPage(`location.href = ${JSON.stringify(url)}`);
  for (let i = 0; i < 150; i++) {
    await Bun.sleep(200);
    const at = await evalPage("document.readyState + ' ' + location.href");
    if (at.startsWith("complete") && at.includes(url.replace(/^http:\/\//, ""))) break;
  }
  await Bun.sleep(800);
}
/// A real click on a page element, through CDP's input domain: Chromium takes
/// it as the user's gesture, which requestWindow insists on.
async function clickInPage(selector: string): Promise<void> {
  const box = JSON.parse(await evalPage(`JSON.stringify((r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()))`)) as [number, number];
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", clickCount: 1 });
  }
}

// ---- screen geometry ---------------------------------------------------------

/// The visible frame of the screen the window is on, top-left origin like
/// ndshot's coordinates.
function visibleFrame(): { x: number; y: number; w: number; h: number } {
  const js = `ObjC.import("AppKit");
    const s = $.NSScreen.mainScreen; const f = s.frame; const v = s.visibleFrame;
    JSON.stringify({ x: v.origin.x, y: f.size.height - v.origin.y - v.size.height, w: v.size.width, h: v.size.height })`;
  const out = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", js]);
  return JSON.parse(out.stdout.toString());
}

const MARGIN = 16;
const TAB = 28;

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${name}: ${ok ? "ok" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}

/// The next host trace line matching `pattern` after `from`.
async function traced(pattern: RegExp, from: number, ms = 5000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = lines.slice(from).find((l) => pattern.test(l));
    if (hit) return hit;
    await Bun.sleep(50);
  }
  return "";
}

/// Holds a flight's or a drag's pacing to the display: the mean within a tenth
/// of a frame and no more than two frames (or one in fifty) late.
function paced(name: string, line: string): void {
  const m = /phase=(\w+) frames=(\d+) refreshHz=(\d+) meanMs=([\d.]+) p95Ms=([\d.]+) maxMs=([\d.]+) late=(\d+)/.exec(line);
  if (!m) return check(`${name}.frames`, false, `no frame trace: ${line}`);
  const [, phase, frames, hz, mean, p95, max, late] = m;
  const budget = 1000 / Number(hz);
  console.log(`  FRAMES ${name} ${phase}: ${frames} frames at ${hz} Hz, mean ${mean} ms, p95 ${p95} ms, max ${max} ms, late ${late}`);
  check(`${name}.pace`, Number(mean) < budget * 1.1 && Number(late) <= Math.max(2, Number(frames) / 50), `budget ${budget.toFixed(2)} ms`);
}

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
  await app.setWindowSize(1280, 860);
  const vis = visibleFrame();
  console.log(`  screen visible frame ${JSON.stringify(vis)}`);

  const appWindow = (): NdshotWindow => ndshotWindows(app.pid)[0] ?? fail("no window on screen");
  const capture = (name: string, windowID = appWindow().windowID): void => {
    const out = `${SHOTS}/pip-${name}.png`;
    const shot = Bun.spawnSync(["timeout", "30", NDSHOT, "capture", "--out", out, "--window-id", String(windowID), "--region", "--no-focus"]);
    if (shot.exitCode !== 0) fail(`capture ${name}: ${shot.stderr.toString().trim()}`);
    console.log(`  capture pip-${name}.png`);
  };
  /// The window the host last adopted (its trace names the window number,
  /// which is the CGWindowID ndshot lists), if it is still on screen.
  const pipWindow = (_before?: Set<number>): NdshotWindow | undefined => {
    const adopted = lines.filter((l) => l.includes("ND_PIP adopted")).at(-1);
    const id = Number(/ id=(\d+)/.exec(adopted ?? "")?.[1] ?? 0);
    return ndshotWindows(app.pid).find((w) => w.windowID === id);
  };
  const geometry = async () => (await app.windows()).windows[0]?.geometry ?? fail("the window reports no geometry");
  /// Screen point to the window-relative point app.cursor takes.
  const at = async (x: number, y: number) => {
    const g = await geometry();
    return { x: x - g.x, y: y - g.y };
  };
  const refreshed = (w: NdshotWindow): NdshotWindow => ndshotWindows(app.pid).find((x) => x.windowID === w.windowID) ?? fail("the floating window went away");
  const corner = (w: NdshotWindow, top: boolean, right: boolean) => ({
    x: right ? vis.x + vis.w - w.width - MARGIN : vis.x + MARGIN,
    y: top ? vis.y + MARGIN : vis.y + vis.h - w.height - MARGIN,
  });
  const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

  /// Grabs the window at `grab` (window-relative fractions), carries it to the
  /// middle of the screen, then flicks it toward `toward` and lets go.
  async function throwTo(w: NdshotWindow, grab: { fx: number; fy: number }, toward: { x: number; y: number }, name: string): Promise<NdshotWindow> {
    const from = await at(w.x + w.width * grab.fx, w.y + w.height * grab.fy);
    const mark = lines.length;
    await app.cursor.move(from, { steps: 4 });
    await Bun.sleep(150);
    await app.cursor.down();
    const mid = await at(vis.x + vis.w / 2, vis.y + vis.h / 2);
    if (process.env.NB_PIP_SAMPLE) Bun.spawn(["sample", String(app.pid), "1", "5", "-mayDie", "-file", `${process.env.NB_PIP_SAMPLE}-${name}.txt`], { stdout: "ignore", stderr: "ignore" });
    await app.cursor.move(mid, { steps: 45, intervalMs: 8 });
    const end = { x: mid.x + toward.x, y: mid.y + toward.y };
    await app.cursor.move(end, { steps: 6, intervalMs: 8 });
    await app.cursor.up();
    paced(`${name}.drag`, await traced(/frames phase=drag/, mark));
    if (!process.env.NB_PIP_REDUCED) paced(`${name}.throw`, await traced(/frames phase=throw/, mark));
    await Bun.sleep(300);
    return refreshed(w);
  }

  // ---- floating video -------------------------------------------------------------
  if (legs.includes("video")) {
    await load(`http://127.0.0.1:${server.port}/video`);
    await evalPage("document.querySelector('video').play()");
    await Bun.sleep(800);
    const before = new Set(ndshotWindows(app.pid).map((w) => w.windowID));
    const mark = lines.length;
    check("video.request", (await evalPage("document.querySelector('video').requestPictureInPicture().then(() => 'ok', (e) => String(e))", true)) === "ok");
    check("video.openedEvent", (await traced(new RegExp(`ND_APP PIP ${tab} video opened`), mark)) !== "");
    await Bun.sleep(1200);
    let pip = pipWindow(before) ?? fail("no floating window");
    const c = corner(pip, false, true);
    check("video.restsInCorner", near(pip.x, c.x) && near(pip.y, c.y), `at ${pip.x},${pip.y} corner ${c.x},${c.y}`);
    capture("video-open", pip.windowID);
    // Chromium shows the page's origin over the video for three seconds after
    // it opens; the rest state is after that.
    await Bun.sleep(3000);
    capture("video-rest", pip.windowID);

    let m = lines.length;
    await app.cursor.move(await at(pip.x + pip.width * 0.7, pip.y + pip.height * 0.7), { steps: 10 });
    check("video.hoverShowsControls", (await traced(/ND_PIP controls shown/, m)) !== "");
    await Bun.sleep(400);
    capture("video-hover", pip.windowID);

    // Play and pause: the round button in the middle.
    await app.cursor.click(await at(pip.x + pip.width / 2, pip.y + pip.height / 2), { steps: 4 });
    await Bun.sleep(400);
    check("video.pause", (await evalPage("String(document.querySelector('video').paused)")) === "true");
    capture("video-paused", pip.windowID);
    await app.cursor.click(await at(pip.x + pip.width / 2, pip.y + pip.height / 2), { steps: 1 });
    await Bun.sleep(400);
    check("video.play", (await evalPage("String(document.querySelector('video').paused)")) === "false");

    // Thrown into each corner in turn: top left, top right, bottom left, then
    // home to bottom right.
    for (const [name, top, right, toward] of [
      ["tl", true, false, { x: -160, y: -110 }],
      ["tr", true, true, { x: 160, y: -110 }],
      ["bl", false, false, { x: -160, y: 110 }],
      ["br", false, true, { x: 160, y: 110 }],
    ] as const) {
      pip = await throwTo(pip, { fx: 0.3, fy: 0.75 }, toward, `video.${name}`);
      const want = corner(pip, top, right);
      check(`video.snapped.${name}`, near(pip.x, want.x) && near(pip.y, want.y), `at ${pip.x},${pip.y} want ${want.x},${want.y}`);
      capture(`video-snapped-${name}`, pip.windowID);
    }

    // Mid-drag: held in the middle of the screen.
    {
      const from = await at(pip.x + pip.width * 0.3, pip.y + pip.height * 0.75);
      await app.cursor.move(from, { steps: 4 });
      await app.cursor.down();
      await app.cursor.move(await at(vis.x + vis.w / 2, vis.y + vis.h / 2), { steps: 30, intervalMs: 8 });
      await Bun.sleep(300);
      const held = refreshed(pip);
      capture("video-dragging", held.windowID);
      const grabbedAt = await app.cursor.position();
      check("video.followsPointer", near(held.x + held.width * 0.3, grabbedAt.x, 3) && near(held.y + held.height * 0.75, grabbedAt.y, 3), `window ${held.x},${held.y} pointer ${grabbedAt.x},${grabbedAt.y}`);
      await app.cursor.move(await at(vis.x + vis.w - 200, vis.y + vis.h - 150), { steps: 30, intervalMs: 8 });
      await Bun.sleep(80);
      await app.cursor.up();
      await Bun.sleep(900);
      pip = refreshed(pip);
    }

    // Stashed by a two-finger swipe toward the right edge, brought back by one
    // toward the screen.
    m = lines.length;
    await app.cursor.swipe(await at(pip.x + pip.width / 2, pip.y + pip.height / 2), [-12, -18, -24, -30, -34], [-30, -22, -14, -8]);
    await traced(/settle stash/, m);
    await Bun.sleep(900);
    pip = refreshed(pip);
    check("video.stashedBySwipe", near(pip.x, vis.x + vis.w - TAB, 3), `x ${pip.x} want ${vis.x + vis.w - TAB}`);
    capture("video-stashed", pip.windowID);
    m = lines.length;
    await app.cursor.swipe(await at(vis.x + vis.w - TAB / 2, pip.y + pip.height / 2), [12, 18, 24, 30, 34], [30, 22, 14, 8]);
    await traced(/settle reveal/, m);
    await Bun.sleep(900);
    pip = refreshed(pip);
    check("video.revealedBySwipe", near(pip.x, vis.x + vis.w - pip.width - MARGIN, 3), `x ${pip.x}`);

    // Resized from its left edge: the aspect holds.
    {
      const ratio = pip.width / pip.height;
      await app.cursor.move(await at(pip.x + 2, pip.y + pip.height / 2), { steps: 4 });
      await app.cursor.down();
      await app.cursor.move(await at(pip.x - 140, pip.y + pip.height / 2 - 20), { steps: 20 });
      await app.cursor.up();
      await Bun.sleep(900);
      pip = refreshed(pip);
      check("video.edgeResizeGrows", pip.width > 459 + 60, `${pip.width}x${pip.height}`);
      check("video.edgeResizeKeepsAspect", Math.abs(pip.width / pip.height - ratio) < 0.02, `${(pip.width / pip.height).toFixed(3)} vs ${ratio.toFixed(3)}`);
    }

    // Pinched smaller: it settles on one of the snap sizes, aspect kept.
    {
      const ratio = pip.width / pip.height;
      m = lines.length;
      await app.cursor.pinch(await at(pip.x + pip.width / 2, pip.y + pip.height / 2), Array(10).fill(-0.04));
      const settled = await traced(/settle size/, m);
      await Bun.sleep(900);
      pip = refreshed(pip);
      check("video.pinchSettles", settled !== "", `${pip.width}x${pip.height}`);
      check("video.pinchKeepsAspect", Math.abs(pip.width / pip.height - ratio) < 0.02);
      capture("video-pinched", pip.windowID);
    }

    // Back to tab: the video returns to the page, the window goes.
    m = lines.length;
    await app.cursor.move(await at(pip.x + pip.width / 2, pip.y + pip.height / 2), { steps: 6 });
    await Bun.sleep(400);
    await app.cursor.click(await at(pip.x + 8 + 28 + 6 + 14, pip.y + 8 + 14), { steps: 4 });
    check("video.returnEvent", (await traced(new RegExp(`ND_APP PIP ${tab} video returnToTab`), m)) !== "");
    await Bun.sleep(1200);
    check("video.windowGone", !pipWindow(before));
    check("video.backInPage", (await evalPage("String(!document.pictureInPictureElement)")) === "true");
    console.log("NB_PIP_VIDEO_OK");
  }

  // ---- document picture in picture ------------------------------------------------
  // Reduce Motion (NB_PIP_REDUCED=1 runs the host as if it were on): the
  // window fades in where it rests and a throw puts it straight in its
  // corner, with no flight.
  if (legs.includes("reduced")) {
    await load(`http://127.0.0.1:${server.port}/doc`);
    let m = lines.length;
    await clickInPage("#pop");
    const open = await traced(/frames phase=open/, m);
    console.log(`  reduced open: ${open.trim()}`);
    let pip = pipWindow() ?? fail("no document window");
    const c = corner(pip, false, true);
    check("reduced.opensInCorner", near(pip.x, c.x) && near(pip.y, c.y), `at ${pip.x},${pip.y}`);
    m = lines.length;
    pip = await throwTo(pip, { fx: 0.5, fy: 6 / pip.height }, { x: -160, y: -110 }, "reduced");
    const tl = corner(pip, true, false);
    check("reduced.landsWithoutFlight", near(pip.x, tl.x) && near(pip.y, tl.y) && !lines.slice(m).some((l) => /frames phase=throw frames=[1-9]\d/.test(l)), `at ${pip.x},${pip.y}`);
    capture("reduced-landed", pip.windowID);
    await evalPage("documentPictureInPicture.window?.close(), 'ok'");
    await Bun.sleep(800);
  }

  // Google Meet: the API is there on its origin. Its own picture in picture
  // lives inside a call, which needs an account; the drive stops at the door.
  if (legs.includes("meet")) {
    await load("https://meet.google.com/");
    const at = await evalPage("location.href");
    const api = await evalPage("typeof documentPictureInPicture + ' ' + typeof documentPictureInPicture?.requestWindow");
    console.log(`  meet: ${at}`);
    check("meet.apiPresent", api === "object function", api);
    capture("meet-landing");
  }
  if (legs.includes("document")) {
    await load(`http://127.0.0.1:${server.port}/doc`);
    check("doc.apiPresent", (await evalPage("typeof documentPictureInPicture + ' ' + typeof documentPictureInPicture.requestWindow")) === "object function");
    const pagesBefore = (await app.tree()) && countPages(await app.tree());
    const before = new Set(ndshotWindows(app.pid).map((w) => w.windowID));
    let m = lines.length;
    await clickInPage("#pop");
    check("doc.openedEvent", (await traced(new RegExp(`ND_APP PIP ${tab} document opened`), m)) !== "");
    await Bun.sleep(1200);
    let pip = pipWindow(before) ?? fail("no document window");
    check("doc.sizeAsRequested", pip.width === 420 && pip.height === 240, `${pip.width}x${pip.height}`);
    const c = corner(pip, false, true);
    check("doc.restsInCorner", near(pip.x, c.x) && near(pip.y, c.y), `at ${pip.x},${pip.y} corner ${c.x},${c.y}`);
    check("doc.contentMoved", (await evalPage("String(!document.getElementById('card'))")) === "true");
    check("doc.notATab", countPages(await app.tree()) === pagesBefore, `${countPages(await app.tree())} pages vs ${pagesBefore}`);
    capture("doc-rest", pip.windowID);
    capture("doc-app-normal");
    await app.setWindowSize(720, 800);
    await Bun.sleep(800);
    capture("doc-app-narrow");
    check("doc.survivesNarrow", !!pipWindow(before));
    await app.setWindowSize(1280, 860);
    await Bun.sleep(500);

    m = lines.length;
    await app.cursor.move(await at(pip.x + pip.width * 0.5, pip.y + pip.height * 0.6), { steps: 10 });
    check("doc.hoverShowsControls", (await traced(/ND_PIP controls shown/, m)) !== "");
    await Bun.sleep(400);
    capture("doc-hover", pip.windowID);
    // The page under the controls still takes clicks.
    await app.cursor.click(await at(pip.x + pip.width * 0.5, pip.y + pip.height * 0.5), { steps: 2 });

    // Thrown by its grabber into the top left corner.
    pip = await throwTo(pip, { fx: 0.5, fy: 6 / 240 }, { x: -160, y: -110 }, "doc.tl");
    const tl = corner(pip, true, false);
    check("doc.snapped.tl", near(pip.x, tl.x) && near(pip.y, tl.y), `at ${pip.x},${pip.y} want ${tl.x},${tl.y}`);
    capture("doc-snapped-tl", pip.windowID);
    for (const [name, top, right, toward] of [
      ["tr", true, true, { x: 160, y: -110 }],
      ["br", false, true, { x: 160, y: 110 }],
      ["bl", false, false, { x: -160, y: 110 }],
      ["tl2", true, false, { x: -160, y: -110 }],
    ] as const) {
      pip = await throwTo(pip, { fx: 0.5, fy: 6 / pip.height }, toward, `doc.${name}`);
      const want = corner(pip, top, right);
      check(`doc.snapped.${name}`, near(pip.x, want.x) && near(pip.y, want.y), `at ${pip.x},${pip.y} want ${want.x},${want.y}`);
      capture(`doc-snapped-${name}`, pip.windowID);
    }

    // A hard flick past the left edge stashes it; a click on the tab brings it back.
    {
      const from = await at(pip.x + pip.width / 2, pip.y + 6);
      await app.cursor.move(from, { steps: 3 });
      await app.cursor.down();
      await app.cursor.move({ x: from.x + 120, y: from.y + 80 }, { steps: 12, intervalMs: 8 });
      m = lines.length;
      await app.cursor.move({ x: from.x - 60, y: from.y + 100 }, { steps: 5, intervalMs: 8 });
      await app.cursor.up();
      await traced(/settle throw .*stashed\(right: false\)/, m);
      await Bun.sleep(900);
      pip = refreshed(pip);
      check("doc.stashedByFlick", near(pip.x, vis.x - pip.width + TAB, 3), `x ${pip.x} want ${vis.x - pip.width + TAB}`);
      capture("doc-stashed", pip.windowID);
      await app.cursor.click(await at(vis.x + TAB / 2, pip.y + pip.height / 2), { steps: 6 });
      await Bun.sleep(900);
      pip = refreshed(pip);
      check("doc.revealedByTab", near(pip.x, vis.x + MARGIN, 3), `x ${pip.x}`);
    }

    // Pinched larger: a pinch on the page resizes the window, not the page.
    {
      m = lines.length;
      await app.cursor.pinch(await at(pip.x + pip.width / 2, pip.y + pip.height / 2), Array(10).fill(0.05));
      check("doc.pinchSettles", (await traced(/settle size/, m)) !== "");
      await Bun.sleep(900);
      pip = refreshed(pip);
      check("doc.pinchGrew", pip.width > 420, `${pip.width}x${pip.height}`);
      check("doc.pageNotZoomed", (await evalPage("String(visualViewport.scale)")) === "1");
      capture("doc-pinched", pip.windowID);
    }

    // The close button: the window shrinks away, the page's controls come home.
    m = lines.length;
    await app.cursor.move(await at(pip.x + pip.width / 2, pip.y + pip.height / 2), { steps: 6 });
    await Bun.sleep(400);
    await app.cursor.click(await at(pip.x + 8 + 14, pip.y + 8 + 14), { steps: 4 });
    await Bun.sleep(1200);
    check("doc.closeGone", !pipWindow(before));
    check("doc.contentReturned", (await evalPage("String(!!document.querySelector('#home #card'))")) === "true");
    check("doc.closedEvent", (await traced(new RegExp(`ND_APP PIP ${tab} document closed`), m)) !== "");

    // Back to tab from another tab: the app brings the opener's tab forward.
    m = lines.length;
    await clickInPage("#pop");
    await traced(/frames phase=open/, m);
    await Bun.sleep(300);
    pip = pipWindow(before) ?? fail("no document window the second time");
    // Another tab in front: ⌘T, an address, Return (the command bar closes
    // with it; while it is open it sits above every window, this one too).
    await app.cursor.press("Meta+t");
    await Bun.sleep(800);
    Bun.spawnSync(["osascript", "-e", `tell application "System Events" to keystroke "127.0.0.1:${server.port}/video"`]);
    await Bun.sleep(300);
    await app.cursor.press("Enter");
    await Bun.sleep(1500);
    check("doc.otherTabInFront", (await evalPage("document.visibilityState")) === "hidden");
    m = lines.length;
    pip = refreshed(pip);
    await app.cursor.move(await at(pip.x + pip.width / 2, pip.y + pip.height / 2), { steps: 6 });
    await Bun.sleep(400);
    capture("doc-return-hover", pip.windowID);
    await app.cursor.click(await at(pip.x + 8 + 28 + 6 + 14, pip.y + 8 + 14), { steps: 4 });
    check("doc.returnEvent", (await traced(new RegExp(`ND_APP PIP ${tab} document returnToTab`), m)) !== "");
    await Bun.sleep(1200);
    check("doc.returnGone", !pipWindow(before));
    check("doc.returnShowsTab", (await evalPage("document.visibilityState")) === "visible");

    // Closing the opener tab closes the window, as in Chrome.
    await clickInPage("#pop");
    await Bun.sleep(1200);
    check("doc.reopened", !!pipWindow(before));
    await app.cursor.click(await at(appWindow().x + appWindow().width - 60, appWindow().y + 300), { steps: 6 });
    await app.cursor.press("Meta+w");
    await Bun.sleep(1500);
    check("doc.openerClosedClosesWindow", !pipWindow(before));
    console.log("NB_PIP_DOC_OK");
  }
  if (failed) fail(`${failed} check(s) failed`);
  console.log("NB_PIP_OK");
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}

function countPages(tree: { root: unknown }): number {
  let n = 0;
  walk((tree as { root: Parameters<typeof walk>[0] }).root, (node) => {
    if (typeof node.testID === "string" && /^page-t\d+$/.test(node.testID)) n += 1;
  });
  return n;
}
