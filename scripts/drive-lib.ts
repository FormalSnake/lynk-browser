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
export const NDSHOT = `${FRAMEWORK}/tools/ndshot/bin/ndshot`;

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
  const out = Bun.spawnSync([NDSHOT, "list"]);
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
  const shot = Bun.spawnSync([NDSHOT, "capture", "--out", out, "--window-id", String(windowID)]);
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

  /// Navigation goes through the ADDRESS FIELD, not the palette: that is
  /// where a person types an address, and it is deterministic where the
  /// palette is not (a palette opened in the same beat as a tab closing has
  /// come up holding nothing). Enter is a keystroke and GTK synthesises none
  /// (-32003), so the drive fills the field and then runs the handler Enter
  /// runs, through a test-only menu item; the key binding itself stays
  /// uncovered.
  /// The address field is the route on GTK. On AppKit a SearchInput packed
  /// into a header bar is not actionable by the tree's rule (-32001), so the
  /// drive cannot fill it there and the palette is the only field it can both
  /// fill and submit. Framework gap; the app draws the same field on both.
  async function goTo(app: AppHandle, url: string): Promise<void> {
    if (process.platform === "darwin") {
      await openPalette(app);
      await typeQuery(app, url);
      await whenReady("submit the palette query", () => app.setValue("palette", true));
      return;
    }
    // Read back before committing. `text` on the field is the address the app
    // last set, so a navigation that lands between the fill and the commit
    // rewrites the field under the drive, and the commit would then re-enter
    // the address the tab was already on. A person retyping is the same fix.
    await whenReady(`type ${JSON.stringify(url)} into the address field`, async () => {
      await app.setValue("omnibox", url);
      const held = String((await app.mustFind("omnibox")).value ?? "");
      if (held !== url) throw new Error(`the field holds ${JSON.stringify(held)} after being set to ${JSON.stringify(url)}`);
    });
    await whenReady("commit the address field", () => app.click("menu-commit-address"));
  }

  return { openPalette, typeQuery, goTo };
}

/// The titles of a SourceTree's item rows, polled until they satisfy `check`.
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
    last = ((await app.mustFind(testId)).rows ?? []).filter((r) => r.testID).map((r) => r.title);
    if (check(last)) return last;
    await Bun.sleep(120);
  }
  return fail(`timed out waiting for ${what}; ${testId} rows were ${JSON.stringify(last)}`);
}
