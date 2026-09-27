#!/usr/bin/env bun
// Stage-1 acceptance drive. Self-contained: a Bun.serve fixture supplies every
// page, so nothing here touches the network. Fixture pages count their own
// loads server-side, which is how "switching tabs did not reload the page" is
// proved rather than assumed.
//
// Run headless: scripts/headless.sh bun scripts/browser-drive.ts
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { launchApp, type AppHandle, type JsonNode } from "@nativedesktop/test";
import { LAYOUT_SEGMENT_WIDTH } from "../src/lib/metrics.ts";
import {
  SHOTS,
  fail,
  paletteDriver,
  shoot,
  step,
  textsUnder,
  walk,
  listActive,
  listRows,
  listSections,
  waitRows as rowsMatching,
  waitText as textMatching,
} from "./drive-lib.ts";

// NB_DRIVE_ROOT moves every scratch path below so a run with its own display
// and lock file does not share them with another run on the same machine.
const SCRATCH = process.env.NB_DRIVE_ROOT ?? "/tmp";
const PROFILE = `${SCRATCH}/nb-drive-profile`;
const DOWNLOADS = `${SCRATCH}/nb-drive-downloads`;
// The webview jar lives under the user data dir, so the cookie round trip needs
// one of its own — otherwise it reads a jar the dev box already had and a
// browser that persists nothing still passes.
const DATA_HOME = `${SCRATCH}/nb-drive-data`;
// Fresh per run for the same reason: a value left behind by the previous run
// would survive a restart no matter what the engine did with this one.
const COOKIE_VALUE = `v${Date.now()}`;
// One knob for every wait: the same drive runs on an idle laptop and inside a
// full framework gate sweep, where everything is several times slower.
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);

rmSync(PROFILE, { recursive: true, force: true });
rmSync(DOWNLOADS, { recursive: true, force: true });
rmSync(DATA_HOME, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- fixture ---

const loads: Record<string, number> = {};
let cookieSets = 0;

function page(key: string, title: string, body: string): Response {
  loads[key] = (loads[key] ?? 0) + 1;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title} load ${loads[key]}</title></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    switch (path) {
      case "/a":
        return page("a", "Page A", "<h1>Page A</h1>");
      case "/b":
        return page("b", "Page B", "<h1>Page B</h1>");
      case "/c":
        return page("c", "Page C", "<h1>Page C</h1>");
      case "/long": {
        const rows = Array.from({ length: 400 }, (_, i) => `<p id="p${i}">row ${i}</p>`).join("");
        return page("long", "Long page", `<h1>Long page</h1>${rows}`);
      }
      // Three permissions, because Chromium records its own content setting
      // from every explicit answer: a type that has been allowed or blocked
      // once never reaches the app again, so each leg needs one of its own.
      case "/permission":
        return page(
          "permission",
          "Permission",
          '<script>Notification.requestPermission().then((p) => { document.title = "notif:" + p; });</script>',
        );
      case "/permission-geo":
        return page(
          "permissionGeo",
          "Permission geo",
          '<script>navigator.geolocation.getCurrentPosition(() => { document.title = "geo:ok"; },' +
            ' (e) => { document.title = "geo:e" + e.code; });</script>',
        );
      case "/permission-midi":
        return page(
          "permissionMidi",
          "Permission midi",
          '<script>navigator.requestMIDIAccess({ sysex: true }).then(() => { document.title = "midi:ok"; },' +
            ' () => { document.title = "midi:no"; });</script>',
        );
      // A page with state a reload would lose: a counter that ticks, a field
      // holding a value, both reported in the title so the tab row can be
      // read for them. The load counter is the server's own.
      case "/counter":
        return page(
          "counter",
          "Counter",
          '<input id="field"><script>let n = 0; const f = document.getElementById("field");' +
            ' const show = () => { document.title = `Counter c=${n} f=${f.value}`; };' +
            " setInterval(() => { n++; show(); }, 500); f.addEventListener(\"input\", show);" +
            ' window.nbTest = () => { f.value = "typed-by-drive"; f.dispatchEvent(new Event("input")); };</script>',
        );
      case "/action":
        return page("action", "Action page", "<h1>Action page</h1>");
      case "/search":
        return page("search", "Search results", "<h1>Search results</h1>");
      // Sets the cookie on its first load only. The tab is restored at this
      // address, and a restored tab that loads it again after the restart
      // would set the cookie afresh and hide a jar that persisted nothing.
      case "/setcookie":
        cookieSets++;
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Cookie set</title><h1>Cookie set</h1>',
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              ...(cookieSets === 1 ? { "set-cookie": `nbdrive=${COOKIE_VALUE}; Path=/; Max-Age=3600` } : {}),
            },
          },
        );
      case "/whoami": {
        const sent = /(?:^|;\s*)nbdrive=([^;]+)/.exec(req.headers.get("cookie") ?? "");
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Who am I</title><h1>cookie=${sent ? sent[1] : "none"}</h1>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      case "/popup":
        // The link is clicked from the app side (see NB_TEST_JS below): the
        // engine blocks a gesture-less target=_blank click made by the page
        // itself.
        return page("popup", "Popup page", '<a id="open" href="/c" target="_blank">open c</a>');
      case "/image.png":
        // 1x1 PNG, so "Save Image" has something real to fetch.
        return new Response(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            "base64",
          ),
          { headers: { "content-type": "image/png" } },
        );
      case "/file.txt":
        return new Response("nativebrowser download fixture\n", {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="fixture.txt"',
          },
        });
      default:
        return new Response("not found", { status: 404 });
    }
  },
});
const base = `http://127.0.0.1:${server.port}`;

// ---------------------------------------------------------------- helpers ---

/// Tab rows only: the sidebar's "Pinned"/"Tabs" headings are rows as well, and
/// they are the ones without a testID.
async function tabRows(app: AppHandle): Promise<{ title: string; testID: string | null }[]> {
  return listRows(await app.mustFind("tab-list"));
}

/// The section headings the sidebar is currently drawing, in order.
async function tabSections(app: AppHandle): Promise<string[]> {
  return listSections(await app.mustFind("tab-list"));
}

/// The fixture's load counters once they have stopped moving. The omnibox
/// shows the address the app set, not the page the engine fetched, so a
/// navigation is still in flight when the address already reads as arrived;
/// comparing counters across a layout switch needs them settled first.
async function settledLoads(): Promise<string> {
  let last = "";
  for (let stable = 0; stable < 8; ) {
    const now = JSON.stringify(loads);
    stable = now === last ? stable + 1 : 0;
    last = now;
    await Bun.sleep(200);
  }
  return last;
}

/// Where the page area starts, in logical units from the window's left edge.
/// This is what "there is no tab column" means on either backend: GTK takes
/// the sidebar pane out and AppKit collapses its split item, and neither
/// shows up as the sidebar node disappearing from the tree.
async function contentInset(app: AppHandle): Promise<number> {
  return (await app.mustFind("content")).geometry?.x ?? -1;
}

async function waitContentInset(app: AppHandle, check: (x: number) => boolean): Promise<void> {
  const deadline = Date.now() + PATIENCE;
  let seen = -1;
  while (Date.now() < deadline) {
    seen = await contentInset(app);
    if (check(seen)) return;
    await Bun.sleep(150);
  }
  fail(`the page area still starts at x=${seen}`);
}

/// A row action the app only offers under some condition, retried until the
/// row actually declares it. The alternative is sleeping and hoping.
async function clickRowAction(app: AppHandle, testId: string, action: string): Promise<void> {
  // The sidebar layout's rows carry no pin action; the Tabs menu pins the
  // selected tab, which is the row the callers here have just selected.
  const row = /(^|-)tab-(t\d+)$/.exec(testId);
  if (row && (action === "pin" || action === "unpin")) {
    const deadline = Date.now() + PATIENCE;
    while (listActive(await app.mustFind("tab-list")) !== row[2]) {
      if (Date.now() > deadline) fail(`${testId} never became the selected tab to ${action}`);
      await Bun.sleep(150);
    }
    await app.click("menu-pin-tab");
    return;
  }
  const deadline = Date.now() + PATIENCE;
  for (;;) {
    try {
      await app.click({ testId, action });
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await Bun.sleep(200);
    }
  }
}

/// A click retried until the widget will take it. A popover's content is in
/// the tree before the popover is up, and neither backend calls it actionable
/// until it is, so "present" is not enough to act on.
async function clickWhenReady(app: AppHandle, testId: string): Promise<void> {
  const deadline = Date.now() + PATIENCE;
  for (;;) {
    try {
      await app.click(testId);
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await Bun.sleep(200);
    }
  }
}

/// A setValue retried until the widget will take it (see clickWhenReady).
async function setValueWhenReady(testId: string, value: string | boolean): Promise<void> {
  const deadline = Date.now() + PATIENCE;
  for (;;) {
    try {
      await app.setValue(testId, value);
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await Bun.sleep(200);
    }
  }
}

/// Tab row testIDs, polled until they satisfy `check`. A row's title is
/// whatever its page last called itself, and a page that redirects keeps
/// changing it; the testID is the tab.
async function waitTabIds(
  app: AppHandle,
  check: (ids: string[]) => boolean,
  what: string,
): Promise<string[]> {
  const deadline = Date.now() + PATIENCE;
  let ids: string[] = [];
  while (Date.now() < deadline) {
    ids = (await tabRows(app)).map((r) => r.testID!);
    if (check(ids)) return ids;
    await Bun.sleep(150);
  }
  return fail(`timed out waiting for ${what}; tab rows were ${JSON.stringify(ids)}`);
}

async function waitRows(app: AppHandle, check: (rows: string[]) => boolean, what: string): Promise<string[]> {
  return rowsMatching(app, "tab-list", check, what, PATIENCE);
}

const { openPalette, typeQuery, goTo } = paletteDriver({ timeoutMs: PATIENCE });

/// The index of the first palette row whose id matches. Palette rows carry
/// their app-side id on the wire, so a drive names the row it wants instead of
/// counting to it.
async function paletteRow(app: AppHandle, match: (id: string) => boolean, what: string): Promise<number> {
  const deadline = Date.now() + PATIENCE;
  let ids: string[] = [];
  let previous = "";
  while (Date.now() < deadline) {
    ids = ((await app.mustFind("palette")).rows ?? []).map((r) => r.id ?? "");
    const signature = ids.join(",");
    const at = ids.findIndex((id) => match(id));
    // The list has to have stopped moving before an index means anything:
    // history results arrive asynchronously, and acting on a half-ranked list
    // activates whatever has since slid into that row.
    if (at >= 0 && signature === previous) return at;
    previous = signature;
    await Bun.sleep(200);
  }
  return fail(`the palette never settled on ${what}; its rows were ${JSON.stringify(ids)}`);
}

/// The current page URL, as shown by the header's address display.
/// The address the window shows: the field's text, or, in the sidebar layout
/// (no field), the accessible name of the row on show, which carries the
/// whole address.
async function shownUrl(app: AppHandle): Promise<string> {
  const field = await app.find("omnibox");
  if (field) return String(field.text ?? "");
  const active = listActive(await app.mustFind("tab-list"));
  const row = await app.mustFind(`tab-${active}`);
  return row.label === "New Tab" ? "" : String(row.label ?? "");
}

async function waitUrl(app: AppHandle, suffix: string, timeoutMs = PATIENCE): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = await shownUrl(app);
    if (seen.endsWith(suffix)) return seen;
    await Bun.sleep(120);
  }
  return fail(`address display is ${JSON.stringify(seen)}, want it to end with ${JSON.stringify(suffix)}`);
}

async function waitText(app: AppHandle, testId: string, check: (t: string) => boolean, what: string): Promise<string> {
  return textMatching(app, testId, check, what, PATIENCE);
}

// "page-stack" is the overlay holding the webviews, not one of them.
function isPage(testID: string | null | undefined): testID is string {
  return !!testID && testID.startsWith("page-") && testID !== "page-stack";
}

/// The visible tab's webview, by ref. Every tab keeps a live view and only the
/// active one is shown, so "the page the drive is looking at" is a tree lookup
/// rather than a name the drive can compose.
async function shownPageRef(app: AppHandle): Promise<number> {
  return (await shownPage(app)).ref;
}

async function shownPage(app: AppHandle): Promise<JsonNode> {
  const tree = await app.tree();
  let found: JsonNode | null = null;
  walk(tree.root, (n) => {
    if (found === null && isPage(n.testID) && n.visible) found = n;
  });
  return found ?? fail("no visible webview in the tree");
}

/// The rectangle the page occupies, as the string a comparison can print.
async function shownPageBox(app: AppHandle): Promise<string> {
  return JSON.stringify((await shownPage(app)).geometry ?? null);
}

/// The same rectangle, once it has a size and has stopped changing. A view
/// that has just been shown reports 0x0 for a frame or two, and a baseline
/// read there would compare a placeholder against a real allocation.
async function settledPageBox(app: AppHandle): Promise<string> {
  const deadline = Date.now() + PATIENCE;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    const now = await shownPageBox(app);
    const sized = !now.includes('"w":0') && !now.includes('"h":0');
    stable = sized && now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 3) return now;
    await Bun.sleep(150);
  }
  return fail(`the page never settled on a size, last ${last}`);
}

/// Whatever the window's focus is on, as a printable name. Used to wait for
/// the engine to stop taking the focus for itself: a Chrome-style webview
/// grabs the GTK focus as its page commits, hidden ones included, so an app
/// that asks for the address field while a page is still settling loses the
/// caret to the page a frame later.
async function focusName(app: AppHandle): Promise<string> {
  const tree = await app.tree();
  const hits: string[] = [];
  walk(tree.root, (n) => {
    if (n.focused) hits.push(`${n.type}/${n.testID ?? "-"}`);
  });
  return hits.join(",") || "none";
}

async function focusSettled(app: AppHandle): Promise<string> {
  const deadline = Date.now() + PATIENCE;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    const now = await focusName(app);
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 6) return last;
    await Bun.sleep(200);
  }
  return last;
}

/// How much the pixels in one rectangle of the REAL X screen vary, 0 for a
/// flat fill. The `screenshot` RPC renders the GTK widget tree offscreen, and
/// a Chrome-style webview is an X11 child window that ladder never draws, so
/// the app's own capture cannot tell a painted page from an empty one. This
/// can. Returns null where there is no X screen to read (macOS), which is the
/// leg saying it did not run rather than that it passed.
async function pageInk(app: AppHandle, box: { x: number; y: number; w: number; h: number }, name: string): Promise<number | null> {
  if (!process.env.DISPLAY) return null;
  const title = (await app.windows()).windows[0]!.title ?? "";
  const info = Bun.spawnSync(["xwininfo", "-name", title]);
  if (info.exitCode !== 0) return null;
  const at = (key: string): number => Number(/(-?\d+)/.exec(info.stdout.toString().split(key)[1] ?? "")?.[1] ?? NaN);
  const winX = at("Absolute upper-left X:");
  const winY = at("Absolute upper-left Y:");
  if (!Number.isFinite(winX) || !Number.isFinite(winY)) return null;
  const shot = `${SHOTS}/${name}.png`;
  if (Bun.spawnSync(["import", "-window", "root", "-silent", shot]).exitCode !== 0) return null;
  const stats = Bun.spawnSync([
    "convert",
    shot,
    "-crop",
    `${box.w}x${box.h}+${winX + box.x}+${winY + box.y}`,
    "+repage",
    "-format",
    "%[fx:standard_deviation]",
    "info:",
  ]);
  if (stats.exitCode !== 0) return null;
  const sd = Number(stats.stdout.toString().trim());
  return Number.isFinite(sd) ? sd : null;
}

/// The whole screen, popovers included: they are surfaces of their own, which
/// a capture of the window leaves out. X11 only.
function rootShot(name: string): void {
  if (!process.env.DISPLAY) return;
  Bun.spawnSync(["import", "-window", "root", "-silent", `${SHOTS}/${name}.png`]);
}

// ------------------------------------------------------------------ drive ---

function launch(storeDir: string): Promise<AppHandle> {
  return launchApp({
    entry: "src/main.tsx",
    logPath: process.env.NB_HOST_LOG,
    env: {
      NB_STORE_DIR: storeDir,
      NB_DOWNLOAD_DIR: DOWNLOADS,
      XDG_DATA_HOME: DATA_HOME,
      NB_TEST_HOOKS: "1",
      // The unpacked extension the drive installs through the app's own
      // install API: launchApp passes no argv, so --load-extension is out.
      NB_TEST_EXT: resolve(import.meta.dir, "../fixtures/nd-test-ext"),
      // Declares a popup, switches it off at runtime and sets a badge.
      NB_TEST_EXT_ACTION: resolve(import.meta.dir, "../fixtures/nd-action-ext"),
      // The counter page defines nbTest to fill its field; every other page
      // the drive runs this on has the link.
      NB_TEST_JS: "window.nbTest ? window.nbTest() : document.getElementById('open').click()",
      // What the Debug menu's "Context: save image" hook downloads.
      NB_TEST_IMAGE: `${base}/image.png`,
      // Searches land on the fixture: a live engine can answer the search tab
      // with a captcha and stall the leg on network state.
      NB_TEST_SEARCH_PREFIX: `${base}/search?q=`,
      // A D-Bus name, so no hyphens: GTK accepts an invalid application id and
      // then degrades silently.
      ND_APP_ID: process.env.ND_APP_ID ?? "dev.nativebrowser.browser",
    },
    readyTimeoutMs: PATIENCE,
    // waitFor blocks host-side for its full condition timeout, so the client's
    // per-RPC timeout has to be the larger of the two.
    rpcTimeoutMs: PATIENCE,
    // The context-menu tree is only observable as what the app SENDS the
    // engine: no automation can open a real menu.
    onStderr: (line) => {
      if (line.includes("ND_APP CTXMENU")) menuTraces.push(line.trim());
      // Kept rather than read back from the tail: the engine writes hundreds
      // of lines a second, and the tail has moved on by the time a leg looks.
      if (line.includes("ND_APP PERMISSION")) permissionTraces.push(line.trim());
      if (line.includes("ND_APP ACTION ")) actionTraces.push(line.trim());
      if (line.includes("ND_APP MOVE ")) moveTraces.push(line.trim());
    },
  });
}

const menuTraces: string[] = [];
const permissionTraces: string[] = [];
const actionTraces: string[] = [];
const moveTraces: string[] = [];

interface MenuTraceItem {
  id?: string;
  label?: string;
  contexts?: string[];
  children?: MenuTraceItem[];
}

function lastMenuTree(): MenuTraceItem[] | null {
  for (let i = menuTraces.length - 1; i >= 0; i--) {
    const at = menuTraces[i]!.indexOf("ND_APP CTXMENU tab=");
    if (at < 0) continue;
    const json = menuTraces[i]!.slice(menuTraces[i]!.indexOf(" ", at + 19) + 1);
    return JSON.parse(json) as MenuTraceItem[];
  }
  return null;
}

const app = await launch(PROFILE);

try {
  // Acceptance 1 — launch: window, sidebar, omnibox, one restored New tab.
  const { windows } = await app.windows();
  if (windows.length !== 1) fail(`expected 1 window, got ${windows.length}`);
  await app.mustFind("sidebar");
  await app.mustFind("new-tab-page");
  const first = await tabRows(app);
  if (first.length !== 1 || first[0]!.title !== "New Tab") {
    fail(`session should start with one New Tab row, got ${JSON.stringify(first)}`);
  }
  console.log("1. launch: window + sidebar, session has one New Tab");

  // Which engine actually drew a page. The app reads it off its own first view
  // rather than off the config, because `ND_WEBVIEW_ENGINE=chromium` against a
  // host that cannot start CEF falls back to the system engine and says so
  // only on stderr. Everything chrome:// below branches on this, so a probe
  // that never answered has to be a failure rather than a quiet skip.
  const engineReported = await step("the app reports which engine drew its first page", async () => {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      const seen = /ND_APP ENGINE (\w+)/.exec(app.stderrTail(4000));
      if (seen) return seen[1]!;
      await Bun.sleep(250);
    }
    return fail("the app never reported an engine; the probe view answered nothing");
  });
  const wanted = process.env.ND_WEBVIEW_ENGINE === "chromium" ? "chromium" : "system";
  if (engineReported !== wanted) {
    fail(`the app is running on the ${engineReported} engine, the run asked for ${wanted}`);
  }
  const onChromium = engineReported === "chromium";
  console.log(`1b. the app is on the ${engineReported} engine`);
  await shoot(app, "01-new-tab");

  // Acceptance 2 — omnibox navigation: title lands in the sidebar row and the window title.
  await goTo(app, `${base}/a`);
  await waitRows(app, (r) => r[0] === "Page A load 1", "page A title in the sidebar");
  await waitUrl(app, "/a");
  const titled = await app.windows();
  if (!(titled.windows[0]!.title ?? "").startsWith("Page A")) {
    fail(`window title is ${JSON.stringify(titled.windows[0]!.title)}, want the page title`);
  }
  console.log(`2. omnibox navigate: sidebar row + window title track page A (server loads a=${loads.a})`);
  await shoot(app, "02-page-a");

  // Acceptance 3 — second tab, then switch back and forth. The server load counters are the
  //    proof that neither page was torn down and reloaded.
  await app.click("menu-new-tab");
  await waitRows(app, (r) => r.length === 2, "a second tab row");
  await goTo(app, `${base}/b`);
  await waitRows(app, (r) => r[1] === "Page B load 1", "page B title in the sidebar");

  await app.click("menu-tab-0");
  await waitUrl(app, "/a");
  await app.click("menu-tab-1");
  await waitUrl(app, "/b");
  await app.click("menu-tab-0");
  await waitUrl(app, "/a");

  const kept = await waitRows(app, (r) => r.length === 2, "both tab rows");
  if (kept[0] !== "Page A load 1" || kept[1] !== "Page B load 1") {
    fail(`tab switching reloaded a page: rows are ${JSON.stringify(kept)}`);
  }
  if (loads.a !== 1 || loads.b !== 1) fail(`tab switching refetched: ${JSON.stringify(loads)}`);
  const baseline = { a: loads.a, b: loads.b };

  const tree = await app.tree();
  const pages: Record<string, boolean> = {};
  walk(tree.root, (n) => {
    if (isPage(n.testID)) pages[n.testID] = n.visible;
  });
  const visible = Object.entries(pages).filter(([, v]) => v);
  if (visible.length !== 1) fail(`exactly one live webview should be visible, got ${JSON.stringify(pages)}`);
  console.log(`3. tab switch preserves both live pages (loads ${JSON.stringify(loads)}, visible ${JSON.stringify(pages)})`);
  await shoot(app, "03-two-tabs");


  // The command palette has its own shortcut (Ctrl+K) and ranks address, open
  // tabs, history, then app commands. Ctrl+L is the address field's, and is
  // asserted on its own below.
  await step("open the command palette (Ctrl+K path)", () => app.click("menu-palette"));
  await step("palette presents", () => app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: PATIENCE }));
  await shoot(app, "04-palette");
  await typeQuery(app, `${base}/a`);
  const sameRow = await paletteRow(app, (id) => id === "url", "the address row for the page already open");
  await step("activate the address row", () => app.setValue("palette", sameRow));
  const reloadedA = Date.now() + 10_000;
  while (Date.now() < reloadedA && loads.a === baseline.a) await Bun.sleep(120);
  if (loads.a !== baseline.a + 1) fail(`entering the address already open should have reloaded page A, loads ${JSON.stringify(loads)}`);
  await waitUrl(app, "/a");

  // Ctrl+L belongs to the address field: it asks for the caret and it does not
  // open the command palette.
  //
  // Where the caret ENDS UP is not the app's to assert on this engine. With a
  // Chrome-style webview in the window, a grab-focus on any GTK widget is
  // answered ok and then undone: the focus lands in a browser instead (the
  // hidden chrome://extensions view, or the active page). Measured on g815,
  // Xvfb, CEF 151.3.23: `focus` on the omnibox returns {"ok":true} and the
  // tree then reports WebView/page-t1 focused. The find field is taken the
  // same way. So this leg covers the app's half (it asked, and it asked for
  // the right widget) and says so rather than passing on a caret that is not
  // there.
  await settledLoads();
  const holder = await focusSettled(app);
  await step("Ctrl+L asks for the address field", () => app.click("menu-address"));
  // The sidebar layout has no address field: Cmd+L opens the command bar
  // holding the page's address.
  if (!(await app.find("omnibox"))) {
    await step("Ctrl+L opens the command bar on the address", async () => {
      const deadline = Date.now() + PATIENCE;
      while (Date.now() < deadline) {
        if (app.stderrTail(400).includes("ND_APP FOCUS target=palette")) return;
        await Bun.sleep(150);
      }
      return fail("Ctrl+L never opened the command bar");
    });
    await app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: PATIENCE });
    await step("a second Ctrl+L puts it away", () => app.click("menu-address"));
    const shut = Date.now() + PATIENCE;
    while ((await app.find("palette"))?.visible && Date.now() < shut) await Bun.sleep(150);
    if ((await app.find("palette"))?.visible) fail("a second Ctrl+L left the command bar up");
    console.log("4a. Ctrl+L opened the command bar on the page's address and put it away again");
  } else {
    await step("the app asked for the caret", async () => {
      const deadline = Date.now() + PATIENCE;
      while (Date.now() < deadline) {
        if (app.stderrTail(400).includes("ND_APP FOCUS target=omnibox")) return;
        await Bun.sleep(150);
      }
      return fail("the app never issued a focus command for the address field");
    });
    const ctrlLField = await app.mustFind("omnibox");
    if (String(ctrlLField.text ?? "") !== (await shownUrl(app))) {
      fail(`the address field holds ${JSON.stringify(ctrlLField.text)}, want the page's own address`);
    }
    if (await app.find("palette").then((n) => n?.visible)) fail("Ctrl+L opened the command palette instead of focusing the field");
    const caretLanded = (await app.mustFind("omnibox")).focused;
    console.log(
      caretLanded
        ? `4a. Ctrl+L put the caret in the address field (focus had been on ${holder})`
        : `4a. Ctrl+L asked for the address field; the engine kept the focus on ${await focusName(app)} (engine gap, see the comment)`,
    );
  }

  await openPalette(app);
  await typeQuery(app, "Page B");
  const tabRow = await paletteRow(app, (id) => id.startsWith("tab:"), 'an open-tab row for "Page B"');
  await step("switch to the matching tab", () => app.setValue("palette", tabRow));
  await waitUrl(app, "/b");

  await openPalette(app);
  await typeQuery(app, "Reload");
  const reloadRow = await paletteRow(app, (id) => id === "cmd:reload", "the Reload command row");
  await step("run the Reload command", () => app.setValue("palette", reloadRow));
  const reloadedB = Date.now() + 15_000;
  while (Date.now() < reloadedB && loads.b === baseline.b) await Bun.sleep(120);
  if (loads.b !== baseline.b + 1) fail(`the palette Reload command did not reload page B, loads ${JSON.stringify(loads)}`);
  console.log("4. palette: address row, tab switch and app command all ran");

  // Owner report: a new tab's launcher has to come up EMPTY. `query` is a
  // controlled prop the host applies only when its value changes, and the
  // entry keeps whatever was last typed into it, so seeding "" over a seed
  // that was already "" left the previous tab's address sitting in the field.
  // getTree reports the palette's rows and never its text, so the field is
  // read by typing one character into it and reading the result back.
  const tabsBeforeLauncher = (await tabRows(app)).length;
  await step("open a tab and send it somewhere by typing the address", async () => {
    await app.click("menu-new-tab");
    await waitRows(app, (r) => r.length === tabsBeforeLauncher + 1, "the first extra tab row");
    await openPalette(app);
    await typeQuery(app, `${base}/c`);
    await app.setValue("palette", true);
  });
  await waitUrl(app, "/c");
  await step("open a second tab on top of it", () => app.click("menu-new-tab"));
  await waitRows(app, (r) => r.length === tabsBeforeLauncher + 2, "the second extra tab row");
  await step("the new tab page presents its own field", () =>
    app.waitFor({ testId: "new-tab-search", state: "present" }, { timeoutMs: PATIENCE }),
  );
  const fresh = await app.mustFind("new-tab-search");
  // `value` is the live entry text; `text` in the tree is the prop the app
  // last set, which a typed or programmatic edit never touches.
  const held = String(fresh.value ?? "");
  if (held !== "") fail(`the new tab's field came up holding ${JSON.stringify(held)}`);
  const engineLine = await app.mustFind("new-tab-engine");
  if (!String(engineLine.text ?? "").startsWith("Search with ")) {
    fail(`the new tab page names no search engine, it says ${JSON.stringify(engineLine.text)}`);
  }
  if (await app.find("palette").then((n) => n?.visible)) fail("a new tab opened the command palette over the page");
  // Same engine gap as 4a: the field asks for the caret as it mounts, and a
  // browser in the window takes it back. At launch, before any page exists,
  // it holds (screenshot 01-new-tab.png).
  const newTabCaret = fresh.focused;
  await shoot(app, "04b-new-tab-page");
  await step("close both tabs this leg opened", async () => {
    await app.click("menu-close-tab");
    await waitRows(app, (r) => r.length === tabsBeforeLauncher + 1, "one extra tab left");
    await app.click("menu-close-tab");
  });
  await waitRows(app, (r) => r.length === tabsBeforeLauncher, "the tab count back where it started");
  console.log(
    `4b. a new tab lands on its own centred field, empty (${engineLine.text})${newTabCaret ? ", caret in it" : "; the engine kept the caret"}`,
  );

  // Acceptance 2 (continued) — back/forward enable states track real history.
  await app.click("menu-tab-1");
  await waitUrl(app, "/b");
  const backBefore = await app.mustFind("menu-back");
  await goTo(app, `${base}/long`);
  await waitRows(app, (r) => r[1]!.startsWith("Long page"), "the long page title");
  const backAfter = await app.mustFind("menu-back");
  await app.click("menu-back");
  await waitRows(app, (r) => r[1]!.startsWith("Page B"), "page B after going back");
  await app.click("menu-forward");
  await waitRows(app, (r) => r[1]!.startsWith("Long page"), "the long page after going forward");
  console.log(
    `5. back/forward work; Go menu enabled state ${backBefore.enabled} -> ${backAfter.enabled} across the first navigation`,
  );

  // Live-page proof again, on the scrollable fixture. Scroll state survives a tab switch too.
  await app.click("menu-tab-0");
  await waitUrl(app, "/a");
  await app.click("menu-tab-1");
  await waitRows(app, (r) => r[1]!.startsWith("Long page"), "the long page still loaded");
  if (loads.long !== 1) fail(`the long page reloaded on tab switch: ${JSON.stringify(loads)}`);
  console.log("5b. long page still at load 1 after a round trip");

  // Stage 5 — TLS padlock. The fixture is plain http, so the indicator has to
  // report exactly that. Its state lives in its testID because getTree carries
  // a node's text but never its icon name.
  await app.click("menu-tab-0");
  await waitUrl(app, "/a");
  await step("the padlock reports an unencrypted page", () =>
    app.waitFor({ testId: "security-insecure", state: "present" }, { timeoutMs: PATIENCE }),
  );
  if (await app.find("security-secure")) fail("an http page must not show the secure padlock");
  console.log("11. padlock: http://127.0.0.1 reports as not encrypted");

  // Stage 5 — find in page, on the 400-row fixture. "row 399" occurs once.
  await app.click("menu-tab-1");
  await waitRows(app, (r) => r[1]!.startsWith("Long page"), "the long page before searching it");
  // The bar floats over the page the way Chrome's does, so opening it must not
  // move or resize the view underneath it. The page's own rectangle is the
  // measurement: an inline bar takes a row off the top of it.
  const pageBeforeFind = await settledPageBox(app);
  await step("open the find bar", () => app.click("menu-find"));
  // "present", not "visible": the bar lives in a popover now, and neither
  // backend's tree calls a popover's content actionable. Its existence is the
  // assertion, and the steps below drive the field it holds.
  await step("the find bar presents", () => app.waitFor({ testId: "find-bar", state: "present" }, { timeoutMs: PATIENCE }));
  const pageWithFind = await shownPageBox(app);
  if (pageWithFind !== pageBeforeFind) {
    fail(`the find bar pushed the page about: ${pageBeforeFind} -> ${pageWithFind}`);
  }
  await step("type a query with exactly one match", () => app.type("find-query", "row 399"));
  // GTK counts matches; AppKit's WKFindResult only reports match/no-match, so
  // either answer is a pass for "the bar reported what the engine found".
  const counted = await waitText(app, "find-count", (t) => t === "1 match" || t === "Found", "the find result");
  await step("clear the query", () => app.setValue("find-query", ""));
  await step("type a query with no matches at all", () => app.type("find-query", "zzqqxx-not-on-this-page"));
  const missing = await waitText(app, "find-count", (t) => t === "0 matches" || t === "No matches", "a no-match result");
  await shoot(app, "11-find-bar");
  await step("close the find bar", () => app.click("find-close"));
  await step("the find bar goes away", () => app.waitFor({ testId: "find-bar", state: "gone" }, { timeoutMs: PATIENCE }));
  const pageAfterFind = await shownPageBox(app);
  if (pageAfterFind !== pageBeforeFind) {
    fail(`closing the find bar left the page at ${pageAfterFind}, it started at ${pageBeforeFind}`);
  }
  console.log(
    `12. find in page: "row 399" -> ${JSON.stringify(counted)}, absent text -> ${JSON.stringify(missing)}; the page stayed at ${pageBeforeFind}`,
  );

  // Acceptance 4: target=_blank opens a background tab. GTK automation cannot
  //    deliver a click into page content, and the engine refuses a
  //    gesture-less popup, so the click is issued through the app's
  //    NB_TEST_HOOKS-only Debug menu, which runs it via the webview's
  //    executeJavaScript (that path does carry a user gesture).
  await goTo(app, `${base}/popup`);
  await waitRows(app, (r) => r[1]!.startsWith("Popup page"), "the popup fixture to load");
  await app.click("menu-run-test-js");
  await waitRows(app, (r) => r.length === 3, "a background tab from target=_blank");
  const withPopup = await tabRows(app);
  if (!withPopup[1]!.title.startsWith("Popup page")) {
    fail(`the popup tab should stay active, rows are ${JSON.stringify(withPopup.map((r) => r.title))}`);
  }
  await waitUrl(app, "/popup");
  await waitRows(app, (r) => r[2]!.startsWith("Page C"), "page C in the background tab");
  console.log("6. target=_blank opened a background tab without stealing focus");
  await shoot(app, "06-background-tab");

  // Sidebar row action: the per-row close button, dispatched the way a hover
  // click would (click {testId, action}).
  const beforeAction = await tabRows(app);
  const victim = beforeAction[beforeAction.length - 1]!;
  if (!victim.testID) fail("sidebar rows carry no testID");
  const closeId = victim.testID.replace(/tab-(t\d+)$/, "tab-close-$1");
  if (closeId !== victim.testID) {
    // The sidebar layout shows a row's close button on hover or on the
    // selected row. Hover is real input and macOS only, so elsewhere the row
    // is selected first.
    await step("show the row's close button", async () => {
      try {
        await app.hover(victim.testID!);
      } catch {
        await app.click(victim.testID!);
      }
      await app.waitFor({ testId: closeId, state: "visible" }, { timeoutMs: PATIENCE });
    });
    await step("close a tab from its sidebar row button", () => app.click(closeId));
  } else {
    await step("close a tab from its sidebar row action", () =>
      app.click({ testId: victim.testID!, action: "close" }),
    );
  }
  await waitRows(app, (r) => r.length === beforeAction.length - 1, "the row-action close to land");
  await app.click("menu-reopen-tab");
  await waitRows(app, (r) => r.length === beforeAction.length, "the row-action close to be undone");
  console.log("7. sidebar row close action works through automation");

  // Acceptance 5 — close and reopen a tab through the menu.
  await app.click("menu-tab-0");
  await waitUrl(app, "/a");
  await app.click("menu-close-tab");
  await waitRows(app, (r) => r.length === 2 && !r.some((t) => t.startsWith("Page A")), "the page A row to go");
  await app.click("menu-reopen-tab");
  const reopened = await waitRows(app, (r) => r.some((t) => t.startsWith("Page A")), "the reopened page A row");
  if (reopened.length !== 3) fail(`reopen should restore one row, rows are ${JSON.stringify(reopened)}`);
  await waitUrl(app, "/a");
  console.log("8. close tab + reopen closed tab restored the same URL");

  // Stage 6 — cookies outlive the process. The engine keeps its jar in memory
  // unless the host names a file for it, and a browser that forgets every
  // cookie at quit reads as sites ignoring what you told them: a cookie banner
  // accepted yesterday is back today, and on a site that bounces through a
  // consent host it is back on every launch. Set it here, read it back after
  // the restart below.
  // The address field shows /setcookie as soon as the app sets it, before
  // the engine has fetched anything. Restarting on that alone raced the
  // request: under load the host was torn down before the Set-Cookie
  // response arrived, and leg 13 read cookie=none. The row's title comes
  // from the document, which is parsed after its headers are processed.
  await goTo(app, `${base}/setcookie`);
  await waitUrl(app, "/setcookie");
  await waitRows(app, (r) => r.includes("Cookie set"), "the Set-Cookie response to reach the engine");
  if (cookieSets !== 1) fail(`/setcookie was served ${cookieSets} times before the restart, want 1`);

  // Acceptance 7 — restart: the session store brings back the same tabs and the same active one.
  const before = (await tabRows(app)).map((r) => r.title);
  const activeBefore = await shownUrl(app);
  await app.restart();
  await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
  const after = await waitRows(app, (r) => r.length === before.length, "the restored tab rows");
  if (after.length !== before.length) fail(`restored ${after.length} tabs, had ${before.length}`);
  await waitUrl(app, activeBefore);
  console.log(`9. restart restored ${after.length} tabs and the active tab (${activeBefore})`);
  await shoot(app, "09-restored");

  // The other half of the cookie round trip, read off the page rather than out
  // of the app: /whoami echoes the cookie the engine actually sent.
  await goTo(app, `${base}/whoami`);
  await waitUrl(app, "/whoami");
  const echoed = await step("read the cookie back after the restart", async () => {
    const deadline = Date.now() + PATIENCE;
    let last = "";
    while (Date.now() < deadline) {
      const answer = await app.rpc.call("webviewEval", {
        ref: await shownPageRef(app),
        code: "document.body.innerText",
        timeoutMs: 5_000,
      });
      last = answer.ok ? String(answer.value) : `error: ${answer.error}`;
      if (last.includes("cookie=")) return last;
      await Bun.sleep(200);
    }
    return fail(`the page never reported a cookie line; last read ${JSON.stringify(last)}`);
  });
  if (!echoed.includes(`cookie=${COOKIE_VALUE}`)) {
    fail(`the cookie did not survive the restart: /whoami read ${JSON.stringify(echoed)}`);
  }
  console.log(`13. the cookie survived a restart (${COOKIE_VALUE})`);
  // Put the active tab back where the rest of the drive expects it: the steps
  // below assert against page A, and the round trip above borrowed this tab.
  await goTo(app, `${base}/a`);
  await waitUrl(app, "/a");

  // Acceptance 6: download. Runs with every tab from the rest of the drive
  // still live, since a download used to fire once per live view and cancel
  // the same handle once per handler, which crashed the host. Fixed
  // framework-side; this is the regression test for it.
  await goTo(app, `${base}/file.txt`);

  const downloaded = `${DOWNLOADS}/fixture.txt`;
  const landed = Date.now() + 25_000;
  while (Date.now() < landed && !existsSync(downloaded)) await Bun.sleep(150);
  if (!existsSync(downloaded)) fail(`download did not land at ${downloaded}`);
  const body = readFileSync(downloaded, "utf8");
  if (!body.startsWith("nativebrowser download fixture")) fail(`downloaded file has wrong content: ${JSON.stringify(body)}`);

  // Downloads live in the content header now, not the sidebar: a toolbar
  // button opens a popover listing the recent ones. A transfer opens it by
  // itself, which is what makes it findable here without a click.
  // Not a const: a restart destroys the window and builds a new one, and a
  // screenshot against the old ref answers "window closed" (-32004).
  let mainWindow = (await app.windows()).windows[0]!.ref;
  let downloadRows: string[] = [];
  const listed = Date.now() + 15_000;
  while (Date.now() < listed) {
    downloadRows = await textsUnder(app, "downloads-item-", mainWindow);
    if (downloadRows.includes("fixture.txt")) break;
    await Bun.sleep(150);
  }
  if (!downloadRows.includes("fixture.txt")) {
    fail(`the downloads panel lists ${JSON.stringify(downloadRows)}, want a fixture.txt row`);
  }
  // The name comes from the engine's suggestedFilename now, and exactly one
  // event arrives however many views are live.
  if (downloadRows.length !== 1) fail(`one download expected, got ${JSON.stringify(downloadRows)}`);
  if (await app.find("downloads-empty")) fail("the downloads panel still shows its empty state");
  // Reveal is per row and only offered once the file is actually on disk.
  const reveal = await step("find the row's reveal action", async () => {
    const found: JsonNode[] = [];
    walk((await app.tree(mainWindow)).root, (n) => {
      if (n.testID?.startsWith("downloads-reveal-")) found.push(n);
    });
    return found[0] ?? fail("the finished download offers no way to show it in a folder");
  });
  if (!reveal.enabled) fail("the reveal action is disabled on a download that finished");
  // The whole point of the move: nothing about downloads is in the tab list
  // any more. The sidebar layout's bottom bar holds the downloads button, so
  // only the list itself is checked there.
  const inSidebar: string[] = [];
  const sidebarLayout = (await app.find("tab-list")) !== null;
  walk((await app.tree(mainWindow)).root, (n) => {
    if (n.testID !== (sidebarLayout ? "tab-list" : "sidebar")) return;
    walk(n, (child) => {
      if (child.testID?.startsWith("downloads")) inSidebar.push(child.testID);
    });
  });
  if (inSidebar.length > 0) fail(`downloads are back in the sidebar: ${JSON.stringify(inSidebar)}`);

  // A download is not a navigation: the tab stays on the page it was showing.
  await waitUrl(app, "/a");

  // The toast is a transient overlay child; a miss is a timing artefact, the
  // download itself is already proven.
  let toasted = false;
  try {
    await app.waitForText("Saved fixture.txt", { timeoutMs: 8000 });
    toasted = true;
  } catch {
    toasted = false;
  }
  await shoot(app, "10-download");
  console.log(`10. download landed at ${downloaded} with ${(await tabRows(app)).length} tabs live; toast in tree=${toasted}`);

  // Ordering: this leg restarts the app, so it runs AFTER the download leg (a
  // restart immediately before it leaves the download never landing) and
  // BEFORE the settings leg, which turns reopen-on-launch off and would leave
  // this leg's tab with nothing to restore.
  //
  // Owner report: a restored chrome:// tab came back as about:blank and the
  // session then stored about:blank as its address. Chromium refuses a
  // renderer-initiated navigation to chrome://, so such a tab's view has to be
  // CREATED at the address rather than armed one render later.
  //
  // chrome:// exists only under Chromium; on the system engine the app refuses
  // the address, which is its own leg below.
  if (!onChromium) {
    await step("the app refuses a chrome:// address on the system engine", async () => {
      const before = (await tabRows(app)).length;
      await goTo(app, "chrome://version");
      await Bun.sleep(1500);
      const seen = await shownUrl(app);
      if (seen.includes("version")) fail(`the system engine was sent to ${JSON.stringify(seen)}`);
      const after = (await tabRows(app)).length;
      if (after !== before) fail(`refusing a chrome:// address changed the tab count: ${before} -> ${after}`);
    });
    await goTo(app, `${base}/a`);
    await waitUrl(app, "/a");
    console.log("13b. the system engine is never sent to a chrome:// address");
  } else {
    const beforeChrome = (await tabRows(app)).length;
    await step("open a tab and send it to chrome://version", async () => {
      await app.click("menu-new-tab");
      await waitRows(app, (r) => r.length === beforeChrome + 1, "the extra tab row");
      await goTo(app, "chrome://version");
    });
    await waitUrl(app, "version");
    await step("leave it in the background", () => app.click("menu-prev-tab"));
    await app.restart();
    await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
    mainWindow = (await app.windows()).windows[0]!.ref;
    const restoredChrome = await waitTabIds(app, (ids) => ids.length === beforeChrome + 1, "the restored tab rows");
    await step("activate the restored chrome:// tab", () => app.click(`menu-tab-${restoredChrome.length - 1}`));
    const chromeShown = await step("it loads the page it was stored on", async () => {
      const deadline = Date.now() + PATIENCE;
      let seen = "";
      while (Date.now() < deadline) {
        seen = await shownUrl(app);
        if (seen.includes("version")) return seen;
        if (seen.includes("blank")) fail(`the restored chrome:// tab came back on ${JSON.stringify(seen)}`);
        await Bun.sleep(150);
      }
      return fail(`the restored chrome:// tab reads ${JSON.stringify(seen)}`);
    });
    await step("close it again", () => app.click("menu-close-tab"));
    await waitRows(app, (r) => r.length === beforeChrome, "the chrome:// tab to go");
    // Index-free: earlier legs open and close tabs of their own, so "the tab
    // the rest of the drive works in" is whichever one is active once this
    // leg's is gone, sent back to page A. Retried: the palette opened in the
    // same beat as a tab closing has taken a typed query and come up empty,
    // and re-typing it is what a person would do.
    await step("back to page A", async () => {
      const deadline = Date.now() + PATIENCE;
      while (Date.now() < deadline) {
        await goTo(app, `${base}/a`);
        const seen = await shownUrl(app).catch(() => "");
        if (seen.endsWith("/a")) return;
        await Bun.sleep(500);
      }
      return fail("the palette would not take the address back to page A");
    });
    console.log(`13b. a chrome:// tab is reachable from the address bar and survives a restart (${chromeShown})`);
  }

  // Stage 5 — a private window is a real second window on an ephemeral profile,
  // and nothing it does reaches the session store. The store on disk is the
  // assertion: opening private tabs must not change what a restart would bring
  // back.
  const storedTabs = (): number => {
    const raw = JSON.parse(readFileSync(`${PROFILE}/session.json`, "utf8")) as {
      data?: { windows?: { tabs: unknown[] }[] };
    };
    return (raw.data?.windows ?? []).reduce((n, w) => n + w.tabs.length, 0);
  };
  // The store is written on a debounce, and the leg before this one closes a
  // tab, so the baseline is taken once the file has stopped moving. Reading it
  // too early compares a count from before that close against one from after.
  const persistedBefore = await step("the session store settles", async () => {
    const deadline = Date.now() + PATIENCE;
    let last = -1;
    let stable = 0;
    while (Date.now() < deadline) {
      const now = storedTabs();
      stable = now === last ? stable + 1 : 0;
      last = now;
      if (stable >= 5) return now;
      await Bun.sleep(200);
    }
    return last;
  });
  await step("open a private window", () => app.click("menu-private-window"));
  await step("the private window presents", () =>
    app.waitFor({ testId: "private-window", state: "present" }, { timeoutMs: PATIENCE }),
  );
  const twoWindows = await app.windows();
  if (twoWindows.windows.length !== 2) fail(`expected 2 windows with a private one open, got ${twoWindows.windows.length}`);
  if (!(await app.find("private-banner"))) fail("the private window carries no private-browsing marker");
  const privateRows = async (): Promise<number> => ((await app.mustFind("private-tab-list")).rows ?? []).length;
  const privateBefore = await privateRows();
  await step("open a second private tab", () => app.click("private-new-tab"));
  const grew = Date.now() + 10_000;
  while (Date.now() < grew && (await privateRows()) === privateBefore) await Bun.sleep(120);
  if ((await privateRows()) !== privateBefore + 1) fail("the private window did not open a second tab");
  await Bun.sleep(600);
  if (storedTabs() !== persistedBefore) {
    fail(`private tabs reached the session store: ${persistedBefore} -> ${storedTabs()}`);
  }
  await shoot(app, "12-private-window", (await app.find("private-window"))?.ref);
  console.log(`14. private window: 2 windows, ${privateBefore + 1} ephemeral tabs, session store still holds ${persistedBefore}`);

  // Stage 5 — settings actually change behaviour. Switching the engine has to
  // change what the palette offers for a non-address query.
  await step("open settings", () => app.click("menu-settings"));
  await step("the settings window presents", () =>
    app.waitFor({ testId: "settings-window", state: "present" }, { timeoutMs: PATIENCE }),
  );
  await step("choose Google", () => app.setValue("settings-engine", 1));
  await step("turn off reopen-on-launch", () => app.setValue("settings-restore", false));
  await Bun.sleep(600);
  const prefs = JSON.parse(readFileSync(`${PROFILE}/settings.json`, "utf8")) as {
    data?: { searchEngine?: string; restoreOnLaunch?: boolean };
  };
  if (prefs.data?.searchEngine !== "google" || prefs.data?.restoreOnLaunch !== false) {
    fail(`settings did not persist: ${JSON.stringify(prefs.data)}`);
  }
  await openPalette(app);
  await typeQuery(app, "native desktop");
  const searchRow = await paletteRow(app, (id) => id === "url", "the search row for a non-address query");
  const rows = (await app.mustFind("palette")).rows ?? [];
  const searchTitle = rows[searchRow]?.title ?? "";
  if (!searchTitle.includes("Google")) fail(`the palette still offers ${JSON.stringify(searchTitle)} after choosing Google`);
  await step("dismiss the palette", () => app.click("menu-address"));
  await shoot(app, "13-settings", (await app.find("settings-window"))?.ref);
  // The layout switch took the width its two labels need rather than the
  // minimum the row would hand it, which ellipsized "Compact".
  const segmentWidth = (await app.find("settings-layout"))?.geometry?.w ?? 0;
  if (segmentWidth < LAYOUT_SEGMENT_WIDTH) fail(`the layout switch is ${segmentWidth} px wide, want ${LAYOUT_SEGMENT_WIDTH}`);
  console.log(`15. settings: engine + restore persisted, palette now offers ${JSON.stringify(searchTitle)}`);

  // Stage 6: the page context menu. The menu itself is the engine's own
  // (`contextMenuMode` defaults to native), and no drive can open one: GTK4
  // synthesises no pointer input and the engine's menu wants a live
  // right-click. The two halves the app owns are asserted instead: the tree it
  // pushes into the view, and what each of its items does when chosen, fed
  // through the same handler a real click lands in (NB_TEST_HOOKS).
  const menuTree = lastMenuTree();
  if (!menuTree) fail("the app never pushed a context-menu tree to any view");
  const menuLabels = menuTree!.map((i) => i.label ?? "");
  // Chromium's own menu already carries Open Link in New Tab and Save Image
  // As, so the app adds only what it alone knows: its search engine.
  const wantedItems = ["Search with Google"];
  for (const wanted of wantedItems) {
    if (!menuLabels.includes(wanted)) fail(`the context menu is missing ${JSON.stringify(wanted)}: ${JSON.stringify(menuLabels)}`);
  }
  for (const duplicate of ["Open Link in New Tab", "Save Image"]) {
    if (menuLabels.includes(duplicate)) fail(`the app adds ${JSON.stringify(duplicate)}, which Chromium's menu already has`);
  }
  const tabsBefore = (await tabRows(app)).length;
  await step("context menu: search the selection", () => app.click("menu-ctx-search-selection"));
  await waitRows(app, (r) => r.length === tabsBefore + 1, "a tab for the searched selection");
  const searchTab = (await tabRows(app))[tabsBefore];
  // Served by the fixture (NB_TEST_SEARCH_PREFIX), counted server-side like
  // every other page here.
  const searched = Date.now() + PATIENCE;
  while (Date.now() < searched && !loads["search"]) await Bun.sleep(120);
  if (!loads["search"]) fail("the search tab never reached the fixture's /search");
  console.log(
    `16. page context menu: ${menuLabels.length} app items (${JSON.stringify(menuLabels)}), ` +
      `search opened a tab (${JSON.stringify(searchTab?.title ?? "")})`,
  );

  // Pinning is a second row action on the same rows, and it re-sorts the
  // sidebar: a pinned tab moves under its own heading, ahead of the rest.
  // Last, because it deliberately reorders the tabs every leg above indexes by.
  const beforePin = await tabRows(app);
  if ((await tabSections(app)).length !== 0) fail("an unpinned window should draw no section headings");
  const toPin = beforePin[beforePin.length - 1]!;
  // Pin is offered on the row you are on, so the drive selects it first, which
  // is what a person clicking a tab and then its pin button does.
  await step("select the tab to pin", () => app.click(`menu-tab-${beforePin.length - 1}`));
  await step("pin it from its row action", () => clickRowAction(app, toPin.testID!, "pin"));
  await waitTabIds(app, (ids) => ids[0] === toPin.testID, "the pinned tab to sort to the top");
  const sections = await step("read the sidebar's section headings", async () => {
    const deadline = Date.now() + PATIENCE;
    let seen: string[] = [];
    while (Date.now() < deadline) {
      seen = await tabSections(app);
      if (seen.length === 2) return seen;
      await Bun.sleep(150);
    }
    return fail(`pinning should split the sidebar in two, headings were ${JSON.stringify(seen)}`);
  });
  if (sections[0] !== "Pinned" || sections[1] !== "Tabs") {
    fail(`sidebar headings are ${JSON.stringify(sections)}, want Pinned then Tabs`);
  }
  await shoot(app, "17-pinned-tab", mainWindow);
  // A pin that a restart forgets is a preference the browser only pretended to
  // keep, so the store on disk is the assertion.
  await Bun.sleep(800);
  const pinnedOnDisk =
    (
      JSON.parse(readFileSync(`${PROFILE}/session.json`, "utf8")) as {
        data?: { windows?: { tabs: { pinned?: boolean }[] }[] };
      }
    ).data?.windows?.flatMap((w) => w.tabs).filter((t) => t.pinned).length ?? 0;
  if (pinnedOnDisk !== 1) fail(`the session store holds ${pinnedOnDisk} pinned tabs, want 1`);

  await step("unpin it again", () => clickRowAction(app, toPin.testID!, "unpin"));
  await step("the headings go with the last pin", async () => {
    const deadline = Date.now() + PATIENCE;
    let seen: string[] = [];
    while (Date.now() < deadline) {
      seen = await tabSections(app);
      if (seen.length === 0) return;
      await Bun.sleep(150);
    }
    return fail(`the sidebar still draws ${JSON.stringify(seen)} with nothing pinned`);
  });
  const unpinned = (await tabRows(app)).map((r) => r.testID!);
  if (unpinned.length !== beforePin.length) fail(`unpinning changed the tab count: ${JSON.stringify(unpinned)}`);
  console.log(`17. pin sorts ${toPin.testID} under a Pinned heading and persists; unpin takes the headings away`);

  // Extensions: the toolbar area Chrome has. The registry surface behind it
  // (chrome://extensions, listExtensions, installExtension) is Chromium's, and
  // the GTK CEF backend is the only one that answers it, so a run on the
  // system engine or on AppKit has nothing to list and nothing to drive. The
  // app hides the whole area there rather than offering a dead button, which
  // is the first thing asserted.
  if (!onChromium || process.platform !== "linux") {
    if (await app.find("extensions-button")) {
      fail("the extensions button is on show on an engine with no extension registry");
    }
    console.log(
      `19. extensions: skipped and the toolbar area is hidden (engine ${onChromium ? "chromium" : "system"}, ${process.platform})`,
    );
  } else {
    // The app installs the fixture through its own install API, which is
    // also the only route a drive has: launchApp passes no argv.
    const extTabsBefore = (await tabRows(app)).length;
    await step("open the extensions panel", () => app.click("extensions-button"));
    await step("the panel presents", () =>
      app.waitFor({ testId: "extensions-panel", state: "present" }, { timeoutMs: PATIENCE }),
    );
    if (!(await app.find("extensions-empty"))) fail("the panel should start on its empty state");

    await step("install the test extension", () => clickWhenReady(app, "extensions-install-test"));
    const extId = await step("the installed extension gets a row", async () => {
      const deadline = Date.now() + PATIENCE;
      let seen: string[] = [];
      while (Date.now() < deadline) {
        seen = [];
        walk((await app.tree(mainWindow)).root, (n) => {
          if (n.testID?.startsWith("ext-row-")) seen.push(n.testID.slice("ext-row-".length));
        });
        if (seen.length === 1) return seen[0]!;
        await Bun.sleep(200);
      }
      return fail(`the panel lists ${JSON.stringify(seen)} after installing one extension`);
    });
      // The extension opens its own welcome tab on install (chrome.tabs.create),
    // which reaches the app as `newWindow` carrying a chrome-extension:// URL.
    // It used to arrive empty and the app opened a dead about:blank tab.
    const welcome = await waitRows(
      app,
      (r) => r.some((title) => title === "ND Gate options"),
      "the tab the extension opened for itself",
    );
    // The tab the install added, not the ones earlier legs left lying about:
    // a dead one would come up as the last row reading about:blank.
    if (welcome.length !== extTabsBefore + 1 || welcome[welcome.length - 1] !== "ND Gate options") {
      fail(`the extension's tab came up as ${JSON.stringify(welcome.slice(extTabsBefore))}`);
    }
    await step("close the extension's own tab", async () => {
      const at = welcome.findIndex((title) => title === "ND Gate options");
      await app.click(`menu-tab-${at}`);
      await app.click("menu-close-tab");
    });

  const extRow = await app.mustFind(`ext-row-${extId}`);
    if (extRow.text !== "NB Test Extension") fail(`the row reads ${JSON.stringify(extRow.text)}`);
    if (await app.find("extensions-empty")) fail("the panel still shows its empty state with one extension listed");

    await step("pin it to the toolbar", () => clickWhenReady(app, `ext-pin-toggle-${extId}`));
    await step("a toolbar button appears for it", () =>
      app.waitFor({ testId: `ext-action-${extId}`, state: "present" }, { timeoutMs: PATIENCE }),
    );
    await Bun.sleep(600);
    const pinnedOnDiskExt =
      (JSON.parse(readFileSync(`${PROFILE}/settings.json`, "utf8")) as { data?: { pinnedExtensions?: string[] } })
        .data?.pinnedExtensions ?? [];
    if (JSON.stringify(pinnedOnDiskExt) !== JSON.stringify([extId])) {
      fail(`the store holds ${JSON.stringify(pinnedOnDiskExt)} as pinned, want [${extId}]`);
    }

    await step("open the pinned action's popup", () => app.click(`ext-action-${extId}`));
    await step("the popup page loads in the app's own view", () =>
      app.waitFor({ testId: `ext-popup-view-${extId}`, urlContains: "popup.html" }, { timeoutMs: PATIENCE }),
    );
    // The popup is not sized by its document here, so the app measures it: the
    // fixture's body is 260x180, well under the 360x520 it opens at.
    const popupBox = await step("the popup fits the document", async () => {
      const deadline = Date.now() + PATIENCE;
      let box = { w: 0, h: 0 };
      while (Date.now() < deadline) {
        const g = (await app.mustFind(`ext-popup-body-${extId}`)).geometry;
        box = { w: g?.w ?? 0, h: g?.h ?? 0 };
        if (box.w > 0 && box.w < 360) return box;
        await Bun.sleep(200);
      }
      return fail(`the popup is ${JSON.stringify(box)}, want it fitted under the 360x520 default`);
    });
    rootShot("19-extension-popup");
    await step("a second click closes it", () => app.click(`ext-action-${extId}`));
    await step("the popup view goes", () =>
      app.waitFor({ testId: `ext-popup-view-${extId}`, state: "gone" }, { timeoutMs: PATIENCE }),
    );

    await step("open the panel again", () => app.click("extensions-button"));
    await step("toggle the pin off", () => clickWhenReady(app, `ext-pin-toggle-${extId}`));
    await step("the toolbar button goes with it", () =>
      app.waitFor({ testId: `ext-action-${extId}`, state: "gone" }, { timeoutMs: PATIENCE }),
    );
    await step("Manage Extensions opens the page", () => clickWhenReady(app, "extensions-manage"));
    await waitRows(app, (r) => r.length === extTabsBefore + 1, "a tab for chrome://extensions");
    await waitUrl(app, "extensions");
    await step("close it", () => app.click("menu-close-tab"));
    await waitRows(app, (r) => r.length === extTabsBefore, "the tab count back where it started");
    console.log(`19. extensions: ${extRow.text} installed, pinned, popup ${popupBox.w}x${popupBox.h}, unpinned`);

    // An action is opened on its LIVE state, not its manifest. The fixture
    // declares a popup and switches it off at runtime, which is what 1Password
    // does until an account is set up; the owner saw its splash for ever
    // because the app opened the manifest's popup anyway. A click on such an
    // action opens the extension's setup page instead, and the badge it sets
    // is drawn on the button.
    await step("open the panel for the action fixture", () => app.click("extensions-button"));
    await Bun.sleep(500);
    rootShot("19-extensions-panel");
    await step("install the action fixture", () => clickWhenReady(app, "extensions-install-action-test"));
    const actionId = await step("the action fixture gets a row", async () => {
      const deadline = Date.now() + PATIENCE;
      while (Date.now() < deadline) {
        let found = "";
        walk((await app.tree(mainWindow)).root, (n) => {
          if (n.testID?.startsWith("ext-row-") && n.text === "ND Action Extension") found = n.testID.slice(8);
        });
        if (found) return found;
        await Bun.sleep(200);
      }
      return fail("no row for ND Action Extension");
    });
    await step("pin the action fixture", () => clickWhenReady(app, `ext-pin-toggle-${actionId}`));
    await step("close the panel", () => app.click("extensions-button"));
    await goTo(app, `${base}/action`);
    await waitUrl(app, "/action");
    // The badge is drawn once the action's state has been read for this tab,
    // which follows the page load rather than coming with it.
    const badge = await step("the badge the extension set is on its button", async () => {
      await app.waitFor({ testId: `ext-badge-${actionId}`, state: "present" }, { timeoutMs: PATIENCE });
      return waitText(app, `ext-badge-${actionId}`, (t) => t === "7", "the badge reading 7");
    });
    const actionTabsBefore = (await tabRows(app)).length;
    await step("click the action", () => app.click(`ext-action-${actionId}`));
    const onboarding = await waitRows(
      app,
      (r) => r.length === actionTabsBefore + 1 && r[r.length - 1] === "ND Action onboarding",
      "the extension's setup page in a tab of its own",
    );
    const decided = actionTraces.find((line) => line.includes(`id=${actionId}`)) ?? "";
    if (!decided.includes('popup=""')) fail(`the click was decided on ${JSON.stringify(decided)}, want the live popup ""`);
    if (await app.find(`ext-popup-view-${actionId}`)) fail("the popup the extension switched off was mounted anyway");
    if (actionTraces.filter((line) => line.includes(`id=${actionId}`)).length !== 1) {
      fail(`one click decided more than once: ${JSON.stringify(actionTraces)}`);
    }
    await step("close the setup page", () => app.click("menu-close-tab"));
    await waitRows(app, (r) => r.length === actionTabsBefore, "the tab count back where it started");
    await step("open the panel to unpin", () => app.click("extensions-button"));
    await step("unpin the action fixture", () => clickWhenReady(app, `ext-pin-toggle-${actionId}`));
    await step("its button goes", () =>
      app.waitFor({ testId: `ext-action-${actionId}`, state: "gone" }, { timeoutMs: PATIENCE }),
    );
    await step("close the panel", () => app.click("extensions-button"));
    console.log(
      `19b. a popup switched off at runtime is not shown: badge ${JSON.stringify(badge)}, click opened ${JSON.stringify(onboarding[onboarding.length - 1])} (${decided.slice(decided.indexOf("ND_APP"))})`,
    );
  }

  // Permissions. Under 0.4.9 Chromium draws no prompt of its own, so the app
  // owns the whole exchange. Each leg asks for a permission the profile has no
  // setting for yet: an explicit answer is recorded by Chromium too, and a
  // type it has already decided never reaches the app a second time.
  const permTabs = (await tabRows(app)).length;
  const permStore = (): Record<string, string> => {
    const saved =
      (JSON.parse(readFileSync(`${PROFILE}/settings.json`, "utf8")) as {
        data?: { sitePermissions?: Record<string, Record<string, string>> };
      }).data?.sitePermissions ?? {};
    const key = Object.keys(saved).find((k) => k.includes(String(server.port)));
    return key ? saved[key]! : {};
  };
  /// What the app last answered, which is the only way to see an answer the
  /// user did not click and the only way to tell the app's own memory from a
  /// setting Chromium answered by itself.
  const lastAnswer = (): string => permissionTraces[permissionTraces.length - 1] ?? "";
  // Through the address field like every other navigation in this drive: the
  // permission fixtures ask as soon as their page runs, so a navigation that
  // quietly did not happen reads here as a request that never arrived.
  const askFor = (path: string): Promise<void> => goTo(app, `${base}${path}`);

  await step("open a tab for the permission fixtures", () => app.click("menu-new-tab"));
  await waitRows(app, (r) => r.length === permTabs + 1, "a tab for the permission page");
  await step("ask for notifications", () => askFor("/permission"));
  await step("the site-info bubble opens itself with the request", () =>
    app.waitFor({ testId: "permission-request", state: "present" }, { timeoutMs: PATIENCE }),
  );
  const asked = String((await app.mustFind("permission-request")).text ?? "");
  if (!asked.includes("wants to send you notifications")) fail(`the prompt reads ${JSON.stringify(asked)}`);
  await step("allow it", () => clickWhenReady(app, "permission-allow"));
  await waitRows(app, (r) => r[r.length - 1] === "notif:granted", "the page to hear that it was allowed");
  await Bun.sleep(700);
  if (permStore().notifications !== "allow") fail(`the store holds ${JSON.stringify(permStore())} after Allow`);
  if (!lastAnswer().includes("allow=true")) fail(`the app last sent ${JSON.stringify(lastAnswer())}`);

  // Remembered: the same origin asks again and is answered with no prompt.
  // Which memory answered is not asserted, and cannot be: an explicit answer
  // is recorded by Chromium as a content setting too, so the second ask is
  // settled before the app is told about it. The app's own store is what the
  // site-info panel shows and resets, and what answers any request that does
  // reach it.
  await step("ask a second time", () => askFor("/permission?2"));
  await waitRows(app, (r) => r[r.length - 1] === "notif:granted", "the remembered answer to reach the page");
  if (await app.find("permission-request")) fail("a remembered allow still put a prompt up");

  // Reset, from the same bubble the request came up in.
  await step("open the site-info bubble", () => clickWhenReady(app, "security-insecure"));
  await step("reset this site's permissions", () => clickWhenReady(app, "site-permissions-reset"));
  await step("the bubble says the site has nothing on record", () =>
    app.waitFor({ testId: "site-permissions-empty", state: "present" }, { timeoutMs: PATIENCE }),
  );
  await Bun.sleep(700);
  if (Object.keys(permStore()).length !== 0) fail(`reset left ${JSON.stringify(permStore())} behind`);
  await step("put the bubble away", () => clickWhenReady(app, "security-insecure"));

  // Block, on a permission this profile has never decided.
  await step("ask for a location", () => askFor("/permission-geo"));
  await step("the request comes up", () =>
    app.waitFor({ testId: "permission-request", state: "present" }, { timeoutMs: PATIENCE }),
  );
  const askedGeo = String((await app.mustFind("permission-request")).text ?? "");
  if (!askedGeo.includes("wants to use your location")) fail(`the location prompt reads ${JSON.stringify(askedGeo)}`);
  await step("block it", () => clickWhenReady(app, "permission-block"));
  // PERMISSION_DENIED is code 1; a rig with no location provider answers an
  // allowed request with code 2, so the code is what proves the block.
  await waitRows(app, (r) => r[r.length - 1] === "geo:e1", "the page to hear that it was blocked");
  await Bun.sleep(700);
  if (permStore().geolocation !== "block") fail(`the store holds ${JSON.stringify(permStore())} after Block`);

  // A tab closed with a prompt open: the request is answered rather than left
  // pending, which is only visible in what the app sent.
  await step("open one more tab and ask from it", async () => {
    await app.click("menu-new-tab");
    await waitRows(app, (r) => r.length === permTabs + 2, "the second permission tab");
    await askFor("/permission-midi");
  });
  await step("its request is on show", () =>
    app.waitFor({ testId: "permission-request", state: "present" }, { timeoutMs: PATIENCE }),
  );
  const beforeClose = lastAnswer();
  await step("close the tab under the prompt", () => app.click("menu-close-tab"));
  await waitRows(app, (r) => r.length === permTabs + 1, "the closed tab to go");
  const denied = lastAnswer();
  if (denied === beforeClose || !denied.includes("allow=false")) {
    fail(`closing the tab should have denied the request, the app last sent ${JSON.stringify(denied)}`);
  }
  if (await app.find("permission-request")) fail("the prompt outlived the tab that asked");
  await step("close the first permission tab", () => app.click("menu-close-tab"));
  await waitRows(app, (r) => r.length === permTabs, "the tab count back where it started");
  console.log(`20. permissions: allow, remembered, reset, block and a tab closed under a prompt: ${JSON.stringify(asked)}`);

  // Compact is the owner's reference row: back, forward, reload, the tabs, a
  // new-tab button, then the address field taking everything left. Nothing is
  // drawn below it, and the live pages must not notice the switch, so the
  // server's load counters bracket each one.
  const beforeCompact = (await tabRows(app)).map((r) => r.testID!);
  const activeTabId = listActive(await app.mustFind("tab-list"));
  const otherTabId = beforeCompact.map((id) => id.slice(4)).find((id) => id !== activeTabId)!;
  const activeBeforeCompact = await shownUrl(app);
  let loadsAt = await settledLoads();
  const insetBefore = await contentInset(app);
  if (insetBefore <= 0) fail(`the sidebar layout should inset the content, it starts at x=${insetBefore}`);
  await step("switch to the compact layout", () => app.click("menu-layout"));
  await step("the content reclaims the tab column's width", () => waitContentInset(app, (x) => x === 0));
  await app.mustFind("tab-strip");
  await app.mustFind("header-new-tab");
  const afterDrop = await settledLoads();
  if (loadsAt !== afterDrop) fail(`dropping the sidebar reloaded a page: ${loadsAt} -> ${afterDrop}`);

  // The address field is the point of the redraw: always there, always the
  // active tab's address, and wider than any one tab.
  const compactField = await app.mustFind("omnibox");
  if (String(compactField.text ?? "") !== activeBeforeCompact) {
    fail(`the compact address field reads ${JSON.stringify(compactField.text)}, want ${JSON.stringify(activeBeforeCompact)}`);
  }
  const fieldBox = compactField.geometry!;
  const activeSlot = (await app.mustFind(`tab-slot-${activeTabId}`)).geometry!;
  if (fieldBox.w < 240) fail(`the address field is only ${fieldBox.w} wide; its floor is 240`);
  if (fieldBox.x < activeSlot.x) fail(`the address field (x=${fieldBox.x}) should sit after the tabs (x=${activeSlot.x})`);
  if (activeSlot.w > 200) fail(`a compact tab is ${activeSlot.w} wide; the reference draws them near 156`);
  await shoot(app, "18-compact", mainWindow);

  // Owner report: the compact tab list went stale. The row is the only tab UI
  // this layout has, so everything the session does has to reach it.
  // Titles, for the legs that assert on what a tab says. A tab narrowed to
  // its favicon carries no label at all, so this reads short once the row is
  // crowded; `tabIds` is what counts tabs.
  const items = async (check: (p: string[]) => boolean, what: string): Promise<string[]> => {
    const deadline = Date.now() + PATIENCE;
    let seen: string[] = [];
    while (Date.now() < deadline) {
      seen = await textsUnder(app, "tab-item-", mainWindow);
      if (check(seen)) return seen;
      await Bun.sleep(150);
    }
    return fail(`timed out waiting for ${what}; the row read ${JSON.stringify(seen)}`);
  };

  /// Every tab in the row by testID, which is there whether or not the tab is
  /// wide enough to show a title.
  const tabIds = async (check: (ids: string[]) => boolean, what: string): Promise<string[]> => {
    const deadline = Date.now() + PATIENCE;
    let seen: string[] = [];
    while (Date.now() < deadline) {
      const tree = await app.tree(mainWindow);
      seen = [];
      walk(tree.root, (n) => {
        if (n.testID?.startsWith("tab-item-")) seen.push(n.testID);
      });
      if (check(seen)) return seen;
      await Bun.sleep(150);
    }
    return fail(`timed out waiting for ${what}; the row held ${JSON.stringify(seen)}`);
  };
  await tabIds((ids) => ids.length === beforeCompact.length, "one tab in the row per open tab");

  // Only the active tab carries a close button; the rest grow one under the
  // pointer, and GTK synthesises no pointer input, so what is asserted is the
  // half that does not need one.
  await app.mustFind(`tab-close-${activeTabId}`);
  if (await app.find(`tab-close-${otherTabId}`)) {
    fail("an unselected tab draws a close button before the pointer reaches it");
  }

  await step("switch to another tab from the row", () => app.click(`tab-item-${otherTabId}`));
  await step("the close button follows the selection", async () => {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      if (await app.find(`tab-close-${otherTabId}`)) return;
      await Bun.sleep(150);
    }
    return fail("the newly selected tab never grew its close button");
  });
  await step("the window follows the tab the row picked", async () => {
    const wanted = (await app.mustFind(`tab-item-${otherTabId}`)).text ?? "";
    const deadline = Date.now() + PATIENCE;
    let title = "";
    while (Date.now() < deadline) {
      title = (await app.windows()).windows[0]!.title ?? "";
      if (title === wanted) return;
      await Bun.sleep(150);
    }
    return fail(`the window still says ${JSON.stringify(title)}, want ${JSON.stringify(wanted)}`);
  });

  // The page under the row: a switch in this layout must leave the active
  // tab's view filling the content area, not unmounted, hidden or zero-sized.
  // The owner's report was a solid dark content area under a loaded page.
  await step("the active page fills the content area in compact", async () => {
    const box = JSON.parse(await settledPageBox(app)) as { x: number; y: number; w: number; h: number };
    const content = (await app.mustFind("content")).geometry!;
    // 8, not 0: the overlay around the page also holds the load bar, the find
    // anchor and the 2px registry view, and those cost the page a few points
    // at one edge. What this leg is for is the owner's report of a content
    // area with nothing in it, which is a whole-area difference.
    if (Math.abs(box.w - content.w) > 8 || Math.abs(box.h - content.h) > 8) {
      fail(`the page is ${box.w}x${box.h} inside a ${content.w}x${content.h} content area`);
    }
  });
  const pageBox = JSON.parse(await settledPageBox(app)) as { x: number; y: number; w: number; h: number };
  // Reported, not asserted. The crop is taken off the X ROOT at the main
  // window's coordinates, and by this point the drive has left the settings
  // and private windows up; under Xvfb with no compositor they stack over the
  // main window, so those pixels are theirs, not the page's. The hard check on
  // "the content area has nothing in it" is the geometry one above, which
  // catches a view that is unmounted, hidden or zero-sized. Capturing the
  // window by id instead would need the obscured-window contents X does not
  // promise without a compositor.
  const ink = await pageInk(app, pageBox, "18a-compact-page");
  if (ink === null) console.log("  18a. no X screen to read, the ink reading did not run");
  else console.log(`  18a. ink over the page rect: ${ink.toFixed(2)} (root crop, other windows may stack over it)`);

  // Typing an address into the compact field. Enter is a keystroke and GTK
  // synthesises none (-32003), so the drive fills the field and runs the
  // handler Enter runs; what is NOT covered here is the key binding itself.
  await step("type an address into the compact field", () => app.setValue("omnibox", `${base}/c`));
  await step("commit it", () => app.click("menu-commit-address"));
  await waitUrl(app, "/c");
  await items((p) => p.some((t) => t.startsWith("Page C")), "the row to carry the page it landed on");
  console.log("18c. the compact address field takes a URL and the tab lands on it");

  // Opened and retitled: a tab opened from the History menu loads a real page,
  // so it starts on the address and has to end on the page's own title.
  await step("open a tab from the History menu", () => app.click("menu-history-0"));
  await tabIds((ids) => ids.length === beforeCompact.length + 1, "a row entry for the tab history opened");
  // What the tab calls itself, read off the window rather than off the row: a
  // sixth tab at this width is narrowed to its favicon and carries no label.
  await step("the new tab reports its page's own title", async () => {
    const deadline = Date.now() + PATIENCE;
    let title = "";
    while (Date.now() < deadline) {
      title = (await app.windows()).windows[0]!.title ?? "";
      if (title && !title.includes("127.0.0.1")) return;
      await Bun.sleep(150);
    }
    return fail(`the window still says ${JSON.stringify(title)}`);
  });
  await step("close it again", () => app.click("menu-close-tab"));
  const rowAfterClose = await tabIds((ids) => ids.length === beforeCompact.length, "the closed tab to go");
  console.log(`18b. the compact row tracks open, retitle, close and switch (${rowAfterClose.length} tabs)`);

  loadsAt = await settledLoads();
  await step("switch back to the sidebar layout", () => app.click("menu-layout"));
  // The divider lands on a whole pixel while the recorded inset can carry the
  // fraction's remainder, so the return trip is near, not equal.
  await step(`the tab column takes its width back (was ${insetBefore})`, () => waitContentInset(app, (x) => Math.abs(x - insetBefore) <= 2));
  const afterCompact = await waitTabIds(
    app,
    (ids) => ids.length === beforeCompact.length,
    "the tab rows to come back",
  );
  const afterRestore = await settledLoads();
  if (loadsAt !== afterRestore) fail(`restoring the sidebar reloaded a page: ${loadsAt} -> ${afterRestore}`);
  // The same tabs in the same order, and the address bar drives them again.
  if (JSON.stringify(afterCompact) !== JSON.stringify(beforeCompact)) {
    fail(`the round trip through compact changed the tab list: ${JSON.stringify(beforeCompact)} -> ${JSON.stringify(afterCompact)}`);
  }
  await goTo(app, `${base}/c`);
  await waitUrl(app, "/c");
  await shoot(app, "19-sidebar-again", mainWindow);
  console.log(`18. compact drops the sidebar and still navigates; the round trip kept ${afterCompact.length} live tabs`);

  // Tabs move between windows, and between windows on one profile the LIVE
  // page moves: the counter keeps counting from where it was, the field keeps
  // its value and the server sees no second load. GTK cannot synthesise the
  // pointer drag itself (-32003), so every move here goes through the menu
  // items, which call the same moveTab the chips' drop handler calls. Not
  // covered: the drag gesture, the drop index a pointer position maps to, the
  // insertion divider while dragging, and a docked inspector riding along.
  const counterRe = /^Counter c=(\d+) f=(.*)$/;
  const counterIn = (rows: string[]): { c: number; f: string } | null => {
    for (const title of rows) {
      const m = counterRe.exec(title);
      if (m) return { c: Number(m[1]), f: m[2]! };
    }
    return null;
  };
  const rowsIn = async (listId: string): Promise<string[]> => {
    const node = await app.find(listId);
    return node ? listRows(node).map((r) => r.title) : [];
  };
  const waitRowsIn = async (listId: string, check: (rows: string[]) => boolean, what: string): Promise<string[]> => {
    const deadline = Date.now() + PATIENCE;
    let seen: string[] = [];
    while (Date.now() < deadline) {
      seen = await rowsIn(listId);
      if (check(seen)) return seen;
      await Bun.sleep(200);
    }
    return fail(`timed out waiting for ${what}; ${listId} rows were ${JSON.stringify(seen)}`);
  };
  /// The move reported after the first `seen` traces.
  const nextMove = async (seen: number): Promise<RegExpExecArray> => {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      const m = /tab=(t\d+) from=(w\d+) to=(w\d+)/.exec(moveTraces[seen] ?? "");
      if (m) return m;
      await Bun.sleep(100);
    }
    return fail("the app never reported the move");
  };
  const windowCount = async (): Promise<number> => (await app.windows()).windows.length;
  const waitWindowCount = async (n: number, what: string): Promise<void> => {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      if ((await windowCount()) === n) return;
      await Bun.sleep(150);
    }
    fail(`${what}: ${await windowCount()} windows, want ${n}`);
  };

  await step("open a tab for the counter page", () => app.click("menu-new-tab"));
  await goTo(app, `${base}/counter`);
  await waitUrl(app, "/counter");
  // The address is the app's as soon as it is set; the page's script is
  // there once the title is its own.
  await waitRowsIn("tab-list", (r) => counterIn(r) !== null, "the counter page running");
  await step("fill the page's field", () => app.click("menu-run-test-js"));
  const start = counterIn(
    await waitRowsIn("tab-list", (r) => counterIn(r)?.f === "typed-by-drive", "the counter page reporting its field"),
  )!;
  if (loads.counter !== 1) fail(`the counter page loaded ${loads.counter} times before any move`);

  // Reorder within the window: left, then right again.
  const idsBefore = await waitTabIds(app, () => true, "the tab rows");
  const counterRow = idsBefore[idsBefore.length - 1]!;
  await step("move the tab left", () => app.click("menu-move-left"));
  await waitTabIds(app, (ids) => ids[ids.length - 2] === counterRow, "the counter tab one place to the left");
  await step("move the tab right", () => app.click("menu-move-right"));
  await waitTabIds(app, (ids) => ids[ids.length - 1] === counterRow, "the counter tab back at the end");
  if (loads.counter !== 1) fail(`reordering reloaded the page: ${loads.counter} loads`);
  console.log(`21a. Move Tab Left/Right reorders ${counterRow} within the window, loads counter=${loads.counter}`);

  // To a new window: the live page moves.
  const windowsBefore = await windowCount();
  const movesBefore = moveTraces.length;
  await step("move the tab to a new window", () => app.click("menu-move-new-window"));
  const toNew = await nextMove(movesBefore);
  const [, movedTab, mainId, newId] = toNew;
  await waitWindowCount(windowsBefore + 1, "a window for the moved tab");
  const inNew = counterIn(
    await waitRowsIn(`${newId}-tab-list`, (r) => r.length === 1 && (counterIn(r)?.c ?? -1) > start.c, "the counter ticking on in the new window"),
  )!;
  if (inNew.f !== "typed-by-drive") fail(`the field came across as ${JSON.stringify(inNew.f)}`);
  if (counterIn(await rowsIn("tab-list"))) fail("the counter tab is still listed in the window it left");
  if (loads.counter !== 1) fail(`moving the tab to a new window reloaded it: ${loads.counter} loads`);
  await shoot(app, "21-moved-to-new-window", (await app.find(`${newId}-window`))?.ref);
  // A second window's own menu closes its header row, where the first
  // window's menu bar button sits.
  const menuX = (await app.find(`${newId}-window-menu`))?.geometry?.x ?? -1;
  const downloadsX = (await app.find(`${newId}-downloads-button`))?.geometry?.x ?? -1;
  if (!(menuX > downloadsX && downloadsX >= 0)) fail(`${newId}'s menu sits at x=${menuX}, downloads at x=${downloadsX}`);
  console.log(`21b. ${movedTab} moved ${mainId} -> new ${newId} live: c ${start.c} -> ${inNew.c}, field ${inNew.f}, loads counter=${loads.counter}`);

  // Back, from the new window's own menu. It was that window's only tab, so
  // the window closes behind it.
  await step("move it back from the new window's menu", () => app.click(`${newId}-menu-move-to-${mainId}`));
  await waitWindowCount(windowsBefore, "the emptied window closing");
  const back = counterIn(
    await waitRowsIn("tab-list", (r) => (counterIn(r)?.c ?? -1) > inNew.c, "the counter ticking on back in the first window"),
  )!;
  if (back.f !== "typed-by-drive") fail(`the field came back as ${JSON.stringify(back.f)}`);
  if (loads.counter !== 1) fail(`moving the tab between windows reloaded it: ${loads.counter} loads`);
  console.log(`21c. ${movedTab} moved ${newId} -> ${mainId} live and ${newId} closed: c ${inNew.c} -> ${back.c}, field ${back.f}, loads counter=${loads.counter}`);

  // Into the private window: another profile, so the page is reopened there
  // at its address and the tab leaves this window. A second load is the
  // design, not a failure.
  if (!(await app.find("private-window"))) {
    await step("open the private window", () => app.click("menu-private-window"));
    await app.waitFor({ testId: "private-window", state: "present" }, { timeoutMs: PATIENCE });
  }
  await step("move it to the private window", () => app.click("menu-move-to-private"));
  await waitRowsIn("private-tab-list", (r) => r.some((t) => t.startsWith("Counter")), "the counter reopened in the private window");
  if (counterIn(await rowsIn("tab-list"))) fail("the counter tab is still listed in the normal window");
  const deadlineLoads = Date.now() + PATIENCE;
  const counterLoads = (): number => loads.counter ?? 0;
  while (Date.now() < deadlineLoads && counterLoads() !== 2) await Bun.sleep(150);
  if (counterLoads() !== 2) fail(`a move across profiles should reload once, loads counter=${counterLoads()}`);
  console.log(`21d. a move into the private window reopens the page there (loads counter=${loads.counter}) and closes it here`);

  // Each window is persisted with its own tabs and restored as its own
  // window.
  await step("open a new window", () => app.click("menu-new-window"));
  await waitWindowCount(windowsBefore + 1, "the new window");
  const stored = (): { id: string; urls: string[] }[] =>
    (
      JSON.parse(readFileSync(`${PROFILE}/session.json`, "utf8")) as {
        data?: { windows?: { id: string; tabs: { url: string }[] }[] };
      }
    ).data?.windows?.map((w) => ({ id: w.id, urls: w.tabs.map((t) => t.url) })) ?? [];
  const secondId = await step("the store lists the new window", async () => {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      const ws = stored();
      if (ws.length === 2) return ws[1]!.id;
      await Bun.sleep(200);
    }
    return fail(`the store lists ${JSON.stringify(stored())}`);
  });
  if (await app.find(`${secondId}-omnibox`)) {
    await step("type an address into the new window", () => app.setValue(`${secondId}-omnibox`, `${base}/b`));
    await step("commit it", () => app.click("menu-commit-address"));
  } else {
    // The sidebar layout has no address field: the new window's command bar
    // is where its address is typed. The row on show opens its window's command bar on its address; the
    // menu item acts on whichever window has the focus, which a headless
    // compositor may not hand the new one.
    const bar = `${secondId}-palette`;
    // Polled with find, which looks in every window; waitFor watches one.
    let newRow = "";
    for (const deadline = Date.now() + PATIENCE; !newRow && Date.now() < deadline; await Bun.sleep(200)) {
      const list = await app.find(`${secondId}-tab-list`);
      newRow = list ? listActive(list) : "";
    }
    if (!newRow) {
      const wins = (await app.windows()).windows.map((w) => `${w.ref}:${w.title}`);
      const list = await app.find(`${secondId}-tab-list`);
      fail(`the new window shows no tab; windows ${JSON.stringify(wins)}; list ${JSON.stringify(list).slice(0, 600)}`);
    }
    await step("open the new window's command bar", () => app.click(`${secondId}-tab-${newRow}`));
    for (const deadline = Date.now() + PATIENCE; !(await app.find(bar))?.visible; await Bun.sleep(200)) {
      if (Date.now() > deadline) fail("the new window's command bar never presented");
    }
    await step("type an address into the new window", async () => {
      const deadline = Date.now() + PATIENCE;
      for (;;) {
        await setValueWhenReady(bar, `${base}/b`);
        await Bun.sleep(600);
        const rows = (await app.find(bar))?.rows ?? [];
        if (rows.some((r) => r.id === "url" && String(r.title ?? "").includes(`${base}/b`))) return;
        if (Date.now() > deadline) fail(`the new window's command bar never took ${base}/b`);
      }
    });
    await step("commit it", () => setValueWhenReady(bar, true));
  }
  await waitRowsIn(`${secondId}-tab-list`, (r) => r[0]?.startsWith("Page B") ?? false, "page B in the new window");
  await step("open settings", () => app.click("menu-settings"));
  await step("turn reopen-on-launch back on", async () => {
    const deadline = Date.now() + PATIENCE;
    for (;;) {
      try {
        return await app.setValue("settings-restore", true);
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await Bun.sleep(200);
      }
    }
  });
  const persisted = await step("both windows reach the store", async () => {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      const ws = stored();
      if (ws.length === 2 && ws[1]!.urls.some((u) => u.endsWith("/b"))) return ws;
      await Bun.sleep(200);
    }
    return fail(`the store lists ${JSON.stringify(stored())}`);
  });
  const mainRows = await rowsIn("tab-list");
  await app.restart();
  await app.waitForPresent("tab-list", { timeoutMs: PATIENCE });
  await waitWindowCount(2, "both windows restored");
  await waitRowsIn("tab-list", (r) => r.length === mainRows.length, "the first window's tabs restored");
  await waitRowsIn(`${secondId}-tab-list`, (r) => r.length === 1, "the second window's tab restored");
  console.log(
    `21e. restart restored 2 windows: ${persisted.map((w) => `${w.id}=${w.urls.length} tabs`).join(", ")}`,
  );

  console.log("NB_MVP_OK");
} catch (e) {
  console.error(`drive failed: ${(e as Error).message}`);
  console.error("--- host stderr tail ---");
  console.error(app.stderrTail(60));
  throw e;
} finally {
  await app.close().catch(() => {});
  server.stop(true);
}
