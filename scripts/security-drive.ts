#!/usr/bin/env bun
// The sidebar foot's site information mark against real sites, one load per
// case in the one tab: a secure page shows the lock, plain http the open lock,
// a certificate error let through (Chrome's interstitial, bypassed the way a
// user types past it) and mixed content the warning. Each case is captured as
// the foot alone and as the whole screen.
//
// Linux, inside a rig with xdotool, ImageMagick and Pillow (as
// scripts/linux-sidebar.sh runs sidebar-drive.ts); needs the network.
//
//   ND_HOST_BINARY=<nd-hello> bun scripts/security-drive.ts
//
// macOS, through scripts/mac-drive.sh for the bundled host: the interstitial
// is clicked with the real cursor (`app.cursor`), so hold the mac gate lock,
// and captures go through ndshot.
//
// Marker: NB_SECURITY_OK. Captures land in NB_SECURITY_SHOTS
// (screenshots/security by default).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, type JsonNode } from "@nativedesktop/test";

import { NDSHOT, fail, ndshotWindows, paletteDriver, step, walk } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 45_000);
const SHOTS = process.env.NB_SECURITY_SHOTS ?? resolve(ROOT, "screenshots/security");
mkdirSync(SHOTS, { recursive: true });
const MAC = process.platform === "darwin";
if (!MAC && !process.env.DISPLAY) fail("this drive reads an X screen back");

type Security = "secure" | "insecure" | "mixed" | "invalid";
/// `bypass` loads through Chrome's certificate interstitial first.
const CASES: { name: string; url: string; want: Security; bypass?: boolean }[] = [
  // A secure page with iframes of its own, the first report of this.
  { name: "formalsnake", url: "https://www.formalsnake.dev/", want: "secure" },
  { name: "example", url: "https://example.com/", want: "secure" },
  { name: "wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page", want: "secure" },
  { name: "github", url: "https://github.com/", want: "secure" },
  { name: "http", url: "http://http.badssl.com/", want: "insecure" },
  { name: "neverssl", url: "http://neverssl.com/", want: "insecure" },
  // Chrome upgrades an http image on an https page and shows the lock once
  // the upgrade loads; the form posting to http is what it still warns about.
  { name: "mixed", url: "https://mixed.badssl.com/", want: "secure" },
  { name: "mixed-form", url: "https://mixed-form.badssl.com/", want: "mixed" },
  { name: "expired", url: "https://expired.badssl.com/", want: "invalid", bypass: true },
  { name: "self-signed", url: "https://self-signed.badssl.com/", want: "invalid", bypass: true },
  { name: "secure-again", url: "https://example.com/", want: "secure" },
];

const store = mkdtempSync(join(tmpdir(), "nb-security-"));
writeFileSync(join(store, "settings.json"), JSON.stringify({ version: 1, data: { layout: "sidebar" } }));
const { goTo, closePalette } = paletteDriver({ timeoutMs: PATIENCE });

const app = await launchApp({
  entry: "src/main.tsx",
  cwd: ROOT,
  hostBinary: process.env.ND_HOST_BINARY,
  // The engine's profile is the run's own, never the owner's.
  env: {
    NB_STORE_DIR: store,
    NB_TEST_HOOKS: "1",
    ND_APP_ID: "dev.nativebrowser.security",
    XDG_DATA_HOME: join(store, "data"),
    ND_CEF_CACHE: process.env.ND_CEF_CACHE || join(store, "cef"),
  },
  readyTimeoutMs: PATIENCE * 2,
  rpcTimeoutMs: PATIENCE,
  logPath: process.env.NB_SECURITY_HOST_LOG,
  retries: 0,
});

function sh(...argv: string[]): string {
  const r = Bun.spawnSync(argv);
  if (r.exitCode !== 0) fail(`${argv[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

async function lock(): Promise<JsonNode | null> {
  let hit: JsonNode | null = null;
  walk((await app.tree()).root, (n) => {
    if (!hit && n.testID?.startsWith("security-") && n.visible) hit = n;
  });
  return hit;
}

function windowId(): string {
  return sh("xdotool", "search", "--onlyvisible", "--pid", String(app.pid)).trim().split("\n")[0]!;
}

/// The window's point 0,0 on the screen: GTK draws its shadow inside the X
/// window, and openbox names no frame extents, so the margin is what the X
/// window has over the window's own size, split evenly.
async function windowOrigin(): Promise<{ x: number; y: number }> {
  const info = sh("xwininfo", "-id", windowId());
  const field = (name: string): number => Number(new RegExp(`${name}:\\s+(-?\\d+)`).exec(info)?.[1] ?? 0);
  const win = (await app.windows()).windows[0]?.geometry ?? fail("no window geometry");
  return {
    x: field("Absolute upper-left X") + Math.max(0, (field("Width") - win.w) / 2),
    y: field("Absolute upper-left Y") + Math.max(0, (field("Height") - win.h) / 2),
  };
}

/// Chrome's certificate interstitial takes "thisisunsafe" typed into the page
/// as the user's go-ahead.
async function bypassInterstitial(): Promise<void> {
  const win = (await app.windows()).windows[0]!.geometry!;
  const sidebar = (await app.find("sidebar"))?.geometry ?? { x: 0, w: 280 };
  // The page's middle, past the sidebar.
  const at = { x: sidebar.x + sidebar.w + (win.w - sidebar.w) / 2, y: win.h / 2 };
  if (MAC) {
    await app.cursor.click(at);
    await Bun.sleep(500);
    await app.keyboard.type("thisisunsafe");
    return;
  }
  const o = await windowOrigin();
  sh("xdotool", "mousemove", String(Math.round(o.x + at.x)), String(Math.round(o.y + at.y)), "click", "1");
  await Bun.sleep(500);
  sh("xdotool", "type", "--delay", "60", "thisisunsafe");
}

const results: string[] = [];
const problems: string[] = [];
try {
  await app.waitForPresent("sidebar", { timeoutMs: PATIENCE * 2 });
  await app.setWindowSize(1280, 800);
  await Bun.sleep(1500);
  for (const c of CASES) {
    await step(`${c.name}: load ${c.url}`, () => goTo(app, c.url));
    if (await app.find("palette").then((p) => p?.visible)) await closePalette(app).catch(() => {});
    if (c.bypass) {
      // The interstitial is up once the load has settled on it.
      await Bun.sleep(4000);
      await step(`${c.name}: type past the interstitial`, bypassInterstitial);
    }
    const deadline = Date.now() + PATIENCE;
    let got = "";
    while (Date.now() < deadline) {
      got = (await lock())?.testID?.replace(/^security-/, "") ?? "";
      if (got === c.want) break;
      await Bun.sleep(250);
    }
    // A late report would still change the mark: give it the time a slow page
    // takes to finish, then read it again.
    await Bun.sleep(3000);
    const node = (await lock()) ?? fail(`${c.name}: no site information mark in the foot`);
    got = node.testID!.replace(/^security-/, "");
    const full = `${SHOTS}/${c.name}-screen.png`;
    const g = node.geometry!;
    const sidebar = (await app.find("sidebar"))?.geometry ?? { x: 0, w: 280 };
    let crop: { x: number; y: number; w: number; h: number };
    if (MAC) {
      // The window alone, in its backing pixels.
      const shot = ndshotWindows(app.pid)[0] ?? fail(`${c.name}: ndshot sees no window of the app`);
      sh(NDSHOT, "capture", "--out", full, "--window-id", String(shot.windowID));
      const k = Number(sh("magick", "identify", "-format", "%w", full)) / shot.width;
      crop = { x: Math.round(sidebar.x * k), y: Math.round((g.y - 12) * k), w: Math.round(sidebar.w * k), h: Math.round((g.h + 24) * k) };
    } else {
      sh("import", "-window", "root", "-silent", full);
      const o = await windowOrigin();
      crop = { x: Math.round(o.x + sidebar.x), y: Math.round(o.y + g.y - 12), w: Math.round(sidebar.w), h: Math.round(g.h + 24) };
    }
    // The foot's row, the sidebar's width across.
    const foot = `${SHOTS}/${c.name}-foot.png`;
    sh("magick", full, "-crop", `${crop.w}x${crop.h}+${crop.x}+${crop.y}`, "+repage", "-scale", "300%", foot);
    const line = `${c.name}: ${got} (want ${c.want}) ${c.url}`;
    results.push(line);
    console.log(`  ${got === c.want ? "ok  " : "FAIL"} ${line}  ${foot}`);
    if (got !== c.want) problems.push(line);
  }
} finally {
  await app.close().catch(() => {});
}
console.log(results.join("\n"));
if (problems.length) fail(`NB_SECURITY_FAIL\n${problems.join("\n")}`);
console.log(`NB_SECURITY_OK captures in ${SHOTS}`);
process.exit(0);
