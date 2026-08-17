#!/usr/bin/env bun
// AppKit-only evidence for the native page context menu: the engine's own menu
// opens on a real right-click and carries the app's items merged into it.
//
// This is the ONLY backend where the menu itself is observable. GTK4 removed
// app-constructible input events, so no drive can open a WebKitGTK menu; there
// the proof is the command round trip (`ND_WEBVIEW_TRACE`) plus the unit-tested
// matching in the framework's `src/gtk/context_menu.zig`.
//
//   bun scripts/mac-context-menu.ts
//
// Needs an UNLOCKED login session (synthetic NSEvents go nowhere on a locked
// one) and Screen Recording granted to tools/ndshot (see the framework's
// docs/agents/automation.md). Writes one PNG per candidate window into
// shots/appkit-context-menu-*.png and prints the window list it captured.
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { launchApp } from "@nativedesktop/test";

import { SHOTS, fail, paletteDriver, step } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROFILE = "/tmp/nb-mac-ctxmenu-profile";
const NDSHOT = `${ROOT}/../nd-browser-wave/tools/ndshot/bin/ndshot`;
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

// One link wrapping one image, both filling the viewport, so a click anywhere
// in the content area is a link+image hit whatever the window size is.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/pixel.png") {
      return new Response(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
        { headers: { "content-type": "image/png" } },
      );
    }
    return new Response(
      '<!doctype html><html><head><meta charset="utf-8"><title>Context menu fixture</title>' +
        "<style>html,body{margin:0;height:100%}a{display:block;height:100%}img{width:100%;height:100%}</style>" +
        '</head><body><a href="https://example.com/target"><img src="/pixel.png" alt="target"></a></body></html>',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const base = `http://127.0.0.1:${server.port}`;

interface NdshotWindow {
  pid: number;
  windowID: number;
  app: string;
  title: string;
  width: number;
  height: number;
  onScreen: boolean;
}

function listWindows(pid: number): NdshotWindow[] {
  const out = Bun.spawnSync([NDSHOT, "list"]);
  if (out.exitCode !== 0) fail(`ndshot list failed: ${out.stderr.toString().trim()}`);
  return out.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as NdshotWindow)
    .filter((w) => w.pid === pid && w.onScreen);
}

const { goTo } = paletteDriver({ timeoutMs: PATIENCE });

const app = await launchApp({
  entry: "src/main.tsx",
  backend: "appkit",
  cwd: ROOT,
  env: { NB_STORE_DIR: PROFILE, NB_TEST_HOOKS: "1", ND_APP_ID: "dev.nativebrowser.macctxmenu" },
  // The folder picker answers with the fixture extension, for the second half.
  dialogScript: { "dialog.openFile": [[`${ROOT}/fixtures/pair-probe`]] },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => {
    if (line.includes("ND_APP CTXMENU")) console.log(`   app | ${line.trim()}`);
  },
});

try {
  await goTo(app, `${base}/`);
  await Bun.sleep(1500);
  const page = await app.mustFind("page-t1");
  const before = listWindows(app.pid);

  await step("right-click inside the page", () => app.rightClick({ ref: page.ref }));
  // The menu is a tracking loop in the app process: it opens a window of its
  // own, which is what tells us WebKit answered the click at all.
  await Bun.sleep(1200);
  const after = listWindows(app.pid);
  const known = new Set(before.map((w) => w.windowID));
  const opened = after.filter((w) => !known.has(w.windowID));

  console.log(`windows before the click: ${JSON.stringify(before.map((w) => [w.windowID, w.title, w.width, w.height]))}`);
  console.log(`windows after the click:  ${JSON.stringify(after.map((w) => [w.windowID, w.title, w.width, w.height]))}`);
  if (opened.length === 0) fail("no new window opened: WebKit never showed a context menu");

  for (const window of opened) {
    const out = `${SHOTS}/appkit-context-menu-${window.windowID}.png`;
    const shot = Bun.spawnSync([NDSHOT, "capture", "--out", out, "--window-id", String(window.windowID)]);
    if (shot.exitCode !== 0) fail(`ndshot capture failed for ${window.windowID}: ${shot.stderr.toString().trim()}`);
    console.log(`captured ${out} (${window.width}x${window.height})`);
  }

  // Choosing one of the app's items, from the keyboard: NSMenu's tracking loop
  // pulls from the same event queue the automation posts into. The app's items
  // are the LAST two, so arrowing up twice from nothing selected lands on
  // "Open Link in New Tab" whatever WebKit put above it.
  const tabsBefore = ((await app.mustFind("tab-list")).rows ?? []).length;
  await step("select the app's item", async () => {
    await app.keys("up");
    await app.keys("up");
    await app.keys("return");
  });
  const deadline = Date.now() + 15_000;
  let rows = tabsBefore;
  while (Date.now() < deadline && rows === tabsBefore) {
    await Bun.sleep(250);
    rows = ((await app.mustFind("tab-list")).rows ?? []).length;
  }
  if (rows === tabsBefore) {
    fail(`choosing "Open Link in New Tab" opened no tab (still ${rows}); the item never fired`);
  }
  const titles = ((await app.mustFind("tab-list")).rows ?? []).map((r) => r.title);
  console.log(`the chosen item opened a tab: ${JSON.stringify(titles)}`);

  // Second half: an extension's items in the SAME menu. Pair Probe registers a
  // parent with two children and a link-only item, so this is where the native
  // submenu shows up.
  await step("open the extensions manager", () => app.click("menu-extensions-manage"));
  await app.waitFor({ testId: "ext-manager-add-folder", state: "present" }, { timeoutMs: PATIENCE });
  await step("add the fixture extension", () => app.click("ext-manager-add-folder"));
  await app.waitFor({ testId: "ext-prompt-add", state: "present" }, { timeoutMs: PATIENCE });
  await step("accept the permissions", () => app.click("ext-prompt-add"));
  await Bun.sleep(2500);
  await step("close the manager window", () => app.keys("cmd+w"));
  await Bun.sleep(1000);

  await step("select the fixture tab", () => app.click("menu-tab-0"));
  await Bun.sleep(500);
  const withExtension = await app.mustFind("page-t1");
  const beforeSecond = listWindows(app.pid);
  await step("right-click again", () => app.rightClick({ ref: withExtension.ref }));
  await Bun.sleep(1200);
  const knownSecond = new Set(beforeSecond.map((w) => w.windowID));
  const secondMenus = listWindows(app.pid).filter((w) => !knownSecond.has(w.windowID));
  if (secondMenus.length === 0) fail("no menu opened on the second right-click");
  for (const window of secondMenus) {
    const out = `${SHOTS}/appkit-context-menu-extension-${window.windowID}.png`;
    const shot = Bun.spawnSync([NDSHOT, "capture", "--out", out, "--window-id", String(window.windowID)]);
    if (shot.exitCode !== 0) fail(`ndshot capture failed for ${window.windowID}: ${shot.stderr.toString().trim()}`);
    console.log(`captured ${out} (${window.width}x${window.height})`);
  }
  await app.keys("escape");
  console.log("NB_MAC_CTXMENU_OK");
} catch (e) {
  console.error(`drive failed: ${(e as Error).message}`);
  console.error(app.stderrTail(40));
  throw e;
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
