#!/usr/bin/env bun
// The built-in blocker, end to end in the real app.
//
//   scripts/mac-drive.sh scripts/adblock-drive.ts          (macOS, holds the CEF lock)
//   ND_APP_BACKEND=gtk bun scripts/adblock-drive.ts        (Linux, headless.sh)
//
// A fresh profile downloads the pinned uBlock Origin release and compiles its
// default lists. A local page then carries one case per kind of rule, with
// real ad-network URLs (blocked before they reach the network, so the run
// does not depend on them), and reports what survived through its title,
// which the window title mirrors. Legs:
//   on        network blocks, a redirect, generic cosmetic rules, the count
//   hide      ⇧⌘H picker with the real cursor, element gone at once
//   restart   same profile: the hidden element is gone before first paint
//   off       blocking off for the site: everything loads, count 0
//   youtube   uBO's own YouTube scriptlets ran (needs the network)
// Prints NB_ADBLOCK_<LEG>_OK per leg and NB_ADBLOCK_DRIVE_OK at the end.
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { launchApp, type AppHandle } from "@nativedesktop/test";

import { SHOTS, fail, ndshotCapture, ndshotWindows, paletteDriver, step } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROFILE = process.env.NB_ADBLOCK_PROFILE ?? "/tmp/nb-adblock-profile";
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 90_000);
const MAC = process.platform === "darwin";
const SKIP_NETWORK = process.env.NB_ADBLOCK_OFFLINE === "1";

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

/// Fixed geometry for the element the picker leg clicks, in CSS pixels from
/// the page's top-left, so the drive can aim the real cursor at it.
const PICK = { left: 40, top: 160, width: 320, height: 60 };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>adblock fixture</title>
<script>
  window.__early = {};
  document.addEventListener("DOMContentLoaded", function () {
    var el = document.getElementById("nb-pick");
    window.__early.pick = getComputedStyle(el).display;
  });
</script>
<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
<script src="https://www.google-analytics.com/analytics.js"></script>
<script src="/js/prebid.js"></script>
</head><body style="margin:0;font:16px system-ui">
<div class="textad" style="height:40px">text ad (generic class rule)</div>
<div id="ad_banner" style="height:40px">banner (generic id rule)</div>
<div id="nb-pick" style="position:absolute;left:${PICK.left}px;top:${PICK.top}px;width:${PICK.width}px;height:${PICK.height}px;background:#fc6;border-radius:8px">Newsletter popup (pick me)</div>
<img id="px" src="https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/?nb=1" width="1" height="1">
<script>
  function shown(sel) { return getComputedStyle(document.querySelector(sel)).display !== "none"; }
  addEventListener("load", function () {
    setTimeout(function () {
      document.title = "R" + JSON.stringify({
        gptStub: typeof window.googletag === "object",
        adsbygoogle: typeof window.adsbygoogle !== "undefined",
        analytics: typeof window.ga === "function",
        prebid: !!window.__prebid,
        pixel: document.getElementById("px").naturalWidth > 0,
        textad: shown(".textad"),
        adBanner: shown("#ad_banner"),
        pick: shown("#nb-pick"),
        pickEarly: window.__early.pick,
      });
    }, 1500);
  });
</script></body></html>`;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/js/prebid.js") return new Response("window.__prebid = 1", { headers: { "content-type": "text/javascript" } });
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
const FIXTURE = `http://127.0.0.1:${server.port}/fixture`;
const { goTo } = paletteDriver({ timeoutMs: PATIENCE });

interface Report {
  gptStub: boolean;
  adsbygoogle: boolean;
  analytics: boolean;
  prebid: boolean;
  pixel: boolean;
  textad: boolean;
  adBanner: boolean;
  pick: boolean;
  pickEarly: string;
}

/// The blocker's own markers, kept apart from the host's stderr tail, which
/// Chromium's logging floods past them.
const marks: string[] = [];

/// The real cursor is the owner's too: it is only taken over while nobody has
/// touched the machine for two minutes.
function ownerIdleSeconds(): number {
  const out = Bun.spawnSync(["ioreg", "-c", "IOHIDSystem"]).stdout.toString();
  const ns = /"HIDIdleTime" = (\d+)/.exec(out)?.[1];
  return ns ? Number(ns) / 1e9 : 0;
}

function launch(): Promise<AppHandle> {
  marks.length = 0;
  return launchApp({
    onStderr: (line) => {
      if (/NB_ADBLOCK|ND_APP (BLOCKED|BLOCKING|HIDDEN|ENGINE)/.test(line)) marks.push(line);
      if (process.env.NB_ADBLOCK_VERBOSE === "1" && /NB_ADBLOCK|ND_APP|ND_RUNTIME|Error|menu|ND_RPC method=click/.test(line)) console.log(`  ${line}`);
    },
    entry: "src/main.tsx",
    backend: MAC ? "appkit" : (process.env.ND_APP_BACKEND as "gtk" | undefined) ?? "gtk",
    cwd: ROOT,
    env: {
      NB_STORE_DIR: PROFILE,
      NB_TEST_HOOKS: "1",
      ND_APP_ID: "dev.nativebrowser.adblockdrive",
      ND_WEBVIEW_TRACE: "1",
      // On YouTube it reports the scriptlet's flag; on the fixture it presses
      // the element the picker is waiting for, for a backend with no real
      // cursor (the press reaches the picker's world through the shared DOM).
      NB_TEST_JS: `if (location.hostname.endsWith("youtube.com")) {
        document.title = "Y" + JSON.stringify({
          flag: window.ytcfg && ytcfg.data_ && ytcfg.data_.EXPERIMENT_FLAGS ? ytcfg.data_.EXPERIMENT_FLAGS.all_web_enable_network_machine : "no ytcfg",
          adPlacements: window.ytInitialPlayerResponse ? typeof ytInitialPlayerResponse.adPlacements : "no response",
          sheets: document.adoptedStyleSheets.length,
        });
      } else {
        var el = document.getElementById("nb-pick"), r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      }`,
    },
    readyTimeoutMs: PATIENCE,
    rpcTimeoutMs: PATIENCE,
  });
}

async function windowTitle(app: AppHandle): Promise<string> {
  const { windows } = await app.windows();
  const titles = windows.map((w) => w.title ?? "");
  return titles.find((t) => t.startsWith("R{")) ?? titles[0] ?? "";
}

/// Waits for the fixture's report, newer than `after` (the title the last
/// leg saw), since a reload keeps the old title until the new one lands.
async function report(app: AppHandle, what: string, after = ""): Promise<Report> {
  const deadline = Date.now() + PATIENCE;
  while (Date.now() < deadline) {
    const title = await windowTitle(app);
    if (title.startsWith("R{") && title !== after) return JSON.parse(title.slice(1)) as Report;
    await Bun.sleep(200);
  }
  return fail(`${what}: no report from the fixture; window title ${JSON.stringify(await windowTitle(app))}`);
}

/// The count the tab last reported, from the app's test-hook log line.
function blockedCount(_app: AppHandle): number {
  const last = marks.filter((l) => l.includes("ND_APP BLOCKED")).at(-1);
  return last ? Number(/ND_APP BLOCKED \S+ (\d+)/.exec(last)?.[1] ?? -1) : -1;
}

function expectReport(r: Report, want: Partial<Report>, leg: string): void {
  const wrong = Object.entries(want).filter(([k, v]) => r[k as keyof Report] !== v);
  if (wrong.length) fail(`${leg}: ${wrong.map(([k, v]) => `${k}=${String(r[k as keyof Report])} want ${String(v)}`).join(", ")}`);
}

function capture(app: AppHandle, name: string): void {
  if (!MAC) return;
  const w = ndshotWindows(app.pid)[0];
  if (w) console.log(`  captured ${ndshotCapture(w.windowID, name)}`);
}

/// The blocker's menu items stay disabled until the app knows the page is
/// Chromium's, which it learns from the first page it draws.
async function waitForEngine(app: AppHandle): Promise<void> {
  const deadline = Date.now() + PATIENCE * 2;
  while (Date.now() < deadline) {
    if (marks.some((l) => l.includes("NB_ADBLOCK_LOADED")) && marks.some((l) => l.includes("ND_APP ENGINE chromium"))) return;
    await Bun.sleep(250);
  }
  fail(`the blocker never loaded (no NB_ADBLOCK_LOADED); markers: ${marks.join(" | ") || "none"}`);
}

let app = await launch();
try {
  // ---- on -------------------------------------------------------------------
  await step("first run: download uBlock Origin and compile its lists", () => waitForEngine(app));
  await goTo(app, FIXTURE);
  const on = await report(app, "on");
  // gpt.js, adsbygoogle.js and analytics.js are swapped for uBO's stubs
  // (`redirect=`), which define the globals so pages relying on them keep
  // working. Generic cosmetic rules stay off on a local address: uBO's own
  // lists say `$ghide` for it, so `textad` and `adBanner` show here, as they do
  // in uBO; the framework's adblock gate covers generic hiding.
  expectReport(on, { gptStub: true, adsbygoogle: true, analytics: true, prebid: false, pixel: false, textad: true, adBanner: true, pick: true }, "on");
  const count = blockedCount(app);
  if (count < 5) fail(`on: blocked count ${count}, want at least 5`);
  capture(app, "adblock-on");
  console.log(`NB_ADBLOCK_ON_OK blocked=${count} ${JSON.stringify(on)}`);

  // ---- hide -----------------------------------------------------------------
  const page = await app.getByTestId("page-t1").boundingBox();
  if (!page) fail("hide: no page geometry");
  await step("turn the picker on (⇧⌘H)", () => app.click("menu-hide-element"));
  await Bun.sleep(400);
  if (MAC && ownerIdleSeconds() > 120) {
    const target = { x: page.x + PICK.left + PICK.width / 2, y: page.y + PICK.top + PICK.height / 2 };
    await app.cursor.move(target);
    await Bun.sleep(300);
    capture(app, "adblock-picker");
    await app.cursor.click(target);
    await Bun.sleep(600);
    await app.keys("escape");
  } else {
    await step("press the element", () => app.click("menu-run-test-js"));
    await Bun.sleep(600);
    await step("put the picker away (⇧⌘H again)", () => app.click("menu-hide-element"));
  }
  await step("reload after the pick", () => app.click("menu-reload"));
  const hidden = await report(app, "hide", `R${JSON.stringify(on)}`);
  expectReport(hidden, { pick: false }, "hide");
  console.log(`NB_ADBLOCK_HIDE_OK ${JSON.stringify(hidden)}`);

  // ---- restart ----------------------------------------------------------------
  await app.close();
  app = await launch();
  await step("restart: the engine comes back", () => waitForEngine(app));
  const restarted = await report(app, "restart");
  expectReport(restarted, { pick: false, pickEarly: "none", prebid: false }, "restart");
  console.log(`NB_ADBLOCK_RESTART_OK ${JSON.stringify(restarted)}`);

  // ---- off ------------------------------------------------------------------
  await step("turn blocking off for 127.0.0.1", () => app.click("menu-blocking"));
  const off = await report(app, "off", `R${JSON.stringify(restarted)}`);
  expectReport(off, { prebid: true, pick: true }, "off");
  if (blockedCount(app) !== 0) fail(`off: blocked count ${blockedCount(app)}, want 0`);
  capture(app, "adblock-off");
  console.log(`NB_ADBLOCK_OFF_OK ${JSON.stringify(off)}`);
  await step("turn blocking back on", () => app.click("menu-blocking"));
  await report(app, "back on", `R${JSON.stringify(off)}`);

  // ---- youtube ----------------------------------------------------------------
  if (!SKIP_NETWORK) {
    await goTo(app, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
    await Bun.sleep(8000);
    await step("read the scriptlet's effect", () => app.click("menu-run-test-js"));
    const deadline = Date.now() + PATIENCE;
    let yt = "";
    while (Date.now() < deadline && !yt.startsWith("Y{")) {
      yt = (await app.windows()).windows.map((w) => w.title ?? "").find((t) => t.startsWith("Y{")) ?? "";
      await Bun.sleep(200);
    }
    console.log(`  youtube report ${yt}`);
    const report = (yt ? JSON.parse(yt.slice(1)) : {}) as { adPlacements?: string; sheets?: number };
    capture(app, "adblock-youtube");
    // uBO's `set, ytInitialPlayerResponse.adPlacements, undefined` ran in the
    // page's own world before YouTube's scripts, and the cosmetic sheet is in.
    if (report.adPlacements !== "undefined") fail(`youtube: adPlacements is ${report.adPlacements}`);
    if (!report.sheets) fail("youtube: no cosmetic stylesheet adopted");
    console.log(`NB_ADBLOCK_YOUTUBE_OK blocked=${blockedCount(app)} ${yt}`);

    // ---- real sites, on and off ----------------------------------------------
    for (const site of (process.env.NB_ADBLOCK_SITES ?? "https://adblock-tester.com/,https://www.cnn.com/,https://www.google.com/search?q=weather,https://github.com/brave/adblock-rust").split(",")) {
      const name = new URL(site).hostname.replace(/^www\./, "");
      await goTo(app, site);
      await Bun.sleep(10_000);
      const blockedOn = blockedCount(app);
      capture(app, `adblock-site-${name}-on`);
      await step(`blocking off for ${name}`, () => app.click("menu-blocking"));
      await Bun.sleep(10_000);
      capture(app, `adblock-site-${name}-off`);
      await step(`blocking back on for ${name}`, () => app.click("menu-blocking"));
      await Bun.sleep(1500);
      console.log(`NB_ADBLOCK_SITE ${name} blocked=${blockedOn}`);
    }
  }

  console.log("NB_ADBLOCK_DRIVE_OK");
} catch (e) {
  console.error(`adblock drive failed: ${(e as Error).message}`);
  console.error(app.stderrTail(60));
  throw e;
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
