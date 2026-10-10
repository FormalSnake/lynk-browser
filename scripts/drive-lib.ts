// What both acceptance drives need and neither owns: failure shaping, step
// labelling, screenshots, tree walking, and the cross-window lookups that half
// of this app's UI requires because `getTree` walks one window at a time.
//
// Everything here takes its timeout as an argument rather than reading an
// env var, so a drive keeps one knob (`ND_DRIVE_TIMEOUT_MS`) and this file
// keeps no state.
import { resolve } from "node:path";

import type { AppHandle, JsonNode } from "@nativedesktop/test";

/** Where every drive's captures land. The app has one screenshot directory. */
export const SHOTS = resolve(import.meta.dir, "../screenshots");

/// The framework checkout, same default and same env override the shell
/// scripts use.
export const FRAMEWORK = resolve(import.meta.dir, "..", process.env.ND_FRAMEWORK_DIR ?? "../NativeDesktop");

/// The signed capture CLI. The `screenshot` RPC renders offscreen inside the
/// host, which on macOS 26 paints hosted views (header bars, text fields)
/// blank; ndshot captures the live composited window over ScreenCaptureKit
/// instead, so it is the only capture that proves what is on screen.
export const NDSHOT = process.env.ND_NDSHOT ?? `${FRAMEWORK}/tools/ndshot/bin/ndshot`;
/// A capture that never returns stalls the whole drive, so each call is cut
/// off and fails instead.
const NDSHOT_TIMEOUT_MS = 30_000;

export interface NdshotWindow {
  pid: number;
  windowID: number;
  app: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  onScreen: boolean;
}

/// Every on-screen window ndshot can see for one process, largest first: the
/// app's own window comes before the popovers and menus hanging off it.
export function ndshotWindows(pid: number): NdshotWindow[] {
  const out = Bun.spawnSync([NDSHOT, "list"], { timeout: NDSHOT_TIMEOUT_MS });
  if (out.exitCode !== 0) fail(`ndshot list failed: ${out.stderr.toString().trim()}`);
  return out.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as NdshotWindow)
    .filter((w) => w.pid === pid && w.onScreen)
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

export function ndshotCapture(windowID: number, name: string): string {
  const out = `${SHOTS}/${name}.png`;
  const shot = Bun.spawnSync([NDSHOT, "capture", "--out", out, "--window-id", String(windowID)], {
    timeout: NDSHOT_TIMEOUT_MS,
  });
  if (shot.exitCode !== 0) fail(`ndshot capture failed for ${windowID}: ${shot.stderr.toString().trim()}`);
  return out;
}

export function fail(message: string): never {
  throw new Error(message);
}

/// Wraps a step so a failure names what was being attempted. Without it, an
/// automation timeout reads as "waitFor timeout" with no clue which one.
export async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
}

export async function shoot(app: AppHandle, name: string, window?: number): Promise<void> {
  const shot = await app.screenshot(`${SHOTS}/${name}.png`, { minBytes: 1000, window });
  console.log(`  screenshot ${name}.png ${shot.width}x${shot.height}`);
}

export function walk(node: JsonNode, visit: (n: JsonNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/// A testId lookup across every window. When the testId names a `<window>`
/// itself, screenshot `node.ref` rather than the window it was found under: the
/// search returns the first window whose subtree contains it, which for a
/// nested window is its opener.
export async function findAcross(
  app: AppHandle,
  testId: string,
): Promise<{ node: JsonNode; window: number } | null> {
  const { windows } = await app.windows();
  for (const info of windows) {
    // A short-lived window (a picker, a prompt) can close between the
    // enumeration and its own query; a vanished window holds no match.
    const node = await app.find(testId, { window: info.ref }).catch((e) => {
      if (String(e).includes("unknown window ref")) return null;
      throw e;
    });
    if (node) return { node, window: info.ref };
  }
  return null;
}

export async function waitAcross(
  app: AppHandle,
  testId: string,
  timeoutMs: number,
): Promise<{ node: JsonNode; window: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findAcross(app, testId);
    if (found) return found;
    await Bun.sleep(150);
  }
  return fail(`timed out waiting for ${testId} in any window`);
}

/// Every node under `prefix` that carries text, in tree order. The drives use
/// it to read a list of labels the app generated (permission warnings, palette
/// hints) without knowing how many there will be.
export async function textsUnder(app: AppHandle, prefix: string, window: number): Promise<string[]> {
  const tree = await app.tree(window);
  const out: string[] = [];
  walk(tree.root, (n) => {
    if (n.testID?.startsWith(prefix) && n.text) out.push(n.text);
  });
  return out;
}

/// Polls one node's text until it satisfies `check`. A label whose text is a
/// live count settles a frame or two after the thing it counts.
export async function waitText(
  app: AppHandle,
  testId: string,
  check: (text: string) => boolean,
  what: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = String((await app.mustFind(testId)).text ?? "");
    if (check(seen)) return seen;
    await Bun.sleep(150);
  }
  return fail(`timed out waiting for ${what}; ${testId} read ${JSON.stringify(seen)}`);
}

/// The command palette, which is also how a drive navigates: neither backend
/// can submit the header's address field (GTK synthesises no key input), and
/// the palette takes its query and its submit over the automation socket.
/// Bound to one drive's patience and nothing else.
export function paletteDriver(config: { timeoutMs: number }) {
  /// Opens it and waits for it to be ACTIONABLE, not merely visible: the
  /// widget is mounted for the life of the window and a dismissed dialog
  /// still reads as visible for a frame or two, so an open that trusted
  /// `visible` would hand the next setValue a palette on its way out.
  /// Ctrl+K is its own shortcut; Ctrl+L belongs to the address field.
  /// Opening one that is already open is a no-op in the app, so this never
  /// needs to know which state it found.
  async function openPalette(app: AppHandle): Promise<void> {
    const opener = "menu-palette";
    await step(`click ${opener}`, () => app.click(opener));
    await step("wait for the palette to present", () =>
      app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: config.timeoutMs }),
    );
  }

  /// An action retried until the widget will take it, the pattern a popover's
  /// content needs too: present is not actionable.
  async function whenReady<T>(what: string, run: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + config.timeoutMs;
    for (;;) {
      try {
        return await run();
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`${what}: ${(e as Error).message}`);
        await Bun.sleep(200);
      }
    }
  }

  /// setValue(palette, "<string>") replaces the entry text but leaves the
  /// app's controlled `query` state behind (GTK set_text emits changed twice
  /// and the blank intermediate wins), so the ranked item list would not match
  /// what the drive typed. Clearing and inserting keeps both sides in step.
  async function typeQuery(app: AppHandle, text: string): Promise<void> {
    await whenReady("clear the palette query", () => app.setValue("palette", ""));
    await whenReady(`type ${JSON.stringify(text)} into the palette`, () => app.type("palette", text));
  }

  /// Navigation goes through the command bar on both backends: it is the
  /// only address field the sidebar layout has, and it takes its query and
  /// its submit over the automation socket where neither backend's header
  /// field can be submitted (GTK synthesises no Enter).
  async function goTo(app: AppHandle, url: string): Promise<void> {
    await openAddressBar(app);
    // Opening the bar rebuilds its field, and text typed into the one it
    // replaces is lost; the submit then went nowhere. The bar's own address
    // row, built from what it holds, says the text landed. Its title is the
    // address as shown, scheme dropped.
    const landed = async (): Promise<boolean> => {
      const rows = (await app.find("palette"))?.rows ?? [];
      return rows.some((r) => r.id === "url" && String(r.title ?? "") !== "" && url.includes(String(r.title)));
    };
    const deadline = Date.now() + config.timeoutMs;
    for (;;) {
      await typeQuery(app, url);
      const settle = Date.now() + 1500;
      while (Date.now() < settle && !(await landed())) await Bun.sleep(100);
      if (await landed()) break;
      if (Date.now() > deadline) throw new Error(`the command bar never took ${JSON.stringify(url)}`);
    }
    await whenReady("submit the palette query", () => app.setValue("palette", true));
  }

  /// ⌘L: the command bar as an address bar, seeded with the page's address.
  async function openAddressBar(app: AppHandle): Promise<void> {
    await step("click menu-address", () => app.click("menu-address"));
    await step("wait for the address bar to present", () =>
      app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: config.timeoutMs }),
    );
  }

  /// ⌘T, then an address: the command bar opens for a new tab and Enter
  /// opens the address in one. No tab exists until Enter.
  async function newTab(app: AppHandle, url: string): Promise<void> {
    await step("click menu-new-tab", () => app.click("menu-new-tab"));
    await step("wait for the command bar to present", () =>
      app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: config.timeoutMs }),
    );
    await typeQuery(app, url);
    await whenReady("submit the palette query", () => app.setValue("palette", true));
  }

  /// Esc, which GTK cannot synthesise: the test-only item runs its handler.
  async function closePalette(app: AppHandle): Promise<void> {
    await step("close the command bar", () => app.click("menu-close-palette"));
    await step("wait for the command bar to go", async () => {
      const deadline = Date.now() + config.timeoutMs;
      while (Date.now() < deadline) {
        if (!(await app.find("palette"))?.visible) return;
        await Bun.sleep(120);
      }
      fail("the command bar is still up");
    });
  }

  return { openPalette, openAddressBar, typeQuery, goTo, newTab, closePalette };
}

/// The titles of a SourceTree's item rows, polled until they satisfy `check`.
/// The tab rows a list draws, in order: a source list's rows (the private
/// window's), or the tab buttons under the sidebar layout's list box. Section
/// headings are left out either way.
export function listRows(list: JsonNode): { title: string; testID: string }[] {
  if (list.rows) return list.rows.filter((r) => r.testID).map((r) => ({ title: r.title, testID: r.testID! }));
  const rows: { title: string; testID: string }[] = [];
  walk(list, (n) => {
    if (n.testID && /(^|-)tab-t\d+$/.test(n.testID)) rows.push({ title: n.text ?? "", testID: n.testID });
  });
  return rows;
}

/// The section headings a list reads as: a source list's heading rows, or,
/// for the sidebar layout, "Pinned" once a tab is pinned and "Tabs" under it
/// when there are unpinned tabs too (the old list's headings).
export function listSections(list: JsonNode): string[] {
  if (list.rows) return list.rows.filter((r) => !r.testID).map((r) => r.title);
  const count = (suffix: string): number => {
    let n = 0;
    walk(list, (node) => {
      if (node.testID?.endsWith(suffix)) n += listRows(node).length;
    });
    return n;
  };
  const pinned = count("pinned-tabs");
  const today = count("today-tabs");
  if (pinned === 0) return [];
  return today > 0 ? ["Pinned", "Tabs"] : ["Pinned"];
}

/// The selected tab's id: a source list's value, or the sidebar row that
/// carries a close button (or its load spinner, or a pinned tile's marker)
/// while the pointer is elsewhere.
export function listActive(list: JsonNode): string {
  if (list.rows) return String(list.value ?? "");
  let found = "";
  walk(list, (n) => {
    const m = /tab-(?:close|spinner|live)-(t\d+)$/.exec(n.testID ?? "");
    if (m && !found) found = m[1]!;
  });
  return found;
}

/// Both drives assert on a tab list; only the widget's testId differs. A
/// `section` heading is a row too and carries no testID, so filtering on that
/// is what keeps "the second tab" meaning the second TAB.
export async function waitRows(
  app: AppHandle,
  testId: string,
  check: (rows: string[]) => boolean,
  what: string,
  timeoutMs: number,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = listRows(await app.mustFind(testId)).map((r) => r.title);
    if (check(last)) return last;
    await Bun.sleep(120);
  }
  return fail(`timed out waiting for ${what}; ${testId} rows were ${JSON.stringify(last)}`);
}

/// The sidebar foot's glyphs, in the one order every backend draws them. An
/// unnamed child is the spacer before GTK's New Tab plus.
const FOOT_ORDER = [
  "sidebar-settings",
  "site-info-anchor",
  "popups-anchor",
  "zoom-anchor",
  "downloads-anchor",
  "window-menu",
  "extensions-anchor",
  "ext-pin-",
  "",
  "new-tab",
];

/// Fails unless the foot's children run in FOOT_ORDER, both in the tree and
/// left to right on screen, with no testID twice, and every glyph drawn at
/// full size. A pinned extension action is the one glyph a full foot may
/// squeeze out (AppKit gives it no width when the sidebar is narrow); the
/// puzzle before it still lists it. Answers the children's ids.
export function assertFootOrder(bar: JsonNode, line: string, prefix = ""): string[] {
  const ids = bar.children.map((c) => (c.testID ?? "").slice(prefix.length));
  const rank = (id: string): number => {
    const i = FOOT_ORDER.findIndex((want) => (want.endsWith("-") ? id.startsWith(want) : id === want));
    if (i < 0) fail(`${line}: the foot holds an unknown child ${JSON.stringify(id)} (${ids.join(", ")})`);
    return i;
  };
  const named = ids.filter((id) => id);
  if (new Set(named).size !== named.length) fail(`${line}: the foot holds a glyph twice (${ids.join(", ")})`);
  if (ids[0] !== "sidebar-settings") fail(`${line}: settings does not lead the foot (${ids.join(", ")})`);
  for (let i = 1; i < ids.length; i++) {
    if (rank(ids[i]!) < rank(ids[i - 1]!)) fail(`${line}: the foot is out of order (${ids.join(", ")})`);
  }
  for (const c of bar.children) {
    const id = (c.testID ?? "").slice(prefix.length);
    if (!id || id.startsWith("ext-pin-")) continue;
    const g = c.geometry;
    if (!g || g.w < 16 || g.h < 16) fail(`${line}: ${id} is not drawn at full size (${JSON.stringify(g)}; ${ids.join(", ")})`);
  }
  let right = -Infinity;
  for (const c of bar.children) {
    const g = c.geometry;
    if (!g || g.w <= 0) continue;
    if (g.x < right - 1) fail(`${line}: ${c.testID ?? "the spacer"} is drawn left of its predecessor (${ids.join(", ")})`);
    right = g.x + g.w;
  }
  return ids;
}
