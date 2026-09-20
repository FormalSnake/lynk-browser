#!/usr/bin/env bun
// Stage-1 acceptance drive. Self-contained: a Bun.serve fixture supplies every
// page, so nothing here touches the network. Fixture pages count their own
// loads server-side, which is how "switching tabs did not reload the page" is
// proved rather than assumed.
//
// Run headless: scripts/headless.sh bun scripts/browser-drive.ts
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { launchApp, type AppHandle, type JsonNode } from "@nativedesktop/test";
import {
  SHOTS,
  fail,
  paletteDriver,
  shoot,
  step,
  textsUnder,
  walk,
  waitRows as rowsMatching,
  waitText as textMatching,
} from "./drive-lib.ts";

const PROFILE = "/tmp/nb-drive-profile";
const DOWNLOADS = "/tmp/nb-drive-downloads";
// The webview jar lives under the user data dir, so the cookie round trip needs
// one of its own — otherwise it reads a jar the dev box already had and a
// browser that persists nothing still passes.
const DATA_HOME = "/tmp/nb-drive-data";
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
      case "/search":
        return page("search", "Search results", "<h1>Search results</h1>");
      case "/setcookie":
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Cookie set</title><h1>Cookie set</h1>',
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "set-cookie": `nbdrive=${COOKIE_VALUE}; Path=/; Max-Age=3600`,
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
  const list = await app.mustFind("tab-list");
  return (list.rows ?? []).filter((r) => r.testID).map((r) => ({ title: r.title, testID: r.testID }));
}

/// The section headings the sidebar is currently drawing, in order.
async function tabSections(app: AppHandle): Promise<string[]> {
  const list = await app.mustFind("tab-list");
  return (list.rows ?? []).filter((r) => !r.testID).map((r) => r.title);
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
async function shownUrl(app: AppHandle): Promise<string> {
  return String((await app.mustFind("omnibox")).text ?? "");
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

// ------------------------------------------------------------------ drive ---

function launch(storeDir: string): Promise<AppHandle> {
  return launchApp({
    entry: "src/main.tsx",
    env: {
      NB_STORE_DIR: storeDir,
      NB_DOWNLOAD_DIR: DOWNLOADS,
      XDG_DATA_HOME: DATA_HOME,
      NB_TEST_HOOKS: "1",
      NB_TEST_JS: "document.getElementById('open').click()",
      // What the Debug menu's "Context: save image" hook downloads.
      NB_TEST_IMAGE: `${base}/image.png`,
      // Searches land on the fixture: a live engine can answer the search tab
      // with a captcha and stall the leg on network state.
      NB_TEST_SEARCH_PREFIX: `${base}/search?q=`,
      // A D-Bus name, so no hyphens: GTK accepts an invalid application id and
      // then degrades silently.
      ND_APP_ID: "dev.nativebrowser.browser",
    },
    readyTimeoutMs: PATIENCE,
    // waitFor blocks host-side for its full condition timeout, so the client's
    // per-RPC timeout has to be the larger of the two.
    rpcTimeoutMs: PATIENCE,
    // The context-menu tree is only observable as what the app SENDS the
    // engine: no automation can open a real menu.
    onStderr: (line) => {
      if (line.includes("ND_APP CTXMENU")) menuTraces.push(line.trim());
    },
  });
}

const menuTraces: string[] = [];

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
  await app.mustFind("omnibox");
  await app.mustFind("new-tab-page");
  const first = await tabRows(app);
  if (first.length !== 1 || first[0]!.title !== "New Tab") {
    fail(`session should start with one New Tab row, got ${JSON.stringify(first)}`);
  }
  console.log("1. launch: window + sidebar + omnibox, session has one New Tab");
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


  // Owner requirement — the address bar is an Arc-style command palette.
  // primary+l seeds it with the current URL; rows are ranked address, open
  // tabs, history, then app commands.
  await step("open the seeded palette (Ctrl+L path)", () => app.click("menu-address"));
  await step("palette presents", () => app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: PATIENCE }));
  await shoot(app, "04-palette");
  await step("activate the seeded address row", () => app.setValue("palette", 0));
  const reloadedA = Date.now() + 10_000;
  while (Date.now() < reloadedA && loads.a === baseline.a) await Bun.sleep(120);
  if (loads.a !== baseline.a + 1) fail(`the seeded palette row should have reloaded page A, loads ${JSON.stringify(loads)}`);
  await waitUrl(app, "/a");

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
  console.log("4. palette: seeded address row, tab switch and app command all ran");

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
  await step("its launcher presents", () =>
    app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: PATIENCE }),
  );
  const launcher = await step("read the launcher's field back", () => app.type("palette", "z"));
  if (launcher.text !== "z") {
    fail(`the new tab's launcher came up holding ${JSON.stringify(launcher.text.slice(0, -1))}`);
  }
  await step("clear the launcher", () => app.setValue("palette", ""));
  await step("submit nothing, which closes it", () => app.setValue("palette", true));
  await app.mustFind("new-tab-page");
  await step("close both tabs this leg opened", async () => {
    await app.click("menu-close-tab");
    await waitRows(app, (r) => r.length === tabsBeforeLauncher + 1, "one extra tab left");
    await app.click("menu-close-tab");
  });
  await waitRows(app, (r) => r.length === tabsBeforeLauncher, "the tab count back where it started");
  console.log("4b. a new tab's launcher comes up empty after the last one was typed into");

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
  await step("close a tab from its sidebar row action", () =>
    app.click({ testId: victim.testID!, action: "close" }),
  );
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
  await goTo(app, `${base}/setcookie`);
  await waitUrl(app, "/setcookie");

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
  const mainWindow = (await app.windows()).windows[0]!.ref;
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
  // The whole point of the move: nothing about downloads is in the tab column
  // any more.
  const inSidebar: string[] = [];
  walk((await app.tree(mainWindow)).root, (n) => {
    if (n.testID !== "sidebar") return;
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

  // Stage 5 — a private window is a real second window on an ephemeral profile,
  // and nothing it does reaches the session store. The store on disk is the
  // assertion: opening private tabs must not change what a restart would bring
  // back.
  const storedTabs = (): number => {
    const raw = JSON.parse(readFileSync(`${PROFILE}/session.json`, "utf8")) as { data?: { tabs?: unknown[] } };
    return raw.data?.tabs?.length ?? 0;
  };
  const persistedBefore = storedTabs();
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
  const wantedItems = ["Open Link in New Tab", "Save Image", "Search with Google"];
  for (const wanted of wantedItems) {
    if (!menuLabels.includes(wanted)) fail(`the context menu is missing ${JSON.stringify(wanted)}: ${JSON.stringify(menuLabels)}`);
  }
  const linkItem = menuTree!.find((i) => i.id === "nb-open-link");
  if (JSON.stringify(linkItem?.contexts) !== JSON.stringify(["link"])) {
    fail(`the open-link item should be link-only, got ${JSON.stringify(linkItem)}`);
  }

  const tabsBefore = (await tabRows(app)).length;
  await step("context menu: open a link in a new tab", () => app.click("menu-ctx-open-link"));
  await waitRows(app, (r) => r.length === tabsBefore + 1, "a background tab from the context menu");
  const afterOpen = await tabRows(app);
  if (afterOpen[tabsBefore] === undefined) fail("the context menu opened no new tab");
  // A background tab, so the one that was active still is.
  await waitUrl(app, "/a");

  await step("context menu: save an image", () => app.click("menu-ctx-save-image"));
  const savedImage = `${DOWNLOADS}/image.png`;
  const imageLanded = Date.now() + 25_000;
  while (Date.now() < imageLanded && !existsSync(savedImage)) await Bun.sleep(150);
  if (!existsSync(savedImage)) fail(`Save Image did not land at ${savedImage}`);

  await step("context menu: search the selection", () => app.click("menu-ctx-search-selection"));
  await waitRows(app, (r) => r.length === tabsBefore + 2, "a tab for the searched selection");
  const searchTab = (await tabRows(app))[tabsBefore + 1];
  // Served by the fixture (NB_TEST_SEARCH_PREFIX), counted server-side like
  // every other page here.
  const searched = Date.now() + PATIENCE;
  while (Date.now() < searched && !loads["search"]) await Bun.sleep(120);
  if (!loads["search"]) fail("the search tab never reached the fixture's /search");
  console.log(
    `16. page context menu: ${menuLabels.length} app items (${JSON.stringify(menuLabels)}), ` +
      `open-link and search each opened a tab (last is ${JSON.stringify(searchTab?.title ?? "")}), ` +
      `Save Image landed ${savedImage}`,
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
        data?: { tabs?: { pinned?: boolean }[] };
      }
    ).data?.tabs?.filter((t) => t.pinned).length ?? 0;
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

  // Compact is Safari's single row: the pills in the toolbar ARE the tab list
  // and the address bar, and nothing is drawn below it. The live pages must not
  // notice the switch, so the server's load counters bracket each one.
  const beforeCompact = (await tabRows(app)).map((r) => r.testID!);
  const activeTabId = String((await app.mustFind("tab-list")).value ?? "");
  const otherTabId = beforeCompact.map((id) => id.slice(4)).find((id) => id !== activeTabId)!;
  const activeBeforeCompact = await shownUrl(app);
  let loadsAt = await settledLoads();
  const insetBefore = await contentInset(app);
  if (insetBefore <= 0) fail(`the sidebar layout should inset the content, it starts at x=${insetBefore}`);
  await step("switch to the compact layout", () => app.click("menu-layout"));
  await step("the content reclaims the tab column's width", () => waitContentInset(app, (x) => x === 0));
  await app.mustFind("tab-strip");
  await app.mustFind("header-new-tab");
  if (await app.find("omnibox")) fail("compact draws no address bar of its own until a pill is clicked");
  const afterDrop = await settledLoads();
  if (loadsAt !== afterDrop) fail(`dropping the sidebar reloaded a page: ${loadsAt} -> ${afterDrop}`);
  await shoot(app, "18-compact", mainWindow);

  // Owner report: the compact tab list went stale. The strip is the only tab UI
  // this layout has, so everything the session does has to reach it.
  const pills = async (check: (p: string[]) => boolean, what: string): Promise<string[]> => {
    const deadline = Date.now() + PATIENCE;
    let seen: string[] = [];
    while (Date.now() < deadline) {
      seen = await textsUnder(app, "tab-pill-", mainWindow);
      if (check(seen)) return seen;
      await Bun.sleep(150);
    }
    return fail(`timed out waiting for ${what}; the strip read ${JSON.stringify(seen)}`);
  };
  await pills((p) => p.length === beforeCompact.length, "one pill per open tab");

  // The active pill IS the address field. Its value is the proof: the field
  // cannot be submitted from a drive on GTK (the backend refuses key
  // synthesis, -32003), so what it comes up holding is what can be asserted.
  await step("click the active pill", () => app.click(`tab-pill-${activeTabId}`));
  // "present", not "visible": a SearchInput packed into a header bar is not
  // actionable by the tree's rule on either backend, and the assertion here is
  // that the field exists at all, which it does not until the pill is clicked.
  await step("it becomes the address field", () =>
    app.waitFor({ testId: "omnibox", state: "present" }, { timeoutMs: PATIENCE }),
  );
  const field = await app.mustFind("omnibox");
  const held = String(field.value ?? field.text ?? "");
  if (held !== activeBeforeCompact) {
    fail(`the address field came up holding ${JSON.stringify(held)}, want ${JSON.stringify(activeBeforeCompact)}`);
  }
  await step("switch to another pill", () => app.click(`tab-pill-${otherTabId}`));
  await step("the field goes back to being a pill", async () => {
    const deadline = Date.now() + PATIENCE;
    while (Date.now() < deadline) {
      if (!(await app.find("omnibox"))) return;
      await Bun.sleep(150);
    }
    return fail("the address field is still in the strip after switching tabs");
  });
  await step("the window follows the tab the strip picked", async () => {
    const wanted = (await app.mustFind(`tab-pill-${otherTabId}`)).text ?? "";
    const deadline = Date.now() + PATIENCE;
    let title = "";
    while (Date.now() < deadline) {
      title = (await app.windows()).windows[0]!.title ?? "";
      if (title === wanted) return;
      await Bun.sleep(150);
    }
    return fail(`the window still says ${JSON.stringify(title)}, want ${JSON.stringify(wanted)}`);
  });

  // Opened and retitled: a tab opened from the History menu loads a real page,
  // so its pill starts on the address and has to end on the page's own title.
  await step("open a tab from the History menu", () => app.click("menu-history-0"));
  await pills((p) => p.length === beforeCompact.length + 1, "a pill for the tab history opened");
  await pills(
    (p) => !(p[p.length - 1] ?? "127.0.0.1").includes("127.0.0.1"),
    "the new pill to carry the title its page reported",
  );
  // Closed: the pill's own close button only exists under the pointer, and GTK
  // synthesises no pointer input, so this closes the tab the way a keyboard
  // does.
  await step("close it again", () => app.click("menu-close-tab"));
  const stripAfterClose = await pills((p) => p.length === beforeCompact.length, "the closed tab's pill to go");
  console.log(`18b. the compact strip tracks open, retitle, close and switch (${stripAfterClose.length} pills)`);

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
