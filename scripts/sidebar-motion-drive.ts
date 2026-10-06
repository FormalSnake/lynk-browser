#!/usr/bin/env bun
// The sidebar's show/hide slide against the real app, on either backend: the
// page is stretched over the slide and swapped back for the live page once it
// has painted at its new size (the framework's <splitview collapsed>).
//
//   bun scripts/sidebar-motion-drive.ts
//
// macOS: ND_HOST_BINARY names a bundled CEF host; hold the mac gate lock
// around the run, captures go through ndshot. Linux: run inside a rig
// (scripts/linux-sidebar-motion.sh); captures go through grim under a
// Wayland compositor, ImageMagick's import under bare X.
//
// Legs:
//   1  toggles the sidebar NB_MOTION_TOGGLES times (default 12), waiting for
//      each slide to land: the page lands flush at the expected rectangle
//      every time, a capture after the first two shows the page and not a blank or
//      stale frame, and the host's frame trace (ND_SPLIT_MOTION) and the
//      page's own animation frames are collected per slide
//   2  reverses mid-slide (a second toggle 60 to 120 ms into the first) and
//      lands where it started
//   3  captures frames around the slides, each started on its own clock and
//      staggered against the toggle so some land mid-slide, and checks every
//      one for a page edge that is blank or left behind; the ones caught
//      mid-slide are listed. NB_MOTION_SLOW_RUN=1 runs the whole drive with
//      the slide slowed ND_MOTION_SLOWDOWN times (default 8: GTK_SLOWDOWN on
//      GTK; AppKit's own collapse animation cannot be slowed)
//   4  CPU spent by the host and its engine processes per slide
//
// NB_MOTION_REPORT=<path> writes the numbers as JSON beside the log.
// Marker: NB_SIDEBAR_MOTION_OK.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp } from "@nativedesktop/test";

import { NDSHOT, fail, ndshotWindows, step } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 30_000);
const SHOTS = process.env.NB_MOTION_SHOTS ?? resolve(ROOT, "screenshots/sidebar-motion");
const TOGGLES = Number(process.env.NB_MOTION_TOGGLES ?? 12);
const SLOW = Number(process.env.ND_MOTION_SLOWDOWN ?? 8);
const WIDTH = Number(process.env.NB_MOTION_WIDTH ?? 1280);
mkdirSync(SHOTS, { recursive: true });
const darwin = process.platform === "darwin";
const RUN = mkdtempSync(join(tmpdir(), "nb-motion-"));
const CDP_PORT = Number(process.env.ND_CEF_DEBUG_PORT ?? 9493);

// ---------------------------------------------------------------- fixture ---

/// The page's background: a cream no part of the app's chrome uses, so a
/// sample that is not cream is a page edge that is blank, stale or missing.
const CREAM = [246, 227, 180];
const PAGE =
  `<!doctype html><title>Motion fixture</title><style>html,body{margin:0;overflow:hidden;background:#f6e3b4;color:#222;font:16px/1.5 system-ui}` +
  `main{max-width:620px;margin:0 auto;padding:32px}h1{font-size:30px}</style>` +
  `<main><h1>Reading under a sliding sidebar</h1>` +
  Array.from({ length: 14 }, (_, i) => `<p>Paragraph ${i + 1}. The quick brown fox jumps over the lazy dog, and the page reflows to whatever width the window gives it. Text left blurry after a resize would show here first.</p>`).join("") +
  `</main><script>window.__mf=[];(function f(t){__mf.push([+t.toFixed(1),innerWidth]);if(__mf.length>6000)__mf.splice(0,3000);requestAnimationFrame(f)})(performance.now())</script>`;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
});
const PAGE_URL = `http://127.0.0.1:${server.port}/motion`;

const store = join(RUN, "store");
mkdirSync(store, { recursive: true });
writeFileSync(
  join(store, "session.json"),
  JSON.stringify({
    version: 2,
    data: {
      windows: [{ id: "w1", tabs: [{ id: "t1", url: PAGE_URL, title: "Motion fixture", pinned: false }], activeId: "t1", width: WIDTH, height: 800 }],
      nextTabId: 2,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);

// ---------------------------------------------------------------- launch ----

/// The engine's debugging port rides a wrapper that execs the host, since
/// launchApp passes no arguments; the host's own --nd-* helper modes go
/// straight through.
const bundled = process.env.ND_HOST_BINARY ?? fail("set ND_HOST_BINARY");
const hostBinary = join(RUN, "host.sh");
writeFileSync(hostBinary, `#!/bin/sh\ncase "$1" in --nd-*) exec "${bundled}" "$@" ;; esac\nexec "${bundled}" --remote-debugging-port=${CDP_PORT} "$@"\n`);
chmodSync(hostBinary, 0o755);

type SlideTrace = { dir: string; frames: number; span: number; worst: number; late: number; refresh: number; reversals: number };
type PageTrace = { held: number; afterEnd: number; timedOut: boolean };
const slides: SlideTrace[] = [];
const pageSwaps: PageTrace[] = [];
const app = await launchApp({
  entry: "src/main.tsx",
  cwd: ROOT,
  hostBinary,
  env: {
    NB_STORE_DIR: store,
    NB_DOWNLOAD_DIR: join(RUN, "downloads"),
    NB_TEST_HOOKS: "1",
    ND_APP_ID: "dev.nativebrowser.motion",
    XDG_DATA_HOME: join(RUN, "data"),
    ND_CEF_CACHE: process.env.ND_CEF_CACHE || join(RUN, "cef"),
    ND_MOTION_TRACE: process.env.ND_MOTION_TRACE || "1",
    ...(process.env.NB_MOTION_SLOW_RUN && !darwin ? { GTK_SLOWDOWN: String(SLOW) } : {}),
  },
  readyTimeoutMs: PATIENCE * 2,
  rpcTimeoutMs: PATIENCE,
  logPath: process.env.NB_MOTION_HOST_LOG,
  onStderr: (line: string) => {
    const m = /^ND_SPLIT_MOTION dir=(\w+) frames=(\d+) span_ms=([\d.]+) worst_ms=([\d.]+) late=(\d+) refresh_ms=([\d.]+) reversals=(\d+)/.exec(line);
    if (m) slides.push({ dir: m[1]!, frames: +m[2]!, span: +m[3]!, worst: +m[4]!, late: +m[5]!, refresh: +m[6]!, reversals: +m[7]! });
    const p = /^ND_PAGE_MOTION node=\d+ held_ms=([\d.]+) after_end_ms=([\d.]+) resizes=\d+ timed_out=(\w+)/.exec(line);
    if (p) pageSwaps.push({ held: +p[1]!, afterEnd: +p[2]!, timedOut: p[3] === "true" });
  },
  retries: 0,
});

// ---------------------------------------------------------------- helpers ---

type Rect = { x: number; y: number; w: number; h: number };
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

async function maybeRect(id: string): Promise<Rect | null> {
  const node = await app.find(id);
  const g = node?.geometry;
  return g && g.w > 0 && g.h > 0 && node?.visible !== false ? g : null;
}

async function rect(id: string): Promise<Rect> {
  return (await maybeRect(id)) ?? fail(`${id} has no geometry`);
}

async function windowRect(): Promise<Rect> {
  return (await app.windows()).windows[0]?.geometry ?? fail("no window geometry");
}

function sh(...argv: string[]): string {
  const r = Bun.spawnSync(argv);
  if (r.exitCode !== 0) fail(`${argv[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

async function settle(id: string): Promise<Rect> {
  let last = "";
  const deadline = Date.now() + PATIENCE;
  while (Date.now() < deadline) {
    const r = await maybeRect(id);
    const k = JSON.stringify(r);
    if (r && k === last) return r;
    last = k;
    await Bun.sleep(120);
  }
  return fail(`${id} never settled`);
}

async function cdpEval(expression: string): Promise<unknown> {
  const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const target = list.find((t) => t.type === "page" && t.url === PAGE_URL) ?? fail("no CDP target for the fixture page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    const answer = new Promise<{ result?: { result?: { value?: unknown } } }>((r) => {
      ws.onmessage = (e) => r(JSON.parse(String(e.data)));
    });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    const m = await Promise.race([answer, Bun.sleep(5_000).then(() => fail(`CDP never answered ${expression}`))]);
    return m.result?.result?.value;
  } finally {
    ws.close();
  }
}

/// What Chromium says about its GPU: the device and whether compositing and
/// rasterization run on it.
async function gpuInfo(): Promise<unknown> {
  const version = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  try {
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    const answer = new Promise<{ result?: { gpu?: { devices?: { vendorString?: string; deviceString?: string }[]; featureStatus?: Record<string, string> } } }>((r) => {
      ws.onmessage = (e) => r(JSON.parse(String(e.data)));
    });
    ws.send(JSON.stringify({ id: 1, method: "SystemInfo.getInfo" }));
    const m = await Promise.race([answer, Bun.sleep(5_000).then(() => fail("SystemInfo.getInfo never answered"))]);
    const gpu = m.result?.gpu;
    return {
      device: gpu?.devices?.map((d) => `${d.vendorString ?? ""} ${d.deviceString ?? ""}`.trim()).join(" | "),
      compositing: gpu?.featureStatus?.gpu_compositing,
      rasterization: gpu?.featureStatus?.rasterization,
    };
  } finally {
    ws.close();
  }
}

/// The page's own animation frames since `mark`: how many, the longest gap
/// between two, and how many widths it was laid out at.
async function pageFrames(mark: number): Promise<{ n: number; gap: number; widths: number }> {
  const frames = (await cdpEval(`JSON.stringify(__mf.slice(${mark}))`)) as string;
  const list = JSON.parse(frames) as [number, number][];
  let gap = 0;
  for (let i = 1; i < list.length; i++) gap = Math.max(gap, list[i]![0] - list[i - 1]![0]);
  return { n: list.length, gap: +gap.toFixed(1), widths: new Set(list.map((f) => f[1])).size };
}

const frameMark = async (): Promise<number> => Number(await cdpEval("__mf.length"));

/// CPU seconds the host and every process under it have used so far.
function cpuSeconds(): number {
  if (darwin) {
    const rows = sh("ps", "-axo", "pid=,ppid=,time=").trim().split("\n").map((l) => l.trim().split(/\s+/));
    const kids = new Map<string, string[]>();
    for (const [pid, ppid] of rows) kids.set(ppid!, [...(kids.get(ppid!) ?? []), pid!]);
    const time = new Map(rows.map(([pid, , t]) => [pid!, t!]));
    let total = 0;
    const visit = (pid: string): void => {
      const t = time.get(pid);
      if (t) {
        const parts = t.split(":").map(Number);
        total += parts.reduce((acc, v) => acc * 60 + v, 0);
      }
      for (const k of kids.get(pid) ?? []) visit(k);
    };
    visit(String(app.pid));
    return total;
  }
  const hz = 100;
  let total = 0;
  const visit = (pid: string): void => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      total += (Number(fields[11]) + Number(fields[12])) / hz;
      const children = readdirSync(`/proc/${pid}/task`).flatMap((t) => {
        try {
          return readFileSync(`/proc/${pid}/task/${t}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
        } catch {
          return [];
        }
      });
      for (const c of children) visit(c);
    } catch {}
  };
  visit(String(app.pid));
  return total;
}

/// A capture of the screen (Linux) or the window (macOS), as a path.
function grab(name: string): string {
  const path = `${SHOTS}/${darwin ? "mac" : "gtk"}-${name}.png`;
  if (darwin) {
    const win = ndshotWindows(app.pid).find((w) => w.title !== "") ?? fail("ndshot sees no app window");
    sh("timeout", "30", NDSHOT, "capture", "--window-id", String(win.windowID), "--out", path);
  } else if (process.env.WAYLAND_DISPLAY && !process.env.NB_MOTION_X11) sh("grim", path);
  else sh("import", "-window", "root", "-silent", path);
  return path;
}

/// As `grab`, without waiting for it.
function grabAsync(name: string): Promise<string> {
  const path = `${SHOTS}/${darwin ? "mac" : "gtk"}-${name}.png`;
  let argv: string[];
  if (darwin) {
    argv = ["timeout", "30", NDSHOT, "capture", "--window-id", String(macWindowId()), "--out", path];
  } else if (process.env.WAYLAND_DISPLAY && !process.env.NB_MOTION_X11) argv = ["grim", path];
  else argv = ["import", "-window", "root", "-silent", path];
  if (process.env.ND_MOTION_TRACE === "frames") console.log(`  capture start ${(Date.now() / 1000).toFixed(3)} ${name}`);
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  return proc.exited.then((code) => {
    if (process.env.ND_MOTION_TRACE === "frames") console.log(`  capture end ${(Date.now() / 1000).toFixed(3)} ${name}`);
    return code === 0 ? path : fail(`${argv[0]} failed for ${name}`);
  });
}

let macWindow = 0;
function macWindowId(): number {
  if (!macWindow) macWindow = (ndshotWindows(app.pid).find((w) => w.title !== "") ?? fail("ndshot sees no app window")).windowID;
  return macWindow;
}

/// Where the page's cream starts from the left on row `y` (window points), to
/// tell a frame caught mid-slide from one at rest.
function pageEdge(path: string, win: Rect, y: number): number {
  const o = origin(path, win);
  const out = sh(
    "python3",
    "-c",
    `from PIL import Image
im = Image.open(${JSON.stringify(path)}).convert("RGB")
y = ${Math.round(o.y + y * o.s)}
for xp in range(0, ${win.w}, 2):
    r, g, b = im.getpixel((int(${o.x} + xp * ${o.s}), y))
    if abs(r - ${CREAM[0]}) + abs(g - ${CREAM[1]}) + abs(b - ${CREAM[2]}) <= 30:
        print(xp); break
else:
    print(-1)`,
  );
  return Number(out.trim());
}

/// The window's top-left in a Linux screen capture, and the capture's scale.
function origin(path: string, win: Rect): { x: number; y: number; s: number } {
  if (darwin) {
    const w = Number(sh("python3", "-c", `from PIL import Image;print(Image.open(${JSON.stringify(path)}).width)`).trim());
    return { x: 0, y: 0, s: w / win.w };
  }
  const id = sh("xdotool", "search", "--onlyvisible", "--pid", String(app.pid)).trim().split("\n")[0]!;
  const info = sh("xwininfo", "-id", id);
  return {
    x: Number(/Absolute upper-left X:\s+(-?\d+)/.exec(info)?.[1] ?? 0),
    y: Number(/Absolute upper-left Y:\s+(-?\d+)/.exec(info)?.[1] ?? 0),
    s: Number(process.env.ND_ACCEPT_SCALE ?? 1),
  };
}

/// Samples the page's trailing margin (cream in every frame of a slide, live
/// or stretched) down the page's height, and its leading margin when `lead`
/// is given. Returns the samples that are not cream.
function blankSamples(path: string, win: Rect, page: { right: number; top: number; bottom: number; lead?: number }): string[] {
  const o = origin(path, win);
  const xs = [page.right - 30, page.right - 12, ...(page.lead !== undefined ? [page.lead + 14] : [])];
  const pts: [number, number][] = [];
  for (const x of xs) for (let y = page.top + 60; y < page.bottom - 10; y += 40) pts.push([Math.round(o.x + x * o.s), Math.round(o.y + y * o.s)]);
  const out = sh(
    "python3",
    "-c",
    `from PIL import Image
im = Image.open(${JSON.stringify(path)}).convert("RGB")
for x, y in ${JSON.stringify(pts)}:
    print(x, y, *im.getpixel((x, y)))`,
  );
  return out
    .trim()
    .split("\n")
    .map((l) => l.split(" ").map(Number))
    .filter(([, , r, g, b]) => Math.abs(r! - CREAM[0]!) + Math.abs(g! - CREAM[1]!) + Math.abs(b! - CREAM[2]!) > 30)
    .map(([x, y, r, g, b]) => `(${x},${y})=${r},${g},${b}`);
}

const sidebarShown = async (): Promise<boolean> => {
  const r = await maybeRect("sidebar");
  return r !== null && r.x >= 0;
};

/// The page's landing rectangle for a state, learned from the first time the
/// app was at rest in it.
const rest: Record<"shown" | "hidden", Rect | null> = { shown: null, hidden: null };

/// Slides the host has reported as landed, for `landed` to wait on.
let slidesSeen = 0;

async function landed(state: "shown" | "hidden", tag: string): Promise<Rect> {
  await step(`the slide to land (${tag})`, async () => {
    const deadline = Date.now() + PATIENCE;
    while (slidesSeen >= 0 && slides.length <= slidesSeen) {
      if (Date.now() > deadline) fail("the host never reported the slide's end");
      await Bun.sleep(50);
    }
    slidesSeen = slides.length;
  });
  await Bun.sleep(100);
  await step(`the sidebar to be ${state} (${tag})`, async () => {
    const deadline = Date.now() + PATIENCE;
    while ((await sidebarShown()) !== (state === "shown")) {
      if (Date.now() > deadline) fail("it never got there");
      await Bun.sleep(50);
    }
  });
  const page = await settle("content");
  const win = await windowRect();
  if (state === "hidden" && (!near(page.x, 0) || !near(page.x + page.w, win.w))) fail(`${tag}: the hidden layout's page is not edge to edge: ${JSON.stringify(page)} in ${win.w}`);
  if (state === "shown") {
    const side = await rect("sidebar");
    if (page.x < side.x + side.w - 1) fail(`${tag}: the page sits under the sidebar: page ${JSON.stringify(page)} sidebar ${JSON.stringify(side)}`);
  }
  const known = rest[state];
  if (known && JSON.stringify(known) !== JSON.stringify(page)) fail(`${tag}: the page landed at ${JSON.stringify(page)}, not ${JSON.stringify(known)}`);
  rest[state] = page;
  return page;
}

/// After a slide: a capture once the page has had its swap, with the page on
/// show at the landed rectangle.
async function checkRest(tag: string, page: Rect): Promise<void> {
  const deadline = Date.now() + 3000;
  let bad: string[] = [];
  let path = "";
  const win = await windowRect();
  while (Date.now() < deadline) {
    path = grab(`rest-${tag}`);
    bad = blankSamples(path, win, { right: page.x + page.w, top: page.y, bottom: page.y + page.h, lead: page.x });
    if (bad.length === 0) return;
    await Bun.sleep(300);
  }
  fail(`${tag}: the page is not on show after the slide (${bad.slice(0, 4).join(" ")}), ${path}`);
}

async function toggle(): Promise<void> {
  if (process.env.ND_MOTION_TRACE === "frames") console.log(`  toggle ${(Date.now() / 1000).toFixed(3)}`);
  await app.click("menu-toggle-sidebar");
}

const report: Record<string, unknown> = { platform: darwin ? "appkit" : "gtk", width: WIDTH };

try {
  await step("the sidebar layout comes up", () => app.waitFor({ testId: "sidebar", state: "visible" }, { timeoutMs: PATIENCE }));
  await step("the fixture page paints", async () => {
    const deadline = Date.now() + PATIENCE;
    while (Number(await cdpEval("typeof __mf === 'object' ? __mf.length : 0").catch(() => 0)) < 30) {
      if (Date.now() > deadline) fail("no animation frames from the page");
      await Bun.sleep(200);
    }
  });
  await Bun.sleep(800);
  report.gpu = await gpuInfo().catch((e) => `unknown (${(e as Error).message})`);
  console.log(`  NB_MOTION_GPU ${JSON.stringify(report.gpu)}`);
  slidesSeen = -1;
  slides.length = 0;
  await landed("shown", "start");
  await checkRest("start", rest.shown!);

  // ---- 1 and 4: repeated toggles -------------------------------------------
  const perSlide: { dir: string; pageFrames: number; pageGap: number; pageWidths: number }[] = [];
  const cpu0 = cpuSeconds();
  const t0 = Date.now();
  for (let i = 0; i < TOGGLES; i++) {
    const want = (await sidebarShown()) ? "hidden" : "shown";
    const mark = await frameMark();
    await toggle();
    const page = await landed(want, `toggle ${i + 1}`);
    await Bun.sleep(500);
    const pf = await pageFrames(mark);
    perSlide.push({ dir: want === "hidden" ? "hide" : "show", pageFrames: pf.n, pageGap: pf.gap, pageWidths: pf.widths });
    if (i < 2) await checkRest(`toggle${i + 1}-${want}`, page);
  }
  const cpu = cpuSeconds() - cpu0;
  const wall = (Date.now() - t0) / 1000;
  report.toggles = TOGGLES;
  report.cpuSecondsPerSlide = +(cpu / TOGGLES).toFixed(3);
  report.cpuSecondsPerSlideWall = +(wall / TOGGLES).toFixed(2);
  report.pageFrames = perSlide;
  console.log(`  NB_MOTION_TOGGLES_OK ${TOGGLES} slides landed flush; cpu ${(cpu / TOGGLES).toFixed(3)} s per slide (incl. ~0.5 s rest each)`);

  // ---- 2: reversal mid-slide ------------------------------------------------
  for (const delay of [60, 120]) {
    const start = (await sidebarShown()) ? "shown" : "hidden";
    await toggle();
    await Bun.sleep(delay);
    await toggle();
    const page = await landed(start, `reversal ${delay} ms`);
    await Bun.sleep(400);
    await checkRest(`reversal-${delay}`, page);
  }
  console.log("  NB_MOTION_REVERSAL_OK a toggle 60 and 120 ms into a slide turned it round and it landed where it started");

  // ---- 3: frames during slides ---------------------------------------------
  // A capture takes longer than a slide on AppKit, so each one is started on
  // its own clock, staggered against the toggle, and the ones that land
  // inside a slide are the mid frames.
  const win = await windowRect();
  const midBad: string[] = [];
  const midFrames: string[] = [];
  let midShots = 0;
  const offsets = process.env.NB_MOTION_SLOW_RUN ? [0, 300, 700, 1100, 1500] : darwin ? [-900, -850, -800, -760, -720, -680, -640, -600] : [-120, -80, -40, 0, 30, 60, 100, 140];
  for (const [i, offset] of offsets.entries()) {
    for (const dir of ["a", "b"]) {
      const shownBefore = await sidebarShown();
      const from = rest[shownBefore ? "shown" : "hidden"]!;
      const to = rest[shownBefore ? "hidden" : "shown"]!;
      const name = `mid-${i}${dir}-${shownBefore ? "hide" : "show"}`;
      let shot: Promise<string>;
      if (offset < 0) {
        shot = grabAsync(name);
        await Bun.sleep(-offset);
        await toggle();
      } else {
        await toggle();
        await Bun.sleep(offset);
        shot = grabAsync(name);
      }
      const path = await shot;
      midShots++;
      const bad = blankSamples(path, win, { right: Math.min(from.x + from.w, to.x + to.w), top: Math.max(from.y, to.y), bottom: Math.min(from.y + from.h, to.y + to.h) });
      if (bad.length) midBad.push(`${path}: ${bad.slice(0, 3).join(" ")}`);
      const edge = pageEdge(path, win, from.y + from.h / 2);
      const lo = Math.min(from.x, to.x);
      const hi = Math.max(from.x, to.x);
      if (edge > lo + 6 && edge < hi - 6) midFrames.push(`${path} edge=${edge}`);
      await landed(shownBefore ? "hidden" : "shown", `sampled slide ${name}`);
      await Bun.sleep(300);
    }
  }
  report.midShots = midShots;
  report.midFrames = midFrames;
  report.midBlank = midBad;
  if (midBad.length) fail(`blank or stale page frames during a slide:\n    ${midBad.join("\n    ")}`);
  console.log(`  NB_MOTION_FRAMES_OK ${midShots} captures around slides, ${midFrames.length} of them mid-slide, the page's trailing margin on show in every one`);
  for (const f of midFrames) console.log(`    mid ${f}`);

  report.slides = slides;
  report.pageSwaps = pageSwaps;
  const worst = Math.max(...slides.map((s) => s.worst));
  const late = slides.reduce((a, s) => a + s.late, 0);
  const frames = slides.reduce((a, s) => a + s.frames, 0);
  console.log(`  NB_MOTION_PACING slides=${slides.length} frames=${frames} late=${late} worst_ms=${worst} swap_after_end_ms(max)=${Math.max(0, ...pageSwaps.map((p) => p.afterEnd))} swap_timeouts=${pageSwaps.filter((p) => p.timedOut).length}`);
  console.log(`  NB_MOTION_PAGE ${JSON.stringify(perSlide.slice(0, 4))}`);
  console.log("NB_SIDEBAR_MOTION_OK");
} finally {
  // Written whatever the run did: a slide that fails is the one worth the numbers.
  report.slides = slides;
  report.pageSwaps = pageSwaps;
  if (process.env.NB_MOTION_REPORT) writeFileSync(process.env.NB_MOTION_REPORT, JSON.stringify(report, null, 2));
  await app.close().catch(() => {});
  server.stop(true);
}
