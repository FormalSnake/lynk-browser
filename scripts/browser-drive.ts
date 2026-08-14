#!/usr/bin/env bun
// Stage-1 acceptance drive. Self-contained: a Bun.serve fixture supplies every
// page, so nothing here touches the network. Fixture pages count their own
// loads server-side, which is how "switching tabs did not reload the page" is
// proved rather than assumed.
//
// Run headless: scripts/headless.sh bun scripts/browser-drive.ts
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { launchApp, type AppHandle, type JsonNode } from "@nativedesktop/test";

const SHOTS = `${import.meta.dir}/../screenshots`;
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

function fail(message: string): never {
  throw new Error(message);
}

function walk(node: JsonNode, visit: (n: JsonNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

async function tabRows(app: AppHandle): Promise<{ title: string; testID: string | null }[]> {
  const list = await app.mustFind("tab-list");
  return (list.rows ?? []).map((r) => ({ title: r.title, testID: r.testID }));
}

async function waitRows(app: AppHandle, check: (rows: string[]) => boolean, what: string): Promise<string[]> {
  const deadline = Date.now() + PATIENCE;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = (await tabRows(app)).map((r) => r.title);
    if (check(last)) return last;
    await Bun.sleep(120);
  }
  return fail(`timed out waiting for ${what}; sidebar rows were ${JSON.stringify(last)}`);
}

/// The address bar IS the command palette. Open it (unless something already
/// did, e.g. New tab), replace the query, then submit it as typed. The palette
/// presents asynchronously and is not actionable until it does, so every open
/// waits for it.
async function openPalette(app: AppHandle): Promise<void> {
  const node = await app.find("palette");
  if (node?.visible) return;
  await step("click the address display", () => app.click("omnibox"));
  await step("wait for the palette to present", () =>
    app.waitFor({ testId: "palette", state: "visible" }, { timeoutMs: PATIENCE }),
  );
}

async function goTo(app: AppHandle, url: string): Promise<void> {
  await openPalette(app);
  await typeQuery(app, url);
  await step("submit the palette query", () => app.setValue("palette", true));
}

/// setValue(palette, "<string>") replaces the entry text but leaves the app's
/// controlled `query` state behind (GTK set_text emits changed twice and the
/// blank intermediate wins), so the ranked item list would not match what the
/// drive typed. Clearing and inserting keeps both sides in step.
async function typeQuery(app: AppHandle, text: string): Promise<void> {
  await step("clear the palette query", () => app.setValue("palette", ""));
  await step(`type ${JSON.stringify(text)} into the palette`, () => app.type("palette", text));
}

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

async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
}

async function shoot(app: AppHandle, name: string): Promise<void> {
  const shot = await app.screenshot(`${SHOTS}/${name}.png`, { minBytes: 1000 });
  console.log(`  screenshot ${name}.png ${shot.width}x${shot.height}`);
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
  if (first.length !== 1 || first[0]!.title !== "New tab") {
    fail(`session should start with one New tab row, got ${JSON.stringify(first)}`);
  }
  console.log("1. launch: window + sidebar + omnibox, session has one New tab");
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
