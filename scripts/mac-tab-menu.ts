#!/usr/bin/env bun
// The sidebar's right-click menus on macOS, through the real system cursor
// (`app.cursor`) on AppKit and the automation right-click on the GTK host
// (ND_BACKEND=gtk, which has no input synthesis): a tab row's and a pinned
// tile's. Both hosts write the same menu trace, and the pick is made with real
// keys either way. Each menu is opened, its
// items read off the host's trace and checked (the labels expected, no label
// twice, no leading, trailing or doubled separator), captured, and then every
// item is picked from it once and its effect read back.
//
// The menu's tracking loop owns the main thread, so nothing between the
// right-click and the pick touches the automation socket: the items come from
// the host's `ND_CONTEXT_MENU` trace and the pick is made with the keyboard.
//
// Moves the user's cursor and holds the machine-wide mac gate lock:
//   bash -c '. ~/Developer/NativeDesktop/scripts/mac/cef-gate-lock.sh; cef_gate_lock;
//     trap cef_gate_unlock EXIT; ND_CEF_CACHE=$RUN_DIR/cache bun scripts/mac-tab-menu.ts'
// The host needs Accessibility once: `<host> --nd-grant` with SIP off.
// GTK: ND_BACKEND=gtk ND_HOST_BINARY=<framework>/zig-out/bin/nd-hello, with the
// icon theme on XDG_DATA_DIRS as in scripts/sidebar-drive.ts.
// Marker: NB_MAC_TAB_MENU_OK.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cursor, launchApp, type JsonNode } from "@nativedesktop/test";

import { SHOTS, fail, ndshotWindows, NDSHOT } from "./drive-lib.ts";

const gtkHost = process.env.ND_BACKEND === "gtk";
const compact = process.env.NB_TAB_MENU_LAYOUT === "compact";
const tag = `${gtkHost ? "gtk" : "mac"}-${compact ? "compact" : "sidebar"}`;
/// A tab's right-clickable widget: the sidebar's row or tile, or the compact
/// layout's tab in the toolbar row.
const T = (id: string) => (compact ? `tab-item-${id}` : `tab-${id}`);
const pages = !(gtkHost && process.platform === "darwin");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 30_000);
mkdirSync(SHOTS, { recursive: true });
const store = mkdtempSync(join(tmpdir(), "nb-mac-tab-menu-"));

const loads: Record<string, number> = {};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const key = new URL(req.url).pathname.slice(1);
    loads[key] = (loads[key] ?? 0) + 1;
    return new Response(`<!doctype html><title>Page ${key}</title><h1>${key}</h1>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const url = (path: string) => `${base}/${path}`;

// A pinned tile that has wandered off the page it was pinned at, so Reset to
// Pinned Page has somewhere to go, and four loose tabs to act on.
const tab = (id: string, path: string) => ({ id, url: url(path), title: "", pinned: false });
writeFileSync(
  join(store, "session.json"),
  JSON.stringify({
    version: 2,
    data: {
      windows: [
        {
          id: "w1",
          tabs: [{ id: "t9", url: url("away"), title: "", pinned: true, pinnedUrl: url("home") }, tab("t1", "a"), tab("t2", "b"), tab("t3", "c"), tab("t4", "d")],
          activeId: "t1",
          width: 900,
          height: 600,
        },
      ],
      nextTabId: 10,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);
writeFileSync(
  join(store, "settings.json"),
  JSON.stringify({
    version: 1,
    data: { searchEngine: "duckduckgo", homepage: "", restoreOnLaunch: true, layout: compact ? "compact" : "sidebar", pinnedExtensions: [], sitePermissions: {} },
  }),
);

const traced: string[] = [];
const app = await launchApp({
  entry: "src/main.tsx",
  env: { NB_STORE_DIR: store, NB_TEST_HOOKS: "1" },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => {
    if (line.includes("ND_CONTEXT_MENU ") || line.includes("ND_APP SLEEP ")) traced.push(line.trim());
  },
});

async function poll<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + PATIENCE;
  let last = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
    await Bun.sleep(150);
    last = await read();
  }
  return last;
}

function key(code: number, times = 1): void {
  for (let i = 0; i < times; i++) {
    const run = Bun.spawnSync(["osascript", "-e", `tell application "System Events" to key code ${code}`]);
    if (run.exitCode !== 0) fail(`key code ${code}: ${run.stderr.toString().trim()}`);
  }
}
const DOWN = 125;
const TAB = 48;
const RETURN = 36;
const ESCAPE = 53;

async function testIDs(): Promise<Set<string>> {
  const ids = new Set<string>();
  const { windows } = await app.windows();
  for (const w of windows) {
    const walk = (n: JsonNode): void => {
      if (n.testID) ids.add(n.testID);
      n.children.forEach(walk);
    };
    walk((await app.tree(w.ref)).root);
  }
  return ids;
}

/// The loose rows and the pinned tiles, in the sidebar's order.
async function sidebar(): Promise<{ rows: string[]; tiles: string[] }> {
  const { windows } = await app.windows();
  const root = (await app.tree(windows[0]!.ref)).root;
  const rows: string[] = [];
  const tiles: string[] = [];
  const walk = (n: JsonNode, inRows: boolean): void => {
    const here = inRows || n.testID === "tab-rows";
    const m = n.testID?.match(/^tab-slot-(t\d+)$/);
    if (m) (here ? rows : tiles).push(m[1]!);
    n.children.forEach((c) => walk(c, here));
  };
  walk(root, false);
  return { rows, tiles };
}

interface Item { index: number; kind: string; enabled: boolean; label: string }

/// The last menu the host opened, from its trace.
function shownMenu(): Item[] {
  const lines = traced.filter((l) => l.includes("ND_CONTEXT_MENU "));
  const start = lines.findLastIndex((l) => l.includes(" index=0 "));
  return (start < 0 ? [] : lines.slice(start)).map((l) => {
    const f = /index=(\d+) kind=(\w+) enabled=(\d) label=(.*)$/.exec(l)!;
    return { index: Number(f[1]), kind: f[2]!, enabled: f[3] === "1", label: f[4]! };
  });
}

function menuProblems(items: Item[]): string[] {
  const problems: string[] = [];
  const labels = items.filter((i) => i.kind !== "separator").map((i) => i.label);
  const twice = labels.filter((l, i) => labels.indexOf(l) !== i);
  if (twice.length) problems.push(`duplicate labels ${JSON.stringify(twice)}`);
  // MenuEntry has no submenus, so any other kind would be one the host made up.
  const odd = items.filter((i) => i.kind !== "item" && i.kind !== "separator");
  if (odd.length) problems.push(`submenus or unknown kinds ${JSON.stringify(odd)}`);
  if (items.some((i) => i.kind === "item" && !i.label.trim())) problems.push("an item with no label");
  if (items[0]?.kind === "separator") problems.push("leading separator");
  if (items.at(-1)?.kind === "separator") problems.push("trailing separator");
  items.forEach((it, i) => {
    if (i > 0 && it.kind === "separator" && items[i - 1]!.kind === "separator") problems.push(`adjacent separators at ${i}`);
  });
  return problems;
}

/// Right-clicks `testID` and waits for its menu to be traced.
async function open(testID: string): Promise<Item[]> {
  const before = traced.length;
  const opened = () => traced.slice(before).some((l) => l.includes(" index=0 "));
  // The GDK macOS backend can spend the first press on a window that is not
  // key on making it key, so the GTK run presses again once.
  for (let attempt = 0; attempt < (gtkCursor ? 2 : 1) && !opened(); attempt++) {
    if (gtkCursor) await gtkCursor.rightClick(await screenPoint(testID));
    else await app.cursor.rightClick(app.getByTestId(testID));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !opened()) await Bun.sleep(100);
  }
  // The whole run of lines lands in one write; a beat lets it all arrive.
  await Bun.sleep(300);
  const items = shownMenu();
  if (traced.length === before || items.length === 0) {
    capture(`no-menu-${testID}`);
    const at = gtkCursor ? JSON.stringify(await screenPoint(testID)) : "";
    fail(`right-clicking ${testID} ${at} opened no menu`);
  }
  return items;
}

function capture(name: string): void {
  name = `${tag}-${name}`;
  const own = ndshotWindows(app.pid).filter((w) => w.onScreen).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!own) fail("no window of the app to capture");
  const out = `${SHOTS}/${name}.png`;
  const shot = Bun.spawnSync(["timeout", "30", NDSHOT, "capture", "--out", out, "--window-id", String(own.windowID), "--region", "--no-focus"]);
  if (shot.exitCode !== 0) fail(`ndshot capture ${name}: ${shot.stderr.toString().trim()}`);
  console.log(`captured ${out}`);
}

/// Closes the open menu. Escape does not reach a GTK popover menu on the
/// macOS GDK backend, so there it is closed the way a click elsewhere does.
async function dismiss(): Promise<void> {
  if (!gtkCursor) return key(ESCAPE);
  const own = ndshotWindows(app.pid).filter((w) => w.onScreen).sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
  await gtkCursor.click({ x: own.x + own.width - 40, y: own.y + own.height - 40 }, { steps: 2 });
}

/// Opens `testID`'s menu and picks `label` with the keyboard.
async function pick(testID: string, label: string): Promise<void> {
  const items = await open(testID);
  const target = items.find((i) => i.label === label) ?? fail(`${testID}'s menu has no "${label}" (${items.map((i) => i.label).join(" | ")})`);
  if (!target.enabled) {
    await dismiss();
    fail(`"${label}" is disabled in ${testID}'s menu`);
  }
  // Off the menu, so the item under the pointer does not take the highlight
  // from the keyboard's.
  if (gtkCursor) {
    const own = ndshotWindows(app.pid).filter((w) => w.onScreen).sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
    await gtkCursor.move({ x: own.x + own.width - 40, y: own.y + own.height - 40 }, { steps: 2 });
  }
  const stops = items.filter((i) => i.index <= target.index && i.kind !== "separator" && i.enabled).length;
  // NSMenu opens with nothing highlighted; GTK's popover menu opens with
  // its first item focused, and on the macOS GDK backend moves between its
  // items on Tab only, the arrow keys doing nothing there.
  if (gtkHost) key(TAB, stops - 1);
  else key(DOWN, stops);
  key(RETURN);
  await Bun.sleep(400);
}

const results: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
}

/// The GTK host has no input helper of its own; the AppKit host's posts the
/// same HID-level events for any window, so the right-click is a real one on
/// both. Points are the screen's: the GTK window's origin comes from the
/// window server.
const inputHost = process.env.ND_INPUT_HOST ?? "";
const gtkCursor = gtkHost
  ? new Cursor({ binary: async () => inputHost || fail("ND_INPUT_HOST names an AppKit host for the GTK run"), pid: app.pid, windows: async () => ({ windows: [{ ref: 0, geometry: { x: 0, y: 0, width: 0, height: 0 } }] }) as never })
  : null;

async function screenPoint(testID: string): Promise<{ x: number; y: number }> {
  const own = ndshotWindows(app.pid).filter((w) => w.onScreen).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? fail("no window");
  const box = (await app.getByTestId(testID).boundingBox()) ?? fail(`${testID} has no geometry`);
  return { x: own.x + box.x + box.width / 2, y: own.y + box.y + box.height / 2 };
}

/// Keys go to the frontmost app; the GTK host is never brought forward by an
/// automation call.
function front(): void {
  Bun.spawnSync(["osascript", "-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${app.pid}) to true`]);
}

/// Each menu at the window's normal width and at a narrow one.
async function captureMenus(width: number): Promise<void> {
  const [w] = (await app.windows()).windows;
  await app.setWindowFrame({ window: w!.ref, x: 40, y: 80, width, height: 600 });
  await Bun.sleep(600);
  // A narrow compact row keeps only the tab on show, so its menu stands in
  // for the others there.
  const ids = await testIDs();
  const shown = (id: string) => ids.has(T(id));
  const menus = [[shown("t2") ? T("t2") : T("t1"), "row"], ...(shown("t9") ? [[T("t9"), "tile"]] : [])] as const;
  for (const [testID, name] of menus) {
    await open(testID);
    capture(`tab-menu-${name}-${width}`);
    await dismiss();
    await Bun.sleep(400);
  }
}

try {
  // A narrow compact row drops tabs; the widths below are set before any
  // other tab is needed.
  if (compact) await poll("the tab row", testIDs, (ids) => ids.has(T("t1")));
  else await poll("the sidebar", sidebar, (s) => s.rows.length === 4 && s.tiles.length === 1);
  front();
  await captureMenus(720);
  await captureMenus(900);

  // The menus themselves.
  const rowMenu = await open(T("t2"));
  await dismiss();
  const rowLabels = rowMenu.filter((i) => i.kind !== "separator").map((i) => i.label);
  check("rowMenuItems", JSON.stringify(rowLabels) === JSON.stringify(["Reload", "Duplicate Tab", "Copy Address", "Pin Tab", "Move Tab to New Window", "Put Tab to Sleep", "Close Tab", "Close Other Tabs"]), rowLabels.join(" | "));
  check("rowMenuShape", menuProblems(rowMenu).length === 0, menuProblems(rowMenu).join(", ") || "clean");

  await Bun.sleep(400);
  const tileMenu = await open(T("t9"));
  await dismiss();
  const tileLabels = tileMenu.filter((i) => i.kind !== "separator").map((i) => i.label);
  check("tileMenuItems", JSON.stringify(tileLabels) === JSON.stringify(["Reset to Pinned Page", "Unpin Tab", "Put Tab to Sleep", "Close Tab"]), tileLabels.join(" | "));
  check("tileMenuShape", menuProblems(tileMenu).length === 0, menuProblems(tileMenu).join(", ") || "clean");
  // A restored tab in the background has no page yet, so nothing to let go of.
  const sleepy = (items: Item[]) => items.find((i) => i.label === "Put Tab to Sleep")?.enabled;
  check("sleepNeedsAPage", sleepy(rowMenu) === false && sleepy(tileMenu) === false, `row ${sleepy(rowMenu)}, tile ${sleepy(tileMenu)}`);
  await Bun.sleep(400);

  // Every item, once. Reload on the tab on show, whose page is live; a
  // restored tab in the background has not loaded yet.
  // The GTK host on macOS has no web engine, so the two items whose effect
  // is a page load are proven on the AppKit host and on Linux.
  if (pages) {
    const a0 = await poll("t1 to load", async () => loads.a ?? 0, (n) => n > 0);
    await pick(T("t1"), "Reload");
    const a1 = await poll("t1 to reload", async () => loads.a ?? 0, (n) => n > a0);
    check("reload", a1 > a0, `page a loaded ${a0} -> ${a1}`);

    await pick(T("t1"), "Put Tab to Sleep");
    const slept = await poll("t1 to sleep", async () => traced.some((l) => l.includes("ND_APP SLEEP tab=t1 ")), (v) => v);
    await Bun.sleep(400);
    const asleepMenu = await open(T("t1"));
    await dismiss();
    await Bun.sleep(400);
    check("sleepTab", slept && sleepy(asleepMenu) === false, `slept ${slept}, offered again ${sleepy(asleepMenu)}`);
  } else results.push("skip reload, sleepTab: no web engine on this host");

  await pick(T("t2"), "Duplicate Tab");
  if (compact) {
    // The compact row is proven to open the same menus and run them; the
    // rest acts on the session the same way from either layout.
    const ids = await poll("the duplicate", testIDs, (v) => v.has(T("t10")));
    check("duplicateTab", ids.has(T("t10")), "tab-item-t10 shown");
  } else {
    const dup = await poll("the duplicate", sidebar, (s) => s.rows.length === 5);
    check("duplicateTab", dup.rows.length === 5, `rows ${dup.rows.join(",")}`);

    Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode("") });
    await pick(T("t3"), "Copy Address");
    const copied = await poll("the clipboard", async () => Bun.spawnSync(["pbpaste"]).stdout.toString(), (v) => v === url("c"));
    check("copyAddress", copied === url("c"), copied);

    await pick(T("t4"), "Move Tab to New Window");
    const moved = await poll("a second window", async () => (await app.windows()).windows.length, (n) => n === 2);
    check("moveTabToNewWindow", moved === 2 && !(await sidebar()).rows.includes("t4"), `${moved} windows`);
    // The new window opens over the first; side by side, the first one's rows
    // are under the cursor again.
    const [w1, w2] = (await app.windows()).windows;
    await app.setWindowFrame({ window: w1!.ref, x: 40, y: 80, width: 900, height: 600 });
    await app.setWindowFrame({ window: w2!.ref, x: 960, y: 80, width: 600, height: 500 });
    await Bun.sleep(500);
    // GTK cannot place a window, so the new one may sit over the first one's
    // sidebar there; the first comes back to the front instead.
    if (gtkHost) {
      const own = ndshotWindows(app.pid).filter((w) => w.onScreen).sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
      Bun.spawnSync(["osascript", "-e", `tell application "System Events" to tell (first process whose unix id is ${app.pid}) to perform action "AXRaise" of (first window whose position is {${own.x}, ${own.y}})`]);
      await Bun.sleep(500);
    }

    await pick(T("t1"), "Close Other Tabs");
    const alone = await poll("the other tabs to close", sidebar, (s) => s.rows.length === 1);
    check("closeOtherTabs", JSON.stringify(alone) === JSON.stringify({ rows: ["t1"], tiles: ["t9"] }), JSON.stringify(alone));

    await pick(T("t1"), "Pin Tab");
    const pinned = await poll("t1 to pin", sidebar, (s) => s.tiles.includes("t1"));
    check("pinTab", pinned.tiles.includes("t1") && pinned.rows.length === 0, JSON.stringify(pinned));

    // The tile's own menu, on the one that wandered.
    const home0 = loads.home ?? 0;
    if (!pages) results.push("skip resetToPinnedPage: no web engine on this host");
    else await pick(T("t9"), "Reset to Pinned Page");
    // A restored tile in the background has no page yet; the reset shows when
    // it is opened.
    if (pages) {
      await app.cursor.click(app.getByTestId(T("t9")));
      const home1 = await poll("t9 to go home", async () => loads.home ?? 0, (n) => n > home0);
      check("resetToPinnedPage", home1 > home0, `pinned page loaded ${home0} -> ${home1}`);
    }

    await pick(T("t9"), "Unpin Tab");
    const unpinned = await poll("t9 to unpin", sidebar, (s) => s.rows.includes("t9"));
    check("unpinTab", unpinned.rows.includes("t9") && !unpinned.tiles.includes("t9"), JSON.stringify(unpinned));

    await pick(T("t1"), "Close Tab");
    const closed = await poll("t1 to close", async () => (await testIDs()).has("tab-slot-t1"), (v) => !v);
    check("closeTab", !closed, `tab-slot-t1 ${closed ? "still there" : "gone"}`);
  }
} finally {
  for (const line of results) console.log(line);
  await app.close().catch(() => {});
  server.stop(true);
}

const failed = results.filter((l) => l.startsWith("FAIL"));
if (failed.length) {
  console.log(`NB_MAC_TAB_MENU_FAIL ${failed.length} of ${results.length}`);
  process.exit(1);
}
console.log(`NB_MAC_TAB_MENU_OK ${results.length} checks`);
// The input helper the GTK run borrows lives until its pipe closes.
process.exit(0);
