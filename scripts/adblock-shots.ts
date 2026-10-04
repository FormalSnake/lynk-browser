#!/usr/bin/env bun
// The blocker's surfaces, captured: the command bar's blocker rows, and the
// site-info popover's switch with the page's blocked count, on and off.
//
//   bun scripts/adblock-shots.ts <compact|sidebar> <width>
//
// Backend and host come from the usual env (ND_BACKEND, ND_HOST_BINARY); on
// macOS run it under scripts/mac-drive.sh, which holds no lock itself, so wrap
// it in the CEF gate lock. NB_ADBLOCK_ZIP points at a copy of the uBO release.
// Asserts the rows and the count it captures, then prints NB_ADBLOCK_SHOTS_OK.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { findNode, launchApp, poll } from "@nativedesktop/test";
import { NDSHOT, SHOTS, fail, paletteDriver } from "./drive-lib.ts";

const layout = (process.argv[2] ?? "compact") as "compact" | "sidebar";
const width = Number(process.argv[3] ?? 1280);
const gtk = process.env.ND_BACKEND === "gtk" || process.platform !== "darwin";
const tag = `${layout}-${width}-${gtk ? "gtk" : "appkit"}`;
const STORE = `${process.env.NB_ADBLOCK_SHOTS_DIR ?? "/tmp"}/nb-adblock-shots-${tag}`;
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);

rmSync(STORE, { recursive: true, force: true });
mkdirSync(STORE, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Morning Post</title>
<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-NB"></script>
</head><body style="font:17px Georgia,serif;margin:40px auto;max-width:680px;padding:0 24px">
<h1>Morning Post</h1><p>A fixture for the blocker's surfaces.</p>
<img src="https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/?nb=1" width="1" height="1">
<iframe src="https://tpc.googlesyndication.com/safeframe/1-0-40/html/container.html" width="300" height="250"></iframe>
<p>The rest of the article.</p></body></html>`,
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
      windows: [{ id: "w1", tabs: [{ id: "t1", url, title: "Morning Post", pinned: false }], activeId: "t1", width, height: 760 }],
      nextTabId: 2,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);

const marks: string[] = [];
const app = await launchApp({
  entry: "src/main.tsx",
  backend: gtk ? "gtk" : undefined,
  hostBinary: process.env.ND_HOST_BINARY,
  env: { NB_STORE_DIR: STORE, NB_TEST_HOOKS: "1", NB_ADBLOCK_NO_REFRESH: "1", ND_AUTOMATION_CAPTURE: "region" },
  onStderr: (line) => {
    if (/NB_ADBLOCK|ND_APP (BLOCKED|BLOCKING|ENGINE)/.test(line)) marks.push(line);
    if (process.env.NB_ADBLOCK_VERBOSE === "1" && /adblock (block|redirect)/.test(line)) console.log(`  ${line}`);
  },
  readyTimeoutMs: PATIENCE,
  rpcTimeoutMs: PATIENCE,
});
const pid = (app as unknown as { pid: number }).pid;
const { openPalette, typeQuery, closePalette } = paletteDriver({ timeoutMs: PATIENCE });

async function capture(name: string): Promise<void> {
  const out = `${SHOTS}/${name}-${tag}.png`;
  if (gtk && process.platform !== "darwin") {
    // The X root is the only capture holding both the page (CEF draws into
    // an X11 child window of its own) and the popover's window.
    const shot = Bun.spawnSync(["timeout", "30", "import", "-window", "root", out]);
    if (shot.exitCode !== 0) fail(`import -window root failed: ${shot.stderr.toString().trim()}`);
  } else {
    // The palette and the popover are windows of their own, which only a
    // region capture includes.
    let err = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const shot = Bun.spawnSync(["timeout", "30", process.env.ND_NDSHOT ?? NDSHOT, "capture", "--pid", String(pid), "--region", "--out", out]);
      if (shot.exitCode === 0) break;
      err = shot.stderr.toString().trim();
      if (attempt === 2) fail(`ndshot capture failed: ${err}`);
    }
  }
  console.log(`  capture ${out}`);
}

/// The padlock, the site information's own button in both layouts.
async function openSiteInfo(): Promise<void> {
  let lock = "";
  const visit = (n: { testID?: string; children?: unknown[] }): void => {
    if (!lock && n.testID?.startsWith("security-")) lock = n.testID;
    for (const c of (n.children ?? []) as (typeof n)[]) visit(c);
  };
  visit((await app.tree()).root as { testID?: string; children?: unknown[] });
  if (!lock) fail("no padlock");
  await app.click(lock);
}

const blocked = (): number => Number(/ND_APP BLOCKED \S+ (\d+)/.exec(marks.filter((l) => l.includes("ND_APP BLOCKED")).at(-1) ?? "")?.[1] ?? -1);
const text = async (id: string): Promise<string> => findNode((await app.tree()).root, id)?.text ?? "";

try {
  await app.waitForPresent("page-t1", { timeoutMs: PATIENCE });
  await app.setWindowSize(width, 760);
  await poll(async () => marks.some((l) => l.includes("NB_ADBLOCK_LOADED")) && marks.some((l) => l.includes("ND_APP ENGINE chromium")), (v) => v, {
    timeoutMs: PATIENCE,
  }).catch(() => fail(`the blocker never loaded; ${marks.join(" | ")}`));
  // The restored tab can load before the lists did; this load is filtered.
  await app.getByTestId("menu-reload").click();
  await poll(async () => blocked(), (n) => n >= 3, { timeoutMs: PATIENCE }).catch(() => fail(`blocked count ${blocked()}, want 3 or more`));
  await Bun.sleep(1500);

  // ---- command bar --------------------------------------------------------
  await openPalette(app);
  await typeQuery(app, "ads");
  const rows = await poll(async () => (await app.find("palette"))?.rows ?? [], (r) => r.some((x) => x.id === "cmd:blocking"), { timeoutMs: 5000 }).catch(() =>
    fail("no blocking row for \"ads\""),
  );
  const row = rows.find((r) => r.id === "cmd:blocking")!;
  if (row.title !== "Allow Ads on 127.0.0.1") fail(`blocking row reads ${JSON.stringify(row.title)}`);
  if (!/requests? blocked on this page/.test(String(row.subtitle ?? ""))) fail(`blocking row subtitle ${JSON.stringify(row.subtitle)}`);
  await Bun.sleep(400);
  await capture("adblock-palette");
  await typeQuery(app, "hide");
  await poll(async () => (await app.find("palette"))?.rows ?? [], (r) => r.some((x) => x.id === "cmd:hide-element"), { timeoutMs: 5000 }).catch(() =>
    fail("no Hide Element row"),
  );
  await capture("adblock-palette-hide");
  await closePalette(app);

  // ---- site-info popover ---------------------------------------------------
  await openSiteInfo();
  await poll(async () => (await app.find("site-info-popover"))?.visible, (v) => v === true, { timeoutMs: 8000 }).catch(() => fail("no site-info popover"));
  await poll(() => text("site-blocking-count"), (t) => /requests? blocked on this page/.test(t), { timeoutMs: 5000 }).catch(async () =>
    fail(`site-blocking-count reads ${JSON.stringify(await text("site-blocking-count"))}`),
  );
  await Bun.sleep(700);
  await capture("adblock-siteinfo");
  // The switch is the popover's own way to turn the site off.
  // A capture can take the key focus long enough for GTK to put the popover
  // away; it is opened again rather than toggled blind.
  // GTK's compact layout reports the switch inside its popover as invisible
  // to automation while it is on screen (the capture shows it); the View
  // menu's item is the same switch.
  await app.setValue("site-blocking-switch", false).catch(async () => {
    console.log("  the switch is not actionable here; turning blocking off from the menu");
    await openSiteInfo();
    await app.click("menu-blocking");
  });
  await poll(async () => marks.some((l) => l.includes("ND_APP BLOCKING 127.0.0.1 off")), (v) => v, { timeoutMs: 8000 }).catch(() => fail(`the switch did not turn blocking off; ${marks.slice(-6).join(" | ")}`));
  await poll(async () => blocked(), (n) => n === 0, { timeoutMs: PATIENCE }).catch(() => fail(`blocked count ${blocked()} with blocking off`));
  if (!(await app.find("site-info-popover"))?.visible) await openSiteInfo();
  await poll(() => text("site-blocking-count"), (t) => t === "Off for this site", { timeoutMs: 8000 }).catch(async () =>
    fail(`site-blocking-count reads ${JSON.stringify(await text("site-blocking-count"))} with blocking off`),
  );
  await Bun.sleep(700);
  await capture("adblock-siteinfo-off");
  console.log(`NB_ADBLOCK_SHOTS_OK ${tag}`);
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
