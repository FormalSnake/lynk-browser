#!/usr/bin/env bun
// Landing page captures of the shipped app on macOS: real sites, Chromium,
// the system's appearance (run it with the mac in Dark).
//
//   bunx nd package mac --no-sign --no-notarize
//   bun scripts/site-shots-mac.ts
//
// Runs on the packaged bundle because CEF needs its framework and helper apps
// at fixed paths; a bare host falls back to WKWebView. The profile lives in a
// fresh temp dir, so nothing of the owner's browsing shows up.
// Writes site/src/assets/shots/mac-*.png. Marker: NB_SITE_SHOTS_OK.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp } from "@nativedesktop/test";

import { NDSHOT, fail, ndshotWindows, paletteDriver, step, walk } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(ROOT, "site/src/assets/shots");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
const HOST = process.env.ND_HOST_BINARY ?? resolve(ROOT, "dist/mac/Lynk Browser.app/Contents/MacOS/Lynk Browser");
const RUN = mkdtempSync(join(tmpdir(), "nb-site-shots-"));
mkdirSync(OUT, { recursive: true });

const HOME = "https://www.formalsnake.dev";
const PINS = ["https://github.com", "https://www.youtube.com", "https://en.wikipedia.org"];
const TABS = [
  `${HOME}/blog`,
  `${HOME}/projects`,
  "https://github.com/FormalSnake",
  "https://en.wikipedia.org/wiki/Web_browser",
];
const ARTICLE = `${HOME}/blog/12-my-coding-setup`;

mkdirSync(join(RUN, "store"), { recursive: true });
writeFileSync(
  join(RUN, "store", "settings.json"),
  JSON.stringify({ version: 1, data: { freshWindow: true, homepage: HOME, layout: "sidebar" } }),
);

const lines: string[] = [];
const app = await launchApp({
  entry: "src/main.tsx",
  backend: "appkit",
  cwd: ROOT,
  hostBinary: HOST,
  env: {
    NB_STORE_DIR: join(RUN, "store"),
    NB_DOWNLOAD_DIR: join(RUN, "downloads"),
    // Only for the reader's log line; the Debug menu it adds lives in the
    // menu bar, outside the window capture.
    NB_TEST_HOOKS: "1",
    ND_WEBVIEW_ENGINE: "chromium",
    ND_CEF_STYLE: "chrome",
    ND_CEF_CACHE: join(RUN, "cef"),
    ND_APP_ID: "dev.nativebrowser.siteshots",
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
  onStderr: (line) => {
    lines.push(line);
  },
});

const { goTo, newTab, openPalette, typeQuery } = paletteDriver({ timeoutMs: PATIENCE });

function capture(name: string): void {
  const window = ndshotWindows(app.pid)[0] ?? fail("no app window on screen");
  const out = `${OUT}/${name}.png`;
  const shot = Bun.spawnSync([NDSHOT, "capture", "--out", out, "--window-id", String(window.windowID)], { timeout: 30_000 });
  if (shot.exitCode !== 0) fail(`capture ${name}: ${shot.stderr.toString().trim()}`);
  console.log(`captured ${out} (${window.width}x${window.height} pt)`);
}

/// The active tab is done when its row has no spinner and the load bar is
/// gone; favicons and web fonts land a beat later, hence the settle.
async function settled(settleMs = 3000): Promise<void> {
  const deadline = Date.now() + PATIENCE;
  for (;;) {
    const busy: string[] = [];
    walk((await app.tree()).root, (n) => {
      if (n.visible && /(^|-)tab-spinner-t\d+$/.test(n.testID ?? "")) busy.push(n.testID!);
    });
    if (busy.length === 0) break;
    if (Date.now() > deadline) fail(`the page never finished loading: ${busy.join(" ")}`);
    await Bun.sleep(250);
  }
  await Bun.sleep(settleMs);
}

/// View > Tabs lists every tab of the window; its items select them.
async function selectTab(match: (label: string) => boolean): Promise<void> {
  const items: { id: string; label: string }[] = [];
  walk((await app.tree()).root, (n) => {
    if (/^menu-tab-\d+$/.test(n.testID ?? "")) items.push({ id: n.testID!, label: n.text ?? "" });
  });
  const hit = items.find((i) => match(i.label)) ?? fail(`no tab matched among ${JSON.stringify(items.map((i) => i.label))}`);
  await app.click(hit.id);
}

async function readerOn(): Promise<void> {
  const deadline = Date.now() + PATIENCE;
  while (!lines.some((l) => /ND_APP READER t\d+ on/.test(l))) {
    const failed = lines.find((l) => l.includes("ND_APP READER failed"));
    if (failed) fail(failed);
    if (Date.now() > deadline) fail("reading mode never came up");
    await Bun.sleep(150);
  }
}

try {
  await app.setWindowSize(1440, 900);
  await step("wait for the homepage", () => settled());

  await step("pin the homepage", () => app.click("menu-pin-tab"));
  for (const url of PINS) {
    await step(`open ${url}`, () => newTab(app, url));
    await settled(1500);
    await step(`pin ${url}`, () => app.click("menu-pin-tab"));
    await Bun.sleep(500);
  }
  for (const url of TABS) {
    await step(`open ${url}`, () => newTab(app, url));
    await settled(1500);
  }
  await step("back to the homepage", () => selectTab((l) => /formalsnake/i.test(l) && !/blog|projects/i.test(l)));
  await settled(4000);
  capture("mac-hero");

  await step("open the command bar", () => openPalette(app));
  await typeQuery(app, "formal");
  // The inserted text comes back selected; a caret reads as typed.
  await app.keys("right");
  await Bun.sleep(1500);
  capture("mac-command-bar");
  await app.keys("escape");
  await Bun.sleep(800);

  await step("select the blog", () => selectTab((l) => /blog/i.test(l)));
  await settled(1500);
  await step("switch to the compact layout", () => app.click("menu-layout"));
  await Bun.sleep(2500);
  capture("mac-compact");
  await step("back to the sidebar layout", () => app.click("menu-layout"));
  await Bun.sleep(1500);

  await step("open the article", () => goTo(app, ARTICLE));
  await settled(3000);
  await step("enter reading mode", () => app.click("menu-reader"));
  await readerOn();
  await Bun.sleep(2000);
  capture("mac-reader");

  console.log("NB_SITE_SHOTS_OK");
} catch (e) {
  console.error(`capture run failed: ${(e as Error).message}`);
  console.error(app.stderrTail(40));
  throw e;
} finally {
  await app.close().catch(() => {});
}
