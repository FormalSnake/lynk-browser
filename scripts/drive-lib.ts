// What both acceptance drives need and neither owns: failure shaping, step
// labelling, screenshots, tree walking, and the cross-window lookups that half
// of this app's UI requires because `getTree` walks one window at a time.
//
// Everything here takes its timeout as an argument rather than reading an
// env var, so a drive keeps one knob (`ND_DRIVE_TIMEOUT_MS`) and this file
// keeps no state.
import { resolve } from "node:path";

import type { AppHandle, JsonNode } from "@nativedesktop/test";

import { CHROMIUM_SCHEME } from "../src/extensions/scheme.ts";

/// What the HOST process needs before it initializes, so every CEF child
/// inherits it. A custom scheme is only standard, secure and CORS-enabled if it
/// was declared during on_register_custom_schemes, which runs before any app
/// code; the app's own registerScheme call installs the factory afterwards.
export const ENGINE_ENV: Record<string, string> =
  process.env.ND_WEBVIEW_ENGINE === "chromium" ? { ND_CEF_SCHEMES: CHROMIUM_SCHEME } : {};

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

/// The app's address bar IS its command palette, and both drives drive it the
/// same way on both backends. Bound to one drive's patience and nothing else.
export function paletteDriver(config: { timeoutMs: number }) {
  /// Open it, unless something already did (New tab does). The palette
  /// presents asynchronously and is not actionable until it does, so every
  /// open waits for it.
  ///
  /// The omnibox is a `<searchinput>` on both backends now, and a field has no
  /// click handler, so the palette opens the way a person opens it: the
  /// Address item in the File menu, which both backends bind to Ctrl+L.
  async function openPalette(app: AppHandle): Promise<void> {
    const node = await app.find("palette");
    if (node?.visible) return;
    const opener = "menu-address";
    await step(`click ${opener}`, () => app.click(opener));
    await step("wait for the palette to present", () =>
      app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: config.timeoutMs }),
    );
  }

  /// setValue(palette, "<string>") replaces the entry text but leaves the
  /// app's controlled `query` state behind (GTK set_text emits changed twice
  /// and the blank intermediate wins), so the ranked item list would not match
  /// what the drive typed. Clearing and inserting keeps both sides in step.
  async function typeQuery(app: AppHandle, text: string): Promise<void> {
    await step("clear the palette query", () => app.setValue("palette", ""));
    await step(`type ${JSON.stringify(text)} into the palette`, () => app.type("palette", text));
  }

  async function goTo(app: AppHandle, url: string): Promise<void> {
    await openPalette(app);
    await typeQuery(app, url);
    await step("submit the palette query", () => app.setValue("palette", true));
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
