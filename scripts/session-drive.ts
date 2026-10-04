#!/usr/bin/env bun
// Tab lifecycle against the real app, on either backend: restored tabs and
// tabs opened behind the page wait to be looked at, Put to Sleep gives a
// page's memory back and the page comes back where it was, and "Start with a
// fresh window" keeps the pins across a relaunch.
//
//   bun scripts/session-drive.ts
//
// macOS: run through scripts/mac-drive.sh (a bundled host, so the engine is
// CEF) under the machine's CEF gate lock. Linux: scripts/linux-session.sh.
//
// Legs:
//   1  a restored session: only the tab on show has a view and was fetched;
//      the others read their stored titles, and one loads when it is shown
//   2  a ⌘/ctrl-clicked link opens behind the page, right after it, and
//      builds no view and fetches nothing until it is shown; a target=_blank
//      click opens in front, right after the page, as in Chrome
//   3  seven live pages, five put to sleep from the Tabs menu: their views go,
//      and the renderer count and resident memory drop
//   4  a sleeping tab shown again reloads its own address and scroll position
//   5  captures: dimmed sleeping rows in both layouts at 1280 and 720, the
//      command bar offering Put Tab to Sleep, and a window's own menu
//   6  "Start with a fresh window" on: a relaunch brings back the pin and a
//      new tab only; off again: a relaunch brings back every tab
//
// Marker: NB_SESSION_OK.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchApp, type JsonNode } from "@nativedesktop/test";

import { NDSHOT, fail, findAcross, listActive, listRows, ndshotWindows, paletteDriver, step, walk } from "./drive-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 30_000);
const SHOTS = process.env.NB_SESSION_SHOTS ?? resolve(ROOT, "screenshots/session");
mkdirSync(SHOTS, { recursive: true });
const darwin = process.platform === "darwin";
const appkit = darwin && process.env.ND_BACKEND !== "gtk";
const store = mkdtempSync(join(tmpdir(), "nb-session-"));
const { goTo, newTab, typeQuery, closePalette } = paletteDriver({ timeoutMs: PATIENCE });

// ---------------------------------------------------------------- fixture ---

const loads: Record<string, number> = {};
const TITLES: Record<string, string> = {
  pin: "Pinned page",
  a: "Page A",
  b: "Page B",
  c: "Page C",
  bg: "Behind page",
  blank: "Blank target",
};
const server = Bun.serve({
  port: Number(process.env.ND_ACCEPT_FIXTURE_PORT ?? 0),
  hostname: "127.0.0.1",
  fetch(req) {
    const key = new URL(req.url).pathname.slice(1);
    if (key === "favicon.ico") return new Response(null, { status: 404 });
    loads[key] = (loads[key] ?? 0) + 1;
    const title = TITLES[key] ?? `Heavy ${key}`;
    // The heavy pages hold 80 MB each, touched so it is resident, which is
    // what makes a page's memory visible in the renderer's RSS.
    const heavy = key.startsWith("m") ? "<script>window.hog = new Uint8Array(80e6).fill(7);</script>" : "";
    const rows = Array.from({ length: 200 }, (_, i) => `<p>${title} row ${i}</p>`).join("");
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>` +
        `<a id="link" href="/bg">behind</a> <a id="blank" href="/blank" target="_blank">blank</a>${heavy}${rows}</body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const base = `http://127.0.0.1:${server.port}`;

writeFileSync(
  join(store, "session.json"),
  JSON.stringify({
    version: 2,
    data: {
      windows: [
        {
          id: "w1",
          tabs: [
            { id: "t1", url: `${base}/pin`, title: "Pinned page", pinned: true },
            { id: "t2", url: `${base}/a`, title: "Page A", pinned: false },
            { id: "t3", url: `${base}/b`, title: "Page B", pinned: false },
            { id: "t4", url: `${base}/c`, title: "Page C", pinned: false },
          ],
          activeId: "t2",
          width: 1280,
          height: 800,
        },
      ],
      nextTabId: 5,
      nextWindowId: 2,
      zoomByHost: {},
    },
  }),
);

const app = await launchApp({
  entry: "src/main.tsx",
  cwd: ROOT,
  hostBinary: process.env.ND_HOST_BINARY,
  env: {
    NB_STORE_DIR: store,
    NB_TEST_HOOKS: "1",
    ND_APP_ID: "dev.nativebrowser.session",
    XDG_DATA_HOME: join(store, "data"),
    ND_CEF_CACHE: process.env.ND_CEF_CACHE || join(store, "cef"),
  },
  readyTimeoutMs: PATIENCE * 2,
  rpcTimeoutMs: PATIENCE,
  logPath: process.env.NB_SESSION_HOST_LOG,
  retries: 0,
});

// ---------------------------------------------------------------- helpers ---

function sh(...argv: string[]): string {
  const r = Bun.spawnSync(argv);
  if (r.exitCode !== 0) fail(`${argv[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

async function waitFor<T>(what: string, read: () => Promise<T> | T, ok: (v: T) => boolean, timeoutMs = PATIENCE): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await Bun.sleep(150);
  }
  return fail(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/// A real ⌘/ctrl-click on the page's #link: Blink drops the modifiers of a
/// click a script dispatches, and Chrome then opens the link in front. The
/// link is stretched over the whole page for the click, so the view's centre
/// lands on it.
async function modifierClickLink(tab: string): Promise<void> {
  await evalIn(tab, `(() => { document.getElementById("link").style.cssText = "position:fixed;inset:0;z-index:9;opacity:0"; return "ok"; })()`);
  const box = (await app.getByTestId(`page-${tab}`).boundingBox()) ?? fail(`page-${tab} has no geometry`);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (darwin) {
    await app.cursor.click(at, { modifiers: ["command"] });
  } else {
    const id = sh("xdotool", "search", "--onlyvisible", "--pid", String(app.pid), "").trim().split("\n").at(-1)!;
    const geo = sh("xdotool", "getwindowgeometry", id);
    const [ox, oy] = (/Position: (-?\d+),(-?\d+)/.exec(geo) ?? []).slice(1).map(Number);
    sh("xdotool", "mousemove", String(ox! + Math.round(at.x)), String(oy! + Math.round(at.y)), "keydown", "ctrl", "click", "1", "keyup", "ctrl");
  }
  await evalIn(tab, `(() => { document.getElementById("link").style.cssText = ""; return "ok"; })()`);
}

/// Tab ids in the sidebar, in order, with what each row reads.
async function rows(): Promise<{ id: string; title: string }[]> {
  return listRows(await app.mustFind("tab-list")).map((r) => ({ id: r.testID.replace(/^.*tab-/, ""), title: r.title }));
}

async function activeTab(): Promise<string> {
  return listActive(await app.mustFind("tab-list"));
}

/// The tabs that have a view: the pool holds one `page-<id>` per live tab.
async function views(): Promise<string[]> {
  const ids: string[] = [];
  const { windows } = await app.windows();
  for (const w of windows) {
    walk((await app.tree(w.ref)).root, (n: JsonNode) => {
      const m = /^page-(t\d+)$/.exec(n.testID ?? "");
      if (m && !ids.includes(m[1]!)) ids.push(m[1]!);
    });
  }
  return ids.sort();
}

async function waitViews(what: string, ok: (ids: string[]) => boolean): Promise<string[]> {
  return waitFor(what, views, ok);
}

/// Every renderer under the host, and the resident memory of the host and all
/// of its descendants, in MB.
function processes(): { renderers: number; rendererMb: number; totalMb: number } {
  const table = sh("ps", "-e", "-o", "pid=,ppid=,rss=,args=")
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: +m[1]!, ppid: +m[2]!, rss: +m[3]!, args: m[4]! }));
  const mine = new Set([app.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of table) {
      if (!mine.has(p.pid) && mine.has(p.ppid)) {
        mine.add(p.pid);
        grew = true;
      }
    }
  }
  const tree = table.filter((p) => mine.has(p.pid));
  const renderers = tree.filter((p) => p.args.includes("--type=renderer"));
  const mb = (kb: number) => Math.round(kb / 1024);
  return {
    renderers: renderers.length,
    rendererMb: mb(renderers.reduce((n, p) => n + p.rss, 0)),
    totalMb: mb(tree.reduce((n, p) => n + p.rss, 0)),
  };
}

/// Waits for the process table to stop moving: a closed browser's renderer
/// exits a moment after the view goes.
async function settledProcesses(): Promise<ReturnType<typeof processes>> {
  let last = processes();
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(1000);
    const now = processes();
    if (now.renderers === last.renderers && Math.abs(now.rendererMb - last.rendererMb) < 8) return now;
    last = now;
  }
  return last;
}

async function evalIn(tab: string, code: string): Promise<string> {
  const r = await app.evalInPage({ testId: `page-${tab}` }, code, { timeoutMs: 5000 });
  if (!r.ok) fail(`page-${tab}: ${code} threw ${r.error}`);
  return String(r.value ?? "");
}

async function capture(name: string, title?: string): Promise<void> {
  const path = `${SHOTS}/${appkit ? "mac" : "gtk"}-${name}.png`;
  if (darwin) {
    // The window's area of the screen, so a menu over it is in the capture.
    const win =
      ndshotWindows(app.pid).find((w) => (title ? w.title.includes(title) : w.title !== "")) ?? fail("ndshot sees no app window");
    sh("timeout", "30", NDSHOT, "capture", "--window-id", String(win.windowID), "--region", "--no-focus", "--out", path);
  } else if (process.env.DISPLAY) {
    await Bun.sleep(400);
    sh("import", "-window", "root", "-silent", path);
  } else return;
  console.log(`  capture ${path}`);
}

function stored(): { tabs: { url: string; pinned: boolean }[] }[] {
  return (JSON.parse(readFileSync(join(store, "session.json"), "utf8")) as { data: { windows: { tabs: { url: string; pinned: boolean }[] }[] } })
    .data.windows;
}

async function setFresh(on: boolean): Promise<void> {
  await step("open settings", async () => {
    // A menu item's click is answered after the app has handled it, and a
    // host still leaving a menu's tracking loop can drop the first one.
    for (let attempt = 0; attempt < 3; attempt++) {
      await app.click("menu-settings").catch((e: unknown) => console.log(`   menu-settings click: ${String(e)}`));
      const found = await waitFor("the fresh-window switch", () => findAcross(app, "settings-fresh-window"), (n) => n !== null, 10_000).catch(() => null);
      if (found) return;
    }
    fail("Settings never opened");
  });
  await waitFor(
    `the fresh-window switch set ${on}`,
    async () => {
      await app.setValue("settings-fresh-window", on).catch(() => {});
      await Bun.sleep(300);
      const saved = JSON.parse(readFileSync(join(store, "settings.json"), "utf8")) as { data?: { freshWindow?: boolean } };
      return saved.data?.freshWindow;
    },
    (v) => v === on,
  );
}

// ------------------------------------------------------------------- legs ---

try {
  // 1. Lazy restore.
  await waitFor("the four restored rows", rows, (r) => r.length === 4);
  await waitViews("the tab on show's view", (v) => v.includes("t2"));
  await waitFor("page A fetched", () => loads["a"] ?? 0, (n) => n === 1);
  await Bun.sleep(2000);
  const restored = await rows();
  // A pinned tile reads its monogram, not its title.
  const want = ["P", "Page A", "Page B", "Page C"];
  if (JSON.stringify(restored.map((r) => r.title)) !== JSON.stringify(want)) {
    fail(`restored rows read ${JSON.stringify(restored)}, want ${JSON.stringify(want)}`);
  }
  if (JSON.stringify(await views()) !== JSON.stringify(["t2"])) fail(`restored views ${JSON.stringify(await views())}, want only t2`);
  for (const key of ["pin", "b", "c"]) if (loads[key]) fail(`the restored tab at /${key} was fetched before it was shown`);
  await step("show restored page B", () => app.click("tab-t3"));
  await waitViews("page B's view", (v) => v.includes("t3"));
  await waitFor("page B fetched once", () => loads["b"] ?? 0, (n) => n === 1);
  if (loads["c"] || loads["pin"]) fail("showing page B fetched another restored tab");
  console.log(`1. restore: 4 rows by stored title, one view (t2); showing t3 built its view and fetched /b once; /c and /pin untouched`);

  // 2. Opened from the page, where Chrome puts each: a modifier-click behind
  // the page, right after it; a target=_blank click in front, right after it.
  const before = (await rows()).map((r) => r.id);
  await modifierClickLink("t3");
  const afterBg = await waitFor("a row for the modifier-clicked link", rows, (r) => r.length === before.length + 1);
  const bgTab = afterBg.find((r) => !before.includes(r.id))!.id;
  await Bun.sleep(1500);
  if ((await activeTab()) !== "t3") fail(`a modifier-click moved the window to ${await activeTab()}`);
  const opener = afterBg.findIndex((r) => r.id === "t3");
  if (afterBg[opener + 1]?.id !== bgTab) fail(`the modifier-clicked tab sits at ${afterBg.findIndex((r) => r.id === bgTab)}, want right after t3 (${opener + 1})`);
  if ((await views()).includes(bgTab)) fail(`a tab opened behind the page built a view`);
  if (loads["bg"]) fail(`a tab opened behind the page was fetched (${JSON.stringify(loads)})`);
  if (!afterBg[opener + 1]!.title.endsWith("/bg")) fail(`the waiting row reads ${JSON.stringify(afterBg[opener + 1]!.title)}, want its address`);
  await evalIn("t3", `(() => { document.getElementById("blank").click(); return "ok"; })()`);
  const afterBlank = await waitFor("a row for the target=_blank link", rows, (r) => r.length === before.length + 2);
  const blankTab = afterBlank.find((r) => !before.includes(r.id) && r.id !== bgTab)!.id;
  await waitFor("the target=_blank tab on show", activeTab, (a) => a === blankTab);
  const order = afterBlank.map((r) => r.id);
  const at = order.indexOf("t3");
  if (order[at + 1] !== blankTab || order[at + 2] !== bgTab) fail(`after t3: ${JSON.stringify(order.slice(at + 1, at + 3))}, want [${blankTab}, ${bgTab}]`);
  await waitFor("/blank fetched once it is shown", () => loads["blank"] ?? 0, (n) => n === 1);
  await step("show the modifier-clicked tab", () => app.click(`tab-${bgTab}`));
  await waitFor("/bg fetched once it is shown", () => loads["bg"] ?? 0, (n) => n === 1);
  await waitFor("its row takes the page's title", rows, (r) => r.find((x) => x.id === bgTab)?.title === "Behind page");
  console.log(`2. from the page: ${bgTab} (${darwin ? "cmd" : "ctrl"}-click) behind t3 with no view or fetch until shown; ${blankTab} (target=_blank) in front, right after t3`);

  // 3. Put to Sleep, and the memory it gives back.
  for (const m of ["m1", "m2", "m3", "m4", "m5"]) {
    await newTab(app, `${base}/${m}`);
    await waitFor(`/${m} fetched`, () => loads[m] ?? 0, (n) => n === 1);
  }
  const heavy = (await rows()).slice(-5).map((r) => r.id);
  // Scrolled, so leg 4 can check the page comes back where it was.
  await waitFor("the last page to have its hog", () => evalIn(heavy[4]!, "String(!!window.hog)"), (v) => v === "true");
  await evalIn(heavy[2]!, "window.scrollTo(0, 900), String(scrollY)");
  const awake = await views();
  const beforeSleep = await settledProcesses();
  console.log(`   before: ${awake.length} views ${JSON.stringify(awake)}, ${JSON.stringify(beforeSleep)}`);
  const tabsMenu = (await app.rpc.call("menuModel", { testId: "menubar" })).items.filter((i) => /sleep/i.test(i));
  if (tabsMenu.length !== 1) fail(`the menu bar carries ${JSON.stringify(tabsMenu)}, want one Put Tab to Sleep`);
  const slept: string[] = [];
  for (let i = 0; i < 5; i++) {
    const on = await activeTab();
    await step(`put ${on} to sleep`, () => app.click("menu-sleep-tab"));
    await waitViews(`${on}'s view to go`, (v) => !v.includes(on));
    slept.push(on);
  }
  const afterSleep = await settledProcesses();
  const left = await views();
  console.log(`   after: ${left.length} views ${JSON.stringify(left)}, ${JSON.stringify(afterSleep)}`);
  if (slept.some((id) => left.includes(id))) fail(`a slept tab kept its view: slept ${JSON.stringify(slept)}, views ${JSON.stringify(left)}`);
  if ((await rows()).length !== before.length + 7) fail("putting tabs to sleep changed the number of rows");
  const fewer = beforeSleep.renderers - afterSleep.renderers;
  const freed = beforeSleep.rendererMb - afterSleep.rendererMb;
  if (fewer < 5) fail(`sleeping 5 tabs ended ${fewer} renderers (${beforeSleep.renderers} -> ${afterSleep.renderers})`);
  if (freed < 5 * 60) fail(`sleeping 5 tabs gave back ${freed} MB of renderer memory`);
  console.log(
    `3. slept ${JSON.stringify(slept)} from the Tabs menu: renderers ${beforeSleep.renderers} -> ${afterSleep.renderers}, ` +
      `renderer RSS ${beforeSleep.rendererMb} -> ${afterSleep.rendererMb} MB, all processes ${beforeSleep.totalMb} -> ${afterSleep.totalMb} MB`,
  );

  // 4. A sleeping tab shown again.
  const back = heavy[2]!;
  if (!slept.includes(back)) fail(`${back} was meant to be asleep`);
  const loadsBefore = loads["m3"] ?? 0;
  await step(`show sleeping ${back}`, () => app.click(`tab-${back}`));
  await waitViews(`${back}'s view`, (v) => v.includes(back));
  await waitFor("/m3 fetched again", () => loads["m3"] ?? 0, (n) => n === loadsBefore + 1);
  const info = await waitFor("the woken page's address", () => app.webviewInfo({ testId: `page-${back}` }), (i) => !i.loading && (i.url ?? "").endsWith("/m3"));
  const scrolled = await waitFor("the woken page's scroll", () => evalIn(back, "String(scrollY)"), (y) => Number(y) === 900, 10_000);
  console.log(`4. ${back} woke on its own address (${info.url}), fetched once more, scrolled back to ${scrolled}`);

  // 5. Captures.
  for (const width of [1280, 720]) {
    await app.setWindowSize(width, 800);
    await Bun.sleep(800);
    await capture(`sleeping-sidebar-${width}`);
  }
  await step("compact layout", () => app.click("menu-layout"));
  for (const width of [1280, 720]) {
    await app.setWindowSize(width, 800);
    await Bun.sleep(800);
    await capture(`sleeping-compact-${width}`);
  }
  await step("sidebar layout", () => app.click("menu-layout"));
  await app.setWindowSize(1280, 800);
  await step("open the command bar", () => app.click("menu-palette"));
  await app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: PATIENCE });
  await typeQuery(app, "sleep");
  const offered = await waitFor(
    "Put Tab to Sleep in the command bar",
    async () => ((await app.find("palette"))?.rows ?? []).map((r) => String(r.id)),
    (ids) => ids.includes("cmd:sleep-tab"),
  );
  await capture("sleep-command-bar");
  await closePalette(app);
  console.log(`5. captured sleeping rows in both layouts at 1280 and 720; the command bar offers ${JSON.stringify(offered)}`);

  // A window's own menu, over a second window holding two tabs: the page it
  // was given opens a link, which lands in its own window.
  const moved = await activeTab();
  await step("move the tab on show to a new window", () => app.click("menu-move-new-window"));
  await app.waitForWindows(2, PATIENCE);
  const w2 = await waitFor("the second window", () => findAcross(app, "w2-tab-list"), (f) => f !== null);
  await step("open a link from the moved page", async () => {
    const r = await app.evalInPage({ testId: `page-${moved}` }, `(() => { document.getElementById("blank").click(); return "ok"; })()`, {
      window: w2!.window,
      timeoutMs: 5000,
    });
    if (!r.ok) fail(`the click threw ${r.error}`);
  });
  await waitFor(
    "two tabs in the second window",
    async () => {
      const found = await findAcross(app, "w2-tab-list");
      return found ? listRows(found.node).length : 0;
    },
    (n) => n === 2,
  );
  let menuClick: Promise<unknown> = Promise.resolve();
  // Read before the menu opens: AppKit serves no tree while it tracks.
  // The link's tab opened in front, so it names the window once it loads.
  await Bun.sleep(1500);
  const w2List = (await findAcross(app, "w2-tab-list"))!.node;
  const shownId = listActive(w2List);
  const titled = listRows(w2List).find((r) => r.testID.endsWith(`tab-${shownId}`))?.title;
  await step("open the second window's menu", async () => {
    const button = await waitFor("the second window's menu button", () => findAcross(app, "w2-window-menu"), (f) => f !== null);
    // AppKit answers the click only once the menu's tracking loop ends.
    menuClick = app.click({ ref: button!.node.ref }).catch(() => null);
    if (!appkit) await menuClick;
  });
  await Bun.sleep(1200);
  await capture("window-menu", titled);
  await step("close the second window's menu", async () => {
    if (!appkit) {
      await app.keys("escape", { window: w2!.window }).catch(() => {});
      return;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      await app.keys("escape", { window: w2!.window }).catch(() => {});
      const done = await Promise.race([menuClick.then(() => true), Bun.sleep(2000).then(() => false)]);
      if (done) return;
    }
    fail("the menu is still tracking after four escapes");
  });
  await Bun.sleep(600);

  // 6. Start with a fresh window.
  await setFresh(true);
  await app.restart();
  await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
  const fresh = await waitFor("the fresh window's rows", rows, (r) => r.length === 2);
  if (fresh[0]!.title !== "P" || fresh[1]!.title !== "New Tab") fail(`a fresh window reads ${JSON.stringify(fresh)}`);
  if ((await activeTab()) !== fresh[1]!.id) fail(`a fresh window shows ${await activeTab()}, not its new tab`);
  if ((await app.windows()).windows.filter((w) => w.title !== "").length !== 1) fail("a fresh start brought back a second window");
  if ((await views()).length !== 0) fail(`a fresh window built views: ${JSON.stringify(await views())}`);
  console.log(`6a. fresh window on: relaunch shows ${JSON.stringify(fresh.map((r) => r.title))}, the new tab in front, one window`);
  await newTab(app, `${base}/c`);
  // ⌘T from an untouched new tab loads in it rather than beside it.
  const kept = await waitFor("/c in the fresh window", rows, (r) => r.some((x) => x.title === "Page C"));
  await setFresh(false);
  await app.restart();
  await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
  const again = await waitFor("every tab back", rows, (r) => r.length === kept.length);
  if (!again.some((r) => r.title === "Page C")) fail(`fresh window off brought back ${JSON.stringify(again)}`);
  console.log(`6b. fresh window off: relaunch brings back ${JSON.stringify(again.map((r) => r.title))}; stored ${JSON.stringify(stored().map((w) => w.tabs.length))}`);

  console.log("NB_SESSION_OK");
} catch (e) {
  console.error(`drive failed: ${(e as Error).message}`);
  console.error(app.stderrTail(60));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
