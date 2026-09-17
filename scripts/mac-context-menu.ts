#!/usr/bin/env bun
// AppKit-only evidence for the native page context menu: the engine's own menu
// opens on a real right-click and carries the app's items merged into it.
//
// This is the ONLY backend where the menu itself is observable. GTK4 removed
// app-constructible input events, so no drive can open the menu there; the
// proof is the command round trip (`ND_WEBVIEW_TRACE`) plus the unit-tested
// matching in the framework's `src/gtk/context_menu.zig`.
//
//   bun scripts/mac-context-menu.ts
//
// Needs an UNLOCKED login session (synthetic NSEvents go nowhere on a locked
// one) and Screen Recording granted to tools/ndshot (see the framework's
// docs/agents/automation.md). Writes one PNG per candidate window into
// screenshots/appkit-context-menu-*.png and prints the window list it captured.
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { launchApp } from "@nativedesktop/test";

import { SHOTS, fail, ndshotCapture, ndshotWindows, paletteDriver, step, type NdshotWindow } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROFILE = "/tmp/nb-mac-ctxmenu-profile";
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

const { goTo } = paletteDriver({ timeoutMs: PATIENCE });

/// Right-clicks until a menu window actually opens. Headful synthesis is at the
/// mercy of what has focus: a click that lands while another app is frontmost
/// activates this one instead of opening anything.
async function openMenu(ref: number, what: string): Promise<NdshotWindow[]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const before = new Set(ndshotWindows(app.pid).map((w) => w.windowID));
    await app.rightClick({ ref });
    await Bun.sleep(1200);
    const opened = ndshotWindows(app.pid).filter((w) => !before.has(w.windowID));
    if (opened.length > 0) return opened;
    console.log(`   ${what}: no menu on attempt ${attempt}, retrying`);
    await app.keys("escape").catch(() => {});
    await Bun.sleep(600);
  }
  return fail(`${what}: the engine never showed a context menu`);
}

const app = await launchApp({
  entry: "src/main.tsx",
  backend: "appkit",
  cwd: ROOT,
  env: { NB_STORE_DIR: PROFILE, NB_TEST_HOOKS: "1", ND_APP_ID: "dev.nativebrowser.macctxmenu" },
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
  // The menu is a tracking loop in the app process: it opens a window of its
  // own, which is what tells us the engine answered the click at all.
  const opened = await step("right-click inside the page", () => openMenu(page.ref, "first right-click"));
  console.log(`menu windows: ${JSON.stringify(opened.map((w) => [w.windowID, w.width, w.height]))}`);

  for (const window of opened) {
    const out = ndshotCapture(window.windowID, `appkit-context-menu-${window.windowID}`);
    console.log(`captured ${out} (${window.width}x${window.height})`);
  }

  // Choosing one of the app's items, from the keyboard: NSMenu's tracking loop
  // pulls from the same event queue the automation posts into. The app's items
  // are the LAST two, so arrowing up twice from nothing selected lands on
  // "Open Link in New Tab" whatever the engine put above it.
  const tabsBefore = ((await app.mustFind("tab-list")).rows ?? []).length;
  // The menu's tracking loop needs a beat between posted events: back to back,
  // the first arrow can land before the loop starts pulling from the queue.
  await step("select the app's item", async () => {
    await Bun.sleep(400);
    await app.keys("up");
    await Bun.sleep(250);
    await app.keys("up");
    await Bun.sleep(250);
    if (process.env.NB_CTXMENU_DEBUG === "1") {
      for (const window of opened) ndshotCapture(window.windowID, "appkit-context-menu-selected");
    }
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
  console.log("NB_MAC_CTXMENU_OK");
} catch (e) {
  console.error(`drive failed: ${(e as Error).message}`);
  console.error(app.stderrTail(40));
  throw e;
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
