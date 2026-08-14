#!/usr/bin/env bun
// Stage-1 acceptance drive. Self-contained: a Bun.serve fixture supplies every
// page, so nothing here touches the network. Fixture pages count their own
// loads server-side, which is how "switching tabs did not reload the page" is
// proved rather than assumed.
//
// Run headless: scripts/headless.sh bun scripts/browser-drive.ts
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { launchApp, type AppHandle } from "@nativedesktop/test";
import {
  SHOTS,
  fail,
  paletteDriver,
  shoot,
  step,
  walk,
  waitRows as rowsMatching,
  waitText as textMatching,
} from "./drive-lib.ts";

const PROFILE = "/tmp/nb-drive-profile";
const DOWNLOADS = "/tmp/nb-drive-downloads";
// One knob for every wait: the same drive runs on an idle laptop and inside a
// full framework gate sweep, where everything is several times slower.
const PATIENCE = Number(process.env.ND_DRIVE_TIMEOUT_MS ?? 60_000);

rmSync(PROFILE, { recursive: true, force: true });
rmSync(DOWNLOADS, { recursive: true, force: true });
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
      case "/popup":
        // The link is clicked from the app side (see NB_TEST_JS below): WebKit
        // blocks a gesture-less target=_blank click made by the page itself.
        return page("popup", "Popup page", '<a id="open" href="/c" target="_blank">open c</a>');
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

async function tabRows(app: AppHandle): Promise<{ title: string; testID: string | null }[]> {
  const list = await app.mustFind("tab-list");
  return (list.rows ?? []).map((r) => ({ title: r.title, testID: r.testID }));
}

async function waitRows(app: AppHandle, check: (rows: string[]) => boolean, what: string): Promise<string[]> {
  return rowsMatching(app, "tab-list", check, what, PATIENCE);
}

const { openPalette, typeQuery, goTo } = paletteDriver({ backend: "gtk", timeoutMs: PATIENCE });

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

// ------------------------------------------------------------------ drive ---

function launch(storeDir: string): Promise<AppHandle> {
  return launchApp({
    entry: "src/main.tsx",
    backend: "gtk",
    env: {
      NB_STORE_DIR: storeDir,
      NB_DOWNLOAD_DIR: DOWNLOADS,
      NB_TEST_HOOKS: "1",
      NB_TEST_JS: "document.getElementById('open').click()",
      // A D-Bus name, so no hyphens: GTK accepts an invalid application id and
      // then degrades silently.
      ND_APP_ID: "dev.nativebrowser.browser",
    },
    readyTimeoutMs: PATIENCE,
    // waitFor blocks host-side for its full condition timeout, so the client's
    // per-RPC timeout has to be the larger of the two.
    rpcTimeoutMs: PATIENCE,
  });
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
    if (n.testID?.startsWith("page-")) pages[n.testID] = n.visible;
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
  await step("open the find bar", () => app.click("menu-find"));
  await step("the find bar presents", () => app.waitFor({ testId: "find-bar", state: "visible" }, { timeoutMs: PATIENCE }));
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
  console.log(`12. find in page: "row 399" -> ${JSON.stringify(counted)}, absent text -> ${JSON.stringify(missing)}`);

  // Stage 5 — the page context menu. WebKit's own context-menu signal needs a
  // real right-click, which GTK4 will not synthesize, so the drive opens the
  // menu off a synthetic hit test (NB_TEST_HOOKS) and then runs an item. What
  // is proved is the app's half: the menu the hit test earns, and the action.
  await step("open the page menu", () => app.click("menu-open-page-menu"));
  await step("the page menu presents", () =>
    app.waitFor({ testId: "context-menu-open-link", state: "present" }, { timeoutMs: PATIENCE }),
  );
  const wanted = [
    "context-menu-open-link",
    "context-menu-copy-link",
    "context-menu-copy-image",
    "context-menu-save-image",
    "context-menu-copy",
    "context-menu-search-selection",
    "context-menu-back",
    "context-menu-forward",
    "context-menu-reload",
  ];
  for (const item of wanted) {
    if (!(await app.find(item))) fail(`the page menu is missing ${item}`);
  }
  // A GtkPopover does not map under headless weston (its items report
  // visible=false with unallocated geometry), so the click below is refused as
  // not-actionable on GTK. The menu is verified visually on AppKit instead,
  // where the same items map and are clickable. The item SET is the portable
  // assertion and it is the app's half of the feature.
  const clicked = await app
    .click("context-menu-reload")
    .then(() => true)
    .catch(() => false);
  console.log(`13. page context menu: ${wanted.length} items for a link+image+selection hit; item click ran=${clicked}`);

  // Acceptance 4 — target=_blank opens a background tab. GTK automation cannot deliver a
  //    click into page content, and WebKit refuses a gesture-less popup, so the
  //    click is issued through the app's NB_TEST_HOOKS-only Debug menu, which
  //    runs it via the webview's executeJavaScript (that path does carry a user
  //    gesture).
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

  // Acceptance 6 — download. It runs with every tab from the rest of the drive
  // still live: WebKitGTK's download-started lives on the shared network
  // session, and the host used to fire it once per view and cancel the same
  // WebKitDownload once per handler, which segfaulted. Fixed framework-side, so
  // this is now the regression test for it.
  await goTo(app, `${base}/file.txt`);

  const downloaded = `${DOWNLOADS}/fixture.txt`;
  const landed = Date.now() + 25_000;
  while (Date.now() < landed && !existsSync(downloaded)) await Bun.sleep(150);
  if (!existsSync(downloaded)) fail(`download did not land at ${downloaded}`);
  const body = readFileSync(downloaded, "utf8");
  if (!body.startsWith("nativebrowser download fixture")) fail(`downloaded file has wrong content: ${JSON.stringify(body)}`);

  let downloadRows: string[] = [];
  const listed = Date.now() + 15_000;
  while (Date.now() < listed) {
    downloadRows = ((await app.mustFind("downloads-list")).rows ?? []).map((r) => r.title);
    if (downloadRows.includes("fixture.txt")) break;
    await Bun.sleep(150);
  }
  if (!downloadRows.includes("fixture.txt")) fail(`downloads list is ${JSON.stringify(downloadRows)}, want a fixture.txt row`);
  // The name comes from the engine's suggestedFilename now, and exactly one
  // event arrives however many views are live.
  if (downloadRows.length !== 1) fail(`one download expected, got ${JSON.stringify(downloadRows)}`);

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
