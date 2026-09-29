#!/usr/bin/env bun
// Zoom indicator drive: the magnifier while the page is zoomed, and the
// popover with the value and the controls. Compact carries the magnifier at the
// trailing end of its address field and the popover under it; the sidebar
// layout has no address field, so the magnifier sits among the glyphs at the
// sidebar's foot and the popover opens above it. Seeds a zoomed host, launches
// the app in one layout at one width, steps the zoom from the View menu (which
// shows the popover for a moment, as a chord does) and asserts:
//
//   - the value in the popover is the stepped zoom;
//   - the popover points at the magnifier: the trailing 40px of the address
//     field in compact, the indicator's own button in the sidebar;
//   - macOS: a real Cmd+= with the page focused steps the value again.
//
// It captures the window with the popover up, then opens the find bar,
// captures it, and closes it with Escape, which has to leave the tree.
//
//   bun scripts/zoom-shots.ts <compact|sidebar> <width>
//
// Backend and host come from the usual env (ND_BACKEND, ND_HOST_BINARY). On
// macOS the popover is found in the window server's list and captured with
// ndshot (the icon is clicked and the keys pressed with the real cursor and
// keyboard, so hold the mac CEF gate lock); on GTK the host logs the rectangle
// the popover points at (ND_POPOVER_POINTING), since a popover's own geometry
// is not readable there.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { findNode, launchApp, poll } from "@nativedesktop/test";
import { FRAMEWORK, NDSHOT, SHOTS, fail } from "./drive-lib.ts";

const layout = (process.argv[2] ?? "compact") as "compact" | "sidebar";
const width = Number(process.argv[3] ?? 1280);
const gtk = process.env.ND_BACKEND === "gtk" || process.platform !== "darwin";
const tag = `${layout}-${width}-${gtk ? "gtk" : "appkit"}`;
const STORE = `/tmp/nb-zoom-${tag}`;
const LOG = `${STORE}/host.log`;
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);
/// The icon slot on both backends: GTK's entry icon is 16px plus padding,
/// AppKit's overlay is the cancel-button rect.
const ICON_SLOT = 40;

rmSync(STORE, { recursive: true, force: true });
mkdirSync(STORE, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Zoomed page</title></head>` +
        `<body style="font:16px system-ui;margin:48px"><h1>Zoomed page</h1><p>Fixture for the zoom indicator.</p></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ),
});
const url = `http://127.0.0.1:${server.port}/`;

writeFileSync(
  `${STORE}/settings.json`,
  JSON.stringify({
    version: 1,
    data: { searchEngine: "duckduckgo", homepage: "", restoreOnLaunch: true, layout, sitePermissions: {}, pinnedExtensions: [] },
  }),
);
writeFileSync(
  `${STORE}/session.json`,
  JSON.stringify({
    version: 2,
    data: {
      windows: [{ id: "w1", tabs: [{ id: "t1", url, title: "Zoomed page", pinned: false }], activeId: "t1", width, height: 760 }],
      nextTabId: 2,
      nextWindowId: 2,
      zoomByHost: { [new URL(url).host]: 1.25 },
    },
  }),
);

const app = await launchApp({
  entry: "src/main.tsx",
  backend: gtk ? "gtk" : undefined,
  hostBinary: process.env.ND_HOST_BINARY,
  // Region capture composites the popover window into the screenshot (macOS).
  env: { NB_STORE_DIR: STORE, ND_AUTOMATION_CAPTURE: "region" },
  logPath: LOG,
});
const pid = (app as unknown as { pid: number }).pid;

type Win = { x: number; y: number; width: number; height: number; alpha: number; layer: number };
const census = async (): Promise<Win[]> => {
  const proc = Bun.spawn(["swift", `${FRAMEWORK}/scripts/mac/window-census.swift`, String(pid)], {
    stdout: "pipe",
    env: { ...process.env, SDKROOT: undefined, DEVELOPER_DIR: undefined },
  });
  const text = await new Response(proc.stdout).text();
  return text.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l) as Win);
};

function capture(name = `zoom-${tag}`): void {
  // ScreenCaptureKit sometimes drops the request while another capture is in
  // flight on the machine; a retry is cheaper than a failed run.
  let err = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    // The popover is a window of its own on both backends, so only a region
    // capture includes it, and a region capture can block: bounded.
    const shot = Bun.spawnSync(["timeout", "30", process.env.ND_NDSHOT ?? NDSHOT, "capture", "--pid", String(pid), "--region", "--out", `${SHOTS}/${name}.png`]);
    if (shot.exitCode === 0) return;
    err = shot.stderr.toString().trim();
  }
  fail(`ndshot capture failed: ${err}`);
}

const value = async () => findNode((await app.tree()).root, "zoom-value")?.text ?? "";
const geometry = async (id: string) => findNode((await app.tree()).root, id)?.geometry;

try {
  await app.waitForPresent("page-t1", { timeoutMs: PATIENCE });
  await app.setWindowSize(width, 760);
  await Bun.sleep(2500);
  // Compact's field, or the sidebar's foot glyph, which is only there while
  // the page is not at 100% (the seeded 125%).
  const anchorId = layout === "compact" ? "omnibox" : "zoom-indicator";
  const anchor = await geometry(anchorId);
  if (!anchor || anchor.w <= 0) fail(`${anchorId} never laid out`);
  const right = anchor!.x + anchor!.w;

  // A menu step shows the popover for ZOOM_NOTICE_MS.
  await app.getByTestId("menu-zoom-in").click();
  await poll(value, (v) => v === "150%", { timeoutMs: 5000 }).catch(async () => fail(`the popover value never read 150% (got ${await value()})`));

  if (gtk) {
    // The menu step shows the popover for 1.5s; capture inside that window.
    // GTK on macOS (Quartz) draws the popover in a window of its own, which
    // only a region capture includes.
    if (process.platform === "darwin") capture();
    else await app.screenshot(`${SHOTS}/zoom-${tag}.png`);
    if (layout === "compact") {
      const line = await poll(async () => (await Bun.file(LOG).text()).split("\n").filter((l) => l.includes("ND_POPOVER_POINTING slot=trailingIcon ")).at(-1) ?? null,
        (l) => l != null, { timeoutMs: 5000 }).catch(() => fail("the zoom popover never pointed at the trailing icon"));
      const num = (k: string) => Number(new RegExp(`${k}=(-?\\d+)`).exec(line!)![1]);
      const [x, w, entryW] = [num("x"), num("w"), num("entryW")];
      if (w <= 0 || x < entryW - ICON_SLOT || x + w > entryW) {
        fail(`the zoom popover points at ${x}..${x + w}, outside the trailing ${ICON_SLOT}px of the ${entryW}px field`);
      }
      console.log(`  NB_ZOOM_ANCHOR_OK ${tag} points at ${x}..${x + w} of a ${entryW}px field`);
    } else {
      // A popover anchored on its tree parent points at the whole button.
      console.log(`  NB_ZOOM_ANCHOR_OK ${tag} indicator at ${anchor!.x},${anchor!.y} ${anchor!.w}x${anchor!.h}`);
    }
  } else {
    await Bun.sleep(1800);
    const main = (await app.windows()).windows[0]!.geometry!;
    // The owner's path: a real Cmd+= with the page focused goes to the View
    // menu's accelerator, and the value steps from 150% to 175%.
    const view = await geometry("page-t1");
    if (view) await app.cursor.click({ x: view.x + view.w / 2, y: view.y + view.h / 2 });
    await app.cursor.press("Meta+=");
    await poll(value, (v) => v === "175%", { timeoutMs: 5000 }).catch(async () => fail(`a real Cmd+= did not step the zoom to 175% (got ${await value()})`));
    console.log(`  NB_ZOOM_CHORD_OK ${tag} a real Cmd+= stepped the page to 175%`);
    await app.cursor.press("Meta+-");
    await poll(value, (v) => v === "150%", { timeoutMs: 5000 }).catch(async () => fail(`a real Cmd+- did not step the zoom to 150% (got ${await value()})`));
    console.log(`  NB_ZOOM_CHORD_OK ${tag} a real Cmd+- stepped the page back to 150%`);
    await Bun.sleep(1800);
    // A click on the magnifier keeps the popover up until it is dismissed,
    // which the census below needs: each read compiles a Swift script.
    const at = await geometry(anchorId);
    const iconX = layout === "compact" ? right - 12 : at!.x + at!.w / 2;
    await app.cursor.click({ x: iconX, y: at!.y + at!.h / 2 });
    const pop = await poll(async () => (await census()).find((w) => w.alpha > 0 && w.layer === 0 && w.width < main.w && w.height < 200) ?? null,
      (w) => w != null, { timeoutMs: 8000 }).catch(() => fail("no zoom popover window on screen"));
    const mid = pop!.x + pop!.width / 2 - main.x;
    const top = pop!.y - main.y;
    if (layout === "compact") {
      if (mid < right - ICON_SLOT || mid > right) fail(`the zoom popover points at ${mid}, outside the trailing ${ICON_SLOT}px of the field (${anchor!.x}..${right})`);
      if (top < anchor!.y + anchor!.h - 4) fail(`the zoom popover opened at ${top}, over the field instead of under it`);
    } else {
      if (pop!.x - main.x > at!.x + at!.w || pop!.x + pop!.width - main.x < at!.x) fail(`the zoom popover (${pop!.x - main.x}..${pop!.x + pop!.width - main.x}) is not over the indicator (${at!.x}..${at!.x + at!.w})`);
      if (top + pop!.height > at!.y + 4) fail(`the zoom popover opened at ${top}..${top + pop!.height}, not above the indicator at ${at!.y}`);
    }
    if (pop!.x < main.x || pop!.x + pop!.width > main.x + main.w) fail(`the zoom popover (${pop!.x}..${pop!.x + pop!.width}) hangs out of the window (${main.x}..${main.x + main.w})`);
    console.log(`  NB_ZOOM_ANCHOR_OK ${tag} centre ${mid}, anchor ${at!.x}..${at!.x + at!.w}, popover ${pop!.width}x${pop!.height}`);
    capture();
  }
  console.log(`  capture ${SHOTS}/zoom-${tag}.png`);

  // The find bar: it has to stay inside the window at a narrow width, and
  // Escape has to take it away.
  await Bun.sleep(1800);
  await app.getByTestId("menu-find").click();
  await app.waitFor({ testId: "find-bar", state: "present" }, { timeoutMs: 5000 });
  await app.type("find-query", "zoom");
  await Bun.sleep(700);
  if (process.platform === "darwin") capture(`find-${tag}`);
  else await app.screenshot(`${SHOTS}/find-${tag}.png`);
  console.log(`  capture ${SHOTS}/find-${tag}.png`);
  // GTK on macOS has no input synthesis; the Linux rig's
  // findEscapeReleasesThePage leg covers GTK there.
  if (!gtk || process.platform !== "darwin") {
    if (gtk) await app.keyboard.press("Escape");
    else await app.cursor.press("Escape");
    await app.waitFor({ testId: "find-bar", state: "gone" }, { timeoutMs: 5000 }).catch(() => fail("Escape left the find bar up"));
    console.log(`  NB_FIND_ESCAPE_OK ${tag}`);
  }
  console.log(`NB_ZOOM_OK ${tag}`);
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
