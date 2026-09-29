#!/usr/bin/env bun
// Walks the window from 1440 down to 720 px in 80 px steps, in both layouts,
// and holds every step to the owner's bar for a narrow window: the window is
// the width it was asked for (on GTK its minimum never holds it wider), the
// address field is whole and on screen rather than in the toolbar's overflow,
// the active tab shows its title, and no control overlaps another or runs off
// the window. Captures both layouts at 1440, 1024, 800 and 720.
//
//   macOS (CEF):  scripts/mac-drive.sh scripts/narrow-drive.ts
//   Linux:        NB_XVFB_SCREEN=1600x1000x24 scripts/headless.sh bun scripts/narrow-drive.ts
//
// ND_APPEARANCE=dark (AppKit) or ADW_DEBUG_COLOR_SCHEME=prefer-dark (GTK) with
// NB_SHOT_SUFFIX=dark keeps a dark run's captures apart. Prints NB_NARROW_OK.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchApp, type JsonNode } from "@nativedesktop/test";

import { SHOTS, fail, ndshotCapture, ndshotWindows, shoot, walk } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const SCRATCH = process.env.NB_DRIVE_ROOT ?? "/tmp";
const STORE = `${SCRATCH}/nb-narrow-store`;
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
const SUFFIX = process.env.NB_SHOT_SUFFIX ? `-${process.env.NB_SHOT_SUFFIX}` : "";
const WIDEST = 1440;
const NARROWEST = 720;
const STEP = 80;
const CAPTURED = [1440, 1024, 800, 720];
const HEIGHT = 900;

rmSync(STORE, { recursive: true, force: true });
mkdirSync(STORE, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

// Titles longer than any tab, so a title that shows proves the tab gave it
// room rather than that the text happened to be short.
const TITLES = [
  "Quarterly engineering review and roadmap",
  "Release notes for version 2.0.0 of everything",
  "How the layout toggle works in both layouts",
  "Antes de ir a Google, lee esto con calma",
  "A page whose title is far longer than a tab",
  "The last of six tabs with a long title",
];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const i = Number(new URL(req.url).pathname.slice(1));
    const title = TITLES[i];
    if (title === undefined) return new Response("not found", { status: 404 });
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="font:16px system-ui;margin:48px"><h1>${title}</h1></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const base = `http://127.0.0.1:${server.port}`;

const tabs = TITLES.map((title, i) => ({ id: `t${i + 1}`, url: `${base}/${i}`, title, pinned: false }));
const ACTIVE = "t3";
writeFileSync(
  `${STORE}/settings.json`,
  JSON.stringify({ version: 1, data: { layout: "compact", restoreOnLaunch: true } }),
);
writeFileSync(
  `${STORE}/session.json`,
  JSON.stringify({
    version: 2,
    data: {
      windows: [{ id: "w1", tabs, activeId: ACTIVE, width: WIDEST, height: HEIGHT }],
      nextTabId: tabs.length + 1,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);

const app = await launchApp({
  entry: "src/main.tsx",
  cwd: ROOT,
  env: { NB_STORE_DIR: STORE, NB_TEST_HOOKS: "1" },
});
const gtk = app.backend === "gtk";

const failures: string[] = [];
function check(what: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${detail}`);
  if (!ok) failures.push(`${what}: ${detail}`);
}

type Rect = { x: number; y: number; w: number; h: number };
const right = (g: Rect) => g.x + g.w;

function byId(root: JsonNode): Map<string, JsonNode> {
  const out = new Map<string, JsonNode>();
  walk(root, (n) => {
    if (n.testID && !out.has(n.testID)) out.set(n.testID, n);
  });
  return out;
}

/// The node's geometry when it is drawn: visible, laid out, and not a
/// zero-size placeholder.
function drawn(n: JsonNode | undefined): Rect | null {
  const g = n?.geometry;
  return n?.visible && g && g.w > 1 && g.h > 1 ? g : null;
}

/// Pairs among `controls` that share horizontal pixels on the same row.
function overlaps(controls: Array<[string, Rect]>): string[] {
  const out: string[] = [];
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const [an, a] = controls[i]!;
      const [bn, b] = controls[j]!;
      const sameRow = a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
      const shared = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
      if (sameRow && shared > 1) out.push(`${an} and ${bn} share ${Math.round(shared)} px`);
    }
  }
  return out;
}

/// Asks for a width and waits for the window to have it and for the tree to
/// stop changing, which is when the app's own re-render at that width landed.
async function settleAt(width: number): Promise<{ root: JsonNode; winWidth: number }> {
  await app.setWindowSize(width, HEIGHT);
  const deadline = Date.now() + 8000;
  let last = "";
  let stable = 0;
  let root: JsonNode | null = null;
  let winWidth = -1;
  while (Date.now() < deadline) {
    await Bun.sleep(250);
    const { windows } = await app.windows();
    winWidth = Math.round(windows[0]?.geometry?.w ?? -1);
    root = (await app.tree()).root;
    const shape = JSON.stringify(root, (k, v) => (k === "text" ? undefined : v));
    stable = shape === last && winWidth === width ? stable + 1 : 0;
    last = shape;
    if (stable >= 2) break;
  }
  return { root: root ?? fail(`no tree at ${width}`), winWidth };
}

function capture(name: string): Promise<void> | void {
  if (gtk) return shoot(app, name);
  // The screenshot RPC paints a macOS 26 toolbar blank; ndshot takes the
  // window as it is composited.
  const win = ndshotWindows(app.pid)[0] ?? fail("ndshot saw no app window");
  console.log(`  captured ${ndshotCapture(win.windowID, name)}`);
}

/// Whether the window is the width it was asked for. GTK reports the
/// window's content without the few pixels its client-side frame takes, so
/// that much short is the width asked for; anything wider is the window
/// being held open by its minimum.
function atWidth(winWidth: number, width: number): boolean {
  return gtk ? winWidth <= width && winWidth >= width - CSD_FRAME : winWidth === width;
}
const CSD_FRAME = 12;

async function compactStep(width: number): Promise<void> {
  const { root, winWidth } = await settleAt(width);
  const at = `compact@${width}`;
  const nodes = byId(root);
  const min = root.children?.[0]?.minSize?.w ?? root.minSize?.w ?? null;
  check(`${at} window`, atWidth(winWidth, width), `window ${winWidth} px${min !== null ? `, content needs ${min}` : ""}`);
  if (gtk) check(`${at} minimum`, min !== null && min <= NARROWEST, `the window's minimum is ${min} px`);

  const field = drawn(nodes.get("omnibox"));
  check(
    `${at} address field`,
    field !== null && field.x >= 0 && right(field) <= width && field.w >= 120,
    field ? `${Math.round(field.w)} px at ${Math.round(field.x)}..${Math.round(right(field))}` : "not drawn (in the overflow?)",
  );

  const slot = drawn(nodes.get(`tab-slot-${ACTIVE}`));
  const item = nodes.get(`tab-item-${ACTIVE}`);
  const clip = gtk ? drawn(nodes.get("tab-clip")) : null;
  const title = item?.text ?? "";
  check(
    `${at} active tab`,
    slot !== null && title.length > 0 && (drawn(item)?.w ?? 0) >= 60 && (!clip || right(slot) <= right(clip) + 1),
    slot
      ? `"${title.slice(0, 24)}" in ${Math.round(slot.w)} px at ${Math.round(slot.x)}${clip ? `, clip ends ${Math.round(right(clip))}` : ""}`
      : "not drawn",
  );

  const controls: Array<[string, Rect]> = [];
  for (const [id, n] of nodes) {
    const header = id === "reload" || id === "header-new-tab" || id === "omnibox" || id === "layout-toggle" ||
      id === "extensions-button" || id === "downloads-button" || id === "window-menu" ||
      id.startsWith("tab-slot-") || id.startsWith("ext-pin-");
    const g = header ? drawn(n) : null;
    if (g) controls.push([id, g]);
  }
  const off = controls.filter(([, g]) => g.x < -1 || right(g) > width + 1).map(([id, g]) => `${id} at ${Math.round(g.x)}..${Math.round(right(g))}`);
  const shared = overlaps(controls);
  check(`${at} controls`, off.length === 0 && shared.length === 0, [...off, ...shared].join("; ") || `${controls.length} controls, none overlapping`);
  // An end-pack button gone from the row is one AppKit moved into the
  // toolbar's overflow menu.
  const missing = ["downloads-button", "window-menu"].filter((id) => nodes.has(id) && !drawn(nodes.get(id)));
  if (nodes.has("extensions-button") && !drawn(nodes.get("extensions-button"))) missing.push("extensions-button");
  check(`${at} end pack`, missing.length === 0, missing.length ? `${missing.join(", ")} not in the row` : "every end button in the row");
  const tabsShown = controls.filter(([id]) => id.startsWith("tab-slot-")).length;
  console.log(`    ${tabsShown} of ${tabs.length} tabs in the row`);
  if (CAPTURED.includes(width)) await capture(`narrow-compact-${width}${SUFFIX}`);
}

async function sidebarStep(width: number): Promise<void> {
  const { root, winWidth } = await settleAt(width);
  const at = `sidebar@${width}`;
  const nodes = byId(root);
  const min = root.children?.[0]?.minSize?.w ?? root.minSize?.w ?? null;
  check(`${at} window`, atWidth(winWidth, width), `window ${winWidth} px${min !== null ? `, content needs ${min}` : ""}`);
  if (gtk) check(`${at} minimum`, min !== null && min <= NARROWEST, `the window's minimum is ${min} px`);

  const list = drawn(nodes.get("tab-list"));
  const row = drawn(nodes.get(`tab-${ACTIVE}`));
  const title = nodes.get(`tab-${ACTIVE}`)?.text ?? "";
  check(
    `${at} active tab`,
    list !== null && row !== null && title.length > 0 && row.w >= 60 && right(row) <= right(list) + 1,
    row ? `"${title.slice(0, 24)}" in ${Math.round(row.w)} px, list ${list ? Math.round(list.w) : "?"} px` : "not drawn",
  );
  const page = drawn(nodes.get("view-slot"));
  check(`${at} page`, page !== null && page.w >= width / 2, page ? `${Math.round(page.w)} px wide` : "not drawn");

  const controls: Array<[string, Rect]> = [];
  for (const id of ["sidebar-settings", "new-tab", "extensions-button", "downloads-button", "window-menu", "security-none", "security-secure", "security-insecure"]) {
    const g = drawn(nodes.get(id));
    if (g) controls.push([id, g]);
  }
  const off = controls.filter(([, g]) => g.x < -1 || right(g) > width + 1).map(([id]) => id);
  const shared = overlaps(controls);
  check(`${at} controls`, off.length === 0 && shared.length === 0, [...off, ...shared].join("; ") || `${controls.length} controls, none overlapping`);
  if (CAPTURED.includes(width)) await capture(`narrow-sidebar-${width}${SUFFIX}`);
}

async function walkWidths(run: (width: number) => Promise<void>): Promise<void> {
  for (let width = WIDEST; width >= NARROWEST; width -= STEP) {
    await run(width);
    // 1024 is between two steps and is one of the captured widths.
    if (width - STEP < 1024 && width > 1024) await run(1024);
  }
}

try {
  await app.waitForPresent("omnibox", { timeoutMs: PATIENCE });
  // Every restored tab's page has to report its title before a title can be
  // asserted.
  await Bun.sleep(5000);
  console.log(`compact, ${app.backend}`);
  await walkWidths(compactStep);

  await app.click("menu-layout");
  await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
  console.log(`sidebar, ${app.backend}`);
  await walkWidths(sidebarStep);
} catch (e) {
  failures.push(`drive: ${(e as Error).message}`);
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}

if (failures.length > 0) {
  console.error(`NB_NARROW_FAIL ${failures.length}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("NB_NARROW_OK");
