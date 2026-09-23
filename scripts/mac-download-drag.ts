#!/usr/bin/env bun
// macOS only: a finished download dragged out of the Downloads panel with
// the real cursor lands in Finder as a copy, and the original stays where the
// app keeps it. Moves the owner's cursor, so it runs under the mac CEF lock.
//
//   ND_HOST_BINARY=<bundled NDShell> bun scripts/mac-download-drag.ts
//
// Marker: NB_DOWNLOAD_DRAG_OK.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "@nativedesktop/test";
import { homedir } from "node:os";
import { fail } from "./drive-lib.ts";

const NDSHOT = process.env.ND_NDSHOT ?? join(homedir(), "Developer/NativeDesktop/tools/ndshot/bin/ndshot");

const ROOT = mkdtempSync(join(tmpdir(), "nb-drag-"));
const STORE = join(ROOT, "store");
const FILES = join(ROOT, "files");
const DEST = join(ROOT, "dropped");
for (const d of [STORE, FILES, DEST]) mkdirSync(d, { recursive: true });
const FILE = join(FILES, "drag-me.txt");
writeFileSync(FILE, "dragged out of the browser\n");
const SEED = join(STORE, "seed.json");
writeFileSync(
  SEED,
  JSON.stringify({
    items: [{ id: "a", url: "https://example.com/drag-me.txt", name: "drag-me.txt", path: FILE, state: "complete", received: 27, total: 27, speed: 0, startedAt: Date.now() }],
  }),
);

function osa(script: string): string {
  const out = Bun.spawnSync(["osascript", "-e", script]);
  if (out.exitCode !== 0) fail(`osascript: ${out.stderr.toString().trim()}`);
  return out.stdout.toString().trim();
}

const app = await launchApp({
  entry: "src/main.tsx",
  hostBinary: process.env.ND_HOST_BINARY,
  env: { NB_STORE_DIR: STORE, NB_TEST_HOOKS: "1", NB_DOWNLOADS_SEED: SEED, NB_DOWNLOAD_DIR: FILES },
  logPath: join(ROOT, "host.log"),
});
try {
  await app.waitForPresent("main-window", { timeoutMs: 60_000 });
  // The Downloads panel is a sheet: a window of its own on the screen, and
  // the row's geometry is inside it.
  await app.click("menu-downloads");
  await app.waitFor({ testId: "all-downloads-item-a", state: "present" }, { timeoutMs: 15_000 });
  await Bun.sleep(800);
  const icon = (await app.find("all-downloads-item-a")) ?? fail("no name on the row");
  if (!icon.geometry) fail("the name has no geometry");
  const listed = Bun.spawnSync([NDSHOT, "list"], { timeout: 15_000 }).stdout.toString();
  const sheet = listed
    .split("\n")
    .filter((l) => l.includes(`"pid":${app.pid}`))
    .map((l) => JSON.parse(l) as { x: number; y: number; width: number; height: number; onScreen: boolean })
    .find((w) => w.onScreen && w.width === 600);
  if (!sheet) fail("the Downloads sheet is not on screen");
  const first = (await app.windows()).windows[0]!;
  const from = {
    // The name's leading edge: the label is draggable, and a button's own
    // tracking loop would swallow the drag.
    x: sheet.x + icon.geometry.x + 20 - first.geometry!.x,
    y: sheet.y + icon.geometry.y + icon.geometry.h / 2 - first.geometry!.y,
  };

  // A Finder window on the drop folder, beside the app, not over it.
  Bun.spawnSync(["open", DEST]);
  await Bun.sleep(1500);
  // Icon view: its empty area is the folder itself. In column view the point
  // under the pointer is a row, and a drop there goes into that row's folder.
  osa(`tell application "Finder" to set current view of front window to icon view`);
  osa(`tell application "Finder" to set bounds of front window to {40, 120, 560, 520}`);
  await Bun.sleep(500);
  const to = { x: 300 - first.geometry!.x, y: 320 - first.geometry!.y };

  console.log(`drag from ${JSON.stringify(from)} to ${JSON.stringify(to)} sheet ${JSON.stringify(sheet)} name ${JSON.stringify(icon.geometry)}`);
  // Press, hold, then move a few points before travelling: AppKit only
  // begins a drag session once the pointer has moved past its threshold
  // with the button down.
  await app.cursor.move(from, { steps: 10 });
  await app.cursor.down();
  await Bun.sleep(200);
  await app.cursor.move({ x: from.x + 6, y: from.y + 2 }, { steps: 6 });
  await app.cursor.move(to, { steps: 40 });
  await Bun.sleep(400);
  await app.cursor.up();
  const log = readFileSync(join(ROOT, "host.log"), "utf8");
  console.log(`dragStarted in the host log: ${/dragStarted|drag.*began|draggingSession/i.test(log)}`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !existsSync(join(DEST, "drag-me.txt"))) await Bun.sleep(150);
  if (!existsSync(join(DEST, "drag-me.txt"))) fail(`the dragged file never reached the Finder folder (it holds ${JSON.stringify(readdirSync(DEST))})`);
  if (!existsSync(FILE)) fail("the drag moved the file instead of copying it");
  console.log("NB_DOWNLOAD_DRAG_OK dropped into Finder as a copy");
} finally {
  await app.close().catch(() => {});
  Bun.spawnSync(["osascript", "-e", `tell application "Finder" to close (every window whose target is (POSIX file "${DEST}" as alias))`]);
  rmSync(ROOT, { recursive: true, force: true });
}
