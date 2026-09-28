#!/usr/bin/env bun
// Composited captures of the browser chrome, AppKit only.
//
//   bun scripts/mac-chrome-shots.ts
//
// The `screenshot` RPC renders offscreen inside the host, and macOS 26 paints
// nothing for the header bar's hosted views on that path, so an in-process
// capture shows a black band where the toolbar is and cannot answer whether the
// toolbar is actually drawn. This drives the app headful and captures the live
// window through ndshot instead. Needs an unlocked login session and Screen
// Recording granted to tools/ndshot (`ndshot doctor`).
//
// Writes screenshots/chrome-*.png and prints one line per capture.
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { launchApp } from "@nativedesktop/test";

import { SHOTS, fail, ndshotCapture, ndshotWindows, paletteDriver, step, type NdshotWindow } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROFILE = "/tmp/nb-chrome-shots-profile";
const DOWNLOADS = "/tmp/nb-chrome-shots-downloads";
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);

rmSync(PROFILE, { recursive: true, force: true });
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

// Long titles on purpose: the sidebar row is the thing under test, and a short
// title proves nothing about how much of the row it is allowed to use.
const PAGES: Record<string, string> = {
  "/one": "Quarterly engineering review and roadmap",
  "/two": "Antes de ir a Google",
  "/three": "Release notes for version 2.0.0",
  "/four": "How the layout toggle works",
};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/image.png") {
      return new Response(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
        { headers: { "content-type": "image/png" } },
      );
    }
    const title = PAGES[path];
    if (!title) return new Response("not found", { status: 404 });
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
        "<style>body{font:16px/1.5 -apple-system,sans-serif;margin:3rem}</style>" +
        `</head><body><h1>${title}</h1></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const base = `http://127.0.0.1:${server.port}`;

const { goTo, newTab } = paletteDriver({ timeoutMs: PATIENCE });

/// ndshot sees popovers and menus as windows of their own. The app's document
/// window is the biggest one that is not the private window.
function documentWindow(): NdshotWindow {
  const windows = ndshotWindows(app.pid).filter((w) => w.title !== "Private Browsing");
  return windows[0] ?? fail("ndshot saw no app window");
}

function capture(name: string, window = documentWindow()): void {
  const out = ndshotCapture(window.windowID, name);
  console.log(`captured ${out} (${window.width}x${window.height}) title=${JSON.stringify(window.title)}`);
}

/// Logical geometry for the widgets a capture is meant to prove something
/// about, so "the title truncates" has a width next to it rather than a guess
/// from counting pixels in the PNG.
async function measure(what: string, testIds: string[], window?: number): Promise<void> {
  const parts: string[] = [];
  for (const id of testIds) {
    const node = await app.find(id, window === undefined ? {} : { window });
    const g = node?.geometry;
    parts.push(g ? `${id}=${Math.round(g.w)}x${Math.round(g.h)}@${Math.round(g.x)},${Math.round(g.y)}` : `${id}=absent`);
  }
  console.log(`  ${what}: ${parts.join(" ")}`);
}

const app = await launchApp({
  entry: "src/main.tsx",
  backend: "appkit",
  cwd: ROOT,
  env: {
    NB_STORE_DIR: PROFILE,
    NB_DOWNLOAD_DIR: DOWNLOADS,
    NB_TEST_HOOKS: "1",
    NB_TEST_IMAGE: `${base}/image.png`,
    ND_APP_ID: "dev.nativebrowser.chromeshots",
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
});

try {
  await goTo(app, `${base}/one`);
  await app.waitFor({ testId: "page-t1", state: "visible" }, { timeoutMs: PATIENCE });
  for (const path of ["/two", "/three", "/four"]) {
    await step(`open a tab on ${path}`, () => newTab(app, `${base}${path}`));
    await Bun.sleep(900);
  }
  await Bun.sleep(2000);

  await step("pin the active tab", () => app.click("menu-pin-tab"));
  await Bun.sleep(800);
  await measure("sidebar", ["split", "sidebar", "new-tab", "tab-list", "content", "omnibox"]);
  capture("chrome-sidebar");

  await step("download an image", () => app.click("menu-ctx-save-image"));
  await app.waitFor({ testId: "downloads-panel", state: "visible" }, { timeoutMs: PATIENCE });
  await Bun.sleep(1500);
  for (const window of ndshotWindows(app.pid).slice(0, 3)) {
    capture(`chrome-downloads-${window.windowID}`, window);
  }
  await app.keys("escape");
  await Bun.sleep(600);

  // Again on settled content. The first open grows the panel mid-flight (the
  // status line changes and Show in Folder appears), so a difference between
  // the two captures is the popover's backing failing to follow its content.
  await step("reopen the downloads popover", () => app.click("menu-downloads"));
  await app.waitFor({ testId: "downloads-panel", state: "visible" }, { timeoutMs: PATIENCE });
  await Bun.sleep(1200);
  await measure("downloads", ["downloads-panel", "downloads-item-d0", "downloads-reveal-d0", "downloads-folder"]);
  capture("chrome-downloads-settled");
  await app.keys("escape");
  await Bun.sleep(600);

  await step("switch to the compact layout", () => app.click("menu-layout"));
  await Bun.sleep(1200);
  await measure("compact", ["split", "sidebar", "omnibox", "downloads-anchor", "tabs-menu"]);
  capture("chrome-compact");

  await step("back to the sidebar layout", () => app.click("menu-layout"));
  await Bun.sleep(1200);

  await step("open a private window", () => app.click("menu-private-window"));
  await app.waitFor({ testId: "private-omnibox", state: "visible" }, { timeoutMs: PATIENCE });
  await Bun.sleep(1500);
  const priv =
    ndshotWindows(app.pid).find((w) => w.title === "Private Browsing") ?? fail("no private window on screen");
  const privateWindow = (await app.windows()).windows.find((w) => w.title === "Private Browsing");
  await measure("private", ["private-sidebar", "private-new-tab", "private-tab-list", "private-omnibox"], privateWindow?.ref);
  capture("chrome-private", priv);

  console.log("NB_CHROME_SHOTS_OK");
} catch (e) {
  console.error(`capture run failed: ${(e as Error).message}`);
  console.error(app.stderrTail(40));
  throw e;
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
