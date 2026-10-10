#!/usr/bin/env bun
// The sidebar layout (docs/sidebar.md) against the real app, on either
// backend, with geometry asserted and every surface captured.
//
//   bun scripts/sidebar-drive.ts
//
// macOS: ND_HOST_BINARY names the host; the pointer legs drive the real cursor
// (`app.cursor`), so hold the machine's mac gate lock around the run, and
// captures go through ndshot. Linux: run inside a rig (the framework's
// scripts/headless-app-chrome.sh with ND_ACCEPT_DRIVE pointing here, or any X
// session with xdotool and ImageMagick); the pointer legs use xdotool.
//
// Legs:
//   1  sidebar geometry at a normal and a narrow width: the window controls
//      on their row's centre line (on AppKit also the close button's red in
//      the capture), rows that truncate inside their row, pinned tiles of one
//      size with their mark centred, the foot's glyphs on one centre line
//   2  the page card: margins, and a corner pixel outside its curve
//   3  the load bar along the page's top edge, mid-load and after
//   1a the pinned grid: 1, 2, 3, 4, 5 and 7 pins at 720 and 1280, and
//      after the sidebar is resized: the tiles span the rows' inset edge to
//      edge, one cell size, a short last row on the column pitch, Arc's
//      height for the width
//   1b AppKit: every pinned tile a Liquid Glass pill, the one on show raised,
//      captured at both widths beside the owner's reference
//   1c GTK: the tab on show set apart in its pixels as a row, a favicon tile
//      and a letter tile, at both widths
//   4  hide the sidebar, then the edge reveal over an unchanged card; on
//      AppKit the traffic lights are gone while it is hidden and ride with
//      the peeking panel, held to the tiles' leading edge on every frame
//      of the slide in and out
//   5  a tab dragged within the list (and between the sections)
//   6  a click on the row on show opens the command bar on its address
//   7  compact and back: no controls row or card in compact, both back after
//
// GTK only, ND_SIDEBAR_CONTROLS=start|end|none names where the rig's
// gtk-decoration-layout puts the window buttons, and leg 1 asserts they are
// there: in the sidebar's first row when they lead, in a strip over the card
// when they trail, and no room kept for them when there are none.
//
// GTK: no icon may be missing from the theme (the host says so on stderr, and
// GTK draws its missing-image glyph there). The GTK host on macOS finds no
// Adwaita icons in Homebrew's GTK, so run it with the theme on the data path:
//   XDG_DATA_DIRS=$(nix build nixpkgs#adwaita-icon-theme --no-link --print-out-paths)/share:/opt/homebrew/share
//
// ND_APPEARANCE=light|dark pins the host's appearance for the captures.
// ND_ANIMATION_SLOWDOWN=<n> stretches the peek's slide n times, and leg 4 then
// also captures it as a frame sequence and checks the lights against the
// tiles in each frame's pixels.
//
// Marker: NB_SIDEBAR_OK.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, type JsonNode } from "@nativedesktop/test";

import { NDSHOT, fail, ndshotWindows, paletteDriver, step, walk } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 30_000);
const SHOTS = process.env.NB_SIDEBAR_SHOTS ?? resolve(ROOT, "screenshots/sidebar");
mkdirSync(SHOTS, { recursive: true });
const darwin = process.platform === "darwin";
/// The AppKit host; the GTK host also runs on macOS (Quartz), with no pointer
/// synthesis there.
const appkit = darwin && process.env.ND_BACKEND !== "gtk";
const store = mkdtempSync(join(tmpdir(), "nb-sidebar-"));
const { openPalette, typeQuery } = paletteDriver({ timeoutMs: PATIENCE });
const DOWNLOADS = mkdtempSync(join(tmpdir(), "nb-sidebar-dl-"));

// ---------------------------------------------------------------- fixture ---

const PAGES: Record<string, string> = {
  mail: "Inbox",
  cal: "Calendar",
  code: "Repositories",
  docs: "Project docs",
  long: "Quarterly engineering review and roadmap for the next fiscal year",
  plain: "Example page",
  news: "Front page",
  music: "Library",
  maps: "Directions",
};
/// A page that holds its load open, so the load bar can be caught mid-load.
/// Every held request, since an engine can ask twice for one navigation.
const held: (() => void)[] = [];
/// Once released, later requests for a slow page are answered at once: an
/// engine that asks again after the release must not be held for good.
let slowOpen = false;
/// Answers the held page. The engine can show a load before its request has
/// reached the server, so this waits for one to be held first.
async function slowRelease(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (held.length === 0 && Date.now() < deadline) await Bun.sleep(100);
  slowOpen = true;
  for (const done of held.splice(0)) done();
}
const PAGE_BLUE = "#2f6bff";
const serve = (port: number) => Bun.serve({
  port,
  hostname: "127.0.0.1",
  // A held page outlives Bun's 10 s idle cut-off while a slow capture runs,
  // and the engine then shows an empty response instead of the page.
  idleTimeout: 0,
  async fetch(req) {
    const key = new URL(req.url).pathname.slice(1);
    if (key.startsWith("slow") && !slowOpen) {
      await new Promise<void>((done) => {
        held.push(done);
        setTimeout(done, PATIENCE);
      });
    }
    if (key === "report.txt") {
      return new Response("sidebar drive download\n", {
        headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="quarterly-report.txt"' },
      });
    }
    const title = PAGES[key] ?? (key.startsWith("bg-") ? `Page on ${key.slice(3)}` : "Slow page");
    const bg = key.startsWith("bg-") ? `#${key.slice(3)}` : PAGE_BLUE;
    return new Response(
      `<!doctype html><title>${title}</title><style>html,body{margin:0;height:100%;background:${bg}}` +
        `h1{margin:0;padding:24px;color:#fff;font:600 28px system-ui}</style><h1>${title}</h1>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const server = serve(Number(process.env.ND_ACCEPT_FIXTURE_PORT ?? 0) || 0);
const base = `http://127.0.0.1:${server.port}`;
/// A second origin, for the one site with a favicon in the cache: the cache is
/// keyed by origin, and every other fixture page shares the first.
const iconServer = serve(0);
const iconBase = `http://127.0.0.1:${iconServer.port}`;
for (const look of ["light", "dark"]) mkdirSync(join(store, "favicons", look), { recursive: true });
const ICON = sh(
  "python3",
  "-c",
  `import base64,io
from PIL import Image
b=io.BytesIO(); Image.new("RGB",(32,32),(255,140,0)).save(b,"PNG"); print(base64.b64encode(b.getvalue()).decode())`,
).trim();
for (const look of ["light", "dark"]) writeFileSync(join(store, "favicons", look, encodeURIComponent(iconBase)), `data:image/png;base64,${ICON}`);

/// The page a tab restores to. Linux CEF never requests a restored tab's
/// http address (main has the same gap), so there the pages are data URLs,
/// which it does load at creation.
function pageUrl(path: string): string {
  if (darwin) return `${path === "mail" ? iconBase : base}/${path}`;
  return (
    "data:text/html," +
    encodeURIComponent(
      `<!doctype html><title>${PAGES[path]}</title><style>html,body{margin:0;height:100%;background:${PAGE_BLUE}}</style>`,
    )
  );
}

const tab = (id: string, path: string, extra: object = {}) => ({
  id,
  url: path ? pageUrl(path) : "",
  title: PAGES[path] ?? "",
  pinned: false,
  ...extra,
});
writeFileSync(
  join(store, "session.json"),
  JSON.stringify({
    version: 2,
    data: {
      windows: [
        {
          id: "w1",
          tabs: [
            tab("t1", "mail", { pinned: true }),
            tab("t2", "cal", { pinned: true }),
            tab("t3", "code", { pinned: true }),
            tab("t4", "docs", { pinned: true }),
            tab("t5", "long"),
            tab("t6", "plain"),
            // Pinned and unpinned by the grid leg, for five and seven pins.
            tab("t7", "news"),
            tab("t8", "music"),
            tab("t9", "maps"),
          ],
          activeId: "t6",
          width: 1280,
          height: 800,
        },
      ],
      nextTabId: 10,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);

/// The host's reveal trace (ND_REVEAL_TRACE): one line per display frame
/// while the peeking panel slides, with where the panel and the close button
/// are on screen.
type RevealFrame = { dir: string; t: number; panel: number; close: number; alpha: number; hidden: boolean; at: number };
const revealFrames: RevealFrame[] = [];
/// Icon names the GTK host could not find in its theme.
const missingIcons = new Set<string>();
const slowdown = Number(process.env.ND_ANIMATION_SLOWDOWN ?? 1);
const look = process.env.ND_APPEARANCE ?? "system";

const launchOptions = {
  entry: "src/main.tsx",
  cwd: ROOT,
  hostBinary: process.env.ND_HOST_BINARY,
  // Every profile the app or its engine could open is the run's own: the
  // engine's cache (and with it installed extensions) defaults to one under
  // the user's data dir, which is the owner's live profile on a dev machine.
  env: {
    NB_STORE_DIR: store,
    NB_DOWNLOAD_DIR: DOWNLOADS,
    NB_TEST_HOOKS: "1",
    ND_APP_ID: "dev.nativebrowser.sidebar",
    XDG_DATA_HOME: join(store, "data"),
    ND_CEF_CACHE: process.env.ND_CEF_CACHE || join(store, "cef"),
    ND_REVEAL_TRACE: "1",
  },
  readyTimeoutMs: PATIENCE * 2,
  rpcTimeoutMs: PATIENCE,
  logPath: process.env.NB_SIDEBAR_HOST_LOG,
  onStderr: (line: string) => {
    const icon = /^ND_WARN icon "([^"]+)" is not in the icon theme/.exec(line);
    if (icon) missingIcons.add(icon[1]!);
    const m = /^ND_REVEAL_FRAME dir=(\w+) t=([\d.]+) panel=(-?[\d.]+) close=(-?[\d.]+) alpha=([\d.]+) hidden=(\d)/.exec(line);
    if (m) revealFrames.push({ dir: m[1]!, t: +m[2]!, panel: +m[3]!, close: +m[4]!, alpha: +m[5]!, hidden: m[6] === "1", at: Date.now() });
  },
  // A second host on the first one's CEF profile hands its launch to the first,
  // which then opens a whole Chromium window of its own: a slow first start
  // must fail the run, not be relaunched over.
  retries: 0,
};
const app = await launchApp(launchOptions);
let closed = false;

// ---------------------------------------------------------------- helpers ---

type Rect = { x: number; y: number; w: number; h: number };
const mid = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;
const tree = async (): Promise<JsonNode> => (await app.tree()).root;

async function rect(id: string): Promise<Rect> {
  const node = await app.mustFind(id);
  const g = node.geometry;
  if (!g || g.w <= 0 || g.h <= 0) fail(`${id} has no geometry (${JSON.stringify(g)})`);
  return g!;
}

async function maybeRect(id: string): Promise<Rect | null> {
  const node = await app.find(id);
  const g = node?.geometry;
  return g && g.w > 0 && g.h > 0 && node?.visible !== false ? g : null;
}

/// A node mounted a moment ago, once GTK has allocated it: the load bar
/// mounts when its load starts and reads as hidden, with no size, until the
/// next frame lays it out.
async function laidOut(id: string): Promise<Rect> {
  return (await waitFor(`${id} to be laid out`, () => maybeRect(id), (r) => r !== null))!;
}

async function settle(id: string): Promise<Rect> {
  let last = "";
  const deadline = Date.now() + PATIENCE;
  while (Date.now() < deadline) {
    const r = await rect(id);
    const k = JSON.stringify(r);
    if (k === last) return r;
    last = k;
    await Bun.sleep(200);
  }
  return fail(`${id} never settled`);
}

async function windowRect(): Promise<Rect> {
  return (await app.windows()).windows[0]?.geometry ?? fail("no window geometry");
}

function sh(...argv: string[]): string {
  const r = Bun.spawnSync(argv);
  if (r.exitCode !== 0) fail(`${argv[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/// Captures the window with what is over it, and returns a reader whose
/// points are window points.
/// The window's area of the screen, popovers and menus included: a popover is
/// a surface of its own, which a capture of the window leaves out.
async function captureScreen(name: string): Promise<string | null> {
  const path = `${SHOTS}/${appkit ? "mac" : "gtk"}-${name}.png`;
  if (darwin) {
    const win = ndshotWindows(app.pid).find((w) => w.title !== "") ?? fail("ndshot sees no app window");
    sh("timeout", "30", NDSHOT, "capture", "--window-id", String(win.windowID), "--region", "--no-focus", "--out", path);
  } else if (process.env.WAYLAND_DISPLAY && !process.env.ND_SIDEBAR_X11) {
    // XWayland's rootless root window cannot be read back; the compositor's
    // output can, a few frames after the client drew (as in capture()).
    await Bun.sleep(1500);
    sh("grim", path);
  } else if (process.env.DISPLAY) {
    sh("import", "-window", "root", "-silent", path);
  } else return null;
  console.log(`  capture ${path}`);
  return path;
}

type Shot = { path: string; pixel: (x: number, y: number) => number[]; ox: number; oy: number; scale: number };

async function capture(name: string): Promise<Shot | null> {
  const path = `${SHOTS}/${appkit ? "mac" : "gtk"}-${name}.png`;
  let ox = 0;
  let oy = 0;
  let scale = 1;
  if (darwin) {
    const win = ndshotWindows(app.pid).find((w) => w.title !== "") ?? fail("ndshot sees no app window");
    const out = sh("timeout", "30", NDSHOT, "capture", "--window-id", String(win.windowID), "--out", path);
    scale = Number(out.trim().split(" ").pop()!.split("x")[0]) / win.width;
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
    if (process.env.WAYLAND_DISPLAY && !process.env.ND_SIDEBAR_X11) {
      // A headless Hyprland repaints an XWayland window a few frames after
      // the client has drawn; a capture right away shows the state before.
      await Bun.sleep(1500);
      sh("grim", path);
    } else sh("import", "-window", "root", path);
    const origin = linuxWindowOrigin();
    ox = origin.x;
    oy = origin.y;
    scale = origin.scale;
  }
  console.log(`  capture ${path}`);
  const pixel = (x: number, y: number): number[] => {
    const px = Math.round(ox + x * scale);
    const py = Math.round(oy + y * scale);
    const out = sh("python3", "-c", `from PIL import Image;print(*Image.open(${JSON.stringify(path)}).convert("RGB").getpixel((${px},${py})))`);
    return out.trim().split(" ").map(Number);
  };
  return { path, pixel, ox, oy, scale };
}

/// The median luminance inside each rect, 4 px in from its edges, on a
/// capture: the fill a tile or row is drawn on, whatever small mark sits in it.
function medianLuminance(shot: Shot, rects: Rect[]): number[] {
  return JSON.parse(
    sh(
      "python3",
      "-c",
      `from PIL import Image
import json
im = Image.open(${JSON.stringify(shot.path)}).convert("L"); ox, oy, s = ${shot.ox}, ${shot.oy}, ${shot.scale}
out = []
for r in ${JSON.stringify(rects)}:
    px = [im.getpixel((int(ox + x * s), int(oy + y * s))) for y in range(int(r["y"]) + 4, int(r["y"] + r["h"]) - 4) for x in range(int(r["x"]) + 4, int(r["x"] + r["w"]) - 4)]
    px.sort()
    out.append(px[len(px) // 2])
print(json.dumps(out))`,
    ),
  ) as number[];
}

/// The app window's top-left on the screen capture, in device pixels. The
/// window's own content origin: xwininfo reports the X window GTK draws in,
/// shadow margins included, which GTK's own geometry already accounts for.
function linuxWindowOrigin(): { x: number; y: number; scale: number } {
  const id = sh("xdotool", "search", "--onlyvisible", "--pid", String(app.pid)).trim().split("\n")[0]!;
  const info = sh("xwininfo", "-id", id);
  const x = Number(/Absolute upper-left X:\s+(-?\d+)/.exec(info)?.[1] ?? 0);
  const y = Number(/Absolute upper-left Y:\s+(-?\d+)/.exec(info)?.[1] ?? 0);
  return { x, y, scale: Number(process.env.ND_ACCEPT_SCALE ?? 1) };
}

function isPageBlue(rgb: number[]): boolean {
  const want = [0x2f, 0x6b, 0xff];
  return rgb.every((c, i) => Math.abs(c - want[i]!) < 40);
}

/// Where the close button's red is, in window points, inside `box`. Red by
/// how far it stands from green and blue: light mode draws it paler.
function redCentroid(path: string, scale: number, box: Rect): { x: number; y: number; n: number } {
  const out = sh(
    "python3",
    "-c",
    `from PIL import Image
im=Image.open(${JSON.stringify(path)}).convert("RGB");s=${scale}
xs=[];ys=[]
for y in range(int(${box.y}*s),int(${box.y + box.h}*s)):
  for x in range(int(${box.x}*s),int(${box.x + box.w}*s)):
    r,g,b=im.getpixel((x,y))
    if r>180 and r-g>70 and r-b>70 and b>40: xs.append(x); ys.append(y)
n=len(xs)
print(sum(xs)/n/s if n else -1, sum(ys)/n/s if n else -1, n)`,
  );
  const [x, y, n] = out.trim().split(" ").map(Number);
  return { x: x!, y: y!, n: n! };
}

/// Every descendant with a testID, for asserting what a layout does not draw.
async function testIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  walk(await tree(), (n) => {
    if (n.testID) ids.add(n.testID);
  });
  return ids;
}

async function pointer(action: "move" | "click", x: number, y: number): Promise<void> {
  if (appkit) {
    if (action === "move") await app.cursor.move({ x, y }, { steps: 8 });
    else await app.cursor.click({ x, y });
    return;
  }
  const w = linuxWindowOrigin();
  const px = Math.round(w.x + x * w.scale);
  const py = Math.round(w.y + y * w.scale);
  // XWayland drives XTEST motion against its own pointer, which exists only
  // once the seat has a pointer: headless Hyprland has no input device until
  // a virtual pointer binds one, and until then the warp is dropped.
  for (let attempt = 0; ; attempt++) {
    sh("xdotool", "mousemove", String(px), String(py));
    const m = sh("xdotool", "getmouselocation").match(/x:(-?\d+)\s+y:(-?\d+)/);
    if (Math.abs(Number(m?.[1]) - px) <= 1 && Math.abs(Number(m?.[2]) - py) <= 1) break;
    if (attempt === 4) fail(`the pointer did not reach ${px},${py} (at ${m?.[0]})`);
    if (process.env.HYPRLAND_INSTANCE_SIGNATURE) sh("wlrctl", "pointer", "move", "0", "0");
    await Bun.sleep(150);
  }
  if (action === "click") sh("xdotool", "click", "1");
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  if (appkit) return app.cursor.drag(from, to, { steps: 24 });
  const w = linuxWindowOrigin();
  const at = (p: { x: number; y: number }) => [String(Math.round(w.x + p.x * w.scale)), String(Math.round(w.y + p.y * w.scale))];
  sh("xdotool", "mousemove", ...at(from));
  await Bun.sleep(200);
  sh("xdotool", "mousedown", "1");
  await Bun.sleep(200);
  // Slow enough for GTK to start the XDND session and for the target to see
  // the pointer arrive before the release.
  for (let i = 1; i <= 20; i++) {
    sh("xdotool", "mousemove", ...at({ x: from.x + ((to.x - from.x) * i) / 20, y: from.y + ((to.y - from.y) * i) / 20 }));
    await Bun.sleep(60);
  }
  await Bun.sleep(400);
  sh("xdotool", "mouseup", "1");
}

async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + PATIENCE;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await Bun.sleep(150);
  }
  return fail(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/// Today's rows, in order, by tab id.
async function todayOrder(): Promise<string[]> {
  const list = await app.mustFind("today-tabs");
  const ids: string[] = [];
  walk(list, (n) => {
    const m = /^tab-slot-(.+)$/.exec(n.testID ?? "");
    if (m) ids.push(m[1]!);
  });
  return ids;
}

// ------------------------------------------------------------------- legs ---

const gtkControls = process.env.ND_SIDEBAR_CONTROLS ?? "end";

async function geometryLeg(width: number): Promise<void> {
  await app.setWindowSize(width, 800);
  await settle("sidebar");
  const line = `width=${width}`;

  // Window controls: in the first row, or (GTK, trailing layout) in the strip.
  // With none on the leading side the row is not drawn at all.
  const sidebar = await rect("sidebar");
  const leading = appkit || gtkControls === "start";
  const row = leading ? await rect("controls-row") : null;
  if (!leading && (await maybeRect("controls-row"))) fail(`${line}: an empty controls row still takes room in the sidebar`);
  const firstTile = await rect("tab-slot-t1");
  if (!leading && !near(firstTile.y, sidebar.y + 8, 1)) fail(`${line}: the pinned tiles start at ${firstTile.y}, not at the sidebar's top inset`);
  if (!appkit && gtkControls === "none") {
    // No buttons at all (a tiling compositor's ":" layout): nothing is kept
    // for them. No strip, and the card starts at the sidebar's own top inset.
    const strip = await maybeRect("controls-strip");
    if (strip) fail(`${line}: an empty layout still draws a controls strip (${JSON.stringify(strip)})`);
    for (const id of ["controls-start", "controls-end"]) {
      const r = await maybeRect(id);
      if (r && r.w > 1) fail(`${line}: ${id} takes ${r.w}px with no buttons to show`);
    }
    const card = await rect("content");
    if (!near(card.y, sidebar.y + 8, 1)) fail(`${line}: the card starts at ${card.y}, the sidebar's top inset is ${sidebar.y + 8}`);
  } else if (row) {
    const slot = await rect("controls-start");
    if (!near(mid(slot).y, mid(row).y)) fail(`${line}: window controls off the row's centre (${JSON.stringify({ slot, row })})`);
    // The buttons share the column's leading margin with the tiles and the
    // row fills under them.
    if (!near(slot.x, firstTile.x, 1)) fail(`${line}: window controls start at ${slot.x}, the tiles at ${firstTile.x}`);
    if (slot.x + slot.w > sidebar.x + sidebar.w) fail(`${line}: window controls leave the sidebar`);
    if (!appkit && (await maybeRect("controls-end"))) fail(`${line}: a trailing controls slot is drawn with a leading layout`);
    if (!appkit && (await maybeRect("controls-strip"))) fail(`${line}: a leading layout still draws the trailing strip over the card`);
  } else {
    const slot = await rect("controls-end");
    const strip = await rect("controls-strip");
    const card = await rect("content");
    if (slot.x < sidebar.x + sidebar.w) fail(`${line}: the window controls are inside the sidebar (${JSON.stringify({ slot, sidebar })})`);
    if (slot.x < strip.x - 1 || slot.x + slot.w > strip.x + strip.w + 1 || slot.y < strip.y - 1 || slot.y + slot.h > strip.y + strip.h + 1) {
      fail(`${line}: the controls leave their strip (${JSON.stringify({ slot, strip })})`);
    }
    if (card.y < slot.y + slot.h) fail(`${line}: the page card starts above the controls' bottom edge (${JSON.stringify({ card, slot })})`);
    // As short as the controls, plus the platform's padding and no more.
    if (strip.h > slot.h + 2 * 8 + 1) fail(`${line}: the strip is ${strip.h} tall for ${slot.h} of controls`);
    if (!near(strip.x + strip.w, (await windowRect()).w, 1)) fail(`${line}: the strip does not reach the window's trailing edge`);
  }

  // Rows stay inside the sidebar, and a long title is cut rather than
  // widening the column.
  const long = await rect("tab-t5");
  const longRow = await rect("tab-slot-t5");
  if (long.x + long.w > longRow.x + longRow.w + 1) fail(`${line}: the long title overflows its row`);
  // And the title gets the row's whole free run: everything but the trailing
  // slot (24), the row's insets and the gap before the trailing slot (up to
  // 8 each), never cut down to a few characters.
  if (long.w < longRow.w - 24 - 8 - 8 - 1) fail(`${line}: the long title has ${long.w} of its row's ${longRow.w}`);
  if (longRow.x + longRow.w > sidebar.x + sidebar.w) fail(`${line}: a tab row overflows the sidebar`);

  // Pinned tabs: the grid, and each tile's mark in its middle.
  await gridCheck(line);

  // Every icon drawn so far is in the theme: a row with no favicon shows the
  // globe, never GTK's missing-image glyph.
  if (missingIcons.size) fail(`${line}: icons missing from the theme: ${[...missingIcons].join(", ")}`);

  // The foot: settings leading on macOS, downloads leading and the New Tab
  // plus trailing on GTK, all on one centre line.
  const bar = await rect("bottom-bar");
  const lead = await rect(appkit ? "sidebar-settings" : "downloads-button");
  if (!near(lead.x, bar.x, 1)) fail(`${line}: ${appkit ? "settings" : "downloads"} is not at the foot's leading edge`);
  for (const id of ["sidebar-settings", "downloads-button"]) {
    const r = await rect(id);
    if (!near(mid(r).y, mid(lead).y)) fail(`${line}: ${id} is off the foot's centre line`);
  }
  if (!appkit) {
    const plus = await rect("new-tab");
    if (!near(plus.x + plus.w, bar.x + bar.w, 1)) fail(`${line}: the New Tab plus is not at the foot's trailing edge (${JSON.stringify({ plus, bar })})`);
    if (!near(mid(plus).y, mid(lead).y)) fail(`${line}: the New Tab plus is off the downloads button's centre line`);
  }

  const shot = await capture(`sidebar-${width}`);
  if (shot && appkit) {
    const slot = await rect("controls-start");
    const scale = Number(sh("python3", "-c", `from PIL import Image;print(Image.open(${JSON.stringify(shot.path)}).width/${(await windowRect()).w})`).trim());
    const red = redCentroid(shot.path, scale, { x: slot.x - 4, y: 0, w: slot.w + 8, h: row!.y + row!.h + 8 });
    // The close button (14 pt) sits as far from the window's left edge as
    // from its top, and its left edge is the tiles' left edge.
    if (red.n < 20 || !near(red.y, mid(slot).y) || !near(red.x, red.y, 1) || !near(red.x - 7, firstTile.x, 1)) {
      fail(`${line}: the close button's centre is ${red.x.toFixed(1)},${red.y.toFixed(1)} (${red.n} px): left gap ${(red.x - 7).toFixed(1)}, top gap ${(red.y - 7).toFixed(1)}, tiles at ${firstTile.x}`);
    }
  }
  console.log(`  NB_SIDEBAR_GEOMETRY_OK ${line} sidebar=${sidebar.w} long=${long.w}`);
}

/// The pinned grid (docs/sidebar.md): Arc's favourites. The drive knows the
/// rule's numbers: 40 pt at least per tile, four columns at most, 6 between
/// tiles, and Arc's height for the width, measured off the owner's reference
/// (a tile 108 px wide is 80 tall there).
const PIN_MIN = 40;
const PIN_COLUMNS = 4;
const PIN_GAP = 6;
const ARC_RATIO = 80 / 108;

/// The pinned tiles in their order in the block.
async function pinnedOrder(): Promise<string[]> {
  const block = await app.find("pinned-tabs");
  const ids: string[] = [];
  if (block) {
    walk(block, (n) => {
      const m = /^tab-slot-(.+)$/.exec(n.testID ?? "");
      if (m) ids.push(m[1]!);
    });
  }
  return ids;
}

/// The tiles fill the column's content width exactly: the first column
/// starts on the tab rows' leading edge, a full row ends on their trailing
/// edge (the same inset mirrored), every tile is one cell, the last row's
/// tiles sit on the column pitch, and a tile is Arc's height for its width.
async function gridCheck(line: string): Promise<{ columns: number; w: number; h: number }> {
  const ids = await pinnedOrder();
  if (ids.length === 0) fail(`${line}: no pinned tiles`);
  const sidebar = await rect("sidebar");
  const row = await rect("tab-slot-t6");
  const left = row.x;
  const right = row.x + row.w;
  const span = right - left;
  if (!near(left - sidebar.x, sidebar.x + sidebar.w - right, 1)) {
    fail(`${line}: the rows are not inset evenly (${left - sidebar.x} leading, ${sidebar.x + sidebar.w - right} trailing)`);
  }
  const tiles = await Promise.all(ids.map((id) => rect(`tab-slot-${id}`)));
  const first = tiles[0]!;
  // A short single row has fewer tiles than columns, so the count comes
  // from the cell width, and the first row then has to agree with it.
  const columns = Math.round((span + PIN_GAP) / (first.w + PIN_GAP));
  const dump = JSON.stringify({ span, tiles });
  if (columns < 1 || columns > PIN_COLUMNS) fail(`${line}: ${columns} columns (${dump})`);
  const firstRow = tiles.filter((t) => near(t.y, first.y, 1)).length;
  if (firstRow !== Math.min(ids.length, columns)) fail(`${line}: ${firstRow} tiles in the first row, ${columns} columns (${dump})`);
  // As many columns as fit at the minimum width, unless the cap is hit; the
  // GTK tile's own minimum can make a column wider than the floor.
  const fit = Math.min(PIN_COLUMNS, Math.floor((span + PIN_GAP) / (PIN_MIN + PIN_GAP)));
  if (appkit ? columns !== fit : columns > fit) fail(`${line}: ${columns} columns in ${span} pt, the rule gives ${fit} (${dump})`);
  const cell = (span - PIN_GAP * (columns - 1)) / columns;
  const pitch = cell + PIN_GAP;
  for (const [i, t] of tiles.entries()) {
    const at = { x: left + (i % columns) * pitch, y: first.y + Math.floor(i / columns) * (first.h + PIN_GAP) };
    if (!near(t.w, cell, 1) || !near(t.h, first.h, 1)) fail(`${line}: tile ${ids[i]} is ${t.w}x${t.h}, a cell is ${cell.toFixed(1)}x${first.h} (${dump})`);
    if (!near(t.x, at.x, 1) || !near(t.y, at.y, 1)) fail(`${line}: tile ${ids[i]} is at ${t.x},${t.y}, its cell at ${at.x.toFixed(1)},${at.y.toFixed(1)} (${dump})`);
    const mark = await rect(`tab-${ids[i]}`);
    if (!near(mid(t).x, mid(mark).x) || !near(mid(t).y, mid(mark).y)) {
      fail(`${line}: tile ${ids[i]}'s mark is off its centre (${JSON.stringify({ tile: t, mark })})`);
    }
  }
  if (!near(first.x, left, 1)) fail(`${line}: the tiles start at ${first.x}, the rows at ${left}`);
  if (ids.length >= columns) {
    const end = tiles[columns - 1]!;
    if (!near(end.x + end.w, right, 1)) fail(`${line}: the last column ends at ${end.x + end.w}, the rows at ${right}`);
  }
  const ratio = first.h / first.w;
  if (Math.abs(ratio - ARC_RATIO) / ARC_RATIO > 0.02) fail(`${line}: a tile is ${first.w}x${first.h} (${ratio.toFixed(3)}), Arc's is ${ARC_RATIO.toFixed(3)}`);
  return { columns, w: first.w, h: first.h };
}

/// Pins or unpins one tab through the Tabs menu, on the tab itself.
async function setPinned(id: string, pinned: boolean): Promise<void> {
  const order = [...(await pinnedOrder()), ...(await todayOrder())];
  await app.click(`menu-tab-${order.indexOf(id)}`);
  // A tile on show carries its live marker, a row on show its close button.
  await waitFor(`${id} on show`, async () => (await app.find(`tab-live-${id}`)) ?? (await app.find(`tab-close-${id}`)), (n) => n !== null);
  await app.click("menu-pin-tab");
  await waitFor(`${id} ${pinned ? "pinned" : "unpinned"}`, pinnedOrder, (o) => o.includes(id) === pinned);
}

async function gridLeg(): Promise<void> {
  const report: string[] = [];
  const counts: [number, string[]][] = [
    [4, []],
    [3, ["-t4"]],
    [2, ["-t3"]],
    [1, ["-t2"]],
    [5, ["+t2", "+t3", "+t4", "+t7"]],
    [7, ["+t8", "+t9"]],
  ];
  for (const [count, moves] of counts) {
    for (const m of moves) await setPinned(m.slice(1), m[0] === "+");
    if ((await pinnedOrder()).length !== count) fail(`expected ${count} pins, have ${JSON.stringify(await pinnedOrder())}`);
    for (const width of [720, 1280]) {
      await app.setWindowSize(width, 800);
      await settle("sidebar");
      await settle(`tab-slot-${(await pinnedOrder()).at(-1)}`);
      const g = await gridCheck(`pins=${count} width=${width}`);
      report.push(`${count}@${width}=${g.columns}x${g.w}x${g.h}`);
      if (count === 4 || count === 7) await capture(`grid-${look}-${count}-${width}`);
    }
  }
  // The sidebar resized by the window; the divider drag comes late in the
  // drive (dividerLeg), since the split keeps a dragged width after.
  for (const width of [900, 1100]) {
    await app.setWindowSize(width, 800);
    await settle("sidebar");
    await settle("tab-slot-t9");
    const g = await gridCheck(`pins=7 width=${width}`);
    report.push(`7@${width}=${g.columns}x${g.w}x${g.h}`);
  }
  for (const id of ["t9", "t8", "t7"]) await setPinned(id, false);
  await app.click(`menu-tab-${[...(await pinnedOrder()), ...(await todayOrder())].indexOf("t6")}`);
  console.log(`  NB_SIDEBAR_GRID_OK ${report.join(" ")}`);
}

/// GTK: the tab on show reads at a glance as a row, as a tile with a favicon
/// and as a tile with a letter, in its pixels: its fill stands apart from
/// every tab of its kind at rest. GTK has no glass to raise a tile with.
async function selectionLeg(): Promise<void> {
  if (!darwin) {
    // Linux restores tabs as data URLs, which no favicon is cached for, so
    // the first tile goes to the one site that has one.
    await app.click("tab-t1");
    await waitFor("t1 on show", () => app.find("tab-live-t1"), (n) => n !== null);
    await app.click("tab-t1");
    await app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: PATIENCE });
    await typeQuery(app, `${iconBase}/mail`);
    await app.setValue("palette", true);
    await waitFor("the command bar to close", async () => (await app.find("palette"))?.visible ?? false, (v) => !v);
    await waitFor("the site to load", async () => (await app.find("progress"))?.value ?? 1, (v) => Number(v) >= 1);
  }
  const iconShown = () => waitFor("the first tile's favicon", async () => (await app.mustFind("tab-t1")).text ?? "", (t) => t === "");
  const tiles = ["t1", "t2", "t3", "t4"];
  const rows = ["t5", "t6"];
  const report: string[] = [];
  for (const width of [1280, 720]) {
    await app.setWindowSize(width, 800);
    await settle("sidebar");
    for (const [id, kind] of [["t6", "row"], ["t1", "icon-tile"], ["t2", "letter-tile"]] as const) {
      // A click on the tab already on show opens the command bar instead.
      if (!(await app.find(`tab-live-${id}`)) && !(await app.find(`tab-close-${id}`))) await app.click(`tab-${id}`);
      await waitFor(`${id} on show`, async () => (await app.find(`tab-live-${id}`)) ?? (await app.find(`tab-close-${id}`)), (n) => n !== null);
      await iconShown();
      await Bun.sleep(400);
      const shot = await capture(`active-${kind}-${look}-${width}`);
      if (!shot) continue;
      const group = kind === "row" ? rows : tiles;
      const lums = medianLuminance(shot, await Promise.all(group.map((t) => rect(`tab-slot-${t}`))));
      const live = lums[group.indexOf(id)]!;
      const gap = Math.min(...lums.filter((_, i) => group[i] !== id).map((l) => Math.abs(l - live)));
      if (gap < 12) fail(`width=${width}: the ${kind} on show is not set apart from the rest (median luminance ${lums.join(",")}, ${id} on show)`);
      report.push(`${kind}@${width}=${gap}`);
    }
  }
  await app.click("tab-t6");
  await waitFor("t6 on show", () => app.find("tab-close-t6"), (n) => n !== null);
  // The width the grid leg left the window at, which the load bar leg after
  // this one was written against.
  await app.setWindowSize(1100, 800);
  await settle("sidebar");
  console.log(`  NB_SIDEBAR_SELECTION_OK ${look}: luminance gap of the tab on show to the nearest at rest ${report.join(" ")}`);
}

/// AppKit, with the real cursor: a pinned tile pressed and dragged over the
/// others moves them aside while it is held; Escape, and a release where
/// nothing takes a drop, put them back; a drop on a tile commits the order. A plain
/// click still selects. The frames of the held drag go in a strip.
async function reorderLeg(): Promise<void> {
  await app.setWindowSize(1280, 800);
  await waitFor("the window at 1280", windowRect, (r) => r.w === 1280);
  await settle("tab-slot-t4");
  const start = await pinnedOrder();
  if (JSON.stringify(start) !== JSON.stringify(["t1", "t2", "t3", "t4"])) fail(`the pins start as ${JSON.stringify(start)}`);
  const strip: string[] = [];
  /// Presses on one tile and carries it over another, and leaves it held.
  async function hold(id: string, over: string, frames = false): Promise<void> {
    const from = mid(await rect(`tab-slot-${id}`));
    const to = mid(await rect(`tab-slot-${over}`));
    await app.cursor.move(from, { steps: 8 });
    await app.cursor.down();
    await app.cursor.move({ x: from.x + 10, y: from.y + 3 }, { steps: 6 });
    if (frames) strip.push((await captureScreen(`reorder-1-lifted`))!);
    await app.cursor.move(to, { steps: 30 });
    if (frames) {
      // The others on their way to their new cells, then settled.
      strip.push((await captureScreen(`reorder-2-sliding`))!);
      await Bun.sleep(400);
      strip.push((await captureScreen(`reorder-3-held`))!);
    }
  }
  const expect = async (what: string, order: string[]) =>
    waitFor(what, pinnedOrder, (o) => JSON.stringify(o) === JSON.stringify(order));

  // The press on a glass tile: macOS 27's interactive glass brightens and
  // swells the pill under the pointer (the system's response, nothing the
  // app animates). Measured on a strip of the tile away from its letter.
  const pressed = await rect("tab-slot-t3");
  const glow = async (name: string): Promise<number> => {
    const path = (await captureScreen(`reorder-glass-${name}`))!;
    strip.push(path);
    return Number(
      sh("python3", "-c", `from PIL import Image, ImageStat
im = Image.open(${JSON.stringify(path)}).convert("L"); s = im.width / 1280
print(ImageStat.Stat(im.crop((int(${pressed.x + 4} * s), int(${pressed.y + pressed.h * 0.2} * s), int(${pressed.x + pressed.w * 0.25} * s), int(${pressed.y + pressed.h * 0.8} * s)))).mean[0])`).trim(),
    );
  };
  await app.cursor.move(mid(pressed), { steps: 8 });
  await Bun.sleep(400);
  const resting = await glow("0-resting");
  await app.cursor.down();
  await Bun.sleep(120);
  const lit = await glow("1-pressed");
  await app.cursor.up();
  await Bun.sleep(600);
  // And on the last tile, whose swell reaches past the column's edge.
  await app.cursor.move(mid(await rect("tab-slot-t4")), { steps: 8 });
  await app.cursor.down();
  await Bun.sleep(120);
  strip.push((await captureScreen("reorder-glass-2-pressed-edge"))!);
  await app.cursor.up();
  await Bun.sleep(600);
  const major = Number(sh("sw_vers", "-productVersion").split(".")[0]);
  if (major >= 27 && lit - resting < 1) fail(`the pressed glass tile did not light up (${resting.toFixed(1)} -> ${lit.toFixed(1)})`);
  console.log(`  glass press on macOS ${major}: ${resting.toFixed(1)} -> ${lit.toFixed(1)}`);

  // Held over the last tile, the others move aside; Escape puts them back.
  await hold("t2", "t4");
  await expect("t2 shown in the last slot while held", ["t1", "t3", "t4", "t2"]);
  Bun.spawnSync(["osascript", "-e", 'tell application "System Events" to key code 53']);
  await Bun.sleep(400);
  await app.cursor.up();
  await expect("Escape to put the tiles back", start);
  await Bun.sleep(600);

  // Released where nothing takes a drop (the foot's empty stretch): the
  // same. Not outside the window, where the release lands on whatever the
  // desktop has there, and the screen's top edge opens Mission Control.
  await hold("t2", "t4");
  const foot = await rect("bottom-bar");
  await app.cursor.move({ x: foot.x + foot.w - 30, y: foot.y + foot.h / 2 }, { steps: 20 });
  await app.cursor.up();
  await expect("a release on the foot to put the tiles back", start);
  await Bun.sleep(600);

  // Dropped on the third tile: the first moves to the third slot.
  await hold("t1", "t3", true);
  await expect("t1 shown in the third slot while held", ["t2", "t3", "t1", "t4"]);
  await app.cursor.up();
  await Bun.sleep(600);
  await expect("the drop to keep t1 in the third slot", ["t2", "t3", "t1", "t4"]);
  strip.push((await captureScreen(`reorder-4-dropped`))!);
  await gridCheck("after the reorder");

  // A plain click on a tile still selects its tab.
  await app.cursor.click(mid(await rect("tab-slot-t2")));
  await waitFor("t2 on show after a click", () => app.find("tab-live-t2"), (n) => n !== null);
  if (JSON.stringify(await pinnedOrder()) !== JSON.stringify(["t2", "t3", "t1", "t4"])) fail("a click moved a tile");

  const out = `${SHOTS}/mac-reorder-strip-${look}.png`;
  const t = await rect("pinned-tabs");
  // While a drag is on, the capture is the whole screen (the drag image is a
  // window of its own over the app's), so those frames are offset by where
  // the window is on it.
  const at = await windowRect();
  sh(
    "python3",
    "-c",
    `from PIL import Image, ImageDraw
import os
paths = ${JSON.stringify(strip)}
tiles = []
for p in paths:
    im = Image.open(p).convert("RGB")
    s = 2 if im.width > 2560 else im.width / 1280
    ox, oy = (${at.x}, ${at.y}) if im.width > 2560 else (0, 0)
    c = im.crop((int((ox + ${t.x - 12}) * s), int((oy + ${t.y - 12}) * s), int((ox + ${t.x + t.w + 12}) * s), int((oy + ${t.y + t.h + 12}) * s)))
    canvas = Image.new("RGB", (c.width, c.height + 30), (128, 128, 128)); canvas.paste(c, (0, 30))
    ImageDraw.Draw(canvas).text((8, 8), os.path.basename(p), fill=(255, 255, 255)); tiles.append(canvas)
m = Image.new("RGB", (max(i.width for i in tiles), sum(i.height for i in tiles) + 8 * len(tiles)), (128, 128, 128))
y = 0
for i in tiles:
    m.paste(i, (0, y)); y += i.height + 8
m.save(${JSON.stringify(out)})`,
  );
  console.log(`  NB_SIDEBAR_REORDER_OK held drags moved the others aside, Escape and a release on the foot put them back, a drop kept t2,t3,t1,t4; strip ${out}`);
}

/// AppKit: the sidebar resized by dragging the split's divider with the real
/// cursor, narrower and then wider, and the grid follows each time. Late in
/// the drive: the split holds a dragged width from then on.
async function dividerLeg(): Promise<void> {
  await app.setWindowSize(1100, 800);
  await waitFor("the window at 1100", windowRect, (r) => r.w === 1100);
  await waitFor("the sidebar to widen with it", () => rect("sidebar"), (r) => r.w > 220);
  const report: string[] = [];
  for (const by of [-70, 110]) {
    const before = await settle("sidebar");
    const at = { x: before.x + before.w, y: before.y + before.h / 2 };
    await app.cursor.drag(at, { x: at.x + by, y: at.y }, { steps: 24 });
    const after = await settle("sidebar");
    if (Math.abs(after.w - before.w) < 20) fail(`the divider drag left the sidebar at ${after.w} (was ${before.w})`);
    await settle(`tab-slot-${(await pinnedOrder()).at(-1)}`);
    const g = await gridCheck(`dragged sidebar=${after.w}`);
    report.push(`${after.w}=${g.columns}x${g.w}x${g.h}`);
    await capture(`grid-${look}-dragged-${after.w}`);
  }
  console.log(`  NB_SIDEBAR_GRID_DRAG_OK ${report.join(" ")}`);
}

/// AppKit: each pinned tile is its own Liquid Glass pill, and the tile on show
/// the raised one. With a loose tab on show every tile rests; with a pinned
/// one on show that tile alone is raised. Captured at both widths, and set
/// beside the owner's reference (`~/Developer/nativebrowser-ref`).
async function glassLeg(): Promise<void> {
  const pins = ["t1", "t2", "t3", "t4"];
  const materials = async () => Promise.all(pins.map(async (id) => (await app.mustFind(`tab-slot-${id}`)).material ?? null));
  const resting = await materials();
  if (resting.some((m) => m !== "glass")) fail(`with a loose tab on show the tiles are ${JSON.stringify(resting)}, not all resting glass`);
  // Every other tile is untouched by a tile coming on show, and the rows are
  // no glass at all.
  if ((await app.mustFind("tab-slot-t6")).material === "glass") fail("the tab row on show is drawn as a glass tile");
  await app.click("tab-t2");
  const raised = await waitFor("the second tile to rise", materials, (m) => m[1] === "raised-glass");
  if (raised.filter((m) => m === "glass").length !== 3) fail(`one tile on show, but the tiles are ${JSON.stringify(raised)}`);
  const crops: string[] = [];
  for (const width of [1280, 720]) {
    await app.setWindowSize(width, 800);
    await settle("sidebar");
    await Bun.sleep(600);
    const shot = await capture(`glass-${look}-${width}`);
    if (!shot) continue;
    // The raised tile reads brighter than every resting one, in its pixels.
    const tiles = await Promise.all(pins.map((id) => rect(`tab-slot-${id}`)));
    const lums = JSON.parse(
      sh(
        "python3",
        "-c",
        `from PIL import Image
import json
im = Image.open(${JSON.stringify(shot.path)}).convert("L"); s = im.width / ${width}
out = []
for r in ${JSON.stringify(tiles)}:
    px = [im.getpixel((int(x * s), int(y * s))) for y in range(int(r["y"]) + 4, int(r["y"] + r["h"]) - 4) for x in range(int(r["x"]) + 4, int(r["x"] + r["w"]) - 4)]
    px.sort()
    out.append(px[len(px) // 2])
print(json.dumps(out))`,
      ),
    ) as number[];
    const others = lums.filter((_, i) => i !== 1);
    if (lums[1]! < Math.max(...others) + 6) fail(`width=${width}: the raised tile is not brighter than the resting ones (median luminance ${lums.join(",")})`);
    console.log(`  glass width=${width}: tile luminance ${lums.join(",")} (the second raised)`);
    const bar = await rect("sidebar");
    const rows = await rect("tab-slot-t6");
    // The sidebar's top with a strip of the page beside it: the reference's
    // framing.
    crops.push(`${shot.path}|${bar.x + bar.w + 140}|${rows.y + rows.h + 120}`);
  }
  if (crops.length) {
    const out = `${SHOTS}/mac-glass-montage-${look}.png`;
    sh(
      "python3",
      "-c",
      `from PIL import Image, ImageDraw
import os
H = 720
panes = [("reference (Arc)", Image.open(os.path.expanduser("~/Developer/nativebrowser-ref/arc-glass-pinned.png")).convert("RGB"))]
for spec in ${JSON.stringify(crops)}:
    path, w, h = spec.split("|")
    im = Image.open(path).convert("RGB")
    s = im.width / (1280 if path.endswith("-1280.png") else 720)
    panes.append((os.path.basename(path), im.crop((0, 0, min(im.width, int(float(w) * s)), min(im.height, int(float(h) * s))))))
imgs = []
for label, im in panes:
    im = im.resize((int(im.width * H / im.height), H))
    canvas = Image.new("RGB", (im.width, H + 36), (128, 128, 128))
    canvas.paste(im, (0, 36))
    ImageDraw.Draw(canvas).text((10, 10), label, fill=(255, 255, 255))
    imgs.append(canvas)
m = Image.new("RGB", (sum(i.width for i in imgs) + 16 * (len(imgs) - 1), H + 36), (128, 128, 128))
x = 0
for i in imgs:
    m.paste(i, (x, 0))
    x += i.width + 16
m.save(${JSON.stringify(out)})`,
    );
    console.log(`  montage ${out}`);
  }
  await app.click("tab-t6");
  await waitFor("the tiles to rest again", materials, (m) => m.every((x) => x === "glass"));
  console.log(`  NB_SIDEBAR_GLASS_OK ${look}: resting ${resting.join(",")}, one on show ${raised.join(",")}`);
}

/// The trace of one slide of the peeking panel, once it has run out. With
/// ND_ANIMATION_SLOWDOWN the slide is long enough to capture, and each
/// capture is checked in its pixels too: the close button's red against the
/// first tile's orange favicon, which sits in the tile's middle.
async function peekFrames(dir: "in" | "out", tileW: number): Promise<RevealFrame[]> {
  const shots: string[] = [];
  const ended = () => {
    const mine = revealFrames.filter((f) => f.dir === dir);
    return mine.length > 0 && Date.now() - mine[mine.length - 1]!.at > 300;
  };
  const deadline = Date.now() + 5000 * slowdown;
  let n = 0;
  while (!ended() && Date.now() < deadline) {
    if (slowdown > 1) {
      const win = ndshotWindows(app.pid).find((w) => w.title !== "") ?? fail("ndshot sees no app window");
      const path = `${SHOTS}/mac-peek-${dir}-${String(++n).padStart(2, "0")}.png`;
      sh("timeout", "30", NDSHOT, "capture", "--window-id", String(win.windowID), "--no-focus", "--out", path);
      shots.push(path);
      // The capture blocks; the host's trace lines are read in between.
      await Bun.sleep(20);
    } else await Bun.sleep(50);
  }
  const frames = revealFrames.filter((f) => f.dir === dir);
  if (!frames.length) fail(`no trace of the peek sliding ${dir} (ND_REVEAL_TRACE)`);
  if (shots.length) {
    const win = await windowRect();
    const out = sh(
      "python3",
      "-c",
      `from PIL import Image
import json
shots = ${JSON.stringify(shots)}
res = []
strip = []
for path in shots:
    im = Image.open(path).convert("RGB"); s = im.width / ${win.w}
    def centroid(y0, y1, want):
        xs = [x for y in range(int(y0 * s), int(y1 * s)) for x in range(0, int(360 * s)) if want(im.getpixel((x, y)))]
        return (sum(xs) / len(xs) / s, len(xs)) if xs else (None, 0)
    red, rn = centroid(0, 60, lambda p: p[0] > 180 and p[0] - p[1] > 70 and p[0] - p[2] > 70 and p[2] > 40)
    orange, on = centroid(60, 140, lambda p: p[0] > 200 and 100 < p[1] < 180 and p[2] < 80)
    res.append({"path": path, "close": None if red is None else red - 7, "tile": None if orange is None else orange - ${tileW} / 2, "rn": rn, "on": on})
    strip.append(im.crop((0, 0, int(360 * s), int(260 * s))))
w = sum(i.width for i in strip) + 8 * (len(strip) - 1)
m = Image.new("RGB", (w, strip[0].height), (128, 128, 128))
x = 0
for i in strip:
    m.paste(i, (x, 0)); x += i.width + 8
m.save(${JSON.stringify(`${SHOTS}/mac-peek-${dir}-strip.png`)})
print(json.dumps(res))`,
    );
    const measured = JSON.parse(out) as { path: string; close: number | null; tile: number | null; rn: number; on: number }[];
    let checked = 0;
    for (const f of measured) {
      // A frame where either mark is cut by the window's edge says nothing.
      if (f.close === null || f.tile === null || f.close < 1 || f.tile < 1 || f.rn < 20 || f.on < 20) continue;
      checked++;
      if (!near(f.close, f.tile, 1)) fail(`peek ${dir}: in ${f.path} the close button starts at ${f.close.toFixed(1)}, the first tile at ${f.tile.toFixed(1)}`);
    }
    console.log(`  peek ${dir}: ${shots.length} frames captured, ${checked} with both marks whole held together (${SHOTS}/mac-peek-${dir}-strip.png)`);
  }
  return frames;
}

/// Every traced frame of a slide keeps the close button on the tiles' leading
/// edge (the panel's edge plus the tiles' offset in it), visible throughout,
/// and the trace covers the start, the middle and the end of the slide.
function holdLights(dir: string, frames: RevealFrame[], tileOffset: number): void {
  const bad = frames.filter((f) => !near(f.close, f.panel + tileOffset, 1) || f.hidden || f.alpha < 0.99);
  if (bad.length) fail(`peek ${dir}: the lights leave the tiles on ${bad.length} of ${frames.length} frames, first ${JSON.stringify(bad[0])} (tiles ${tileOffset} into the panel)`);
  const xs = frames.map((f) => f.panel);
  const rest = dir === "in" ? xs[xs.length - 1]! : xs[0]!;
  const away = dir === "in" ? xs[0]! : xs[xs.length - 1]!;
  const mid = xs.filter((x) => Math.abs(x - rest) > 4 && Math.abs(x - away) > 4);
  if (away > rest - 100 || mid.length < 3) fail(`peek ${dir}: the trace does not cover the slide (${xs.map((x) => x.toFixed(0)).join(" ")})`);
  console.log(`  NB_SIDEBAR_PEEK_LIGHTS_OK ${dir}: ${frames.length} frames from ${away.toFixed(0)} to ${rest.toFixed(0)}, ${mid.length} mid-slide, close button on the tiles' edge (+${tileOffset}) in every one`);
}

/// GTK, trailing controls, sidebar hidden: the strip is gone and keeps no
/// room, slides in over the page while the pointer is at the top edge, and the
/// page does not move for it. At the drive's current width and at 1280.
async function stripLeg(page: Rect): Promise<Rect> {
  const shown = async () => {
    const r = await maybeRect("controls-strip");
    return r !== null && r.y + r.h > 1 ? r : null;
  };
  const byPointer = !darwin;
  for (const width of [(await windowRect()).w, 1280]) {
    if (width !== (await windowRect()).w) {
      await app.setWindowSize(width, 800);
      await settle("content");
      page = await cardLeg(`hidden-${width}`, 0, 0);
    }
    await waitFor("the strip to be away", shown, (r) => r === null);
    await capture(`strip-hidden-${width}`);
    if (byPointer) await pointer("move", width / 2, 1);
    else await app.click("menu-reveal-strip");
    const strip = await waitFor("the strip to slide in", shown, (r) => r !== null && near(r.y, 0));
    await Bun.sleep(400);
    const under = await rect("content");
    if (JSON.stringify(under) !== JSON.stringify(page)) fail(`the strip moved the page: ${JSON.stringify(page)} -> ${JSON.stringify(under)}`);
    const end = await rect("controls-end");
    if (!near(end.x + end.w, (await windowRect()).w - 8, 1)) fail(`the revealed controls are not at the strip's trailing end (${JSON.stringify({ end, strip })})`);
    await capture(`strip-revealed-${width}`);
    if (byPointer) await pointer("move", width / 2, 400);
    else await app.click("menu-conceal-strip");
    await waitFor("the strip to slide away", shown, (r) => r === null);
    console.log(`  NB_SIDEBAR_STRIP_OK width=${width} strip=${JSON.stringify(strip)} page=${JSON.stringify(page)}`);
  }
  return page;
}

/// The page beside the sidebar. GTK draws it as a card inset by 8 on the
/// sidebar's colour; AppKit runs it to the window's edges, where the glass
/// sidebar reflects it.
async function cardLeg(tag: string, leading: number | null, margin?: number): Promise<Rect> {
  const card = await settle("content");
  // CEF repaints a resized page on its own thread, a beat after the host has
  // moved and cut its window; a capture before that shows the old size.
  if (!darwin) await Bun.sleep(1200);
  const win = await windowRect();
  const M = margin ?? (appkit ? 0 : 8);
  const line = `${tag} card=${JSON.stringify(card)} window=${win.w}x${win.h}`;
  if (!near(win.w - (card.x + card.w), M)) fail(`the card's trailing margin is not ${M}: ${line}`);
  if (!near(win.h - (card.y + card.h), M)) fail(`the card's bottom margin is not ${M}: ${line}`);
  if ((appkit || margin === 0) && !near(card.y, 0)) fail(`the page does not reach the window's top: ${line}`);
  if (leading !== null && !near(card.x, leading)) fail(`the card's leading edge is not at ${leading}: ${line}`);
  let shot = await capture(`card-${tag}`);
  // The GTK host on macOS has no web engine to draw a page with.
  // A nested headless Hyprland paints the engine window late or not at all
  // (the framework rig runs only its menu legs there), so its runs check
  // geometry and keep the captures.
  if (shot && !(darwin && !appkit) && !process.env.ND_SIDEBAR_NO_PAINT) {
    // A software-rendered CEF under a nested compositor takes a while to paint
    // a page it was just resized for; the capture is retaken until it has.
    const deadline = Date.now() + 10_000;
    while (!isPageBlue(shot!.pixel(card.x + card.w / 2, card.y + card.h - 40)) && Date.now() < deadline) {
      await Bun.sleep(1000);
      shot = await capture(`card-${tag}`);
    }
    const corner = shot!.pixel(card.x + 0.5, card.y + card.h - 1);
    const inside = shot!.pixel(card.x + card.w / 2, card.y + card.h - 40);
    if (!isPageBlue(inside)) fail(`the page does not fill the card (${inside}): ${line}`);
    if (appkit) {
      // The glass sidebar picks the page's blue up along its trailing edge,
      // and stays neutral away from it.
      if (card.x > 0) {
        const edge = shot!.pixel(card.x - 3, card.y + card.h / 2);
        const middle = shot!.pixel(card.x / 2, card.y + card.h / 2);
        if (edge[2]! < edge[0]! + 20 || middle[2]! > middle[0]! + 20) {
          fail(`the sidebar does not reflect the page beside it (edge ${edge}, middle ${middle}): ${line}`);
        }
      }
      // Nothing of compact's toolbar stays over the page's top edge: its
      // field text and glyphs are the only light ink on the fixture's blue.
      // One pass over the strip; a process per pixel would take minutes.
      const light = sh(
        "python3",
        "-c",
        `from PIL import Image
im = Image.open(${JSON.stringify(shot!.path)}).convert("RGB"); s = im.width / ${win.w}
print(sum(1 for y in range(12, 37, 4) for x in range(${Math.round(card.x + card.w / 2)}, ${Math.round(card.x + card.w - 8)}, 2)
  if min(im.getpixel((int(x * s), int(y * s)))[:2]) > 170))`,
      ).trim();
      if (light !== "0") fail(`${light} light pixels are drawn over the page's top edge: ${line}`);
    } else if (isPageBlue(corner)) fail(`the page's square corner shows past the card's curve (${corner}): ${line}`);
  }
  console.log(`  NB_SIDEBAR_CARD_OK ${line}`);
  return card;
}

try {
  await step("the sidebar layout comes up", () => app.waitFor({ testId: "sidebar", state: "visible" }, { timeoutMs: PATIENCE }));
  await waitFor("the page to load", async () => (await app.mustFind("tab-t6")).text, (t) => t === "Example page");
  // The row's title comes from the store; the page itself has painted once
  // its load bar has run out (or there never was one).
  await waitFor("the page to finish loading", async () => (await app.find("progress"))?.value ?? 1, (v) => Number(v) >= 1);
  await Bun.sleep(1000);

  // ---- 1 and 2 ----------------------------------------------------------
  for (const width of [1280, 720]) {
    await geometryLeg(width);
    await cardLeg(`open-${width}`, null);
  }
  await gridLeg();
  if (appkit) await glassLeg();
  else await selectionLeg();

  // ---- 3: the load bar ----------------------------------------------------
  // The address is edited in the command bar, so the drive types into the
  // bar, on both backends. The GTK host on macOS has no web engine, so
  // nothing ever loads there.
  if (!(darwin && !appkit)) await loadBarLeg();

  async function loadBarLeg(): Promise<void> {
  // The grid leg unpinned three tiles just before, and the list moves up
  // as the grid gives back its second row.
  const rowIdle = await settle("tab-slot-t6");
  await step("start a slow load", async () => {
    await openPalette(app);
    slowOpen = false;
    await typeQuery(app, `${base}/slow`);
    await app.setValue("palette", true);
  });
  // Mounted since the first load, so presence says nothing: a load is on show
  // once the bar's value is below the end.
  await waitFor("the load to start", async () => (await app.find("progress"))?.value, (v) => v !== undefined && Number(v) < 1);
  const bar = await laidOut("progress");
  const card = await rect("content");
  if (!near(bar.y, card.y, 1) || bar.x < card.x - 1 || bar.x + bar.w > card.x + card.w + 1) {
    fail(`the load bar is not on the card's top edge (${JSON.stringify({ bar, card })})`);
  }
  // No spinner competes with the bar except in the row itself.
  await waitFor("the row's spinner", () => maybeRect("tab-spinner-t6"), (r) => r !== null);
  const rowLoading = await rect("tab-slot-t6");
  if (!near(rowLoading.y, rowIdle.y, 0.5) || !near(rowLoading.h, rowIdle.h, 0.5)) {
    fail(`the spinner moved the row (${JSON.stringify({ rowIdle, rowLoading })})`);
  }
  // A frame for the host to draw what it was just told.
  await Bun.sleep(400);
  const loading = await capture("loading");
  if (loading) {
    const ink = loading.pixel(bar.x + 3, bar.y + 1);
    if (isPageBlue(ink)) fail(`the load bar is not drawn on the page's top edge (${ink} at ${bar.x + 3},${bar.y + 1})`);
  }
  await slowRelease();
  // The fill reaches the end and fades (0.25 s, then 0.3 s after 0.2 s).
  await Bun.sleep(1500);
  await capture("loaded");
  await waitFor("the row's spinner to stop with the load", () => maybeRect("tab-spinner-t6"), (r) => r === null);
  console.log("  NB_SIDEBAR_LOADBAR_OK the bar ran along the card's top edge and the row spun, captured mid-load and after");
  }

  // ---- 4: hide, then the edge reveal --------------------------------------
  const tileW = (await rect("tab-slot-t1")).w;
  // Off the leading edge first: a pointer left there peeks the sidebar
  // straight back in.
  if (appkit) await pointer("move", 700, 400);
  await app.click("menu-toggle-sidebar");
  await waitFor("the sidebar to hide", () => maybeRect("sidebar"), (r) => r === null || r.x + r.w <= 0);
  // Hidden, the page is immersive on both backends: edge to edge, no frame.
  let hidden = await cardLeg("hidden", 0, 0);
  if (!appkit && gtkControls === "end") hidden = await stripLeg(hidden);
  // AppKit: the traffic lights went with the sidebar.
  if (appkit) {
    const shot = await capture("peek-collapsed");
    const scale = Number(sh("python3", "-c", `from PIL import Image;print(Image.open(${JSON.stringify(shot!.path)}).width/${(await windowRect()).w})`).trim());
    const red = redCentroid(shot!.path, scale, { x: 0, y: 0, w: 160, h: 90 });
    if (red.n >= 20) fail(`the traffic lights are still drawn with the sidebar hidden (${red.n} red px at ${red.x.toFixed(1)},${red.y.toFixed(1)})`);
  }
  // A real pointer where there is one: on Linux the page is edge to edge under it.
  revealFrames.length = 0;
  if (appkit || !darwin) await pointer("move", 2, 400);
  else await app.click("menu-reveal-sidebar");
  await waitFor("the sidebar to come in", () => maybeRect("sidebar"), (r) => r !== null && r.x >= 0);
  const slide = appkit ? await peekFrames("in", tileW) : [];
  await Bun.sleep(400);
  const over = await rect("content");
  if (JSON.stringify(over) !== JSON.stringify(hidden)) fail(`the reveal resized the page: ${JSON.stringify(hidden)} -> ${JSON.stringify(over)}`);
  // The panel is the sidebar floated, not a bigger one: inside the window with
  // its foot on show.
  {
    const panel = await rect("sidebar");
    const foot = await rect("bottom-bar");
    const win = await windowRect();
    if (panel.y + panel.h > win.h + 1 || foot.y + foot.h > win.h + 1 || panel.w > win.w / 2) {
      fail(`the revealed panel does not fit the window (${JSON.stringify({ panel, foot, win })})`);
    }
  }
  await capture("revealed");
  // The lights ride with the panel: on every frame of the slide the close
  // button's leading edge is the tiles' leading edge, as it is at rest.
  const tileOffset = appkit ? (await rect("tab-slot-t1")).x - (await rect("sidebar")).x : 0;
  if (appkit) {
    const rest = await rect("controls-start");
    if (!near(rest.x, (await rect("tab-slot-t1")).x, 1)) fail(`the peeking panel's controls start at ${rest.x}, its tiles at ${(await rect("tab-slot-t1")).x}`);
    holdLights("in", slide, tileOffset);
  }
  revealFrames.length = 0;
  if (appkit || !darwin) await pointer("move", 700, 400);
  else await app.click("menu-conceal-sidebar");
  await waitFor("the sidebar to leave", () => maybeRect("sidebar"), (r) => r === null || r.x + r.w <= 0);
  if (appkit) {
    holdLights("out", await peekFrames("out", tileW), tileOffset);
    const shot = await capture("peek-concealed");
    const scale = Number(sh("python3", "-c", `from PIL import Image;print(Image.open(${JSON.stringify(shot!.path)}).width/${(await windowRect()).w})`).trim());
    const red = redCentroid(shot!.path, scale, { x: 0, y: 0, w: 160, h: 90 });
    if (red.n >= 20) fail(`the traffic lights stayed behind when the panel slid out (${red.n} red px)`);
  }
  await app.click("menu-toggle-sidebar");
  await waitFor("the sidebar to come back", () => maybeRect("sidebar"), (r) => r !== null && r.x >= 0);
  console.log("  NB_SIDEBAR_REVEAL_OK hidden, revealed over an unchanged card, concealed, shown");

  // ---- 5: drag a tab within today's list ----------------------------------
  if (!appkit) {
    // GTK on macOS takes no synthesized pointer at all; under Xvfb, XTEST
    // starts the drag and the list tracks the slot (ND_APP DRAG over), but the
    // release never ends the XDND session, so no drop arrives. No Linux drive
    // in this repo covers a real drag either (browser-drive leg 19 moves tabs
    // through the menu for the same reason).
    console.log("  NB_SIDEBAR_DRAG_SKIP no synthesized drop reaches a GTK drop target here");
  } else {
    const before = await todayOrder();
    const from = mid(await rect("tab-t6"));
    const onto = await rect("tab-slot-t5");
    await drag(from, { x: from.x, y: onto.y + 4 });
    const after = await waitFor("the drop to reorder today's tabs", todayOrder, (o) => o.indexOf("t6") < o.indexOf("t5"));
    console.log(`  NB_SIDEBAR_DRAG_OK today's tabs ${before.join(",")} -> ${after.join(",")}`);
  }

  // ---- 6: the row on show is the address ------------------------------------
  await app.click("tab-t6");
  await app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: PATIENCE });
  await capture("address");
  await app.click("menu-address");
  await waitFor("the command bar to close", async () => (await app.find("palette"))?.visible ?? false, (v) => !v);
  console.log("  NB_SIDEBAR_ADDRESS_OK a click on the row on show opened the command bar, Cmd+L put it away");

  // ---- 7: compact and back ------------------------------------------------
  await app.click("menu-layout");
  // Present rather than measured: AppKit hosts the row in the window's
  // toolbar, which the tree lists without a frame.
  await waitFor("the compact row", testIds, (ids) => ids.has("tab-strip"));
  const compactIds = await testIds();
  for (const gone of ["controls-row", "controls-start", "controls-strip", "sidebar", "sidebar-settings"]) {
    if (compactIds.has(gone)) fail(`compact still draws ${gone}`);
  }
  const plain = await settle("content");
  const win = await windowRect();
  if (!near(plain.x, 0) || !near(plain.x + plain.w, win.w)) fail(`compact's page is still inset: ${JSON.stringify(plain)}`);
  for (const width of [win.w, 1280]) {
    if (width !== (await windowRect()).w) {
      await app.setWindowSize(width, 800);
      await settle("content");
    }
    const compactShot = await capture(`compact-${width}`);
    if (compactShot && appkit) {
      // The traffic lights sit in the toolbar band, as far in from the left
      // edge as from the top.
      const scale = Number(sh("python3", "-c", `from PIL import Image;print(Image.open(${JSON.stringify(compactShot.path)}).width/${width})`).trim());
      const red = redCentroid(compactShot.path, scale, { x: 0, y: 0, w: 80, h: 60 });
      if (red.n < 20) fail("compact lost the traffic lights");
      if (!near(red.x, red.y, 1)) fail(`compact's close button is ${(red.x - 7).toFixed(1)} from the left edge and ${(red.y - 7).toFixed(1)} from the top`);
    }
  }
  // Compact's load bar runs along the page's top edge, over the page.
  if (!(darwin && !appkit)) {
    await openPalette(app);
    slowOpen = false;
    await typeQuery(app, `${base}/slow-compact`);
    await app.setValue("palette", true);
    await waitFor("compact's load to start", async () => (await app.find("progress"))?.value, (v) => v !== undefined && Number(v) < 1);
    const bar = await laidOut("progress");
    const page = await rect("content");
    if (!near(bar!.y, page.y, 1) || bar!.x < page.x - 1 || bar!.x + bar!.w > page.x + page.w + 1) {
      fail(`compact's load bar is not on the page's top edge (${JSON.stringify({ bar, page })})`);
    }
    await Bun.sleep(400);
    await capture("compact-loading");
    await slowRelease();
    await Bun.sleep(1500);
    await capture("compact-loaded");
    console.log("  NB_SIDEBAR_COMPACT_LOADBAR_OK compact's bar ran along the page's top edge");
  }
  await app.click("menu-layout");
  await waitFor("the sidebar layout again", () => maybeRect("sidebar"), (r) => r !== null);
  if ((await testIds()).has("chrome")) fail("the sidebar layout still draws compact's header bar");
  await waitFor("compact's load to finish", async () => (await app.find("progress"))?.value ?? 1, (v) => Number(v) >= 1);
  await geometryLeg(1280);
  // A tile with no icon the host can draw keeps its letter.
  const tile = await app.mustFind("tab-t2");
  if (!tile.text) fail("the second pinned tile lost its letter after the switch back");
  await cardLeg("again", null);
  console.log("  NB_SIDEBAR_SWITCH_OK compact dropped the controls row and the card, and the sidebar layout came back whole");

  const footIds = async (): Promise<string[]> => {
    // The glyphs themselves, not what their closed popovers hold.
    const ids: string[] = [];
    const visit = (n: JsonNode): void => {
      if (n.type === "Popover") return;
      if (n.type === "Button" && n.testID) ids.push(n.testID);
      for (const c of n.children ?? []) visit(c);
    };
    visit(await app.mustFind("bottom-bar"));
    return ids;
  };

  // ---- 7c: the switch, over and over ----------------------------------------
  // Every glyph in the foot has a size once the sidebar is back, each time.
  // NB_SIDEBAR_SWITCHES sets how many round trips (3 by default).
  const switches = Number(process.env.NB_SIDEBAR_SWITCHES ?? 3);
  for (let i = 1; i <= switches; i++) {
    await app.click("menu-layout");
    await waitFor("the compact row", testIds, (ids) => ids.has("tab-strip"));
    await app.setWindowSize(i % 2 ? 720 : 1280, 800);
    await app.click("menu-layout");
    await waitFor("the sidebar layout again", () => maybeRect("sidebar"), (r) => r !== null);
    // The same wait the geometry leg makes before it measures the foot.
    await settle("sidebar");
    for (const id of await footIds()) {
      const g = (await app.mustFind(id)).geometry;
      if (!g || g.w < 20 || g.h < 20) {
        let later = g;
        for (let t = 0; t < 20 && (!later || later.w < 20); t++) {
          await Bun.sleep(150);
          later = (await app.mustFind(id)).geometry;
        }
        fail(`switch ${i}/${switches}: ${id} is ${JSON.stringify(g)} after the sidebar came back, ${JSON.stringify(later)} 3 s on`);
      }
    }
    // Sized in the tree is not drawn: each glyph has to be in the capture,
    // where the tree says it is.
    const shot = appkit ? await capture(`switch-${i}`) : null;
    if (shot) {
      const w = (await windowRect()).w;
      for (const id of await footIds()) {
        const g = (await app.mustFind(id)).geometry!;
        const spread = Number(
          sh("python3", "-c", `from PIL import Image
im = Image.open(${JSON.stringify(shot.path)}).convert("L"); s = im.width / ${w}
box = im.crop((int(${g.x + 4} * s), int(${g.y + 4} * s), int(${g.x + g.w - 4} * s), int(${g.y + g.h - 4} * s)))
lo, hi = box.getextrema(); print(hi - lo)`).trim(),
        );
        if (spread < 40) {
          const parent = JSON.stringify(await app.find(id.replace(/-button$/, "-anchor")));
          fail(`switch ${i}/${switches}: nothing is drawn where ${id} is (${JSON.stringify(g)}, contrast ${spread}); anchor ${parent.slice(0, 200)}`);
        }
      }
    }
  }
  console.log(`  NB_SIDEBAR_SWITCHES_OK ${switches} round trips, every foot glyph sized each time`);


  // ---- 7a: the foot's popovers ------------------------------------------------
  // Each opens beside or above the foot and stays inside the window, and
  // opening one puts the other away. A real download gives the list a name.
  if (!(darwin && !appkit)) {
    await openPalette(app);
    await typeQuery(app, `${base}/report.txt`);
    await app.setValue("palette", true);
    await waitFor("the download to land", async () => readdirSync(DOWNLOADS).filter((f) => !f.endsWith(".crdownload")).length, (n) => n > 0);
  }
  const openPopovers = async (): Promise<string[]> => {
    const ids: string[] = [];
    walk((await app.tree()).root, (n) => {
      if (n.type === "Popover" && n.visible && (n.geometry?.w ?? 0) > 4) ids.push(n.testID ?? String(n.ref));
    });
    return ids;
  };
  for (const width of [1280, 720]) {
    await app.setWindowSize(width, 800);
    await settle("sidebar");
    const win = await windowRect();
    // The extensions controls need the Chromium engine, which the GTK host
    // on macOS does not have.
    const pairs = [
      ["extensions-button", "extensions-panel", "extensions-popover"],
      ["downloads-button", "downloads-panel", "downloads-popover"],
    ] as const;
    // Every host but that one runs Chromium and must say so: a first render
    // that read the engine before the host announced it drew no extensions
    // button at all, for the life of the window.
    const hasExtensions = !(darwin && !appkit);
    if (hasExtensions && !(await app.find("extensions-button"))) fail(`width=${width}: no extensions button on a Chromium host`);
    for (const [button, panel, popover] of pairs.filter(([b]) => hasExtensions || b !== "extensions-button")) {
      const footBefore = await Promise.all((await footIds()).map(async (id) => [id, await rect(id)] as const));
      await app.click(button);
      const box = await waitFor(`${panel} to show`, () => maybeRect(panel), (r) => r !== null);
      // The popover floats: nothing in the foot moves for it.
      for (const [id, was] of footBefore) {
        const now = await rect(id);
        if (!near(now.x, was.x) || !near(now.w, was.w)) fail(`width=${width}: opening ${popover} moved ${id} ${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
      }
      await Bun.sleep(500);
      const shotPath = await captureScreen(`popover-${panel}-${width}`);
      const up = await openPopovers();
      if (up.length !== 1 || up[0] !== popover) fail(`width=${width}: after ${button} the open popovers are ${JSON.stringify(up)}`);
      const pr = await rect(popover);
      if (pr.x < -1 || pr.y < -1 || pr.x + pr.w > win.w + 1 || pr.y + pr.h > win.h + 1) {
        fail(`width=${width}: ${popover} ${JSON.stringify(pr)} leaves the window ${win.w}x${win.h}`);
      }
      // A fresh profile has nothing installed; anything listed was read from
      // someone else's.
      if (panel === "extensions-panel" && !(await app.find("extensions-empty"))) {
        fail(`width=${width}: the extensions panel lists extensions this run never installed`);
      }
      if (panel === "downloads-panel" && !(darwin && !appkit)) {
        let item: JsonNode | null = null;
        walk((await app.tree()).root, (n) => {
          if (!item && n.testID?.startsWith("downloads-item-")) item = n;
        });
        const it = item as JsonNode | null;
        if (!it || it.text !== "quarterly-report.txt" || (it.geometry?.w ?? 0) < 120) {
          fail(`width=${width}: the download reads ${JSON.stringify(it?.text)} in ${it?.geometry?.w}px`);
        }
      }
      if (appkit && shotPath) {
        // The arrow is the popover's only drawing below its body: find its
        // lowest rows under the body and where they are centred.
        const btn = await rect(button);
        const tip = Number(
          sh(
            "python3",
            "-c",
            `from PIL import Image
im = Image.open(${JSON.stringify(shotPath)}).convert("RGB"); s = im.width / ${win.w}
lum = lambda x, y: sum(im.getpixel((int(x * s), int(y * s)))) / 3
best = None
lo, hi = ${Math.round(btn.x - 20)}, ${Math.round(btn.x + btn.w + 20)}
# The row just under the arrow, above the button's glyph, is what the arrow
# is drawn over: each column is compared with it, so the column's gradient
# toward the page drops out.
ref = ${Math.round(btn.y + 2)}
for y in range(${Math.round(pr.y + pr.h - 14)}, ${Math.round(btn.y)}):
    xs = [x / 4 for x in range(lo * 4, hi * 4) if abs(lum(x / 4, y) - lum(x / 4, ref)) > 10]
    if 0 < len(xs) and xs[-1] - xs[0] <= 24: best = (xs[0] + xs[-1]) / 2
print(best if best is not None else -1)`,
          ).trim(),
        );
        if (!near(tip, mid(btn).x, 2)) fail(`width=${width}: ${popover}'s arrow points at x=${tip}, its button's centre is ${mid(btn).x}`);
      }
      console.log(`  NB_SIDEBAR_POPOVER_OK width=${width} ${popover}=${JSON.stringify(pr)} panel=${JSON.stringify(box)}`);
    }
    await app.click("downloads-button");
    await waitFor("the downloads panel to go", () => maybeRect("downloads-panel"), (r) => r === null);
  }

  // ---- 7c: the foot's popovers read over any page ---------------------------
  // The panel that keeps a popover inside the window has to be NSPopover's
  // material, not a glass that lets the page through: over a blue, a white
  // and a black page every text row keeps 4.5:1 against the panel right
  // behind it, measured in strips along the row so the half over the page
  // counts on its own. The compact layout's site-info popover is a real
  // NSPopover and is captured and measured the same way for comparison.
  if (appkit) {
    const contrast = (shotPath: string, box: Rect, winW: number): number =>
      Number(
        sh(
          "python3",
          "-c",
          `from PIL import Image
from collections import Counter
im = Image.open(${JSON.stringify(shotPath)}).convert("RGB"); s = im.width / ${winW}
def lum(p):
    c = [v / 255 for v in p]
    c = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
ratio = lambda a, b: (max(a, b) + 0.05) / (min(a, b) + 0.05)
x0, y0, x1, y1 = int(${box.x} * s), int(${box.y} * s), int(${box.x + box.w} * s), int(${box.y + box.h} * s)
x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, im.width), min(y1, im.height)
worst = None
step = int(24 * s)
for sx in range(x0, x1 - step // 2, step):
    px = [im.getpixel((x, y)) for x in range(sx, min(sx + step, x1)) for y in range(y0, y1)]
    if not px: continue
    bg = Counter((p[0] // 8, p[1] // 8, p[2] // 8) for p in px).most_common(1)[0][0]
    bgl = lum([v * 8 + 4 for v in bg])
    best = max(ratio(lum(p), bgl) for p in px)
    if best < 1.5: continue  # no text in this strip
    worst = best if worst is None else min(worst, best)
print(worst if worst is not None else -1)`,
        ).trim(),
      );
    const rowsOf = async (panel: string): Promise<Rect[]> => {
      const out: Rect[] = [];
      walk((await app.tree()).root, (n) => {
        const id = n.testID ?? "";
        const g = n.geometry;
        if (!g || g.w <= 0 || g.h <= 0) return;
        if (panel === "extensions-panel" && ["extensions-empty", "extensions-manage", "extensions-install-action-test"].includes(id)) out.push(g);
        if (panel === "downloads-panel" && id.startsWith("downloads-item-")) out.push(g);
      });
      return out;
    };
    const results: string[] = [];
    const low: string[] = [];
    for (const bg of ["2f6bff", "ffffff", "000000"]) {
      await openPalette(app);
      await typeQuery(app, `${base}/bg-${bg}`);
      await app.setValue("palette", true);
      await Bun.sleep(1500);
      // The comparison: a real NSPopover over the same page.
      await app.click("menu-layout");
      await waitFor("the compact row", testIds, (ids) => ids.has("tab-strip"));
      for (const width of [1280, 720]) {
        await app.setWindowSize(width, 800);
        await Bun.sleep(500);
        // Compact's padlock leads the active tab.
        const lock = [...(await testIds())].find((id) => id.startsWith("security-")) ?? fail("no padlock in the active tab");
        await app.click(lock);
        await waitFor("the site-info popover", async () => (await app.find("site-info-popover"))?.visible, (v) => v === true);
        await Bun.sleep(600);
        const shotPath = (await captureScreen(`contrast-nspopover-${bg}-${width}`)) ?? fail("no capture");
        const g = (await app.find("site-info-popover"))?.geometry;
        // Reported, not asserted: NSPopover is the reference, and it hangs
        // out of the window, where the capture has no pixels for it.
        if (g && g.w > 4) results.push(`nspopover/${bg}/${width}=${contrast(shotPath, g, (await windowRect()).w).toFixed(1)}`);
        await app.click(lock);
        await Bun.sleep(400);
      }
      await app.click("menu-layout");
      await waitFor("the sidebar layout again", () => maybeRect("sidebar"), (r) => r !== null);
      for (const width of [1280, 720]) {
        await app.setWindowSize(width, 800);
        await settle("sidebar");
        const win = await windowRect();
        for (const [button, panel] of [["extensions-button", "extensions-panel"], ["downloads-button", "downloads-panel"]] as const) {
          await app.click(button);
          await waitFor(`${panel} to show`, () => maybeRect(panel), (r) => r !== null);
          // A row is laid out a moment after its panel shows, at 0,0 until then.
          const rows = await waitFor(`${panel}'s rows`, () => rowsOf(panel), (rs) => rs.length > 0 && rs.every((r) => r.y > 0));
          await Bun.sleep(600);
          const shotPath = (await captureScreen(`contrast-${panel}-${bg}-${width}`)) ?? fail("no capture");
          for (const row of rows) {
            const c = contrast(shotPath, row, win.w);
            if (c < 4.5) low.push(`${panel} over #${bg} at ${width}: a row reads at ${c.toFixed(2)}:1 (${JSON.stringify(row)}), ${shotPath}`);
            results.push(`${panel}/${bg}/${width}=${c.toFixed(1)}`);
          }
          await app.click(button);
          await waitFor(`${panel} to go`, () => maybeRect(panel), (r) => r === null);
        }
      }
    }
    if (low.length) fail(`${low.join("\n")}\nmeasured: ${results.join(" ")}`);
    console.log(`  NB_SIDEBAR_POPOVER_CONTRAST_OK ${results.join(" ")}`);
  }

  // ---- 7b: right-click on each sidebar surface -------------------------------
  // With the real cursor. Whatever menu comes up is captured on its own (a
  // menu is a window of its own) for a look at its items, then dismissed.
  if (appkit) {
    const targets: [string, string][] = [
      ["tab-t5", "tab-row"],
      ["tab-t2", "pinned-tile"],
      ["new-tab", "new-tab-row"],
      ["sidebar-settings", "foot"],
      ["content", "page"],
    ];
    const found: string[] = [];
    for (const [id, name] of targets) {
      const at = mid(await rect(id));
      const before = new Set(ndshotWindows(app.pid).map((w) => w.windowID));
      await app.cursor.click(at, { button: "right" });
      await Bun.sleep(800);
      const main = ndshotWindows(app.pid).find((w) => w.title !== "");
      const menus = ndshotWindows(app.pid).filter((w) => !before.has(w.windowID) && w.windowID !== main?.windowID && w.width < 600);
      // The screen under the window, menu on top; focusing the window first
      // would put the menu away.
      if (menus.length && main) {
        sh("timeout", "30", NDSHOT, "capture", "--window-id", String(main.windowID), "--region", "--no-focus", "--out", `${SHOTS}/mac-ctx-${name}.png`);
      }
      found.push(`${name}=${menus.map((m) => `${m.width}x${m.height}`).join("+") || "none"}`);
      // Escape puts a menu away; a menu tracks the mouse in its own loop,
      // which holds the automation socket until it closes.
      if (menus.length) Bun.spawnSync(["osascript", "-e", 'tell application "System Events" to key code 53']);
      await Bun.sleep(600);
    }
    console.log(`  NB_SIDEBAR_CTX_OK menus opened: ${found.join(" ")}`);
  }

  // ---- 7e: reorder the pinned tiles ------------------------------------------
  if (appkit) await reorderLeg();

  // ---- 7d: the divider --------------------------------------------------------
  // Before 8, which leaves the Settings window up.
  if (appkit) await dividerLeg();

  // ---- 8: the two tile styles ----------------------------------------------
  // Icons by default: the site with a cached favicon shows it, the rest their
  // letter. Letters, chosen in Settings, drop the icon for every tile. Linux
  // pages are data URLs, which have no origin to cache an icon under.
  if (darwin) {
    const text = async (id: string) => (await app.mustFind(id)).text ?? "";
    if ((await text("tab-t1")) !== "" || (await text("tab-t2")) === "") {
      fail(`icon tiles: t1 ${JSON.stringify(await text("tab-t1"))}, t2 ${JSON.stringify(await text("tab-t2"))}`);
    }
    const icons = await capture("pins-icons");
    const t1 = await rect("tab-t1");
    if (icons && appkit) {
      const hit = sh(
        "python3",
        "-c",
        `from PIL import Image
im = Image.open(${JSON.stringify(icons.path)}).convert("RGB"); s = im.width / ${(await windowRect()).w}
print(sum(1 for y in range(${Math.round(t1.y)}, ${Math.round(t1.y + t1.h)}) for x in range(${Math.round(t1.x)}, ${Math.round(t1.x + t1.w)})
  if (lambda p: p[0] > 200 and 100 < p[1] < 180 and p[2] < 80)(im.getpixel((int(x * s), int(y * s))))))`,
      ).trim();
      if (Number(hit) < 20) fail(`the first tile does not show its favicon (${hit} orange pixels)`);
    }
    await app.click("sidebar-settings");
    await app.waitFor({ testId: "settings-window", state: "present" }, { timeoutMs: PATIENCE });
    await app.setValue("settings-pins", 1);
    await waitFor("the letter tiles", () => text("tab-t1"), (t) => t !== "");
    const letters = await capture("pins-letters");
    for (const id of ["t1", "t2", "t3", "t4"]) {
      const tile = await rect(`tab-slot-${id}`);
      const mark = await rect(`tab-${id}`);
      if (!near(mid(tile).x, mid(mark).x) || !near(mid(tile).y, mid(mark).y)) fail(`letter tile ${id}'s mark is off its centre`);
    }
    await app.setValue("settings-pins", 0);
    await waitFor("the icon tiles again", () => text("tab-t1"), (t) => t === "");
    console.log(`  NB_SIDEBAR_PINS_OK icon tiles by default, letters from Settings (${icons?.path ?? "-"}, ${letters?.path ?? "-"})`);
  }

  // ---- 9: the reordered pins after a relaunch ---------------------------------
  if (appkit) {
    await app.close();
    closed = true;
    const again = await launchApp(launchOptions);
    try {
      const order = async (): Promise<string[]> => {
        const ids: string[] = [];
        const block = await again.find("pinned-tabs");
        if (block) walk(block, (n) => {
          const m = /^tab-slot-(.+)$/.exec(n.testID ?? "");
          if (m) ids.push(m[1]!);
        });
        return ids;
      };
      const kept = await waitFor("the pins after a relaunch", order, (o) => o.length === 4);
      if (JSON.stringify(kept) !== JSON.stringify(["t2", "t3", "t1", "t4"])) fail(`after a relaunch the pins are ${JSON.stringify(kept)}`);
      console.log(`  NB_SIDEBAR_REORDER_KEPT_OK ${kept.join(",")} after a relaunch`);
    } finally {
      await again.close();
    }
  }

  if (missingIcons.size) fail(`icons missing from the theme: ${[...missingIcons].join(", ")}`);
  console.log("NB_SIDEBAR_OK");
} finally {
  if (!closed) await app.close();
  server.stop(true);
  iconServer.stop(true);
}
