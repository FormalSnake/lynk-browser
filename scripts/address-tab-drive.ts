#!/usr/bin/env bun
// The tab as the address on macOS, with the real pointer, in both layouts and
// at a normal and a narrow width: resting the pointer on a tab, a pinned tile
// or a row brings up a tooltip window carrying its title and whole address; a
// click on the tab on show opens the command bar on its address, all of it
// selected; a click on the padlock opens the site information under it
// (compact) or over it (sidebar). Captures every one of those states.
//
//   scripts/mac-drive.sh scripts/address-tab-drive.ts
//
// Moves the owner's cursor: run it only while the machine is idle. Prints
// NB_ADDRESS_TAB_OK. Captures land in screenshots/address-tab/.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchApp, type AppHandle, type JsonNode } from "@nativedesktop/test";

import { fail, ndshotWindows, NDSHOT, step, walk } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = `${ROOT}/screenshots/address-tab`;
const SCRATCH = process.env.NB_DRIVE_ROOT ?? "/tmp";
const STORE = `${SCRATCH}/nb-address-tab-store`;
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
/// AppKit shows a tooltip after the pointer has rested about a second.
const TOOLTIP_WAIT_MS = 2500;

if (process.platform !== "darwin") fail("this drive moves the real macOS pointer");
rmSync(STORE, { recursive: true, force: true });
mkdirSync(STORE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const PAGES: Record<string, string> = {
  "/mail": "Inbox (3)",
  "/news": "The Morning Briefing, with a title longer than any tab",
  "/docs": "Widget reference",
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const title = PAGES[new URL(req.url).pathname] ?? "Not found";
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="font:16px system-ui;margin:48px"><h1>${title}</h1>` +
        `<p><a id="link" style="display:block;height:400px;font-size:32px" href="/docs/somewhere/deep?from=hover">A link to hover</a></p></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const base = `http://127.0.0.1:${server.port}`;
const tabs = Object.entries(PAGES).map(([path, title], i) => ({ id: `t${i + 1}`, url: `${base}${path}`, title, pinned: i === 0 }));
const ACTIVE = "t2";
writeFileSync(`${STORE}/settings.json`, JSON.stringify({ version: 1, data: { layout: "compact", restoreOnLaunch: true } }));
writeFileSync(
  `${STORE}/session.json`,
  JSON.stringify({
    version: 2,
    data: { windows: [{ id: "w1", tabs, activeId: ACTIVE, width: 1280, height: 820 }], nextTabId: 4, nextWindowId: 2, zoomByHost: {} },
  }),
);

const problems: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) problems.push(what);
}

const app = await launchApp({
  entry: "src/main.tsx",
  backend: "appkit",
  cwd: ROOT,
  env: { NB_STORE_DIR: STORE, NB_TEST_HOOKS: "1" },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
});

/// The window with everything over it (tooltip, popover, the bar), as the
/// screen shows it.
function capture(name: string): void {
  const win = ndshotWindows(app.pid)[0] ?? fail("ndshot sees no app window");
  const out = `${OUT}/${name}.png`;
  const run = Bun.spawnSync([NDSHOT, "capture", "--region", "--no-focus", "--window-id", String(win.windowID), "--out", out], { timeout: 30_000 });
  if (run.exitCode !== 0) fail(`ndshot capture ${name}: ${run.stderr.toString().trim()}`);
  console.log(`  captured ${out}`);
}

/// The small windows the app has on screen besides its own: a tooltip, a
/// popover.
function smallWindows(): string[] {
  const [main, ...rest] = ndshotWindows(app.pid);
  return rest.filter((w) => main && w.width < main.width / 2 && w.height < 200 && w.width > 20).map((w) => `${w.windowID}:${w.width}x${w.height}`);
}

async function node(id: string): Promise<JsonNode | null> {
  let hit: JsonNode | null = null;
  walk((await app.tree()).root, (n) => {
    if (!hit && n.testID === id) hit = n;
  });
  return hit;
}

/// Rests the pointer on `id` and expects a tooltip window to come up and
/// carry the node's hover text (the accessible name AppKit derives from it).
async function hover(id: string, shot: string): Promise<void> {
  const n = (await node(id)) ?? fail(`${id} is not drawn`);
  const t = tabs.find((x) => id.endsWith(`-${x.id}`))!;
  check(n.label === `${t.title}\n${t.url}`, `${shot}: ${id} hovers ${JSON.stringify(n.label)}`);
  // Off the row first, so the tooltip timer starts on this target.
  await app.cursor.move({ x: 640, y: 400 });
  await Bun.sleep(600);
  const before = new Set(smallWindows());
  await app.cursor.move(app.getByTestId(id));
  await Bun.sleep(TOOLTIP_WAIT_MS);
  const fresh = smallWindows().filter((w) => !before.has(w));
  check(fresh.length > 0, `${shot}: a tooltip window came up over ${id}`);
  capture(shot);
}

/// What the bar's field holds and has selected (the framework's
/// paletteLayout RPC, newer than the published harness's typed surface).
async function barState(): Promise<{ presented: boolean; fieldText: string; selectionStart: number; selectionLength: number }> {
  const rpc = (app as unknown as { rpc: { call(m: string, p: unknown): Promise<unknown> } }).rpc;
  return (await rpc.call("paletteLayout", { testId: "palette" })) as never;
}

async function paletteOpenOn(url: string, what: string): Promise<void> {
  const deadline = Date.now() + PATIENCE;
  let bar = await barState();
  while (Date.now() < deadline && !(bar.presented && bar.fieldText !== "")) {
    await Bun.sleep(150);
    bar = await barState();
  }
  check(bar.fieldText === url, `${what}: the bar opened on ${JSON.stringify(bar.fieldText)}`);
  check(bar.selectionStart === 0 && bar.selectionLength === bar.fieldText.length, `${what}: all of it selected (${bar.selectionStart}+${bar.selectionLength})`);
}

async function closePalette(): Promise<void> {
  await app.click("menu-close-palette");
  await Bun.sleep(500);
}

async function padlock(shot: string, below: boolean): Promise<void> {
  const lock = (await findPrefix("security-")) ?? fail(`${shot}: no padlock`);
  const at = lock.geometry!;
  await app.cursor.click(app.getByTestId(lock.testID!));
  await Bun.sleep(900);
  const pop = await node("site-info-popover");
  check(pop?.visible === true, `${shot}: a click on the padlock opened the site information`);
  const panel = await node("site-info-panel");
  if (panel?.geometry) {
    const g = panel.geometry;
    check(below ? g.y >= at.y + at.h - 2 : g.y + g.h <= at.y + 2, `${shot}: the panel opens ${below ? "under" : "over"} the padlock (${JSON.stringify(g)} vs ${JSON.stringify(at)})`);
  }
  capture(shot);
  await app.cursor.press("Escape");
  await Bun.sleep(800);
  check((await node("site-info-popover"))?.visible !== true, `${shot}: Escape put the site information away`);
}

async function findPrefix(prefix: string): Promise<JsonNode | null> {
  let hit: JsonNode | null = null;
  walk((await app.tree()).root, (n) => {
    if (!hit && n.testID?.startsWith(prefix) && n.visible) hit = n;
  });
  return hit;
}

try {
  await app.waitForPresent(`tab-item-${ACTIVE}`, { timeoutMs: PATIENCE });
  // Every restored page has to report its title before hover text is read.
  await Bun.sleep(5000);
  for (const layout of ["compact", "sidebar"] as const) {
    const item = (id: string) => (layout === "compact" ? `tab-item-${id}` : `tab-${id}`);
    for (const [width, size] of [
      [1280, "normal"],
      [720, "narrow"],
    ] as const) {
      const tag = `${layout}-${size}`;
      await app.setWindowSize(width, 820);
      await Bun.sleep(1200);
      await hover(item(ACTIVE), `${tag}-hover-active`);
      await hover(item("t3"), `${tag}-hover-other`);
      await hover(item("t1"), `${tag}-hover-pinned`);

      await step(`${tag}: click the tab on show`, () => app.cursor.click(app.getByTestId(item(ACTIVE))));
      await paletteOpenOn(tabs[1]!.url, tag);
      await Bun.sleep(400);
      capture(`${tag}-bar-from-tab`);
      await closePalette();

      await padlock(`${tag}-site-info`, layout === "compact");
    }
    if (layout === "compact") {
      await app.click("menu-layout");
      await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
      await Bun.sleep(1500);
    }
  }
  await app.click("menu-layout");
  await app.waitForPresent(`tab-item-${ACTIVE}`, { timeoutMs: PATIENCE });
  await Bun.sleep(1500);

  // Link hover in the page: Chromium's status bubble names where it goes,
  // at the page's bottom corner. Read as a change in that corner between the
  // pointer off the link and on it.
  await app.setWindowSize(1280, 820);
  await Bun.sleep(1000);
  const page = (await findPrefix(`page-${ACTIVE}`))?.geometry ?? (await node("view-slot"))?.geometry ?? fail("no page");
  await app.cursor.move({ x: page.x + page.w - 40, y: page.y + page.h - 200 });
  await Bun.sleep(1200);
  capture("link-off");
  await app.cursor.move({ x: page.x + 160, y: page.y + 300 });
  await Bun.sleep(1500);
  capture("link-on");
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}

if (problems.length) {
  console.error(`NB_ADDRESS_TAB_FAIL ${problems.length}\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("NB_ADDRESS_TAB_OK");
